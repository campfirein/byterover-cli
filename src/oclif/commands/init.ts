/* eslint-disable no-unreachable */
import {Command, Flags} from '@oclif/core'

import {InitEvents, type InitLocalResponse} from '../../shared/transport/events/init-events.js'
import {type DaemonClientOptions, formatConnectionError, withDaemonRetry} from '../lib/daemon-client.js'

export default class Init extends Command {
  public static description = 'Initialize a ByteRover project in the current directory'
  public static examples = ['<%= config.bin %> <%= command.id %>', '<%= config.bin %> <%= command.id %> --force']
  public static flags = {
    force: Flags.boolean({
      char: 'f',
      default: false,
      description: 'Force re-initialization even if already initialized',
    }),
  }
  public static hidden = true

  protected getDaemonOptions(): DaemonClientOptions {
    return {projectPath: process.cwd()}
  }

  public async run(): Promise<void> {
    this.log('The init command is not available. Use: brv vc init')
    return

    const {flags} = await this.parse(Init)
    const daemonOptions = this.getDaemonOptions()

    // Step 1: Local init (.brv/config.json + context tree)
    try {
      const response = await withDaemonRetry<InitLocalResponse>(
        async (client) => client.requestWithAck<InitLocalResponse>(InitEvents.LOCAL, {force: flags.force}),
        daemonOptions,
      )

      if (response.alreadyInitialized) {
        this.log('ByteRover project already initialized.')
        return
      }
    } catch (error) {
      this.log(formatConnectionError(error))
      return
    }

    // Step 2: Version control init
    try {
      await this.config.runCommand('vc:init')
    } catch {
      // vc:init logs its own errors
      return
    }

    // Step 3: Connector setup — interactive agent selection + default connector
    try {
      await this.config.runCommand('connectors:install')
    } catch {
      // connector setup is optional
    }

    this.log(`\nByteRover is ready in ${process.cwd()}`)
    this.log('  Ask your coding agent to curate your project —')
    this.log('  try "hey, curate the context for this project"')
  }
}
