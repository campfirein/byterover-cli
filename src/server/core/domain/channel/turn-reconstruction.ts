import type {Turn, TurnAuthor, TurnEvent} from '../../../../shared/types/channel.js'

import {TURN_TERMINAL_STATES} from './turn-state-machine.js'

/** Arguments for reconstructing a {@link Turn} from its persisted event log. */
export type ReconstructTurnArgs = {
  readonly channelId: string
  /** The turn's events, as read back from the transcript (any order). */
  readonly events: readonly TurnEvent[]
  readonly turnId: string
}

/**
 * Author used when an event log carries no explicit author. The transcript
 * records member-scoped events, not a turn header, so a replayed turn attributes
 * itself to the local user rather than inventing a richer identity.
 */
const FALLBACK_AUTHOR: TurnAuthor = {handle: 'you', kind: 'local-user'}

/**
 * Rebuilds a {@link Turn} projection from its append-only event log. Pure and
 * side-effect-free: the transcript is the source of truth, so callers reading a
 * turn's history project it here rather than persisting a separate turn header.
 *
 * The prompt comes from the first `message` event; the state from the last
 * `turn_state_change`; `endedAt` is populated only once the turn reaches a
 * terminal state. Tolerates an empty log so a freshly-created turn still
 * reconstructs.
 */
export const reconstructTurnFromEvents = (args: ReconstructTurnArgs): Turn => {
  const {channelId, events, turnId} = args

  const firstMessage = events.find(
    (event): event is Extract<TurnEvent, {kind: 'message'}> => event.kind === 'message',
  )
  const lastStateChange = [...events]
    .reverse()
    .find(
      (event): event is Extract<TurnEvent, {kind: 'turn_state_change'}> =>
        event.kind === 'turn_state_change',
    )

  const startedAt = events[0]?.emittedAt ?? new Date(0).toISOString()
  const state = lastStateChange?.to ?? 'pending'
  const endedAt = TURN_TERMINAL_STATES.includes(state) ? lastStateChange?.emittedAt : undefined
  const promptBlocks = firstMessage === undefined ? [] : [{text: firstMessage.content, type: 'text' as const}]

  return {
    author: FALLBACK_AUTHOR,
    channelId,
    mentions: [],
    promptBlocks,
    promptedBy: 'user',
    startedAt,
    state,
    turnId,
    ...(endedAt === undefined ? {} : {endedAt}),
  }
}
