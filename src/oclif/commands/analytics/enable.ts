import {confirm} from '@inquirer/prompts'
import {Command, Flags} from '@oclif/core'
import {readFile} from 'node:fs/promises'
import {dirname, resolve} from 'node:path'
import {fileURLToPath} from 'node:url'

import {PRIVACY_POLICY_URL} from '../../../shared/constants/privacy.js'
import {
  GlobalConfigEvents,
  type GlobalConfigGetResponse,
  type GlobalConfigSetAnalyticsResponse,
} from '../../../shared/transport/events/global-config-events.js'
import {type DaemonClientOptions, formatConnectionError, withDaemonRetry} from '../../lib/daemon-client.js'

// The disclosure markdown is a static asset (PM/legal own its copy) that the
// build copies into dist/server/templates/sections/. Reading it as a file from
// oclif is a runtime fs read, not a TypeScript import, so the oclif-server
// boundary rule is preserved. If a future need surfaces the disclosure to
// other surfaces (e.g. the M1.7 webui rendering it as HTML), consider moving
// the asset under src/shared/ or serving it via a daemon transport event.
const here = dirname(fileURLToPath(import.meta.url))
const DISCLOSURE_PATH = resolve(here, '../../../server/templates/sections/analytics-disclosure.md')

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

  protected async confirmDisclosure(): Promise<boolean> {
    return confirm({default: false, message: 'Enable analytics with the terms above?'})
  }

  protected async getCurrentAnalytics(options?: DaemonClientOptions): Promise<boolean> {
    return withDaemonRetry<boolean>(async (client) => {
      const response = await client.requestWithAck<GlobalConfigGetResponse>(GlobalConfigEvents.GET)
      return response.analytics
    }, options)
  }

  protected isInteractive(): boolean {
    return process.stdin.isTTY === true && process.stdout.isTTY === true
  }

  protected async loadDisclosure(): Promise<string> {
    return readFile(DISCLOSURE_PATH, 'utf8')
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
    const disclosure = await this.loadDisclosure()
    this.log(disclosure)

    if (yesFlag) {
      return true
    }

    if (!this.isInteractive()) {
      this.error(
        'Cannot enable analytics in non-interactive mode without confirmation.\n' +
          'Re-run in a terminal, or pass --yes to accept the disclosure non-interactively.',
      )
    }

    return this.confirmDisclosure()
  }
}
