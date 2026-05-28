import {CATEGORY_ORDER, type SettingsRow, type SettingsRowCategory} from '../../../../shared/types/settings-row.js'
import {formatDuration} from '../../../../shared/utils/format-duration.js'

const CATEGORY_HEADERS: Readonly<Record<SettingsRowCategory, string>> = {
  concurrency: 'CONCURRENCY',
  llm: 'LLM',
  other: 'OTHER',
  'task-history': 'TASK HISTORY',
  updates: 'UPDATES',
}

export function groupRowsByCategory(rows: readonly SettingsRow[]): ReadonlyArray<{
  readonly category: SettingsRowCategory
  readonly header: string
  readonly rows: readonly SettingsRow[]
}> {
  const buckets = new Map<SettingsRowCategory, SettingsRow[]>()
  for (const row of rows) {
    const list = buckets.get(row.category) ?? []
    list.push(row)
    buckets.set(row.category, list)
  }

  const result: Array<{category: SettingsRowCategory; header: string; rows: readonly SettingsRow[]}> = []
  for (const category of CATEGORY_ORDER) {
    const bucket = buckets.get(category)
    if (bucket && bucket.length > 0) {
      result.push({category, header: CATEGORY_HEADERS[category], rows: bucket})
    }
  }

  return result
}

export function bottomHintFor(mode: 'browse' | 'edit' | 'edit-error' | 'saving', focusedKey?: string): string {
  switch (mode) {
    case 'browse': {
      return 'Up/Down move | Enter edit | R reset | Esc exit'
    }

    case 'edit': {
      return `Editing ${focusedKey ?? ''} | Enter save | Esc cancel`
    }

    case 'edit-error': {
      return `Editing ${focusedKey ?? ''} | Enter save (when valid) | Esc cancel`
    }

    case 'saving': {
      return 'Saving... | Esc to exit (mutation resolves in background)'
    }
  }
}

export function preFillBufferFor(row: SettingsRow): string {
  // preFillBufferFor only runs when entering integer text-input mode.
  // Boolean rows take the toggle path in the page and never reach here;
  // guard the narrowing so the function still compiles under the wider
  // SettingsRow union.
  if (typeof row.current !== 'number') return String(row.current)
  if (row.unit === 'ms') return formatDuration(row.current)
  return String(row.current)
}

export function validateSettingInput(raw: string, descriptor: {max: number; min: number}): string | undefined {
  const trimmed = raw.trim()
  if (trimmed.length === 0) return 'Value is required'

  const numeric = Number(trimmed)
  if (!Number.isFinite(numeric)) return `Expected an integer, got '${raw}'`
  if (!Number.isInteger(numeric)) return `Expected an integer, got ${numeric}`
  if (numeric < descriptor.min || numeric > descriptor.max) {
    return `Value ${numeric} is outside allowed range [${descriptor.min}, ${descriptor.max}]`
  }

  return undefined
}
