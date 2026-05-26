import {Command} from '@oclif/core'

import {
  GlobalConfigEvents,
  type GlobalConfigSetAnalyticsResponse,
} from '../../../shared/transport/events/global-config-events.js'
import {type DaemonClientOptions, formatConnectionError, withDaemonRetry} from '../../lib/daemon-client.js'

export default class Disable extends Command {
  public static description = `Disable ByteRover CLI analytics.

Stops anonymous usage telemetry. Re-enable any time with: brv analytics enable`
  public static examples = ['<%= config.bin %> <%= command.id %>']

  public async run(): Promise<void> {
    try {
      const response = await this.setAnalytics(false, {projectPath: process.cwd()})
      this.log(response.previous === response.current ? 'Analytics already disabled' : 'Analytics disabled')
    } catch (error) {
      this.log(formatConnectionError(error))
    }
  }

  protected async setAnalytics(
    analytics: boolean,
    options?: DaemonClientOptions,
  ): Promise<GlobalConfigSetAnalyticsResponse> {
    return withDaemonRetry<GlobalConfigSetAnalyticsResponse>(
      async (client) =>
        client.requestWithAck<GlobalConfigSetAnalyticsResponse>(GlobalConfigEvents.SET_ANALYTICS, {analytics}),
      options,
    )
  }
}
