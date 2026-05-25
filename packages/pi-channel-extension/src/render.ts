import {ChannelClient, type TurnEvent} from '@brv/channel-client'

import type {PiCommandContext} from './pi-api.js'

// Subscribe to a turn and project each `channel:turn-event` into
// `ctx.ui.notify(...)`. Pi's UI has no streaming primitive, so we batch
// `agent_message_chunk` events into a single notification when the
// turn ends (or every N chunks, configurable).
//
// Returns the terminal turn_state_change.to value ('completed' or
// 'cancelled') so the caller can render an end-of-turn line.

export type RenderTurnOptions = {
  readonly channelId: string
  readonly turnId: string
  readonly memberHandle?: string
  readonly client: ChannelClient
  readonly ctx: PiCommandContext
}

export const renderTurn = async ({
  channelId,
  client,
  ctx,
  memberHandle,
  turnId,
}: RenderTurnOptions): Promise<'completed' | 'cancelled' | 'unknown'> => {
  let terminal: 'completed' | 'cancelled' | 'unknown' = 'unknown'
  const transcripts: Map<string, string[]> = new Map()

  const flush = (member: string): void => {
    const chunks = transcripts.get(member)
    if (chunks === undefined || chunks.length === 0) return
    ctx.ui.notify(`[${member}] ${chunks.join('')}`)
    transcripts.set(member, [])
  }

  for await (const event of client.subscribeTurn(channelId, turnId)) {
    const kind = String(event.kind ?? '')
    const member = String(event.memberHandle ?? memberHandle ?? '?')
    switch (kind) {
      case 'agent_message_chunk': {
        const content = String((event as TurnEvent & {content?: unknown}).content ?? '')
        if (content === '') break
        const buffer = transcripts.get(member) ?? []
        buffer.push(content)
        transcripts.set(member, buffer)
        break
      }

      case 'tool_call': {
        flush(member)
        const name = String((event as TurnEvent & {name?: unknown}).name ?? 'tool')
        ctx.ui.notify(`[${member}] ↳ ${name}`)
        break
      }

      case 'tool_call_update': {
        flush(member)
        const name = String((event as TurnEvent & {name?: unknown}).name ?? 'tool')
        const status = String((event as TurnEvent & {status?: unknown}).status ?? '')
        ctx.ui.notify(`[${member}] ↳ ${name} ${status}`)
        break
      }

      case 'permission_request': {
        flush(member)
        const permissionId = String(
          (event as TurnEvent & {permissionId?: unknown}).permissionId ?? '?',
        )
        ctx.ui.notify(
          `[${member}] needs approval (permissionId=${permissionId}). ` +
            `Run \`/channel approve ${channelId} ${turnId} ${permissionId}\` or \`/channel deny ...\`.`,
          'warning',
        )
        break
      }

      case 'turn_state_change': {
        flush(member)
        const to = String((event as TurnEvent & {to?: unknown}).to ?? '')
        if (to === 'completed' || to === 'cancelled') {
          terminal = to
        }

        ctx.ui.notify(`turn ${turnId} ${to}`)
        break
      }

      default: {
        // unknown event kinds: stay silent rather than leak noisy lines.
        break
      }
    }
  }

  // Drain any chunks that arrived after the last flush-trigger.
  for (const member of transcripts.keys()) flush(member)
  return terminal
}
