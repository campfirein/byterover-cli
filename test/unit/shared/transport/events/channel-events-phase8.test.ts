import {expect} from 'chai'

import {
  ChannelMentionRequestSchema,
  ChannelMentionSyncResponseSchema,
} from '../../../../../src/shared/transport/events/channel-events.js'

// Slice 8.0 — Phase-8 wire schema extensions (CHANNEL_PROTOCOL.md §8.4):
//   - `ChannelMentionRequest` gains optional `mode`, `suppressThoughts`,
//     `timeout` fields so agent drivers can opt into sync-mode + thought
//     suppression without breaking existing stream-mode callers.
//   - New `ChannelMentionSyncResponseSchema` describes the assembled
//     response returned by the daemon when `mode === 'sync'`.

describe('channel-events Phase 8 schemas (Slice 8.0)', () => {
describe('ChannelMentionRequestSchema (Slice 8.0 — sync mode + suppressThoughts)', () => {
  const baseValidRequest = {
    channelId: 'pi-test',
    prompt: '@kimi hi',
  }

  it('accepts the existing Phase-2 payload (back-compat)', () => {
    const parsed = ChannelMentionRequestSchema.parse(baseValidRequest)
    expect(parsed.channelId).to.equal('pi-test')
    expect(parsed.prompt).to.equal('@kimi hi')
    expect((parsed as {mode?: unknown}).mode).to.equal(undefined)
    expect((parsed as {suppressThoughts?: unknown}).suppressThoughts).to.equal(undefined)
    expect((parsed as {timeout?: unknown}).timeout).to.equal(undefined)
  })

  it('accepts mode: "sync"', () => {
    const parsed = ChannelMentionRequestSchema.parse({...baseValidRequest, mode: 'sync'})
    expect(parsed.mode).to.equal('sync')
  })

  it('accepts mode: "stream"', () => {
    const parsed = ChannelMentionRequestSchema.parse({...baseValidRequest, mode: 'stream'})
    expect(parsed.mode).to.equal('stream')
  })

  it('rejects unknown mode values', () => {
    expect(() =>
      ChannelMentionRequestSchema.parse({...baseValidRequest, mode: 'fire-and-forget'}),
    ).to.throw()
  })

  it('accepts suppressThoughts: true', () => {
    const parsed = ChannelMentionRequestSchema.parse({...baseValidRequest, suppressThoughts: true})
    expect(parsed.suppressThoughts).to.equal(true)
  })

  it('accepts suppressThoughts: false', () => {
    const parsed = ChannelMentionRequestSchema.parse({...baseValidRequest, suppressThoughts: false})
    expect(parsed.suppressThoughts).to.equal(false)
  })

  it('rejects non-boolean suppressThoughts', () => {
    expect(() =>
      ChannelMentionRequestSchema.parse({...baseValidRequest, suppressThoughts: 'yes'}),
    ).to.throw()
  })

  it('accepts a positive integer timeout (ms)', () => {
    const parsed = ChannelMentionRequestSchema.parse({...baseValidRequest, timeout: 60_000})
    expect(parsed.timeout).to.equal(60_000)
  })

  it('rejects non-positive timeouts', () => {
    expect(() =>
      ChannelMentionRequestSchema.parse({...baseValidRequest, timeout: 0}),
    ).to.throw()
    expect(() =>
      ChannelMentionRequestSchema.parse({...baseValidRequest, timeout: -1}),
    ).to.throw()
  })

  it('rejects non-integer timeouts', () => {
    expect(() =>
      ChannelMentionRequestSchema.parse({...baseValidRequest, timeout: 1.5}),
    ).to.throw()
  })

  it('does NOT add projectRoot to the wire payload (deliverable 4 — context-based)', () => {
    // The wire schema must remain projectRoot-free; project root is derived
    // from Socket.IO request context (`cwd` query) by the handler, never
    // forwarded as a request field. The MCP server's tool surface accepts
    // `projectRoot` and applies it at connection time, not as a payload key.
    const withProjectRoot = ChannelMentionRequestSchema.parse({
      ...baseValidRequest,
      projectRoot: '/tmp/should-not-stick',
    })
    expect((withProjectRoot as {projectRoot?: unknown}).projectRoot).to.equal(undefined)
  })
})

describe('ChannelMentionSyncResponseSchema (Slice 8.0)', () => {
  const validSyncResponse = {
    channelId: 'pi-test',
    durationMs: 47_312,
    endedState: 'completed' as const,
    finalAnswer: 'auth.py looks clean for token storage but vulnerable to CSRF.',
    toolCalls: [
      {callId: 'tc-1', name: 'ReadFile', status: 'completed'},
    ],
    turnId: '01HX-xyz',
  }

  it('accepts a happy-path completed turn', () => {
    const parsed = ChannelMentionSyncResponseSchema.parse(validSyncResponse)
    expect(parsed.turnId).to.equal('01HX-xyz')
    expect(parsed.finalAnswer).to.contain('CSRF')
    expect(parsed.endedState).to.equal('completed')
    expect(parsed.durationMs).to.equal(47_312)
    expect(parsed.toolCalls).to.have.lengthOf(1)
  })

  it('accepts a cancelled turn', () => {
    const parsed = ChannelMentionSyncResponseSchema.parse({
      ...validSyncResponse,
      endedState: 'cancelled',
    })
    expect(parsed.endedState).to.equal('cancelled')
  })

  it('rejects endedState: "errored" (closed enum match TurnStateSchema terminals)', () => {
    expect(() =>
      ChannelMentionSyncResponseSchema.parse({...validSyncResponse, endedState: 'errored'}),
    ).to.throw()
  })

  it('accepts an open-string tool-call status (matches Slice 4.−1 loosening)', () => {
    const parsed = ChannelMentionSyncResponseSchema.parse({
      ...validSyncResponse,
      toolCalls: [
        {callId: 'tc-1', name: 'ReadFile', status: 'pending'},
        {callId: 'tc-2', name: 'WriteFile', status: 'in_progress'},
        // status is optional — omitted entirely is also valid.
        {callId: 'tc-3', name: 'Bash'},
      ],
    })
    expect(parsed.toolCalls).to.have.lengthOf(3)
    expect(parsed.toolCalls[0]!.status).to.equal('pending')
    expect(parsed.toolCalls[2]!.status).to.equal(undefined)
  })

  it('accepts an empty toolCalls array (no tools used)', () => {
    const parsed = ChannelMentionSyncResponseSchema.parse({...validSyncResponse, toolCalls: []})
    expect(parsed.toolCalls).to.have.lengthOf(0)
  })

  it('rejects negative durationMs', () => {
    expect(() =>
      ChannelMentionSyncResponseSchema.parse({...validSyncResponse, durationMs: -1}),
    ).to.throw()
  })

  it('rejects missing finalAnswer', () => {
    const rest: Record<string, unknown> = {...validSyncResponse}
    delete rest.finalAnswer
    expect(() => ChannelMentionSyncResponseSchema.parse(rest)).to.throw()
  })
})
})
