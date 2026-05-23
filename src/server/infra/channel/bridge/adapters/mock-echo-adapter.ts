import {type ParleyAdapter, type ParleyAdapterContext} from '../parley-adapter.js'
import {type ParleyResponseDataChunk} from '../parley-response-generator.js'

/**
 * Phase 9.5.2 — `MockEchoAdapter` wraps the existing `mockEchoChunks`
 * generator as a `ParleyAdapter`.
 *
 * Echoes the inbound prompt text back as a single
 * `agent_message_chunk`. Used when no real agent is configured or in
 * tests. Profile name is `'mock-echo'`.
 */
export class MockEchoAdapter implements ParleyAdapter {
  public readonly kind = 'mock' as const
  public readonly profile = 'mock-echo'

  public async *generate(args: ParleyAdapterContext): AsyncIterable<ParleyResponseDataChunk> {
    const echo = args.envelope.prompt.map((b) => b.text).join('\n')
    yield {content: echo, kind: 'agent_message_chunk'}
  }
}
