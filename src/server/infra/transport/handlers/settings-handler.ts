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
import type {ISettingsStore} from '../../../core/interfaces/storage/i-settings-store.js'
import type {ITransportServer} from '../../../core/interfaces/transport/i-transport-server.js'

import {SettingsEvents} from '../../../../shared/transport/events/settings-events.js'
import {findSettingDescriptor, SETTINGS_REGISTRY} from '../../../core/domain/entities/settings.js'
import {InvalidSettingValueError, UnknownSettingKeyError} from '../../storage/settings-validator.js'

export interface SettingsHandlerDeps {
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
  private readonly store: ISettingsStore
  private readonly transport: ITransportServer

  public constructor(deps: SettingsHandlerDeps) {
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
        try {
          await this.store.set(data.key, data.value)
          return {ok: true, restartRequired: restartRequiredFor(data.key)}
        } catch (error) {
          return {error: errorToDTO(error, data.key, data.value), ok: false}
        }
      },
    )

    this.transport.onRequest<SettingsResetRequest, SettingsResetResponse>(
      SettingsEvents.RESET,
      async (data) => {
        try {
          await this.store.reset(data.key)
          return {ok: true, restartRequired: restartRequiredFor(data.key)}
        } catch (error) {
          return {error: errorToDTO(error, data.key), ok: false}
        }
      },
    )
  }
}

function restartRequiredFor(key: string): boolean {
  return findSettingDescriptor(key)?.restartRequired ?? true
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
