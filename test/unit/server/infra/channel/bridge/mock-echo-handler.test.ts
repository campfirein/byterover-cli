/* eslint-disable camelcase */
import {expect} from 'chai'
import {generateKeyPairSync} from 'node:crypto'

import {verifyResponseTerminal, verifyTranscriptSeal} from '../../../../../../src/agent/core/trust/sign.js'
import {transcriptDigest} from '../../../../../../src/server/core/domain/channel/parley-types.js'
import {mockEchoResponse} from '../../../../../../src/server/infra/channel/bridge/mock-echo-handler.js'

describe('mockEchoResponse (Slice 9.3c-iii)', () => {
  const keypair = generateKeyPairSync('ed25519')
  const buildArgs = () => ({
    channel_id: 'review-2026',
    delivery_id: 'd-001',
    l2PrivateKey: keypair.privateKey,
    prompt: [{text: 'hello bob', type: 'text' as const}],
    protocol: 'query' as const,
    request_envelope_hash: 'a'.repeat(64),
    turn_id: 't-001',
  })

  it('emits exactly THREE frames: agent_message_chunk → stream_end → transcript_seal', () => {
    const frames = mockEchoResponse(buildArgs())
    expect(frames.map((f) => f.kind)).to.deep.equal([
      'agent_message_chunk',
      'stream_end',
      'transcript_seal',
    ])
  })

  it('echoes the prompt text in the agent_message_chunk frame', () => {
    const frames = mockEchoResponse(buildArgs())
    const chunk = frames[0] as {content: string; kind: string}
    expect(chunk.kind).to.equal('agent_message_chunk')
    expect(chunk.content).to.equal('hello bob')
  })

  it('assigns strictly-increasing seq values starting at 1', () => {
    const frames = mockEchoResponse(buildArgs())
    expect(frames.map((f) => (f as {seq: number}).seq)).to.deep.equal([1, 2, 3])
  })

  it('signs the stream_end terminal frame with the L2 key over the full request-bound payload', () => {
    const args = buildArgs()
    const frames = mockEchoResponse(args)
    const streamEnd = frames[1] as {
      ended_state: 'completed'
      kind: 'stream_end'
      seq: number
      signature: string
    }
    expect(streamEnd.kind).to.equal('stream_end')
    expect(streamEnd.ended_state).to.equal('completed')

    const expectedPayload = {
      channel_id: args.channel_id,
      delivery_id: args.delivery_id,
      protocol: args.protocol,
      request_envelope_hash: args.request_envelope_hash,
      seq: 2,
      terminal_payload: {ended_state: 'completed', kind: 'stream_end'},
      turn_id: args.turn_id,
    }
    expect(verifyResponseTerminal(expectedPayload, streamEnd.signature, keypair.publicKey)).to.equal(true)
  })

  it('signs the transcript_seal over the digest of the chunk+terminal (NOT including the seal itself)', () => {
    const args = buildArgs()
    const frames = mockEchoResponse(args)
    const seal = frames[2] as {
      kind: 'transcript_seal'
      signature: string
      transcript_digest: string
    }
    expect(seal.kind).to.equal('transcript_seal')

    // The digest is computed over the FIRST TWO frames (chunk + signed
    // stream_end). The seal itself is not in the digest.
    const expectedDigest = transcriptDigest([frames[0], frames[1]])
    expect(seal.transcript_digest).to.equal(expectedDigest)

    const expectedSealPayload = {
      channel_id: args.channel_id,
      delivery_id: args.delivery_id,
      ended_state: 'completed',
      protocol: args.protocol,
      request_envelope_hash: args.request_envelope_hash,
      transcript_digest: expectedDigest,
      turn_id: args.turn_id,
    }
    expect(verifyTranscriptSeal(expectedSealPayload, seal.signature, keypair.publicKey)).to.equal(true)
  })

  it('concatenates multi-block prompts with a single newline between text blocks', () => {
    const frames = mockEchoResponse({
      ...buildArgs(),
      prompt: [
        {text: 'line one', type: 'text'},
        {text: 'line two', type: 'text'},
      ],
    })
    const chunk = frames[0] as {content: string}
    expect(chunk.content).to.equal('line one\nline two')
  })

  it('produces frames that round-trip through ParleyResponseFrameSchema', async () => {
    const frames = mockEchoResponse(buildArgs())
    const {ParleyResponseFrameSchema} = await import('../../../../../../src/server/core/domain/channel/parley-types.js')
    for (const frame of frames) {
      const r = ParleyResponseFrameSchema.safeParse(frame)
      expect(r.success, JSON.stringify({error: r.success ? null : r.error, frame})).to.equal(true)
    }
  })
})
