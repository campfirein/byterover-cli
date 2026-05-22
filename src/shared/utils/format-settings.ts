import type {SettingsItemDTO} from '../transport/events/settings-events.js'
import type {RowParseResult, SettingsRow, SettingsRowCategory, SettingsRowUnit} from '../types/settings-row.js'

import {CATEGORY_ORDER} from '../types/settings-row.js'
import {formatCount, formatDuration, parseDuration} from './format-duration.js'

export function buildSettingsRows(items: readonly SettingsItemDTO[]): SettingsRow[] {
  const rows: SettingsRow[] = []
  for (const item of items) {
    if (item.type === 'boolean' && typeof item.current === 'boolean' && typeof item.default === 'boolean') {
      rows.push(toBooleanRow(item, item.current, item.default))
      continue
    }

    if (isIntegerItem(item)) rows.push(toIntegerRow(item))
  }

  return rows.sort((a, b) => CATEGORY_ORDER.indexOf(a.category) - CATEGORY_ORDER.indexOf(b.category))
}

export function parseRowInput(row: SettingsRow, raw: string): RowParseResult {
  const trimmed = raw.trim()
  if (trimmed === '') return {kind: 'error', message: 'Value is required'}

  if (row.unit === 'ms') return parseAsDuration(row, raw)
  return parseAsCount(row, raw)
}

function parseAsDuration(row: SettingsRow, raw: string): RowParseResult {
  if (row.min === undefined || row.max === undefined) {
    return {kind: 'error', message: `${row.key} has no numeric range`}
  }

  const parsed = parseDuration(raw)
  if (typeof parsed === 'number') {
    if (parsed < row.min || parsed > row.max) {
      return {
        kind: 'error',
        message: `value ${formatDuration(parsed)} is outside allowed range [${formatDuration(row.min)}, ${formatDuration(row.max)}]`,
      }
    }

    return {displayValue: formatDuration(parsed), kind: 'ok', value: parsed}
  }

  return {kind: 'error', message: parsed.hint}
}

function parseAsCount(row: SettingsRow, raw: string): RowParseResult {
  if (row.min === undefined || row.max === undefined) {
    return {kind: 'error', message: `${row.key} has no numeric range`}
  }

  if (/\d+\s*(?:ms|s|m|h)/i.test(raw)) {
    return {kind: 'error', message: `${row.key} expects an integer count, got duration '${raw}'.`}
  }

  const stripped = raw.replaceAll(',', '').trim()
  if (!/^-?\d+$/.test(stripped)) {
    return {kind: 'error', message: `Expected an integer, got '${raw}'`}
  }

  const numeric = Number.parseInt(stripped, 10)
  if (!Number.isFinite(numeric)) return {kind: 'error', message: `Expected an integer, got '${raw}'`}
  if (numeric < row.min || numeric > row.max) {
    return {kind: 'error', message: `out of range: max ${row.max}`}
  }

  return {displayValue: formatCount(numeric), kind: 'ok', value: numeric}
}

type IntegerSettingsItemDTO = Omit<SettingsItemDTO, 'current' | 'default' | 'max' | 'min' | 'type'> & {
  readonly current: number
  readonly default: number
  readonly max: number
  readonly min: number
  readonly type: 'integer'
}

function isIntegerItem(item: SettingsItemDTO): item is IntegerSettingsItemDTO {
  return item.type === 'integer' && typeof item.min === 'number' && typeof item.max === 'number'
}

function toIntegerRow(item: IntegerSettingsItemDTO): SettingsRow {
  const unit: SettingsRowUnit = item.unit ?? 'count'
  const category = toRowCategory(item.category)
  const displayCurrent = unit === 'ms' ? formatDuration(item.current) : formatCount(item.current)
  const displayDefault = unit === 'ms' ? formatDuration(item.default) : formatCount(item.default)
  const displayRange = formatIntegerRange(item, unit)

  return {
    category,
    current: item.current,
    default: item.default,
    description: item.description,
    displayCurrent,
    displayDefault,
    displayRange,
    key: item.key,
    label: item.key,
    max: item.max,
    min: item.min,
    modified: item.current !== item.default,
    restartRequired: item.restartRequired,
    type: 'integer',
    unit,
  }
}

function toBooleanRow(item: SettingsItemDTO, current: boolean, defaultValue: boolean): SettingsRow {
  return {
    category: toRowCategory(item.category),
    current,
    default: defaultValue,
    description: item.description,
    displayCurrent: renderBoolean(current),
    displayDefault: renderBoolean(defaultValue),
    displayRange: '',
    key: item.key,
    label: item.key,
    modified: current !== defaultValue,
    restartRequired: item.restartRequired,
    type: 'boolean',
  }
}

function renderBoolean(value: boolean): string {
  return value ? '[ on ]' : '[ off ]'
}

function toRowCategory(category: SettingsItemDTO['category']): SettingsRowCategory {
  if (category === 'concurrency' || category === 'llm' || category === 'task-history' || category === 'updates') {
    return category
  }

  return 'other'
}

function formatIntegerRange(item: IntegerSettingsItemDTO, unit: SettingsRowUnit): string {
  const min = unit === 'ms' ? formatDuration(item.min) : formatCount(item.min)
  const max = unit === 'ms' ? formatDuration(item.max) : formatCount(item.max)
  const base = `${min}-${max}`
  if (item.key === 'llm.requestTimeoutMs') return `${base}, max loop budget`
  return base
}
