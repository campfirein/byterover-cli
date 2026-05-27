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
import {findSettingDescriptor, SETTINGS_REGISTRY} from '../../../core/domain/entities/settings.js'
import {processLog} from '../../../utils/process-logger.js'
import {InvalidSettingValueError, UnknownSettingKeyError} from '../../storage/settings-validator.js'

export interface SettingsHandlerDeps {
  readonly analyticsClient?: IAnalyticsClient
  readonly store: ISettingsStore
  readonly transport: ITransportServer
}

/**
 * Handles `settings:*` transport events. Delegates persistence and
 * validation to the injected store; surfaces validator errors as typed
 * structured responses (`{ok: false, error: {...}}`) so no raw exceptions
 * leak across the wire.
 */
export class SettingsHandler {
  private readonly analyticsClient: IAnalyticsClient | undefined
  private readonly store: ISettingsStore
  private readonly transport: ITransportServer

  public constructor(deps: SettingsHandlerDeps) {
    this.analyticsClient = deps.analyticsClient
    this.store = deps.store
    this.transport = deps.transport
  }

  public setup(): void {
    this.transport.onRequest<SettingsListRequest, SettingsListResponse>(
      SettingsEvents.LIST,
      async () => {
        const items = await this.store.list()
        const byKey = new Map(items.map((item) => [item.key, item]))
        return {
          items: SETTINGS_REGISTRY.map((descriptor) => {
            const stored = byKey.get(descriptor.key)
            return descriptorToDTO(descriptor, stored?.current ?? descriptor.default)
          }),
        }
      },
    )

    this.transport.onRequest<SettingsGetRequest, SettingsGetResponse>(
      SettingsEvents.GET,
      async (data) => {
        try {
          const item = await this.store.get(data.key)
          return {...toItemDTO(item), ok: true}
        } catch (error) {
          return {error: errorToDTO(error, data.key), ok: false}
        }
      },
    )

    this.transport.onRequest<SettingsSetRequest, SettingsSetResponse>(
      SettingsEvents.SET,
      async (data) => {
        const typeError = checkValueType(data.key, data.value)
        if (typeError !== undefined) {
          /* eslint-disable camelcase */
          this.emitAnalytics(AnalyticsEventNames.SETTING_CHANGED, {
            failure_kind: 'validation',
            outcome: 'failure',
            setting_key: data.key,
            value_kind: findSettingDescriptor(data.key)?.type ?? 'integer',
          })
          /* eslint-enable camelcase */
          return {error: typeError, ok: false}
        }

        try {
          await this.store.set(data.key, data.value)
          const descriptor = findSettingDescriptor(data.key)
          /* eslint-disable camelcase */
          this.emitAnalytics(AnalyticsEventNames.SETTING_CHANGED, {
            outcome: 'success',
            setting_key: data.key,
            value_changed_from_default: descriptor ? data.value !== descriptor.default : undefined,
            value_kind: descriptor?.type ?? 'integer',
          })
          /* eslint-enable camelcase */
          return {ok: true, restartRequired: restartRequiredFor(data.key)}
        } catch (error) {
          /* eslint-disable camelcase */
          this.emitAnalytics(AnalyticsEventNames.SETTING_CHANGED, {
            failure_kind: classifySettingsFailure(error),
            outcome: 'failure',
            setting_key: data.key,
            value_kind: findSettingDescriptor(data.key)?.type ?? 'integer',
          })
          /* eslint-enable camelcase */
          return {error: errorToDTO(error, data.key, data.value), ok: false}
        }
      },
    )

    this.transport.onRequest<SettingsResetRequest, SettingsResetResponse>(
      SettingsEvents.RESET,
      async (data) => {
        try {
          await this.store.reset(data.key)
          /* eslint-disable camelcase */
          this.emitAnalytics(AnalyticsEventNames.SETTING_RESET, {
            outcome: 'success',
            setting_key: data.key,
            value_kind: findSettingDescriptor(data.key)?.type ?? 'integer',
          })
          /* eslint-enable camelcase */
          return {ok: true, restartRequired: restartRequiredFor(data.key)}
        } catch (error) {
          /* eslint-disable camelcase */
          this.emitAnalytics(AnalyticsEventNames.SETTING_RESET, {
            failure_kind: classifySettingsFailure(error),
            outcome: 'failure',
            setting_key: data.key,
            value_kind: findSettingDescriptor(data.key)?.type ?? 'integer',
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
}

function classifySettingsFailure(error: unknown): string {
  if (error instanceof UnknownSettingKeyError) return 'unknown_key'
  if (error instanceof InvalidSettingValueError) return 'validation'
  if (error instanceof Error && 'code' in error) {
    const code = String((error as {code: unknown}).code)
    if (code.startsWith('E')) return 'config_write'
  }

  return 'unknown'
}

function restartRequiredFor(key: string): boolean {
  return findSettingDescriptor(key)?.restartRequired ?? true
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
function checkValueType(key: string, value: boolean | number): SettingsErrorDTO | undefined {
  const descriptor = findSettingDescriptor(key)
  if (descriptor === undefined) return undefined

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

function toItemDTO(item: SettingItem): SettingsItemDTO {
  const descriptor = findSettingDescriptor(item.key)
  if (descriptor === undefined) {
    throw new Error(`Setting '${item.key}' resolved to no descriptor — registry/store drift`)
  }

  return descriptorToDTO(descriptor, item.current)
}

function descriptorToDTO(descriptor: SettingDescriptor, current: boolean | number): SettingsItemDTO {
  const dto: SettingsItemDTO = {
    current,
    default: descriptor.default,
    description: descriptor.description,
    key: descriptor.key,
    restartRequired: descriptor.restartRequired,
    type: descriptor.type,
  }
  if (descriptor.category !== undefined) dto.category = descriptor.category
  if (descriptor.type === 'integer') {
    dto.min = descriptor.min
    dto.max = descriptor.max
    if (descriptor.unit !== undefined) dto.unit = descriptor.unit
  }

  return dto
}

function errorToDTO(error: unknown, key: string, value?: unknown): SettingsErrorDTO {
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
