 

/**
 * Super properties stamped onto every analytics event. Wire-format
 * snake_case throughout. `device_id` is sourced from `GlobalConfig`;
 * the remaining four are static across the daemon's lifetime.
 */
export type SuperProperties = Readonly<{
  cli_version: string
  device_id: string
  environment: 'development' | 'production'
  node_version: string
  os: NodeJS.Platform
}>

/**
 * Resolves the five super properties for analytics events.
 * `resolve()` is async because `device_id` is sourced from
 * `IGlobalConfigStore.read()` which is itself async.
 */
export interface ISuperPropertiesResolver {
  resolve: () => Promise<SuperProperties>
}
