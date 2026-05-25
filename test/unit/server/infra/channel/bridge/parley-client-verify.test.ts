/* eslint-disable camelcase */
// Wire-shape field names mirror parley-types.ts on-wire JSON and are
// intentionally snake_case.

import {expect} from 'chai'
import {generateKeyPairSync} from 'node:crypto'
import {mkdtemp, rm} from 'node:fs/promises'
import {tmpdir} from 'node:os'
import {join} from 'node:path'

import {InstallIdentityService} from '../../../../../../src/agent/core/trust/install-identity-service.js'
import {PeerTreeIdentityService} from '../../../../../../src/agent/core/trust/peer-tree-identity-service.js'
import {signResponseError, signResponseTerminal, signTranscriptSeal} from '../../../../../../src/agent/core/trust/sign.js'
import {type ParleyResponseFrame, transcriptDigest} from '../../../../../../src/server/core/domain/channel/parley-types.js'
import {verifyResponseStreamForTest} from '../../../../../../src/server/infra/channel/bridge/parley-client.js'

// Phase 9.5.7 §3.2 Layer A — degraded-completion fallback tests.
//
// `verifyResponseStream` exported-for-test entry point. Tests verify:
//   - signed stream_end + chunks + no seal → sealOrigin='implicit-from-signed-terminal', integrityDegraded=true
//   - unsigned / forged stream_end → still throws TRANSCRIPT_TERMINAL_MISSING
//   - only stream_end, no chunks → still throws
//   - malformed ordering (agent_message_chunk after stream_end) → still throws

// Build a signed stream_end frame using the same payload binding as the
// existing verifyResponseTerminal path.
function buildSignedStreamEnd(args: {
  readonly channel_id: string
  readonly delivery_id: string
  readonly privateKey: import('node:crypto').KeyObject
  readonly protocol: 'delegate' | 'query'
  readonly request_envelope_hash: string
  readonly seq: number
  readonly turn_id: string
}): ParleyResponseFrame {
  const terminalPayload = {
    channel_id: args.channel_id,
    delivery_id: args.delivery_id,
    protocol: args.protocol,
    request_envelope_hash: args.request_envelope_hash,
    seq: args.seq,
    terminal_payload: {ended_state: 'completed' as const, kind: 'stream_end' as const},
    turn_id: args.turn_id,
  }
  return {
    ended_state: 'completed',
    kind: 'stream_end',
    seq: args.seq,
    signature: signResponseTerminal(terminalPayload, args.privateKey),
  }
}

function buildChunkFrame(seq: number, content: string): ParleyResponseFrame {
  return {content, kind: 'agent_message_chunk', seq}
}

// Helper: build a signed error frame using the same payload binding as
// verifyResponseError (channel_id, delivery_id, protocol, re_hash, seq, turn_id,
// terminal_payload.kind='error').
function buildSignedErrorFrame(args: {
  readonly channel_id: string
  readonly code: string
  readonly delivery_id: string
  readonly message: string
  readonly privateKey: import('node:crypto').KeyObject
  readonly protocol: 'delegate' | 'query'
  readonly request_envelope_hash: string
  readonly seq: number
  readonly turn_id: string
}): ParleyResponseFrame {
  const errorPayload = {
    channel_id: args.channel_id,
    delivery_id: args.delivery_id,
    protocol: args.protocol,
    request_envelope_hash: args.request_envelope_hash,
    seq: args.seq,
    terminal_payload: {code: args.code, kind: 'error' as const, message: args.message},
    turn_id: args.turn_id,
  }
  return {
    code: args.code,
    kind: 'error',
    message: args.message,
    seq: args.seq,
    signature: signResponseError(errorPayload, args.privateKey),
  }
}

describe('verifyResponseStreamForTest — §3.2 Layer A degraded-completion fallback (phase 9.5.7)', () => {
  let installDir: string

  beforeEach(async () => {
    installDir = await mkdtemp(join(tmpdir(), 'brv-vclient-'))
  })

  afterEach(async () => {
    await rm(installDir, {force: true, recursive: true})
  })

  // Helper: generate a real L2 key pair via PeerTreeIdentityService.
  async function makeL2Key(): Promise<{privateKey: import('node:crypto').KeyObject; publicKey: import('node:crypto').KeyObject}> {
    const idSvc = new InstallIdentityService({installDir})
    await idSvc.loadOrGenerate()
    const l2Svc = new PeerTreeIdentityService({install: idSvc})
    const l2 = await l2Svc.loadOrGenerate()
    return {privateKey: l2.privateKey, publicKey: l2.publicKey}
  }

  it('returns sealOrigin="implicit-from-signed-terminal" and integrityDegraded=true when stream_end is signed, chunks exist, no seal', async () => {
    const {privateKey, publicKey} = await makeL2Key()
    const channel_id = 'ch-degr-1'
    const delivery_id = 'del-degr-1'
    const turn_id = 'turn-degr-1'
    const request_envelope_hash = 'aaaa1111'
    const protocol = 'query' as const

    const chunk = buildChunkFrame(1, 'hello result')
    const streamEnd = buildSignedStreamEnd({
      channel_id, delivery_id, privateKey, protocol, request_envelope_hash, seq: 2, turn_id,
    })
    const frames: ParleyResponseFrame[] = [chunk, streamEnd]

    const result = await verifyResponseStreamForTest({
      expectedChannelId: channel_id,
      expectedDeliveryId: delivery_id,
      expectedReHash: request_envelope_hash,
      expectedTurnId: turn_id,
      frames,
      protocol,
      remoteL2PubKey: publicKey,
    })

    expect(result.ok).to.equal(true)
    if (!result.ok) return
    expect(result.sealOrigin).to.equal('implicit-from-signed-terminal')
    expect(result.integrityDegraded).to.equal(true)
    expect(result.content).to.equal('hello result')
  })

  // §9.5.8 Fix B — second-tier "no terminal at all" fallback.
  it('returns sealOrigin="implicit-from-stream-eof", terminalMissing=true, integrityDegraded=true when chunks exist but no stream_end AND no seal', async () => {
    const {publicKey} = await makeL2Key()
    const channel_id = 'ch-noterm-1'
    const delivery_id = 'del-noterm-1'
    const turn_id = 'turn-noterm-1'
    const request_envelope_hash = 'ffff6666'
    const protocol = 'query' as const

    // Only chunks — no stream_end, no seal
    const chunk1 = buildChunkFrame(1, 'part one ')
    const chunk2 = buildChunkFrame(2, 'part two')
    const frames: ParleyResponseFrame[] = [chunk1, chunk2]

    const result = await verifyResponseStreamForTest({
      expectedChannelId: channel_id,
      expectedDeliveryId: delivery_id,
      expectedReHash: request_envelope_hash,
      expectedTurnId: turn_id,
      frames,
      protocol,
      remoteL2PubKey: publicKey,
    })

    expect(result.ok).to.equal(true)
    if (!result.ok) return
    expect(result.sealOrigin).to.equal('implicit-from-stream-eof')
    expect((result as {terminalMissing?: boolean}).terminalMissing).to.equal(true)
    expect(result.integrityDegraded).to.equal(true)
    expect(result.content).to.equal('part one part two')
  })

  it('still uses implicit-from-signed-terminal path when chunks + stream_end exist but no seal (9.5.7 path unchanged)', async () => {
    const {privateKey, publicKey} = await makeL2Key()
    const channel_id = 'ch-sigterm-unch-1'
    const delivery_id = 'del-sigterm-unch-1'
    const turn_id = 'turn-sigterm-unch-1'
    const request_envelope_hash = 'gggg7777'
    const protocol = 'query' as const

    const chunk = buildChunkFrame(1, 'content')
    const streamEnd = buildSignedStreamEnd({
      channel_id, delivery_id, privateKey, protocol, request_envelope_hash, seq: 2, turn_id,
    })
    const frames: ParleyResponseFrame[] = [chunk, streamEnd]

    const result = await verifyResponseStreamForTest({
      expectedChannelId: channel_id,
      expectedDeliveryId: delivery_id,
      expectedReHash: request_envelope_hash,
      expectedTurnId: turn_id,
      frames,
      protocol,
      remoteL2PubKey: publicKey,
    })

    expect(result.ok).to.equal(true)
    if (!result.ok) return
    // Must still use the signed-terminal path, NOT the stream-eof path
    expect(result.sealOrigin).to.equal('implicit-from-signed-terminal')
    expect((result as {terminalMissing?: boolean}).terminalMissing).to.equal(undefined)
  })

  it('throws TRANSCRIPT_TERMINAL_MISSING when no chunks and no stream_end at all', async () => {
    const {publicKey} = await makeL2Key()
    const channel_id = 'ch-nochunk-noterm-1'
    const delivery_id = 'del-nochunk-noterm-1'
    const turn_id = 'turn-nochunk-noterm-1'
    const request_envelope_hash = 'hhhh8888'
    const protocol = 'query' as const

    // Empty frame set — no chunks, no stream_end, no seal
    const frames: ParleyResponseFrame[] = []

    let caught: unknown
    try {
      await verifyResponseStreamForTest({
        expectedChannelId: channel_id,
        expectedDeliveryId: delivery_id,
        expectedReHash: request_envelope_hash,
        expectedTurnId: turn_id,
        frames,
        protocol,
        remoteL2PubKey: publicKey,
      })
    } catch (error) {
      caught = error
    }

    expect(caught).to.be.instanceOf(Error)
    expect((caught as Error).message).to.include('TRANSCRIPT_TERMINAL_MISSING')
  })

  it('throws TRANSCRIPT_TERMINAL_MISSING when stream_end signature is forged (wrong key)', async () => {
    const {publicKey} = await makeL2Key()
    // Use a DIFFERENT key to sign — this is the forged case
    const {privateKey: forgedPriv} = generateKeyPairSync('ed25519')

    const channel_id = 'ch-forge-1'
    const delivery_id = 'del-forge-1'
    const turn_id = 'turn-forge-1'
    const request_envelope_hash = 'bbbb2222'
    const protocol = 'query' as const

    const chunk = buildChunkFrame(1, 'malicious content')
    const streamEnd = buildSignedStreamEnd({
      channel_id, delivery_id,
      privateKey: forgedPriv,  // wrong key!
      protocol, request_envelope_hash, seq: 2, turn_id,
    })
    const frames: ParleyResponseFrame[] = [chunk, streamEnd]

    let caught: unknown
    try {
      await verifyResponseStreamForTest({
        expectedChannelId: channel_id,
        expectedDeliveryId: delivery_id,
        expectedReHash: request_envelope_hash,
        expectedTurnId: turn_id,
        frames,
        protocol,
        remoteL2PubKey: publicKey,
      })
    } catch (error) {
      caught = error
    }

    expect(caught).to.be.instanceOf(Error)
    expect((caught as Error).message).to.include('TRANSCRIPT_TERMINAL_MISSING')
  })

  it('throws TRANSCRIPT_TERMINAL_MISSING when stream_end is present but no chunks exist', async () => {
    const {privateKey, publicKey} = await makeL2Key()
    const channel_id = 'ch-nochunk-1'
    const delivery_id = 'del-nochunk-1'
    const turn_id = 'turn-nochunk-1'
    const request_envelope_hash = 'cccc3333'
    const protocol = 'query' as const

    // Only stream_end, no chunks
    const streamEnd = buildSignedStreamEnd({
      channel_id, delivery_id, privateKey, protocol, request_envelope_hash, seq: 1, turn_id,
    })
    const frames: ParleyResponseFrame[] = [streamEnd]

    let caught: unknown
    try {
      await verifyResponseStreamForTest({
        expectedChannelId: channel_id,
        expectedDeliveryId: delivery_id,
        expectedReHash: request_envelope_hash,
        expectedTurnId: turn_id,
        frames,
        protocol,
        remoteL2PubKey: publicKey,
      })
    } catch (error) {
      caught = error
    }

    expect(caught).to.be.instanceOf(Error)
    expect((caught as Error).message).to.include('TRANSCRIPT_TERMINAL_MISSING')
  })

  it('throws TRANSCRIPT_TERMINAL_MISSING when agent_message_chunk appears after stream_end (malformed ordering)', async () => {
    const {privateKey, publicKey} = await makeL2Key()
    const channel_id = 'ch-malform-1'
    const delivery_id = 'del-malform-1'
    const turn_id = 'turn-malform-1'
    const request_envelope_hash = 'dddd4444'
    const protocol = 'query' as const

    const chunk1 = buildChunkFrame(1, 'part one')
    const streamEnd = buildSignedStreamEnd({
      channel_id, delivery_id, privateKey, protocol, request_envelope_hash, seq: 2, turn_id,
    })
    const chunkAfterEnd = buildChunkFrame(3, 'spurious extra chunk')
    // stream_end is NOT the last non-heartbeat frame
    const frames: ParleyResponseFrame[] = [chunk1, streamEnd, chunkAfterEnd]

    let caught: unknown
    try {
      await verifyResponseStreamForTest({
        expectedChannelId: channel_id,
        expectedDeliveryId: delivery_id,
        expectedReHash: request_envelope_hash,
        expectedTurnId: turn_id,
        frames,
        protocol,
        remoteL2PubKey: publicKey,
      })
    } catch (error) {
      caught = error
    }

    expect(caught).to.be.instanceOf(Error)
    expect((caught as Error).message).to.include('TRANSCRIPT_TERMINAL_MISSING')
  })

  it('normal path still works when explicit seal is present (sealOrigin=explicit, integrityDegraded=false)', async () => {
    const {privateKey, publicKey} = await makeL2Key()
    const channel_id = 'ch-normal-1'
    const delivery_id = 'del-normal-1'
    const turn_id = 'turn-normal-1'
    const request_envelope_hash = 'eeee5555'
    const protocol = 'query' as const

    const chunk = buildChunkFrame(1, 'final answer')
    const streamEnd = buildSignedStreamEnd({
      channel_id, delivery_id, privateKey, protocol, request_envelope_hash, seq: 2, turn_id,
    })

    // Build a real seal over the chunk + stream_end frames
    const framesForSeal: ParleyResponseFrame[] = [chunk, streamEnd]
    const digest = transcriptDigest(framesForSeal)
    const sealPayload = {
      channel_id,
      delivery_id,
      ended_state: 'completed' as const,
      protocol,
      request_envelope_hash,
      transcript_digest: digest,
      turn_id,
    }
    const seal: ParleyResponseFrame = {
      kind: 'transcript_seal',
      seq: 3,
      signature: signTranscriptSeal(sealPayload, privateKey),
      transcript_digest: digest,
    }

    const frames: ParleyResponseFrame[] = [chunk, streamEnd, seal]

    const result = await verifyResponseStreamForTest({
      expectedChannelId: channel_id,
      expectedDeliveryId: delivery_id,
      expectedReHash: request_envelope_hash,
      expectedTurnId: turn_id,
      frames,
      protocol,
      remoteL2PubKey: publicKey,
    })

    expect(result.ok).to.equal(true)
    if (!result.ok) return
    expect(result.sealOrigin).to.equal('explicit')
    expect(result.integrityDegraded).to.equal(false)
    expect(result.content).to.equal('final answer')
  })

  // ─── §9.5.8 Fix B — signed error + no seal ────────────────────────────────

  describe('§9.5.8 Fix B: signed error + no seal', () => {
    let installDir9: string

    beforeEach(async () => {
      installDir9 = await mkdtemp(join(tmpdir(), 'brv-vclient-errfix-'))
    })

    afterEach(async () => {
      await rm(installDir9, {force: true, recursive: true})
    })

    async function makeL2Key(): Promise<{privateKey: import('node:crypto').KeyObject; publicKey: import('node:crypto').KeyObject}> {
      const idSvc = new InstallIdentityService({installDir: installDir9})
      await idSvc.loadOrGenerate()
      const l2Svc = new PeerTreeIdentityService({install: idSvc})
      const l2 = await l2Svc.loadOrGenerate()
      return {privateKey: l2.privateKey, publicKey: l2.publicKey}
    }

  it('chunks + signed error + no seal → endedState=errored, errorCode populated, integrityDegraded=true, sealOrigin=implicit-from-signed-terminal', async () => {
    const {privateKey, publicKey} = await makeL2Key()
    const channel_id = 'ch-signerr-1'
    const delivery_id = 'del-signerr-1'
    const turn_id = 'turn-signerr-1'
    const request_envelope_hash = 'iiii9999'
    const protocol = 'query' as const

    const chunk = buildChunkFrame(1, 'partial work')
    const errorFrame = buildSignedErrorFrame({
      channel_id,
      code: 'AGENT_CRASH',
      delivery_id,
      message: 'agent crashed mid-turn',
      privateKey,
      protocol,
      request_envelope_hash,
      seq: 2,
      turn_id,
    })
    const frames: ParleyResponseFrame[] = [chunk, errorFrame]

    const result = await verifyResponseStreamForTest({
      expectedChannelId: channel_id,
      expectedDeliveryId: delivery_id,
      expectedReHash: request_envelope_hash,
      expectedTurnId: turn_id,
      frames,
      protocol,
      remoteL2PubKey: publicKey,
    })

    expect(result.ok).to.equal(true)
    if (!result.ok) return
    expect(result.endedState).to.equal('errored')
    expect((result as {errorCode?: string}).errorCode).to.equal('AGENT_CRASH')
    expect((result as {errorMessage?: string}).errorMessage).to.equal('agent crashed mid-turn')
    expect(result.integrityDegraded).to.equal(true)
    expect(result.sealOrigin).to.equal('implicit-from-signed-terminal')
    expect((result as {terminalMissing?: boolean}).terminalMissing).to.equal(undefined)
  })

  it('chunks + unsigned/forged error + no seal → throws TRANSCRIPT_TERMINAL_MISSING', async () => {
    const {publicKey} = await makeL2Key()
    const {privateKey: forgedPriv} = generateKeyPairSync('ed25519')
    const channel_id = 'ch-fgerr-1'
    const delivery_id = 'del-fgerr-1'
    const turn_id = 'turn-fgerr-1'
    const request_envelope_hash = 'jjjj0000'
    const protocol = 'query' as const

    const chunk = buildChunkFrame(1, 'partial work')
    const errorFrame = buildSignedErrorFrame({
      channel_id,
      code: 'AGENT_CRASH',
      delivery_id,
      message: 'forged error',
      // signed with the WRONG key — verification should fail
      privateKey: forgedPriv,
      protocol,
      request_envelope_hash,
      seq: 2,
      turn_id,
    })
    const frames: ParleyResponseFrame[] = [chunk, errorFrame]

    let caught: unknown
    try {
      await verifyResponseStreamForTest({
        expectedChannelId: channel_id,
        expectedDeliveryId: delivery_id,
        expectedReHash: request_envelope_hash,
        expectedTurnId: turn_id,
        frames,
        protocol,
        remoteL2PubKey: publicKey,
      })
    } catch (error) {
      caught = error
    }

    expect(caught).to.be.instanceOf(Error)
    expect((caught as Error).message).to.include('TRANSCRIPT_TERMINAL_MISSING')
  })

  it('chunks + no terminal at all (no error, no stream_end, no seal) → sealOrigin=implicit-from-stream-eof (existing path unchanged)', async () => {
    // This test covers the EXISTING path to confirm it still works after Fix B.
    // When NO terminal of any kind is present, it should use the stream-eof path.
    const {publicKey} = await makeL2Key()
    const channel_id = 'ch-noterm-b-1'
    const delivery_id = 'del-noterm-b-1'
    const turn_id = 'turn-noterm-b-1'
    const request_envelope_hash = 'kkkk1111'
    const protocol = 'query' as const

    const chunk1 = buildChunkFrame(1, 'chunk a ')
    const chunk2 = buildChunkFrame(2, 'chunk b')
    const frames: ParleyResponseFrame[] = [chunk1, chunk2]

    const result = await verifyResponseStreamForTest({
      expectedChannelId: channel_id,
      expectedDeliveryId: delivery_id,
      expectedReHash: request_envelope_hash,
      expectedTurnId: turn_id,
      frames,
      protocol,
      remoteL2PubKey: publicKey,
    })

    expect(result.ok).to.equal(true)
    if (!result.ok) return
    expect(result.sealOrigin).to.equal('implicit-from-stream-eof')
    expect((result as {terminalMissing?: boolean}).terminalMissing).to.equal(true)
    expect(result.endedState).to.equal('completed')
  })
  })  // end describe §9.5.8 Fix B
})
