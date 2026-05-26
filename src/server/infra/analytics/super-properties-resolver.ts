/* eslint-disable camelcase */
import type {ISuperPropertiesResolver, SuperProperties} from '../../core/interfaces/analytics/i-super-properties-resolver.js'
import type {IGlobalConfigStore} from '../../core/interfaces/storage/i-global-config-store.js'

import {readCliVersion} from '../../utils/read-cli-version.js'

type StaticFields = Readonly<{
  cli_version: string
  environment: 'development' | 'production'
  node_version: string
  os: NodeJS.Platform
}>

/**
 * Resolves the five super properties attached to every analytics event.
 *
 * `cli_version`, `os`, `node_version`, and `environment` are cached on
 * first `resolve()` and never re-read (no static value can change at
 * runtime). `device_id` is re-read from `IGlobalConfigStore` on every
 * call so a swapped GlobalConfig is observable; reads are cheap and the
 * value is stable in practice.
 */
export class SuperPropertiesResolver implements ISuperPropertiesResolver {
  private readonly globalConfigStore: IGlobalConfigStore
  private staticFields: StaticFields | undefined
  private readonly versionReader: () => string

  public constructor(globalConfigStore: IGlobalConfigStore, versionReader: () => string = readCliVersion) {
    this.globalConfigStore = globalConfigStore
    this.versionReader = versionReader
  }

  public async resolve(): Promise<SuperProperties> {
    if (!this.staticFields) {
      this.staticFields = {
        cli_version: this.versionReader(),
        environment: process.env.BRV_ENV === 'development' ? 'development' : 'production',
        node_version: process.version,
        os: process.platform,
      }
    }

    const config = await this.globalConfigStore.read()
    return {
      cli_version: this.staticFields.cli_version,
      device_id: config?.deviceId ?? '',
      environment: this.staticFields.environment,
      node_version: this.staticFields.node_version,
      os: this.staticFields.os,
    }
  }
}
