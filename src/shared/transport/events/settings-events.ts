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
 * Backward-compat: every widening here is additive at the JSON layer, so
 * consumers that read pre-existing integer / boolean fields continue to
 * parse the wire format unchanged.
 */
export interface SettingsItemDTO {
  category?: 'concurrency' | 'language' | 'llm' | 'task-history' | 'updates'
  current: boolean | number | string
  default: boolean | number | string
  description: string
  key: string
  max?: number
  min?: number
  /** Allowed values for `type === 'enum'`. Omitted otherwise. */
  options?: readonly string[]
  restartRequired: boolean
  scope?: 'global' | 'project'
  type: 'boolean' | 'enum' | 'integer'
  unit?: 'count' | 'ms'
}

export interface SettingsErrorDTO {
  code: 'invalid_value' | 'invalid_value_type' | 'unknown_key'
  /** Expected runtime kind, only set when `code === 'invalid_value_type'`. */
  expected?: 'boolean' | 'enum' | 'integer'
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
  value: boolean | number | string
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
