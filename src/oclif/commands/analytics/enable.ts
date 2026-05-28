import {Command, Flags} from '@oclif/core'

import {PRIVACY_POLICY_URL} from '../../../shared/constants/privacy.js'
import {
  GlobalConfigEvents,
  type GlobalConfigGetResponse,
  type GlobalConfigSetAnalyticsResponse,
} from '../../../shared/transport/events/global-config-events.js'
import {
  collectConsent as libCollectConsent,
  confirmDisclosure as libConfirmDisclosure,
  isInteractive as libIsInteractive,
  loadDisclosure as libLoadDisclosure,
} from '../../lib/analytics-disclosure.js'
import {type DaemonClientOptions, formatConnectionError, withDaemonRetry} from '../../lib/daemon-client.js'

export default class Enable extends Command {
  public static description = `Enable ByteRover CLI analytics.

Anonymous usage telemetry will be collected to improve the product.
No content of your queries, files, or memory is collected.

Privacy policy: ${PRIVACY_POLICY_URL}  (placeholder until M1.5)
Disable any time with: brv analytics disable`
  public static examples = [
    '<%= config.bin %> <%= command.id %>',
    '<%= config.bin %> <%= command.id %> --yes',
  ]
  public static flags = {
    yes: Flags.boolean({
      char: 'y',
      default: false,
      description: 'Skip the disclosure prompt (CI / non-interactive)',
    }),
  }

  // Thin wrappers delegating to the shared disclosure lib. Preserved as
  // protected methods so the existing test subclass (which overrides them)
  // keeps working. This whole command file is slated for deletion once the
  // unified `brv settings` surface replaces `brv analytics`.
  protected async confirmDisclosure(): Promise<boolean> {
    return libConfirmDisclosure()
  }

  protected async getCurrentAnalytics(options?: DaemonClientOptions): Promise<boolean> {
    return withDaemonRetry<boolean>(async (client) => {
      const response = await client.requestWithAck<GlobalConfigGetResponse>(GlobalConfigEvents.GET)
      return response.analytics
    }, options)
  }

  protected isInteractive(): boolean {
    return libIsInteractive()
  }

  protected async loadDisclosure(): Promise<string> {
    return libLoadDisclosure()
  }

  public async run(): Promise<void> {
    const {flags} = await this.parse(Enable)

    let alreadyEnabled: boolean
    try {
      alreadyEnabled = await this.getCurrentAnalytics({projectPath: process.cwd()})
    } catch (error) {
      this.log(formatConnectionError(error))
      return
    }

    if (alreadyEnabled) {
      this.log('Analytics already enabled')
      return
    }

    // collectConsent may call this.error() for non-TTY without --yes;
    // that throws CLIError and oclif's exit handler surfaces a non-zero
    // exit code. Do NOT wrap it in try/catch.
    const accepted = await this.collectConsent(flags.yes)
    if (!accepted) {
      this.log('Analytics not enabled')
      return
    }

    try {
      await this.setAnalytics(true, {projectPath: process.cwd()})
    } catch (error) {
      this.log(formatConnectionError(error))
      return
    }

    this.log('Analytics enabled')
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

  private async collectConsent(yesFlag: boolean): Promise<boolean> {
    // Delegate the consent flow to the shared lib but preserve the subclass-override
    // hooks (`this.loadDisclosure`, `this.isInteractive`, `this.confirmDisclosure`)
    // so existing tests that stub them keep working.
    return libCollectConsent({
      loadFn: () => this.loadDisclosure(),
      onError: (msg) => this.error(msg),
      onLog: (msg) => this.log(msg),
      promptFn: () => this.confirmDisclosure(),
      ttyCheck: () => this.isInteractive(),
      yesFlag,
    })
  }
}
