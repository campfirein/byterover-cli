export const SettingsEvents = {
  GET: 'settings:get',
  LIST: 'settings:list',
  RESET: 'settings:reset',
  SET: 'settings:set',
} as const

/**
 * Wire shape for one registered setting. Mirrors the in-memory
 * `SettingDescriptor` + `SettingItem` types but lives in `shared/` so
 * surfaces (CLI / TUI / WebUI) can consume it without crossing the
 * server import boundary.
 *
 * M7 T2 added three optional fields (`category`, `unit`, `scope`); T1 of
 * the Update-check toggle project widened `type`, `current`, `default`,
 * and `restartRequired` to also cover boolean descriptors, and made
 * `min` / `max` optional (only integer descriptors carry them). M16.1
 * added the `'readonly-info'` variant: a snapshot has no `default` and
 * `current` may be a structured object or `undefined` (when no info
 * provider is registered). All widenings are additive at the JSON
 * layer, so consumers that read existing integer fields continue to
 * parse the wire format.
 */
export interface SettingsItemDTO {
  category?: 'concurrency' | 'llm' | 'task-history' | 'updates'
  current: boolean | number | Readonly<Record<string, unknown>> | undefined
  default?: boolean | number
  description: string
  key: string
  max?: number
  min?: number
  restartRequired: boolean
  scope?: 'global' | 'project'
  type: 'boolean' | 'integer' | 'readonly-info'
  unit?: 'count' | 'ms'
}

export interface SettingsErrorDTO {
  code: 'invalid_value' | 'invalid_value_type' | 'read_only' | 'unknown_key'
  /** Expected runtime kind, only set when `code === 'invalid_value_type'`. */
  expected?: 'boolean' | 'integer'
  /** `typeof` of the offending value, only set when `code === 'invalid_value_type'`. */
  got?: string
  key: string
  message: string
  value?: unknown
}

export type SettingsListRequest = void

export interface SettingsListResponse {
  items: readonly SettingsItemDTO[]
}

export interface SettingsGetRequest {
  key: string
}

export type SettingsGetResponse =
  | (SettingsItemDTO & {readonly ok: true})
  | {readonly error: SettingsErrorDTO; readonly ok: false}

export interface SettingsSetRequest {
  key: string
  value: boolean | number
}

export type SettingsSetResponse =
  | {readonly error: SettingsErrorDTO; readonly ok: false}
  | {readonly ok: true; readonly restartRequired: boolean}

export interface SettingsResetRequest {
  key: string
}

export type SettingsResetResponse =
  | {readonly error: SettingsErrorDTO; readonly ok: false}
  | {readonly ok: true; readonly restartRequired: boolean}
