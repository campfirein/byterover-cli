import {Command, Flags} from '@oclif/core'
import open from 'open'

import {
  WebuiEvents,
  type WebuiGetPortResponse,
  type WebuiSetPortResponse,
} from '../../shared/transport/events/webui-events.js'
import {formatConnectionError, withDaemonRetry} from '../lib/daemon-client.js'

export default class Webui extends Command {
  public static description = 'Open the web UI in the browser'
  public static examples = ['<%= config.bin %> <%= command.id %>', '<%= config.bin %> <%= command.id %> --port 8080']
  public static flags = {
    port: Flags.integer({
      char: 'p',
      description: 'Set the web UI port (remembered for future use)',
    }),
  }

  public async run(): Promise<void> {
    const {flags} = await this.parse(Webui)

    const webuiPort = flags.port ? await this.resolveSetPort(flags.port) : await this.resolveGetPort()
    const url = `http://127.0.0.1:${webuiPort}`
    this.log(`ByteRover Web UI: ${url}`)

    await open(url).catch(() => {
      this.log('Could not open browser automatically. Open the URL above manually.')
    })
  }

  private async resolveGetPort(): Promise<number> {
    let result: WebuiGetPortResponse
    try {
      result = await withDaemonRetry(
        async (client) => client.requestWithAck<WebuiGetPortResponse>(WebuiEvents.GET_PORT),
        {projectPath: process.cwd()},
      )
    } catch (error) {
      return this.error(formatConnectionError(error))
    }

    if (result.status === 'ok') {
      if (result.requestedPort !== undefined && result.requestedPort !== result.port) {
        this.log(`Port ${result.requestedPort} was in use — using port ${result.port} instead.`)
      }

      return result.port
    }

    if (result.status === 'port_in_use') {
      return this.error(
        `Web UI port ${result.conflictPort} is already in use. Run \`brv webui --port <port>\` to choose a different port.`,
      )
    }

    return this.error('Web UI did not start. Run `brv restart` and try again.')
  }

  private async resolveSetPort(port: number): Promise<number> {
    let result: WebuiSetPortResponse
    try {
      result = await withDaemonRetry(
        async (client) => client.requestWithAck<WebuiSetPortResponse>(WebuiEvents.SET_PORT, {port}),
        {projectPath: process.cwd()},
      )
    } catch (error) {
      return this.error(formatConnectionError(error))
    }

    if (result.status === 'ok') return result.port

    return this.error(
      `Web UI port ${result.conflictPort} is already in use. Run \`brv webui --port <port>\` to choose a different port.`,
    )
  }
}
