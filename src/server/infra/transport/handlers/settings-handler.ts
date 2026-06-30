import type {AnalyticsEventName} from '../../../../shared/analytics/event-names.js'
import type {PropsArg} from '../../../../shared/analytics/events/index.js'
import type {
  SettingsErrorDTO,
  SettingsGetRequest,
  SettingsGetResponse,
  SettingsItemDTO,
  SettingsListRequest,
  SettingsListResponse,
  SettingsResetRequest,
  SettingsResetResponse,
  SettingsSetRequest,
  SettingsSetResponse,
} from '../../../../shared/transport/events/settings-events.js'
import type {SettingDescriptor, SettingItem} from '../../../core/domain/entities/settings.js'
import type {IAnalyticsClient} from '../../../core/interfaces/analytics/i-analytics-client.js'
import type {ISettingsStore} from '../../../core/interfaces/storage/i-settings-store.js'
import type {ITransportServer} from '../../../core/interfaces/transport/i-transport-server.js'

import {AnalyticsEventNames} from '../../../../shared/analytics/event-names.js'
import {SettingsEvents} from '../../../../shared/transport/events/settings-events.js'
import {SETTINGS_REGISTRY} from '../../../core/domain/entities/settings.js'
import {processLog} from '../../../utils/process-logger.js'
import {
  InvalidSettingValueError,
  ReadonlySettingKeyError,
  UnknownSettingKeyError,
} from '../../storage/settings-validator.js'

/**
 * Wire-acceptable shape for a `readonly-info` key's live value. Plain
 * JSON-compatible primitive or object, or `undefined` when the
 * provider has nothing to report. Strings, arrays, and functions are
 * deliberately excluded so callers cannot smuggle unsupported shapes
 * into the settings surface.
 */
export type ReadonlyInfoSnapshot = boolean | number | Readonly<Record<string, unknown>> | undefined

/**
 * Resolver for a `readonly-info` key's live value. Called by LIST and
 * GET at request time. May return synchronously or via a Promise.
 * Throwing is non-fatal: the handler maps a thrown provider error to
 * `code: 'invalid_value'` so a single broken provider cannot crash the
 * settings surface for every key.
 */
export type ReadonlyInfoProvider = () => Promise<ReadonlyInfoSnapshot> | ReadonlyInfoSnapshot

/**
 * Facade over `GlobalConfigHandler` for the `analytics.share` setting.
 * The settings handler routes GET/SET/RESET/LIST for that key through
 * this facade instead of `FileSettingsStore`, so the canonical storage
 * in `config.json`, the device-id seeding race fix, the sync analytics
 * cache, and the abort-on-disable side-effect are all preserved.
 *
 * Structurally satisfied by `GlobalConfigHandler` (no `implements`
 * needed); tests pass a hand-rolled stub.
 */
export interface AnalyticsEnabledFacade {
  getCurrentAnalytics(): Promise<boolean>
  setAnalyticsValue(value: boolean): Promise<{current: boolean; previous: boolean}>
}

export interface SettingsHandlerDeps {
  readonly analyticsClient?: IAnalyticsClient
  /**
   * Facade for the `analytics.share` writable key. When set,
   * GET/SET/RESET/LIST for `analytics.share` route through this facade
   * instead of the file store. When unset, the key surfaces with
   * `current: undefined`.
   */
  readonly globalConfigHandler?: AnalyticsEnabledFacade
  /**
   * Live-value resolvers for `readonly-info` keys, keyed by descriptor key.
   * t3 (analytics.status) registers `'analytics.status' -> getAnalyticsStatus`
   * here; in t1 the map is empty and readonly-info rows surface
   * `current: undefined`.
   */
  readonly infoProviders?: ReadonlyMap<string, ReadonlyInfoProvider>
  /**
   * Override the descriptor registry. Defaults to `SETTINGS_REGISTRY`.
   * Tests inject a small registry containing the variant under test
   * (e.g. a single `readonly-info` descriptor).
   */
  readonly registry?: readonly SettingDescriptor[]
  readonly store: ISettingsStore
  readonly transport: ITransportServer
}

/**
 * Handles `settings:*` transport events. Delegates persistence and
 * validation to the injected store; surfaces validator errors as typed
 * structured responses (`{ok: false, error: {...}}`) so no raw exceptions
 * leak across the wire.
 *
 * Readonly-info keys are gated at the top of SET and RESET — those paths
 * return `code: 'read_only'` without ever touching the store. LIST and
 * GET both resolve the live value via the injected `infoProviders` map;
 * a missing provider yields `current: undefined` on both paths. A
 * throwing provider is handled asymmetrically: GET surfaces the failure
 * as a top-level `code: 'invalid_value'` response (the caller asked for
 * that specific key, so the error matters), while LIST isolates the
 * failure to that one row (`current: undefined`, daemon log captures the
 * error) so a single broken provider cannot blank the whole settings
 * surface.
 */
export class SettingsHandler {
  private readonly analyticsClient: IAnalyticsClient | undefined
  private readonly globalConfigHandler: AnalyticsEnabledFacade | undefined
  private readonly infoProviders: ReadonlyMap<string, ReadonlyInfoProvider>
  private readonly registry: readonly SettingDescriptor[]
  private readonly store: ISettingsStore
  private readonly transport: ITransportServer

  public constructor(deps: SettingsHandlerDeps) {
    this.analyticsClient = deps.analyticsClient
    this.globalConfigHandler = deps.globalConfigHandler
    this.infoProviders = deps.infoProviders ?? new Map()
    this.registry = deps.registry ?? SETTINGS_REGISTRY
    this.store = deps.store
    this.transport = deps.transport
  }

  public setup(): void {
    this.transport.onRequest<SettingsListRequest, SettingsListResponse>(
      SettingsEvents.LIST,
      async () => {
        const items = await this.store.list()
        const byKey = new Map(items.map((item) => [item.key, item]))
        // Per-row try/catch so one throwing readonly-info provider does
        // not blank the whole list. Failed rows surface `current: undefined`
        // (same shape as "no provider registered"); the daemon log captures
        // the actual error for debugging. GET keeps its richer
        // `code: 'invalid_value'` error path because GET is single-key
        // and the caller asked specifically for that key.
        const dtoItems = await Promise.all(
          this.registry.map(async (descriptor) => {
            const stored = byKey.get(descriptor.key)
            let current: SettingItem['current']
            try {
              current = await this.resolveCurrent(descriptor, stored)
            } catch (error) {
              processLog(
                `[Settings] readonly-info provider for '${descriptor.key}' failed: ${error instanceof Error ? error.message : String(error)}`,
              )
              current = undefined
            }

            return descriptorToDTO(descriptor, current)
          }),
        )

        return {items: dtoItems}
      },
    )

    this.transport.onRequest<SettingsGetRequest, SettingsGetResponse>(
      SettingsEvents.GET,
      async (data) => {
        try {
          const item = await this.store.get(data.key)
          const descriptor = this.findDescriptor(data.key)
          if (descriptor === undefined) {
            return {error: errorToDTO(new UnknownSettingKeyError(data.key), data.key), ok: false}
          }

          const current = await this.resolveCurrent(descriptor, item)
          return {...descriptorToDTO(descriptor, current), ok: true}
        } catch (error) {
          return {error: errorToDTO(error, data.key), ok: false}
        }
      },
    )

    this.transport.onRequest<SettingsSetRequest, SettingsSetResponse>(
      SettingsEvents.SET,
      async (data) => {
        const descriptor = this.findDescriptor(data.key)
        if (descriptor?.type === 'readonly-info') {
          /* eslint-disable camelcase */
          this.emitAnalytics(AnalyticsEventNames.SETTING_CHANGED, {
            failure_kind: 'read_only',
            outcome: 'failure',
            setting_key: data.key,
            value_kind: 'readonly-info',
          })
          /* eslint-enable camelcase */
          return {error: readOnlyError(data.key), ok: false}
        }

        // Global-config writables (analytics.share and any future ones)
        // route through the injected facade. The file store stays
        // untouched. Type check still applies (boolean for the only
        // current case), so reuse `checkValueType` before delegating.
        if (descriptor?.storage === 'global-config') {
          const typeError = checkValueType(descriptor, data.key, data.value)
          if (typeError !== undefined) {
            /* eslint-disable camelcase */
            this.emitAnalytics(AnalyticsEventNames.SETTING_CHANGED, {
              failure_kind: 'validation',
              outcome: 'failure',
              setting_key: data.key,
              value_kind: writableValueKind(descriptor),
            })
            /* eslint-enable camelcase */
            return {error: typeError, ok: false}
          }

          if (this.globalConfigHandler === undefined) {
            return {
              error: {
                code: 'misconfigured',
                key: data.key,
                message: `'${data.key}' is stored in global config, but no globalConfigHandler facade was wired into SettingsHandler.`,
              },
              ok: false,
            }
          }

          try {
            await this.globalConfigHandler.setAnalyticsValue(data.value as boolean)
            /* eslint-disable camelcase */
            this.emitAnalytics(AnalyticsEventNames.SETTING_CHANGED, {
              outcome: 'success',
              setting_key: data.key,
              value_changed_from_default: descriptorDefault(descriptor) === undefined
                ? undefined
                : data.value !== descriptorDefault(descriptor),
              value_kind: writableValueKind(descriptor),
            })
            /* eslint-enable camelcase */
            return {ok: true, restartRequired: restartRequiredFor(descriptor)}
          } catch (error) {
            /* eslint-disable camelcase */
            this.emitAnalytics(AnalyticsEventNames.SETTING_CHANGED, {
              failure_kind: classifySettingsFailure(error),
              outcome: 'failure',
              setting_key: data.key,
              value_kind: writableValueKind(descriptor),
            })
            /* eslint-enable camelcase */
            return {error: errorToDTO(error, data.key, data.value), ok: false}
          }
        }

        const typeError = checkValueType(descriptor, data.key, data.value)
        if (typeError !== undefined) {
          /* eslint-disable camelcase */
          this.emitAnalytics(AnalyticsEventNames.SETTING_CHANGED, {
            failure_kind: 'validation',
            outcome: 'failure',
            setting_key: data.key,
            value_kind: writableValueKind(descriptor),
          })
          /* eslint-enable camelcase */
          return {error: typeError, ok: false}
        }

        try {
          await this.store.set(data.key, data.value)
          /* eslint-disable camelcase */
          this.emitAnalytics(AnalyticsEventNames.SETTING_CHANGED, {
            outcome: 'success',
            setting_key: data.key,
            value_changed_from_default: descriptorDefault(descriptor) === undefined
              ? undefined
              : data.value !== descriptorDefault(descriptor),
            value_kind: writableValueKind(descriptor),
          })
          /* eslint-enable camelcase */
          return {ok: true, restartRequired: restartRequiredFor(descriptor)}
        } catch (error) {
          /* eslint-disable camelcase */
          this.emitAnalytics(AnalyticsEventNames.SETTING_CHANGED, {
            failure_kind: classifySettingsFailure(error),
            outcome: 'failure',
            setting_key: data.key,
            value_kind: writableValueKind(descriptor),
          })
          /* eslint-enable camelcase */
          return {error: errorToDTO(error, data.key, data.value), ok: false}
        }
      },
    )

    this.transport.onRequest<SettingsResetRequest, SettingsResetResponse>(
      SettingsEvents.RESET,
      async (data) => {
        const descriptor = this.findDescriptor(data.key)
        if (descriptor?.type === 'readonly-info') {
          /* eslint-disable camelcase */
          this.emitAnalytics(AnalyticsEventNames.SETTING_RESET, {
            failure_kind: 'read_only',
            outcome: 'failure',
            setting_key: data.key,
            value_kind: 'readonly-info',
          })
          /* eslint-enable camelcase */
          return {error: readOnlyError(data.key), ok: false}
        }

        // Reset on a global-config writable means "back to descriptor.default".
        // For analytics.share the default is `false`, so we flip via the facade.
        if (descriptor?.storage === 'global-config') {
          if (this.globalConfigHandler === undefined) {
            return {
              error: {
                code: 'misconfigured',
                key: data.key,
                message: `'${data.key}' is stored in global config, but no globalConfigHandler facade was wired into SettingsHandler.`,
              },
              ok: false,
            }
          }

          // The facade interface is boolean-only (`setAnalyticsValue(value: boolean)`).
          // If a future descriptor is added with storage='global-config' and a
          // non-boolean type, refuse explicitly instead of silently coercing
          // the default to `false`.
          if (descriptor.type !== 'boolean') {
            return {
              error: {
                code: 'misconfigured',
                key: data.key,
                message: `'${data.key}' has storage='global-config' but type='${descriptor.type}'; the facade only supports boolean global-config keys.`,
              },
              ok: false,
            }
          }

          try {
            const defaultValue: boolean = descriptor.default
            await this.globalConfigHandler.setAnalyticsValue(defaultValue)
            /* eslint-disable camelcase */
            this.emitAnalytics(AnalyticsEventNames.SETTING_RESET, {
              outcome: 'success',
              setting_key: data.key,
              value_kind: writableValueKind(descriptor),
            })
            /* eslint-enable camelcase */
            return {ok: true, restartRequired: restartRequiredFor(descriptor)}
          } catch (error) {
            /* eslint-disable camelcase */
            this.emitAnalytics(AnalyticsEventNames.SETTING_RESET, {
              failure_kind: classifySettingsFailure(error),
              outcome: 'failure',
              setting_key: data.key,
              value_kind: writableValueKind(descriptor),
            })
            /* eslint-enable camelcase */
            return {error: errorToDTO(error, data.key), ok: false}
          }
        }

        try {
          await this.store.reset(data.key)
          /* eslint-disable camelcase */
          this.emitAnalytics(AnalyticsEventNames.SETTING_RESET, {
            outcome: 'success',
            setting_key: data.key,
            value_kind: writableValueKind(descriptor),
          })
          /* eslint-enable camelcase */
          return {ok: true, restartRequired: restartRequiredFor(descriptor)}
        } catch (error) {
          /* eslint-disable camelcase */
          this.emitAnalytics(AnalyticsEventNames.SETTING_RESET, {
            failure_kind: classifySettingsFailure(error),
            outcome: 'failure',
            setting_key: data.key,
            value_kind: writableValueKind(descriptor),
          })
          /* eslint-enable camelcase */
          return {error: errorToDTO(error, data.key), ok: false}
        }
      },
    )
  }

  /**
   * Analytics emit helper. Mirrors the try/processLog pattern from other
   * handlers so analytics failures never affect command outcomes.
   */
  private emitAnalytics<E extends AnalyticsEventName>(event: E, ...rest: PropsArg<E>): void {
    const client = this.analyticsClient
    if (!client) return
    try {
      client.track(event, ...rest)
    } catch (error) {
      processLog(`[Settings] analytics track ${event} failed: ${error instanceof Error ? error.message : String(error)}`)
    }
  }

  private findDescriptor(key: string): SettingDescriptor | undefined {
    return this.registry.find((d) => d.key === key)
  }

  /**
   * Resolves the value to surface on the DTO's `current` field.
   *
   * - Writable descriptors (`boolean` / `integer`): the stored override
   *   (if any) wins, else the registered default.
   * - Readonly-info: the injected provider, if registered. Missing
   *   provider -> `undefined`. Provider throws -> rethrow so the GET
   *   handler can map to `code: 'invalid_value'` (LIST swallows below).
   */
  private async resolveCurrent(
    descriptor: SettingDescriptor,
    stored: SettingItem | undefined,
  ): Promise<SettingItem['current']> {
    if (descriptor.type === 'readonly-info') {
      const provider = this.infoProviders.get(descriptor.key)
      if (provider === undefined) return undefined
      return provider()
    }

    if (descriptor.storage === 'global-config') {
      // Global-config-stored values (analytics.share) live in
      // config.json, not settings.json. Without an injected facade we
      // cannot resolve — surface `undefined` so the row still renders
      // rather than crashing.
      if (this.globalConfigHandler === undefined) return undefined
      return this.globalConfigHandler.getCurrentAnalytics()
    }

    if (stored?.current !== undefined) return stored.current
    return descriptor.default
  }
}

function classifySettingsFailure(error: unknown): string {
  if (error instanceof ReadonlySettingKeyError) return 'read_only'
  if (error instanceof UnknownSettingKeyError) return 'unknown_key'
  if (error instanceof InvalidSettingValueError) return 'validation'
  if (error instanceof Error && 'code' in error) {
    const code = String((error as {code: unknown}).code)
    if (code.startsWith('E')) return 'config_write'
  }

  return 'unknown'
}

function restartRequiredFor(descriptor: SettingDescriptor | undefined): boolean {
  return descriptor?.restartRequired ?? true
}

function descriptorDefault(descriptor: SettingDescriptor | undefined): boolean | number | undefined {
  if (descriptor === undefined) return undefined
  if (descriptor.type === 'readonly-info') return undefined
  return descriptor.default
}

function writableValueKind(
  descriptor: SettingDescriptor | undefined,
): 'boolean' | 'integer' | 'readonly-info' {
  if (descriptor === undefined) return 'integer'
  return descriptor.type
}

function readOnlyError(key: string): SettingsErrorDTO {
  return {
    code: 'read_only',
    key,
    message: `Setting '${key}' is read-only and cannot be written or reset.`,
  }
}

/**
 * Pre-validates `value`'s runtime type against the descriptor for `key`.
 *
 * Returns a structured `invalid_value_type` error when the type does not
 * match. Returns `undefined` either on match or when the key has no
 * descriptor at all — in the second case the store's `UnknownSettingKeyError`
 * surfaces as `unknown_key` through the existing error path, so this helper
 * intentionally does not duplicate that check.
 *
 * Range, coupling, and fractional-number violations are left to the store's
 * validator and still surface as `invalid_value`.
 */
function checkValueType(
  descriptor: SettingDescriptor | undefined,
  key: string,
  value: boolean | number,
): SettingsErrorDTO | undefined {
  if (descriptor === undefined) return undefined
  if (descriptor.type === 'readonly-info') return readOnlyError(key)

  const got = typeof value
  if (descriptor.type === 'integer' && got !== 'number') {
    return {
      code: 'invalid_value_type',
      expected: 'integer',
      got,
      key,
      message: `expected integer for '${key}', got ${got}`,
      value,
    }
  }

  if (descriptor.type === 'boolean' && got !== 'boolean') {
    return {
      code: 'invalid_value_type',
      expected: 'boolean',
      got,
      key,
      message: `expected boolean for '${key}', got ${got}`,
      value,
    }
  }

  return undefined
}

function descriptorToDTO(
  descriptor: SettingDescriptor,
  current: SettingItem['current'],
): SettingsItemDTO {
  const dto: SettingsItemDTO = {
    current,
    description: descriptor.description,
    key: descriptor.key,
    restartRequired: descriptor.restartRequired,
    type: descriptor.type,
  }
  if (descriptor.category !== undefined) dto.category = descriptor.category
  if (descriptor.type === 'integer') {
    dto.default = descriptor.default
    dto.min = descriptor.min
    dto.max = descriptor.max
    if (descriptor.unit !== undefined) dto.unit = descriptor.unit
  } else if (descriptor.type === 'boolean') {
    dto.default = descriptor.default
  }

  // readonly-info: no default, no min/max, no unit. Intentionally omitted
  // from the wire shape so the CLI / TUI render path can branch on the
  // absence of `default`.

  return dto
}

function errorToDTO(error: unknown, key: string, value?: unknown): SettingsErrorDTO {
  if (error instanceof ReadonlySettingKeyError) {
    return {code: 'read_only', key: error.key, message: error.message}
  }

  if (error instanceof UnknownSettingKeyError) {
    return {code: 'unknown_key', key: error.key, message: error.message}
  }

  if (error instanceof InvalidSettingValueError) {
    return {code: 'invalid_value', key: error.key, message: error.message, value: error.value}
  }

  return {
    code: 'invalid_value',
    key,
    message: error instanceof Error ? error.message : String(error),
    value,
  }
}
