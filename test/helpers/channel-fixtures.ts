import type {ChannelMemberAcpAgent, TurnEvent} from '../../src/shared/types/channel.js'

/**
 * Shared, schema-valid fixtures for channel storage tests. Each factory returns
 * a complete, valid record so a test only spells out the fields it cares about
 * via `overrides`. Kept in `test/helpers` so transcript-store, channel-store,
 * and turn-reconstruction tests share one source of valid shapes.
 */

type MessageEventOverrides = Partial<Extract<TurnEvent, {kind: 'message'}>>
type ChunkEventOverrides = Partial<Extract<TurnEvent, {kind: 'agent_message_chunk'}>>
type ToolCallEventOverrides = Partial<Extract<TurnEvent, {kind: 'tool_call'}>>
type StateChangeEventOverrides = Partial<Extract<TurnEvent, {kind: 'turn_state_change'}>>

/** Builds a valid `message` TurnEvent. */
export const makeMessageEvent = (overrides: MessageEventOverrides = {}): TurnEvent => ({
  channelId: 'ch1',
  content: 'hi there',
  deliveryId: 'del-1',
  emittedAt: '2026-05-25T10:00:00.000Z',
  kind: 'message',
  memberHandle: '@alice',
  role: 'acp-agent',
  seq: 0,
  turnId: 't1',
  ...overrides,
})

/** Builds a valid `agent_message_chunk` TurnEvent. */
export const makeChunkEvent = (overrides: ChunkEventOverrides = {}): TurnEvent => ({
  channelId: 'ch1',
  content: 'chunk',
  deliveryId: 'del-1',
  emittedAt: '2026-05-25T10:00:02.000Z',
  kind: 'agent_message_chunk',
  memberHandle: '@alice',
  seq: 0,
  turnId: 't1',
  ...overrides,
})

/** Builds a valid `tool_call` TurnEvent. */
export const makeToolCallEvent = (overrides: ToolCallEventOverrides = {}): TurnEvent => ({
  channelId: 'ch1',
  deliveryId: 'del-1',
  emittedAt: '2026-05-25T10:00:03.000Z',
  input: {path: '/tmp/x'},
  kind: 'tool_call',
  memberHandle: '@alice',
  name: 'read_file',
  seq: 0,
  toolCallId: 'tc-1',
  turnId: 't1',
  ...overrides,
})

/** Builds a valid `turn_state_change` TurnEvent (defaults to dispatched → completed). */
export const makeStateChangeEvent = (overrides: StateChangeEventOverrides = {}): TurnEvent => ({
  channelId: 'ch1',
  deliveryId: null,
  emittedAt: '2026-05-25T10:00:05.000Z',
  from: 'dispatched',
  kind: 'turn_state_change',
  memberHandle: null,
  seq: 1,
  to: 'completed',
  turnId: 't1',
  ...overrides,
})

/** Builds a valid acp-agent ChannelMember. */
export const makeAcpMember = (overrides: Partial<ChannelMemberAcpAgent> = {}): ChannelMemberAcpAgent => ({
  agentName: 'Alice',
  capabilities: ['fs'],
  driverClass: 'A',
  handle: '@alice',
  invocation: {args: [], command: 'acp-agent', cwd: '/tmp/proj'},
  joinedAt: '2026-05-25T10:00:00.000Z',
  memberKind: 'acp-agent',
  status: 'idle',
  ...overrides,
})
