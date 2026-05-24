export type SettingsRowCategory = 'concurrency' | 'llm' | 'other' | 'task-history'
export type SettingsRowUnit = 'count' | 'ms'

export interface SettingsRow {
  readonly category: SettingsRowCategory
  readonly current: number
  readonly default: number
  readonly description: string
  readonly displayCurrent: string
  readonly displayDefault: string
  readonly displayRange: string
  readonly key: string
  readonly label: string
  readonly max: number
  readonly min: number
  readonly modified: boolean
  readonly restartRequired: true
  readonly type: 'integer'
  readonly unit: SettingsRowUnit
}

export type RowParseResult =
  | {readonly displayValue: string; readonly kind: 'ok'; readonly value: number}
  | {readonly kind: 'error'; readonly message: string}

export const CATEGORY_ORDER: readonly SettingsRowCategory[] = ['concurrency', 'llm', 'task-history', 'other']
