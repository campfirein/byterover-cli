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
import {signResponseTerminal, signTranscriptSeal} from '../../../../../../src/agent/core/trust/sign.js'
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
})
