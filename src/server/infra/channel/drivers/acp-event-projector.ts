import type {TurnEventPayload} from '../../../core/interfaces/channel/i-acp-driver.js'

/**
 * Project an ACP `session/update` notification payload into a payload-only
 * {@link TurnEventPayload} (CHANNEL_PROTOCOL.md §7.1).
 *
 * Returns `undefined` for unrecognised `sessionUpdate` kinds; the caller
 * WARN-logs and drops. Unknown future kinds MUST NOT crash the driver
 * (§13.2 client requirements).
 */
type SessionUpdate = {
  [k: string]: unknown
  sessionUpdate: string
}

const textOf = (block: unknown): string => {
  if (typeof block === 'object' && block !== null && 'text' in block) {
    const t = (block as {text?: unknown}).text
    if (typeof t === 'string') return t
  }

  return ''
}

/**
 * Slice 4.3 — kimi (and other real ACP agents) send `content[]` arrays on
 * `tool_call` / `tool_call_update` notifications. Each entry is either a
 * `{type: 'content', content: {type: 'text', text: '...'}}` envelope OR a
 * bare `{type: 'text', text: '...'}` block. Concatenate the textual parts
 * so renderers see a useful string instead of dropping the payload.
 * Returns `undefined` when no text could be extracted (caller falls back).
 */
const joinContentText = (content: unknown): string | undefined => {
  if (!Array.isArray(content)) return undefined
  const parts: string[] = []
  for (const entry of content) {
    if (entry === null || typeof entry !== 'object') continue
    const obj = entry as {content?: unknown; text?: unknown; type?: unknown}
    if (typeof obj.text === 'string') {
      parts.push(obj.text)
      continue
    }

    const inner = textOf(obj.content)
    if (inner !== '') parts.push(inner)
  }

  if (parts.length === 0) return undefined
  return parts.join('')
}

/** Build an `agent_meta` payload by copying everything except `sessionUpdate`. */
const agentMetaPayload = (update: SessionUpdate): Record<string, unknown> => {
  const out: Record<string, unknown> = {}
  for (const [k, v] of Object.entries(update)) {
    if (k === 'sessionUpdate') continue
    out[k] = v
  }

  return out
}

export const projectSessionUpdate = (update: SessionUpdate): TurnEventPayload | undefined => {
  switch (update.sessionUpdate) {
    case 'agent_message_chunk': {
      return {content: textOf(update.content), kind: 'agent_message_chunk'}
    }

    case 'agent_thought_chunk': {
      return {content: textOf(update.content), kind: 'agent_thought_chunk'}
    }

    // Slice 4.3: forward-compat projections — real kimi emits these and
    // dropping them silently pollutes the daemon log. Project to the
    // payload-only `agent_meta` variant (spec-blessed by Slice 4.−1).
    case 'available_commands_update':
    // falls through
    case 'current_mode_update':
    // falls through
    case 'current_model_update': {
      return {
        kind: 'agent_meta',
        payload: agentMetaPayload(update),
        subKind: update.sessionUpdate,
      }
    }

    case 'plan': {
      const entries = Array.isArray(update.entries) ? (update.entries as unknown[]) : []
      return {entries, kind: 'plan'}
    }

    case 'tool_call': {
      const name = typeof update.title === 'string' ? update.title : ''
      // Slice 4.3: when an agent omits `rawInput` but supplies `content[]`,
      // surface the joined text as the `input` so the renderer has
      // *something* to display. (The `tool_call` schema variant has no
      // `output` field — `output` lives on `tool_call_update`.)
      const synthesisedInput =
        update.rawInput === undefined ? joinContentText(update.content) : undefined
      return {
        input: update.rawInput ?? synthesisedInput,
        kind: 'tool_call',
        name,
        toolCallId: String(update.toolCallId ?? ''),
      }
    }

    case 'tool_call_update': {
      const out: TurnEventPayload = {
        kind: 'tool_call_update',
        toolCallId: String(update.toolCallId ?? ''),
      }
      // Slice 4.3: status is now any agent-emitted string (the Phase-3
      // closed enum was too narrow — real kimi emits e.g. 'pending').
      if (typeof update.status === 'string') {
        ;(out as {status?: string}).status = update.status
      }

      if (update.rawOutput === undefined) {
        const flattened = joinContentText(update.content)
        if (flattened !== undefined) {
          ;(out as {output?: unknown}).output = flattened
        }
      } else {
        ;(out as {output?: unknown}).output = update.rawOutput
      }

      if (typeof update.error === 'string') {
        ;(out as {error?: string}).error = update.error
      }

      return out
    }

    default: {
      return undefined
    }
  }
}
