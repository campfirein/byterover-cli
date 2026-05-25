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
 * M7 T2 added three optional fields. `category` and `unit` flow through
 * from the descriptor; `scope` is reserved for the future project-store
 * ticket and is always omitted in v1. All three are additive only —
 * existing JSON consumers that ignore them continue to parse correctly.
 */
export interface SettingsItemDTO {
  category?: 'concurrency' | 'llm' | 'task-history'
  current: number
  default: number
  description: string
  key: string
  max: number
  min: number
  restartRequired: true
  scope?: 'global' | 'project'
  type: 'integer'
  unit?: 'count' | 'ms'
}

export interface SettingsErrorDTO {
  code: 'invalid_value' | 'unknown_key'
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
  value: unknown
}

export type SettingsSetResponse =
  | {readonly error: SettingsErrorDTO; readonly ok: false}
  | {readonly ok: true; readonly restartRequired: true}

export interface SettingsResetRequest {
  key: string
}

export type SettingsResetResponse =
  | {readonly error: SettingsErrorDTO; readonly ok: false}
  | {readonly ok: true; readonly restartRequired: true}
