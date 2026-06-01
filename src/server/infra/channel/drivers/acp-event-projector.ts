import type {TurnEventPayload} from '../../../core/interfaces/channel/i-agent-driver.js'

/**
 * Shape of an ACP `session/update` notification's inner `update` object: an
 * open record discriminated by its `sessionUpdate` string.
 */
type SessionUpdate = {
  [k: string]: unknown
  sessionUpdate: string
}

/** Extracts the `.text` of an ACP text content block, or `''` when absent. */
const textOf = (block: unknown): string => {
  if (typeof block === 'object' && block !== null && 'text' in block && typeof block.text === 'string') {
    return block.text
  }

  return ''
}

/**
 * Concatenates the textual parts of an ACP `content[]` array. Each entry is
 * either a `{type: 'content', content: {type: 'text', text}}` envelope or a
 * bare `{type: 'text', text}` block. Returns `undefined` when no text could be
 * extracted so the caller can fall back.
 */
const joinContentText = (content: unknown): string | undefined => {
  if (!Array.isArray(content)) return undefined
  const parts: string[] = []
  for (const entry of content) {
    if (entry === null || typeof entry !== 'object') continue
    if ('text' in entry && typeof entry.text === 'string') {
      parts.push(entry.text)
      continue
    }

    if ('content' in entry) {
      const inner = textOf(entry.content)
      if (inner !== '') parts.push(inner)
    }
  }

  if (parts.length === 0) return undefined
  return parts.join('')
}

/** Narrows arbitrary notification params to a {@link SessionUpdate}, or `undefined`. */
const asSessionUpdate = (value: unknown): SessionUpdate | undefined => {
  if (
    typeof value === 'object' &&
    value !== null &&
    'sessionUpdate' in value &&
    typeof value.sessionUpdate === 'string'
  ) {
    return value as SessionUpdate
  }

  return undefined
}

/**
 * Projects an ACP `session/update` payload into a payload-only
 * {@link TurnEventPayload} — the only place ACP vocabulary touches the domain.
 *
 * Total and defensive: accepts `unknown` and returns `undefined` for malformed
 * input (non-object, or missing/invalid `sessionUpdate`) rather than throwing.
 * Maps the kinds the `TurnEvent` union models — `agent_message_chunk`,
 * `agent_thought_chunk`, `tool_call`, `tool_call_update`. Every other kind
 * (`plan`, the `current_*_update` agent-meta family, or any unknown/future
 * kind) returns `undefined` and the caller drops it — an unrecognised shape
 * MUST NOT crash the driver.
 */
export const projectSessionUpdate = (input: unknown): TurnEventPayload | undefined => {
  const update = asSessionUpdate(input)
  if (update === undefined) return undefined
  switch (update.sessionUpdate) {
    case 'agent_message_chunk': {
      return {content: textOf(update.content), kind: 'agent_message_chunk'}
    }

    case 'agent_thought_chunk': {
      return {content: textOf(update.content), kind: 'agent_thought_chunk'}
    }

    case 'tool_call': {
      const name = typeof update.title === 'string' ? update.title : ''
      // When an agent omits `rawInput` but supplies `content[]`, surface the
      // joined text as `input` so renderers have something to display.
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
      const result: Extract<TurnEventPayload, {kind: 'tool_call_update'}> = {
        kind: 'tool_call_update',
        toolCallId: String(update.toolCallId ?? ''),
      }
      // `status` is any agent-emitted progress string (real agents vary).
      if (typeof update.status === 'string') result.status = update.status
      // Prefer structured `rawOutput`; fall back to joined `content[]` text.
      if (update.rawOutput === undefined) {
        const flattened = joinContentText(update.content)
        if (flattened !== undefined) result.output = flattened
      } else {
        result.output = update.rawOutput
      }

      if (typeof update.error === 'string') result.error = update.error
      return result
    }

    default: {
      return undefined
    }
  }
}
