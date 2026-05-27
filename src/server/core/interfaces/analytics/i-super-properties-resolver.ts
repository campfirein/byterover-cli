 
import type {ClientType} from '../../domain/client/client-info.js'

/**
 * Super properties stamped onto every analytics event. Wire-format
 * snake_case throughout. `device_id` is sourced from `GlobalConfig`;
 * the remaining four are static across the daemon's lifetime.
 *
 * `client_kind` is stamped when the analytics emit originates from a
 * Socket.IO transport call wrapped in `clientKindContext.run()`. Absent
 * when the emit happens outside any context wrap (daemon-internal track
 * or agent-fork connection).
 */
export type SuperProperties = Readonly<{
  cli_version: string
  client_kind?: ClientType
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
