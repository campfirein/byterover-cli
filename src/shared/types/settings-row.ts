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
