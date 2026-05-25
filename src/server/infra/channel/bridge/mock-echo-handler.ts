/* eslint-disable camelcase */
// Response-frame field names mirror IMPLEMENTATION_PHASE_9 §5.2 wire
// shape and are intentionally snake_case.

import {KeyObject} from 'node:crypto'

import {
  signResponseTerminal,
  signTranscriptSeal,
} from '../../../../agent/core/trust/sign.js'
import {
  type ParleyResponseFrame,
  transcriptDigest,
} from '../../../core/domain/channel/parley-types.js'

/**
 * Phase 9 / Slice 9.3c-iii — MockEchoHandler.
 *
 * The slice 9.3 server dispatches verified envelopes to a mock
 * handler that emits the §5.2 normative happy-path response sequence:
 *
 *   1. `agent_message_chunk` (seq 1) — echoes the prompt text.
 *   2. `stream_end` (seq 2, signed by Bob's L2 key,
 *      ended_state: 'completed').
 *   3. `transcript_seal` (seq 3) — digest covers frames 1 + 2; signed
 *      by Bob's L2 key over the request-bound seal payload.
 *
 * Slice 9.4 will replace this with the real `RemoteMemberDriver` that
 * dispatches to Bob's local ACP agent. Until then, mock-echo lets us
 * validate the wire layer end-to-end without depending on agent
 * dispatch + transcript persistence.
 */

export type MockEchoProtocol = 'delegate' | 'query'

export interface MockEchoArgs {
  readonly channel_id: string
  readonly delivery_id: string
  readonly l2PrivateKey: KeyObject
  readonly prompt: ReadonlyArray<{readonly text: string; readonly type: 'text'}>
  readonly protocol: MockEchoProtocol
  readonly request_envelope_hash: string
  readonly turn_id: string
}

export function mockEchoResponse(args: MockEchoArgs): ParleyResponseFrame[] {
  const echo = args.prompt.map((b) => b.text).join('\n')
  const chunk: ParleyResponseFrame = {
    content: echo,
    kind: 'agent_message_chunk',
    seq: 1,
  }

  const terminalPayload = {
    channel_id: args.channel_id,
    delivery_id: args.delivery_id,
    protocol: args.protocol,
    request_envelope_hash: args.request_envelope_hash,
    seq: 2,
    terminal_payload: {ended_state: 'completed' as const, kind: 'stream_end' as const},
    turn_id: args.turn_id,
  }
  const streamEnd: ParleyResponseFrame = {
    ended_state: 'completed',
    kind: 'stream_end',
    seq: 2,
    signature: signResponseTerminal(terminalPayload, args.l2PrivateKey),
  }

  const digest = transcriptDigest([chunk, streamEnd])
  const sealPayload = {
    channel_id: args.channel_id,
    delivery_id: args.delivery_id,
    ended_state: 'completed',
    protocol: args.protocol,
    request_envelope_hash: args.request_envelope_hash,
    transcript_digest: digest,
    turn_id: args.turn_id,
  }
  const seal: ParleyResponseFrame = {
    kind: 'transcript_seal',
    seq: 3,
    signature: signTranscriptSeal(sealPayload, args.l2PrivateKey),
    transcript_digest: digest,
  }

  return [chunk, streamEnd, seal]
}
