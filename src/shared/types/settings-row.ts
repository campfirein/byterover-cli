export type SettingsRowCategory = 'analytics' | 'concurrency' | 'llm' | 'other' | 'task-history' | 'updates'
export type SettingsRowUnit = 'count' | 'ms'

/**
 * View-model for one settings row consumed by the TUI. Discriminated on
 * `type` so the renderer narrows before reading integer-only fields
 * (`min`, `max`, `unit`) or treating `current` / `default` as numeric.
 *
 * Restart requirement is propagated from the descriptor verbatim (no
 * literal `true` constraint) so the dirty-banner filter on the page can
 * gate the restart warning per row.
 *
 * Readonly-info rows carry no `default` / `displayDefault`. The
 * renderer must omit the `(default ...)` cell for them and skip
 * edit / toggle / reset keybinds.
 */
export interface SettingsRow {
  readonly category: SettingsRowCategory
  readonly current: boolean | number | Readonly<Record<string, unknown>> | undefined
  readonly default?: boolean | number
  readonly description: string
  readonly displayCurrent: string
  readonly displayDefault?: string
  /**
   * Full multi-line value for readonly-info rows (e.g. `analytics.status`),
   * shown in the TUI detail panel on Enter. `displayCurrent` is only its
   * headline so the list row stays single-line. Undefined for editable rows.
   */
  readonly displayDetail?: string
  readonly displayRange: string
  readonly key: string
  readonly label: string
  readonly max?: number
  readonly min?: number
  readonly modified: boolean
  readonly restartRequired: boolean
  readonly type: 'boolean' | 'integer' | 'readonly-info'
  readonly unit?: SettingsRowUnit
}

export type RowParseResult =
  | {readonly displayValue: string; readonly kind: 'ok'; readonly value: number}
  | {readonly kind: 'error'; readonly message: string}

export const CATEGORY_ORDER: readonly SettingsRowCategory[] = [
  'concurrency',
  'llm',
  'task-history',
  'updates',
  'analytics',
  'other',
]
