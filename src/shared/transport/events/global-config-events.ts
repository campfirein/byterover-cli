 
import type {CliMetadata} from '../../analytics/cli-metadata-schema.js'

export const GlobalConfigEvents = {
  GET: 'globalConfig:get',
  SET_ANALYTICS: 'globalConfig:setAnalytics',
} as const

/**
 * M13.2 Group C — `globalConfig:get` is a no-payload request. Define the
 * Request interface so M13.3 can attach `cli_metadata`.
 */
export interface GlobalConfigGetRequest {
  cli_metadata?: CliMetadata
}

export interface GlobalConfigGetResponse {
  readonly analytics: boolean
  readonly deviceId: string
  readonly version: string
}

export interface GlobalConfigSetAnalyticsRequest {
  readonly analytics: boolean
  cli_metadata?: CliMetadata
}

export interface GlobalConfigSetAnalyticsResponse {
  readonly current: boolean
  readonly previous: boolean
}
