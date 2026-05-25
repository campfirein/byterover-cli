/**
 * Pure-utility module shared between the oclif `brv settings` commands and
 * the TUI `/settings` page. Renders millisecond durations and integer counts
 * in human form, and parses human-formatted durations back to ms.
 *
 * The module has no daemon, React, or oclif imports; it loads cleanly from
 * any surface.
 */

const MS_PER_SECOND = 1000
const MS_PER_MINUTE = 60 * MS_PER_SECOND
const MS_PER_HOUR = 60 * MS_PER_MINUTE

const UNIT_MS: Record<string, number> = {
  h: MS_PER_HOUR,
  m: MS_PER_MINUTE,
  ms: 1,
  s: MS_PER_SECOND,
}

/**
 * Tagged error union returned by `parseDuration` on failure. Consumers
 * branch on `typeof result === 'number'` for the success path; on the
 * failure path `kind` distinguishes the four error categories and `hint`
 * carries a human-readable suggestion suitable for surfacing verbatim.
 */
export type DurationParseError = {
  readonly hint: string
  readonly input: string
  readonly kind: 'empty' | 'fraction' | 'malformed' | 'unknown-unit'
}

/**
 * Converts a positive ms value to a short human duration string. Multi-part
 * outputs join the largest units first (`5_400_000 -> "1h 30m"`). A zero
 * value collapses to `"0s"` rather than an empty string.
 */
export function formatDuration(ms: number): string {
  if (ms === 0) return '0s'

  const hours = Math.floor(ms / MS_PER_HOUR)
  const remainderAfterHours = ms - hours * MS_PER_HOUR
  const minutes = Math.floor(remainderAfterHours / MS_PER_MINUTE)
  const remainderAfterMinutes = remainderAfterHours - minutes * MS_PER_MINUTE
  const seconds = Math.floor(remainderAfterMinutes / MS_PER_SECOND)

  const parts: string[] = []
  if (hours > 0) parts.push(`${hours}h`)
  if (minutes > 0) parts.push(`${minutes}m`)
  if (seconds > 0) parts.push(`${seconds}s`)

  return parts.join(' ')
}

/**
 * Thousands-separated integer for count values (e.g. `taskHistory.maxEntries`).
 * Uses `en-US` locale baseline; matches existing CLI text-output conventions.
 */
export function formatCount(n: number): string {
  return n.toLocaleString('en-US')
}

/**
 * Parses a human-formatted duration string back to ms. Accepts:
 *
 *   - Single-unit parts: `30m`, `1h`, `45s`, `30000ms` (case-insensitive)
 *   - Multi-part: `1h 30m`, `1h30m` (whitespace optional between parts)
 *   - Bare integer (no unit): treated as ms for back-compat with the
 *     pre-format CLI that only accepted raw integers
 *
 * Rejects fractional values (`1.5h`) with a hint suggesting integer
 * minutes, unknown units (`10x`) with a hint listing accepted units,
 * empty input, and malformed input that does not match the grammar.
 */
export function parseDuration(input: string): DurationParseError | number {
  const trimmed = input.trim()
  if (trimmed === '') {
    return {hint: 'expected a duration like "30m" or "1h 30m", or a raw ms integer.', input, kind: 'empty'}
  }

  if (/^\d+$/.test(trimmed)) {
    return Number.parseInt(trimmed, 10)
  }

  if (/\./.test(trimmed)) {
    return {
      hint: 'fractional durations are not supported; use integer parts (e.g. "90m" instead of "1.5h").',
      input,
      kind: 'fraction',
    }
  }

  const lowered = trimmed.toLowerCase()
  const partPattern = /(\d+)(ms|s|m|h)/g
  let consumed = ''
  let totalMs = 0
  let match: null | RegExpExecArray
  partPattern.lastIndex = 0
  while ((match = partPattern.exec(lowered)) !== null) {
    consumed += match[0]
    const value = Number.parseInt(match[1], 10)
    const unit = match[2]
    totalMs += value * UNIT_MS[unit]
  }

  const collapsed = lowered.replaceAll(/\s+/g, '')
  if (consumed === '' || consumed !== collapsed) {
    if (/\d+\s*[a-z]+/i.test(lowered)) {
      const unknownUnitMatch = lowered.match(/\d+\s*([a-z]+)/i)
      if (unknownUnitMatch !== null && unknownUnitMatch[1] !== undefined) {
        const unit = unknownUnitMatch[1]
        if (!(unit in UNIT_MS)) {
          return {
            hint: 'invalid duration: try 30m, 1h, 1h 30m, or a raw ms integer.',
            input,
            kind: 'unknown-unit',
          }
        }
      }
    }

    return {
      hint: 'expected a duration like "30m", "1h 30m", "45s", or a raw ms integer.',
      input,
      kind: 'malformed',
    }
  }

  return totalMs
}
