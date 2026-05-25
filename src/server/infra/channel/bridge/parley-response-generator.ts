import {type ParleyQueryEnvelope} from '../../../core/domain/channel/parley-types.js'

/**
 * Phase 9 / Slice 9.4c — structured error for parley response
 * generators (kimi round-1 MEDIUM — was string-prefix code parsing).
 *
 * Generators throw `ParleyResponseError` so the parley-server can
 * extract a stable `code` field for the signed `error` terminal frame
 * without parsing message strings. Untyped throws fall back to a
 * generic `GENERATOR_ERROR` code.
 *
 * The `code` is what the remote dialer sees on the wire. The
 * `message` is also signed + transmitted — call sites should make it
 * safe to expose (no stack traces, no internal paths). The server
 * sanitises untyped errors to avoid leaking subprocess details.
 */
export class ParleyResponseError extends Error {
  public readonly code: string

  public constructor(code: string, message: string) {
    super(message)
    this.name = 'ParleyResponseError'
    this.code = code
  }
}

/**
 * Phase 9 / Slice 9.4c — pluggable response-data generator for the
 * Parley server.
 *
 * The server is responsible for the WIRE LAYER of a response stream:
 *   - assigning strictly-increasing `seq` to every frame
 *   - signing the terminal `stream_end` / `error` frame with the L2
 *     key
 *   - computing + signing the `transcript_seal`
 *
 * The dispatcher is responsible for the SEMANTIC CONTENT of the
 * response: text chunks (and, in later slices, thoughts / tool calls /
 * permission requests). It exposes that content as an async iterator
 * of `ParleyResponseDataChunk` values. The server consumes the
 * iterator, projects each chunk into the matching response frame, and
 * appends the signed terminal+seal once the iterator returns or
 * throws.
 *
 * Slice 9.4c ships two dispatchers:
 *   - `mockEchoChunks` — echoes the prompt text as a single
 *     `agent_message_chunk`. Used when no real agent is configured.
 *   - `LocalAgentResponseGenerator` — spawns / reuses an ACP driver
 *     via a configured driver-profile and projects its
 *     `TurnEventPayload` stream into Parley chunks. Used when the
 *     daemon's `BRV_BRIDGE_PARLEY_PROFILE` env is set.
 *
 * Cancel / permission propagation across the bridge is deferred to
 * slice 9.9 (the dispatcher MUST throw an `Error` to surface a
 * mid-stream failure; the server will project it as a signed
 * `error` terminal frame).
 */

export interface ParleyResponseDataChunk {
  readonly content: string
  readonly kind: 'agent_message_chunk' | 'agent_thought_chunk'
}

export type ParleyResponseGenerator = (args: {
  readonly envelope: ParleyQueryEnvelope
}) => AsyncIterable<ParleyResponseDataChunk>

/**
 * Default dispatcher. Echoes the inbound prompt text back as a single
 * `agent_message_chunk`. Mirrors the slice-9.3 mock-echo behaviour
 * but in the new generator shape.
 *
 * @yields one `agent_message_chunk` carrying the concatenated prompt
 *   text.
 */
export const mockEchoChunks: ParleyResponseGenerator = async function* (args) {
  const echo = args.envelope.prompt.map((b) => b.text).join('\n')
  yield {content: echo, kind: 'agent_message_chunk'}
}
