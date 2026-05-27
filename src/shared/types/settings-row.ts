export type SettingsRowCategory = 'concurrency' | 'language' | 'llm' | 'other' | 'task-history' | 'updates'
export type SettingsRowUnit = 'count' | 'ms'

/**
 * View-model for one settings row consumed by the TUI. Discriminated on
 * `type` so the renderer narrows before reading integer-only fields
 * (`min`, `max`, `unit`) or enum-only fields (`options`).
 *
 * Restart requirement is propagated from the descriptor verbatim (no
 * literal `true` constraint) so the dirty-banner filter on the page can
 * gate the restart warning per row.
 */
export interface SettingsRow {
  readonly category: SettingsRowCategory
  readonly current: boolean | number | string
  readonly default: boolean | number | string
  readonly description: string
  readonly displayCurrent: string
  readonly displayDefault: string
  readonly displayRange: string
  readonly key: string
  readonly label: string
  readonly max?: number
  readonly min?: number
  readonly modified: boolean
  /** Allowed values for `type === 'enum'`. Omitted otherwise. */
  readonly options?: readonly string[]
  readonly restartRequired: boolean
  readonly type: 'boolean' | 'enum' | 'integer'
  readonly unit?: SettingsRowUnit
}

export type RowParseResult =
  | {readonly displayValue: string; readonly kind: 'ok'; readonly value: number | string}
  | {readonly kind: 'error'; readonly message: string}

export const CATEGORY_ORDER: readonly SettingsRowCategory[] = [
  'concurrency',
  'llm',
  'task-history',
  'updates',
  'language',
  'other',
]

/**
 * Display label shown above each category's row group in the TUI settings
 * page and in `brv settings list` text output. Adding a new category here
 * (and a corresponding entry in `CATEGORY_ORDER`) is the only edit needed
 * for both consumers to render it — `oclif/commands/settings/index.ts`
 * and `tui/features/settings/utils/format-settings.ts` both import from
 * this module, so the surfaces never drift.
 */
export const CATEGORY_HEADERS: Readonly<Record<SettingsRowCategory, string>> = {
  concurrency: 'CONCURRENCY',
  language: 'LANGUAGE',
  llm: 'LLM',
  other: 'OTHER',
  'task-history': 'TASK HISTORY',
  updates: 'UPDATES',
}

const CATEGORY_SET: ReadonlySet<string> = new Set<string>(CATEGORY_ORDER)

/**
 * Type guard derived from `CATEGORY_ORDER` so the membership check never
 * drifts from the canonical list. Adding a new category to
 * `SettingsRowCategory` + `CATEGORY_ORDER` + `CATEGORY_HEADERS` is the
 * only edit needed — this guard picks it up automatically.
 */
export function isSettingsRowCategory(value: unknown): value is SettingsRowCategory {
  return typeof value === 'string' && CATEGORY_SET.has(value)
}

/**
 * Folds an arbitrary incoming category value into a canonical
 * `SettingsRowCategory`. Unknown / missing categories fall through to
 * `'other'` so an unexpected category emitted by the daemon still renders
 * under the OTHER header instead of getting silently dropped.
 */
export function toRowCategory(category: unknown): SettingsRowCategory {
  return isSettingsRowCategory(category) ? category : 'other'
}
