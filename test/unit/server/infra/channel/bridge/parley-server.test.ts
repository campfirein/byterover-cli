/* eslint-disable camelcase */
import {expect} from 'chai'
import {createHash} from 'node:crypto'
import {mkdtemp, rm} from 'node:fs/promises'
import {tmpdir} from 'node:os'
import {join} from 'node:path'

import {canonicalize} from '../../../../../../src/agent/core/trust/canonical.js'
import {InstallIdentityService} from '../../../../../../src/agent/core/trust/install-identity-service.js'
import {PeerTreeIdentityService} from '../../../../../../src/agent/core/trust/peer-tree-identity-service.js'
import {signParleyHandshake, signRequestAuth} from '../../../../../../src/agent/core/trust/sign.js'
import {TofuStore} from '../../../../../../src/agent/core/trust/tofu-store.js'
import {ParleyResponseFrameSchema} from '../../../../../../src/server/core/domain/channel/parley-types.js'
import {DEFAULT_BRIDGE_CONFIG} from '../../../../../../src/server/infra/channel/bridge/bridge-config.js'
import {Libp2pHost, type Libp2pStreamLike} from '../../../../../../src/server/infra/channel/bridge/libp2p-host.js'
import {
  type ParleyResponseDataChunk,
  type ParleyResponseGenerator,
} from '../../../../../../src/server/infra/channel/bridge/parley-response-generator.js'
import {
  dispatchResponseStream,
  PARLEY_QUERY_PROTOCOL,
  registerParleyServer,
} from '../../../../../../src/server/infra/channel/bridge/parley-server.js'

async function encodeLengthPrefixed(
  bytes: Uint8Array,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  lp: any,
): Promise<Uint8Array> {
  const chunks: Uint8Array[] = []
  for await (const buf of lp.encode([bytes])) {
    chunks.push(buf.subarray())
  }

  let total = 0
  for (const c of chunks) total += c.length
  const out = new Uint8Array(total)
  let offset = 0
  for (const c of chunks) {
    out.set(c, offset)
    offset += c.length
  }

  return out
}

// Phase 9 / Slice 9.3c-iv — `/brv/parley/query/v1` server.
//
// Sanity tests for the server module + integration with a real libp2p
// host. The full two-host happy-path lives in 9.3e (after parley-client
// ships in 9.3d).

// Module-scope so `unicorn/consistent-function-scoping` is satisfied
// for the heartbeat keep-alive test below — the generator does not
// close over per-test state.
const slowGen: ParleyResponseGenerator = async function* (): AsyncIterable<ParleyResponseDataChunk> {
  await new Promise<void>((resolve) => {
    setTimeout(resolve, 500)
  })
  yield {content: 'hi after a wait', kind: 'agent_message_chunk'}
}

describe('parley-server (Slice 9.3c-iv)', () => {
  describe('protocol constant', () => {
    it('exposes the canonical `/brv/parley/query/v1` protocol ID', () => {
      expect(PARLEY_QUERY_PROTOCOL).to.equal('/brv/parley/query/v1')
    })
  })

  describe('registerParleyServer + happy-path round-trip', () => {
    let installDirA: string
    let installDirB: string
    let tofuDirB: string

    beforeEach(async () => {
      installDirA = await mkdtemp(join(tmpdir(), 'brv-parley-srv-A-'))
      installDirB = await mkdtemp(join(tmpdir(), 'brv-parley-srv-B-'))
      tofuDirB = await mkdtemp(join(tmpdir(), 'brv-parley-srv-tofu-'))
    })

    afterEach(async () => {
      await rm(installDirA, {force: true, recursive: true})
      await rm(installDirB, {force: true, recursive: true})
      await rm(tofuDirB, {force: true, recursive: true})
    })

    it('verifies an inbound query envelope, dispatches to mock-echo, and emits 3 signed frames', async () => {
      // Bob — receiver.
      const idB = new InstallIdentityService({installDir: installDirB})
      await idB.loadOrGenerate()
      const l2B = new PeerTreeIdentityService({install: idB})
      const bIdentity = await l2B.loadOrGenerate()
      const hostB = new Libp2pHost({config: DEFAULT_BRIDGE_CONFIG, identity: idB})
      await hostB.start()
      const tofuB = new TofuStore({storePath: join(tofuDirB, 'known-peers.jsonl')})
      await registerParleyServer({
        acceptModes: ['peer-tree'],
        host: hostB,
        l2Identity: l2B,
        tofuPolicy: 'auto',
        tofuStore: tofuB,
      })

      // Alice — caller.
      const idA = new InstallIdentityService({installDir: installDirA})
      const aIdentity = await idA.loadOrGenerate()
      const l2A = new PeerTreeIdentityService({install: idA})
      const aL2 = await l2A.loadOrGenerate()
      const hostA = new Libp2pHost({config: DEFAULT_BRIDGE_CONFIG, identity: idA})
      await hostA.start()

      try {
        // Build a valid envelope on Alice's side.
        const prompt = [{text: 'echo this please', type: 'text' as const}]
        const turn_id = 't-server-001'
        const delivery_id = 'd-server-001'
        const channel_id = 'review-2026'
        const protocol = 'query'
        const body_hash = createHash('sha256')
          .update(canonicalize({channel_id, delivery_id, prompt, protocol, turn_id}), 'utf8')
          .digest('hex')
        const reqAuthPayload = {body_hash, requester_cert: aL2.cert}
        const reqAuthSig = signRequestAuth(reqAuthPayload, aL2.privateKey)
        const handshakeInner = {
          install_cert: aIdentity.cert,
          nonce: Buffer.alloc(16, 0x12).toString('base64'),
          tree_cert: aL2.cert,
          ts: new Date().toISOString(),
          version: 1 as const,
        }
        const handshakeSig = signParleyHandshake(handshakeInner, await idA.getL1PrivateKey())
        const envelope = {
          channel_id,
          delivery_id,
          disclosure_intent: protocol,
          handshake: {...handshakeInner, signature: handshakeSig},
          prompt,
          protocol,
          request_auth: {...reqAuthPayload, signature: reqAuthSig},
          turn_id,
          version: 1 as const,
        }

        // Dial Bob, send the envelope as ONE length-prefixed JSON frame,
        // collect response frames.
        const addrB = hostB.getMultiaddrs()[0]
        const lp = await import('it-length-prefixed')
        const envelopeBytes = new TextEncoder().encode(JSON.stringify(envelope))
        const framedEnvelope = await encodeLengthPrefixed(envelopeBytes, lp)

        const parsedFrames = await hostA.dialAndSendAndConsume(
          addrB,
          PARLEY_QUERY_PROTOCOL,
          framedEnvelope,
          async (source) => {
            const out: unknown[] = []
            for await (const msg of lp.decode(source as AsyncIterable<Uint8Array>)) {
              const bytes = msg.subarray() as Uint8Array
              const json = new TextDecoder('utf8').decode(bytes)
              out.push(JSON.parse(json))
              if (out.length >= 3) break
            }

            return out
          },
        )

        expect(parsedFrames).to.have.lengthOf(3)
        expect((parsedFrames[0] as {kind: string}).kind).to.equal('agent_message_chunk')
        expect((parsedFrames[0] as {content: string}).content).to.equal('echo this please')
        expect((parsedFrames[1] as {kind: string}).kind).to.equal('stream_end')
        expect((parsedFrames[2] as {kind: string}).kind).to.equal('transcript_seal')
        for (const f of parsedFrames) {
          expect(ParleyResponseFrameSchema.safeParse(f).success).to.equal(true)
        }

        // Bob's TOFU store now has Alice pinned auto-tofu.
        const pinned = await tofuB.get(aIdentity.peerId)
        expect(pinned?.pin_state).to.equal('auto-tofu')

        // Bob's identity is locally defined — silence lint about unused.
        expect(bIdentity.cert.cert_kind).to.equal('peer-tree')
      } finally {
        await Promise.allSettled([hostA.stop(), hostB.stop()])
      }
    })
  })

  describe('heartbeat keep-alive (cross-bridge tool-use HIGH fix)', () => {
    let installDirA: string
    let installDirB: string
    let tofuDirB: string

    beforeEach(async () => {
      installDirA = await mkdtemp(join(tmpdir(), 'brv-parley-srv-hbA-'))
      installDirB = await mkdtemp(join(tmpdir(), 'brv-parley-srv-hbB-'))
      tofuDirB = await mkdtemp(join(tmpdir(), 'brv-parley-srv-hbtofu-'))
    })

    afterEach(async () => {
      await rm(installDirA, {force: true, recursive: true})
      await rm(installDirB, {force: true, recursive: true})
      await rm(tofuDirB, {force: true, recursive: true})
    })

    it('emits heartbeat_ping frames while the response generator is idle (so Yamux substream stays open during slow LLM calls)', async () => {
      // `slowGen` is at-scope (rather than inside the it() body) per
      // `unicorn/consistent-function-scoping`. It sleeps 500ms BEFORE
      // yielding its only chunk, so with heartbeatIntervalMs=50ms we
      // expect ~9–10 heartbeat_ping frames to interleave between the
      // request and the chunk. The 500ms idle gap is kimi-recommended
      // over 300ms for CI-runner jitter tolerance — gives ~10x
      // headroom over the heartbeat interval so a slow runner that
      // drops one or two ticks still sees multiple pings.

      const idB = new InstallIdentityService({installDir: installDirB})
      await idB.loadOrGenerate()
      const l2B = new PeerTreeIdentityService({install: idB})
      await l2B.loadOrGenerate()
      const hostB = new Libp2pHost({config: DEFAULT_BRIDGE_CONFIG, identity: idB})
      await hostB.start()
      const tofuB = new TofuStore({storePath: join(tofuDirB, 'known-peers.jsonl')})
      await registerParleyServer({
        acceptModes: ['peer-tree'],
        heartbeatIntervalMs: 50,
        host: hostB,
        l2Identity: l2B,
        responseGenerator: slowGen,
        tofuPolicy: 'auto',
        tofuStore: tofuB,
      })

      const idA = new InstallIdentityService({installDir: installDirA})
      const aIdentity = await idA.loadOrGenerate()
      const l2A = new PeerTreeIdentityService({install: idA})
      const aL2 = await l2A.loadOrGenerate()
      const hostA = new Libp2pHost({config: DEFAULT_BRIDGE_CONFIG, identity: idA})
      await hostA.start()

      try {
        const prompt = [{text: 'slow please', type: 'text' as const}]
        const turn_id = 't-hb-001'
        const delivery_id = 'd-hb-001'
        const channel_id = 'review-2026'
        const protocol = 'query'
        const body_hash = createHash('sha256')
          .update(canonicalize({channel_id, delivery_id, prompt, protocol, turn_id}), 'utf8')
          .digest('hex')
        const reqAuthPayload = {body_hash, requester_cert: aL2.cert}
        const reqAuthSig = signRequestAuth(reqAuthPayload, aL2.privateKey)
        const handshakeInner = {
          install_cert: aIdentity.cert,
          nonce: Buffer.alloc(16, 0x42).toString('base64'),
          tree_cert: aL2.cert,
          ts: new Date().toISOString(),
          version: 1 as const,
        }
        const handshakeSig = signParleyHandshake(handshakeInner, await idA.getL1PrivateKey())
        const envelope = {
          channel_id,
          delivery_id,
          disclosure_intent: protocol,
          handshake: {...handshakeInner, signature: handshakeSig},
          prompt,
          protocol,
          request_auth: {...reqAuthPayload, signature: reqAuthSig},
          turn_id,
          version: 1 as const,
        }

        const addrB = hostB.getMultiaddrs()[0]
        const lp = await import('it-length-prefixed')
        const envelopeBytes = new TextEncoder().encode(JSON.stringify(envelope))
        const framedEnvelope = await encodeLengthPrefixed(envelopeBytes, lp)

        const parsedFrames = (await hostA.dialAndSendAndConsume(
          addrB,
          PARLEY_QUERY_PROTOCOL,
          framedEnvelope,
          async (source) => {
            const out: Array<{kind: string; seq: number}> = []
            for await (const msg of lp.decode(source as AsyncIterable<Uint8Array>)) {
              const bytes = msg.subarray() as Uint8Array
              const json = new TextDecoder('utf8').decode(bytes)
              const f = JSON.parse(json) as {kind: string; seq: number}
              out.push(f)
              if (f.kind === 'transcript_seal') break
            }

            return out
          },
        )) as Array<{kind: string; seq: number}>

        // Frame kind audit:
        //   - At least one heartbeat_ping during the 300ms idle gap.
        //   - Exactly one agent_message_chunk (yielded after the sleep).
        //   - Exactly one stream_end, exactly one transcript_seal.
        //   - The seal is the LAST frame; the frame IMMEDIATELY before
        //     the seal MUST be stream_end (never a heartbeat) so
        //     parley-client.ts's `frames[sealIdx - 1]` picks the terminal.
        const heartbeats = parsedFrames.filter((f) => f.kind === 'heartbeat_ping')
        const chunks = parsedFrames.filter((f) => f.kind === 'agent_message_chunk')
        const ends = parsedFrames.filter((f) => f.kind === 'stream_end')
        const seals = parsedFrames.filter((f) => f.kind === 'transcript_seal')

        expect(heartbeats.length, `heartbeats=${heartbeats.length}, frames=${JSON.stringify(parsedFrames.map((f) => f.kind))}`).to.be.greaterThan(0)
        expect(chunks).to.have.lengthOf(1)
        expect(ends).to.have.lengthOf(1)
        expect(seals).to.have.lengthOf(1)

        const sealIdx = parsedFrames.findIndex((f) => f.kind === 'transcript_seal')
        expect(sealIdx, 'seal is last frame').to.equal(parsedFrames.length - 1)
        expect(
          parsedFrames[sealIdx - 1].kind,
          'frame before seal MUST be stream_end (parley-client picks terminal by index, not kind-filter)',
        ).to.equal('stream_end')

        // seq monotonicity across the whole stream.
        for (const [i, frame] of parsedFrames.entries()) {
          expect(frame.seq, `seq at index ${i}`).to.equal(i + 1)
        }

        // Schema validation — heartbeat_ping must parse.
        for (const f of parsedFrames) {
          expect(ParleyResponseFrameSchema.safeParse(f).success, `frame ${JSON.stringify(f).slice(0, 80)} validates`).to.equal(true)
        }
      } finally {
        await Promise.allSettled([hostA.stop(), hostB.stop()])
      }
    }).timeout(15_000)
  })

  // ── Fix 1: early abort on heartbeat / send failure ───────────────────────
  //
  // Codex K79P0sTCkPTOaaZefPoh1 Fix 1: when a heartbeat send OR a chunk
  // sendFrame throws, requestAbortController.abort() fires BEFORE the
  // generator finishes naturally, not only in the finally block.

  describe('early abort on stream-write failure (Fix 1)', () => {
    let installDir: string

    beforeEach(async () => {
      installDir = await mkdtemp(join(tmpdir(), 'brv-parley-abort-'))
    })

    afterEach(async () => {
      await rm(installDir, {force: true, recursive: true})
    })

    // Tests the heartbeat-failure path: when a heartbeat send throws,
    // requestAbortController.abort() fires promptly. An abort-aware
    // generator can then terminate early (before its natural end).
    it('abortSignal fires promptly when heartbeat send throws — before a slow abort-aware generator completes', async () => {
      const idSvc = new InstallIdentityService({installDir})
      await idSvc.loadOrGenerate()
      const l2Svc = new PeerTreeIdentityService({install: idSvc})
      const l2 = await l2Svc.loadOrGenerate()

      const requestAbortController = new AbortController()
      let abortFiredAt: number | undefined
      requestAbortController.signal.addEventListener('abort', () => {
        abortFiredAt = Date.now()
      }, {once: true})

      // An abort-aware generator: waits NATURAL_END_MS unless abortSignal
      // fires, in which case it terminates immediately. This is the pattern
      // ClaudeCodeHeadlessAdapter uses to terminate the subprocess.
      const NATURAL_END_MS = 400
      let generatorEndedNaturally = false

      const abortAwareGen: ParleyResponseGenerator = async function* ({envelope: _env}) {
        // Yield first chunk immediately (before the heartbeat fires).
        yield {content: 'chunk-1', kind: 'agent_message_chunk' as const}
        // Wait for abortSignal OR NATURAL_END_MS — whichever comes first.
        await new Promise<void>((resolve) => {
          const t = setTimeout(() => {
            generatorEndedNaturally = true
            resolve()
          }, NATURAL_END_MS)
          requestAbortController.signal.addEventListener('abort', () => {
            clearTimeout(t)
            resolve()
          }, {once: true})
        })
        // Only yields chunk-2 if the natural timeout fired (not abort).
        if (generatorEndedNaturally) {
          yield {content: 'chunk-2', kind: 'agent_message_chunk' as const}
        }
      }

      // Fake stream: first send (chunk-1) succeeds; all subsequent sends
      // (including the heartbeat or error-terminal) throw.
      let sendCallCount = 0
      const fakeStream: Libp2pStreamLike = {
        async close() {},
        remotePeerId: 'fake-peer',
        async send(_chunk: Uint8Array) {
          sendCallCount++
          if (sendCallCount >= 2) {
            throw new Error('fake stream closed')
          }
        },
        [Symbol.asyncIterator]() {
          return (async function* (): AsyncIterable<{subarray: () => Uint8Array}> {})()[Symbol.asyncIterator]()
        },
      }

      const fakeEnvelope = {
        channel_id: 'ch-abort-test',
        delivery_id: 'del-abort',
        handshake: {
          install_cert: {cert_kind: 'install', display_handle: '@test', expires_at: new Date(Date.now() + 3_600_000).toISOString(), issued_at: new Date().toISOString(), public_key: {alg: 'ed25519', pub: 'AAAA'}, signature: 'sig'},
          nonce: 'nonce-abort',
          sender_peer_id: 'fake-peer',
          timestamp: new Date().toISOString(),
          tree_cert: undefined,
        },
        prompt: [{text: 'hello', type: 'text' as const}],
        protocol: 'query' as const,
        turn_id: 'turn-abort-test',
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      } as any

      const startMs = Date.now()

      try {
        await dispatchResponseStream({
          envelope: fakeEnvelope,
          generator: abortAwareGen,
          // Short heartbeat so it fires while the generator is in its wait.
          // chunk-1 emits first (send #1 succeeds). The heartbeat fires during
          // the generator's wait, triggers send #2 → throws → aborts.
          heartbeatIntervalMs: 30,
          l2PrivateKey: l2.privateKey,
          requestAbortController,
          requestEnvelopeHash: 'aaaa',
          stream: fakeStream,
        })
      } catch {
        // Expected — terminal write may also fail on dead stream.
      }

      const totalMs = Date.now() - startMs

      // Abort MUST have fired (heartbeat send #2 throws → abort is called early).
      expect(abortFiredAt, 'abort must have fired').to.not.equal(undefined)

      // The total time is well below NATURAL_END_MS — abort interrupted the
      // generator before the natural 400ms timeout expired.
      expect(totalMs, `should complete before ${NATURAL_END_MS}ms natural end (took ${totalMs}ms)`).to.be.lessThan(NATURAL_END_MS - 50)

      // The generator did NOT reach its natural end because abort fired first.
      expect(generatorEndedNaturally, 'generator natural end should NOT have fired').to.equal(false)
    }).timeout(3000)
  })

  // ── §9.5.8 Fix A — diagnostic terminal-send (phase 9.5.8) ──────────────
  //
  // The success-path stream_end and the error-path error terminal sends are
  // wrapped in try/catch + diagnostic log so a torn-down dialer-side stream
  // at the terminal moment doesn't crash dispatchResponseStream.

  describe('§9.5.8 Fix A — terminal-send failure is caught, logged, and does not crash', () => {
    let installDir: string

    beforeEach(async () => {
      installDir = await mkdtemp(join(tmpdir(), 'brv-terminal-send-'))
    })

    afterEach(async () => {
      await rm(installDir, {force: true, recursive: true})
    })

    it('success-path stream_end send failure is caught and logged, dispatchResponseStream resolves without throwing', async () => {
      const idSvc = new InstallIdentityService({installDir})
      await idSvc.loadOrGenerate()
      const l2Svc = new PeerTreeIdentityService({install: idSvc})
      const l2 = await l2Svc.loadOrGenerate()

      const logs: string[] = []

      // Stream that succeeds for chunks but throws on stream_end (the terminal).
      // Send call order: 1=chunk, 2=stream_end → throw.
      let sendCallCount = 0
      const fakeStream: Libp2pStreamLike = {
        async close() {},
        remotePeerId: 'fake-peer',
        async send(_chunk: Uint8Array) {
          sendCallCount++
          if (sendCallCount >= 2) {
            throw new Error('stream torn down before terminal')
          }
        },
        [Symbol.asyncIterator]() {
          return (async function* (): AsyncIterable<{subarray: () => Uint8Array}> {})()[Symbol.asyncIterator]()
        },
      }

      const simpleGen: ParleyResponseGenerator = async function* () {
        yield {content: 'result', kind: 'agent_message_chunk' as const}
      }

      const fakeEnvelope = {
        channel_id: 'ch-terminal-test',
        delivery_id: 'del-terminal',
        handshake: {
          install_cert: {cert_kind: 'install', display_handle: '@test', expires_at: new Date(Date.now() + 3_600_000).toISOString(), issued_at: new Date().toISOString(), public_key: {alg: 'ed25519', pub: 'AAAA'}, signature: 'sig'},
          nonce: 'nonce-terminal',
          sender_peer_id: 'fake-peer',
          timestamp: new Date().toISOString(),
          tree_cert: undefined,
        },
        prompt: [{text: 'hello', type: 'text' as const}],
        protocol: 'query' as const,
        turn_id: 'turn-terminal-test',
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      } as any

      const originalWarn = console.warn
      console.warn = (msg: string) => { logs.push(msg) }
      try {
        // Must NOT throw even though stream_end send fails
        await dispatchResponseStream({
          envelope: fakeEnvelope,
          generator: simpleGen,
          heartbeatIntervalMs: 60_000,
          l2PrivateKey: l2.privateKey,
          requestEnvelopeHash: 'dddd',
          stream: fakeStream,
        })
      } finally {
        console.warn = originalWarn
      }

      // A warning log line must mention stream_end failure with channelId/turnId
      const terminalLog = logs.find((l) => l.includes('stream_end') || l.includes('terminal'))
      expect(terminalLog, 'stream_end send failure must emit a log line').to.not.equal(undefined)
      expect(terminalLog).to.include('turn-terminal-test')
      expect(terminalLog).to.include('ch-terminal-test')
    })

    it('error-path error-terminal send failure is caught and logged, dispatchResponseStream resolves without throwing', async () => {
      const idSvc = new InstallIdentityService({installDir: installDir + '-errterm'})
      await idSvc.loadOrGenerate()
      const l2Svc = new PeerTreeIdentityService({install: idSvc})
      const l2 = await l2Svc.loadOrGenerate()

      const logs: string[] = []

      // Stream that throws on the very first send (the error terminal frame).
      const fakeStream: Libp2pStreamLike = {
        async close() {},
        remotePeerId: 'fake-peer',
        async send(_chunk: Uint8Array) {
          throw new Error('stream torn down before error terminal')
        },
        [Symbol.asyncIterator]() {
          return (async function* (): AsyncIterable<{subarray: () => Uint8Array}> {})()[Symbol.asyncIterator]()
        },
      }

      const {ParleyResponseError} = await import('../../../../../../src/server/infra/channel/bridge/parley-response-generator.js')
      const throwingGen: ParleyResponseGenerator = async function* () {
        const e = new ParleyResponseError('GENERATOR_ERR_TERM', 'test error terminal')
        if (Math.random() < 0) { yield {content: '', kind: 'agent_message_chunk' as const} }
        throw e
      }

      const fakeEnvelope = {
        channel_id: 'ch-errterm-test',
        delivery_id: 'del-errterm',
        handshake: {
          install_cert: {cert_kind: 'install', display_handle: '@test', expires_at: new Date(Date.now() + 3_600_000).toISOString(), issued_at: new Date().toISOString(), public_key: {alg: 'ed25519', pub: 'AAAA'}, signature: 'sig'},
          nonce: 'nonce-errterm',
          sender_peer_id: 'fake-peer',
          timestamp: new Date().toISOString(),
          tree_cert: undefined,
        },
        prompt: [{text: 'hello', type: 'text' as const}],
        protocol: 'query' as const,
        turn_id: 'turn-errterm-test',
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      } as any

      const originalWarn = console.warn
      console.warn = (msg: string) => { logs.push(msg) }
      try {
        // Must NOT throw even though error-terminal send fails
        await dispatchResponseStream({
          envelope: fakeEnvelope,
          generator: throwingGen,
          heartbeatIntervalMs: 60_000,
          l2PrivateKey: l2.privateKey,
          requestEnvelopeHash: 'eeee',
          stream: fakeStream,
        })
      } finally {
        console.warn = originalWarn
      }

      // A warning log line must mention the error terminal failure with channelId/turnId.
      // Use [parley-server] prefix to distinguish from the generator-failed log.
      const terminalLog = logs.find((l) => l.includes('[parley-server]') && l.includes('error terminal'))
      expect(terminalLog, 'error-terminal send failure must emit a [parley-server] log line').to.not.equal(undefined)
      expect(terminalLog).to.include('turn-errterm-test')
      expect(terminalLog).to.include('ch-errterm-test')
    })
  })

  // ── §3.2 Layer B — diagnostic seal-send (phase 9.5.7) ───────────────────
  //
  // Seal sendFrame calls are wrapped in try/catch + diagnostic log so a torn-
  // down dialer-side stream doesn't crash dispatchResponseStream or leave the
  // operator without a log line to grep for the failure.

  describe('§3.2 Layer B — seal-send failure is caught, logged, and does not crash (phase 9.5.7)', () => {
    let installDir: string

    beforeEach(async () => {
      installDir = await mkdtemp(join(tmpdir(), 'brv-seal-send-'))
    })

    afterEach(async () => {
      await rm(installDir, {force: true, recursive: true})
    })

    it('success-path seal-send failure is caught and logged, dispatchResponseStream resolves without throwing', async () => {
      const idSvc = new InstallIdentityService({installDir})
      await idSvc.loadOrGenerate()
      const l2Svc = new PeerTreeIdentityService({install: idSvc})
      const l2 = await l2Svc.loadOrGenerate()

      const logs: string[] = []

      // Stream that succeeds for the chunk + stream_end, but fails on the seal.
      let sendCallCount = 0
      const fakeStream: Libp2pStreamLike = {
        async close() {},
        remotePeerId: 'fake-peer',
        async send(_chunk: Uint8Array) {
          sendCallCount++
          // Calls: 1=chunk, 2=stream_end, 3=seal → throw on seal
          if (sendCallCount >= 3) {
            throw new Error('stream torn down before seal')
          }
        },
        [Symbol.asyncIterator]() {
          return (async function* (): AsyncIterable<{subarray: () => Uint8Array}> {})()[Symbol.asyncIterator]()
        },
      }

      const simpleGen: ParleyResponseGenerator = async function* () {
        yield {content: 'result text', kind: 'agent_message_chunk' as const}
      }

      const fakeEnvelope = {
        channel_id: 'ch-seal-test',
        delivery_id: 'del-seal',
        handshake: {
          install_cert: {cert_kind: 'install', display_handle: '@test', expires_at: new Date(Date.now() + 3_600_000).toISOString(), issued_at: new Date().toISOString(), public_key: {alg: 'ed25519', pub: 'AAAA'}, signature: 'sig'},
          nonce: 'nonce-seal',
          sender_peer_id: 'fake-peer',
          timestamp: new Date().toISOString(),
          tree_cert: undefined,
        },
        prompt: [{text: 'hello', type: 'text' as const}],
        protocol: 'query' as const,
        turn_id: 'turn-seal-test',
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      } as any  // minimal stub — only fields read by dispatchResponseStream

      // Capture console.warn output as the log medium
      const originalWarn = console.warn
      console.warn = (msg: string) => { logs.push(msg) }
      try {
        // Should NOT throw even though seal-send fails
        await dispatchResponseStream({
          envelope: fakeEnvelope,
          generator: simpleGen,
          heartbeatIntervalMs: 60_000,
          l2PrivateKey: l2.privateKey,
          requestEnvelopeHash: 'bbbb',
          stream: fakeStream,
        })
      } finally {
        console.warn = originalWarn
      }

      // A warning log line must mention transcript_seal + turnId
      const sealLog = logs.find((l) => l.includes('transcript_seal') || l.includes('seal'))
      expect(sealLog, 'seal-send failure must emit a log line').to.not.equal(undefined)
      expect(sealLog).to.include('turn-seal-test')
    })

    it('error-path seal-send failure is caught and logged, dispatchResponseStream resolves without throwing', async () => {
      const idSvc = new InstallIdentityService({installDir: installDir + '-err'})
      await idSvc.loadOrGenerate()
      const l2Svc = new PeerTreeIdentityService({install: idSvc})
      const l2 = await l2Svc.loadOrGenerate()

      const logs: string[] = []

      // Stream that succeeds for the error terminal, but fails on the seal.
      let sendCallCount = 0
      const fakeStream: Libp2pStreamLike = {
        async close() {},
        remotePeerId: 'fake-peer',
        async send(_chunk: Uint8Array) {
          sendCallCount++
          // Calls: 1=error frame, 2=seal → throw on seal
          if (sendCallCount >= 2) {
            throw new Error('stream torn down before error-path seal')
          }
        },
        [Symbol.asyncIterator]() {
          return (async function* (): AsyncIterable<{subarray: () => Uint8Array}> {})()[Symbol.asyncIterator]()
        },
      }

      // Generator that throws immediately (error path).
      // The async-generator wrapper is needed to satisfy ParleyResponseGenerator's type.
      const {ParleyResponseError} = await import('../../../../../../src/server/infra/channel/bridge/parley-response-generator.js')
      const throwingGen: ParleyResponseGenerator = async function* () {
        // Throw before yielding — the generator body is entered when iterated.
        const e = new ParleyResponseError('GENERATOR_TEST_ERROR', 'test error')
        // Yield never runs; satisfies require-yield without unreachable-code.
        if (Math.random() < 0) { yield {content: '', kind: 'agent_message_chunk' as const} }
        throw e
      }

      const fakeEnvelope = {
        channel_id: 'ch-seal-err-test',
        delivery_id: 'del-seal-err',
        handshake: {
          install_cert: {cert_kind: 'install', display_handle: '@test', expires_at: new Date(Date.now() + 3_600_000).toISOString(), issued_at: new Date().toISOString(), public_key: {alg: 'ed25519', pub: 'AAAA'}, signature: 'sig'},
          nonce: 'nonce-seal-err',
          sender_peer_id: 'fake-peer',
          timestamp: new Date().toISOString(),
          tree_cert: undefined,
        },
        prompt: [{text: 'hello', type: 'text' as const}],
        protocol: 'query' as const,
        turn_id: 'turn-seal-err-test',
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      } as any

      const originalWarn = console.warn
      console.warn = (msg: string) => { logs.push(msg) }
      try {
        await dispatchResponseStream({
          envelope: fakeEnvelope,
          generator: throwingGen,
          heartbeatIntervalMs: 60_000,
          l2PrivateKey: l2.privateKey,
          requestEnvelopeHash: 'cccc',
          stream: fakeStream,
        })
      } finally {
        console.warn = originalWarn
      }

      // A warning about seal send failure must be emitted
      const sealLog = logs.find((l) => l.includes('transcript_seal') || l.includes('seal'))
      expect(sealLog, 'error-path seal-send failure must emit a log line').to.not.equal(undefined)
      expect(sealLog).to.include('turn-seal-err-test')
    })
  })
})
