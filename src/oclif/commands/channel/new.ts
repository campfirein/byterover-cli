import {Args, Command, Flags} from '@oclif/core'

import type {
  ChannelCreateRequest,
  ChannelCreateResponse,
} from '../../../shared/transport/events/channel-events.js'

import {ChannelEvents} from '../../../shared/transport/events/channel-events.js'
import {ChannelClientError, withChannelClient} from '../../lib/channel-client.js'

export default class ChannelNew extends Command {
  public static args = {
    channelId: Args.string({description: 'Channel handle (e.g. pi-test)', required: false}),
  }
public static description = 'Create a new channel in the current project'
public static examples = [
    '<%= config.bin %> <%= command.id %> pi-test',
    '<%= config.bin %> <%= command.id %> pi-test --title "Pi feature work" --json',
    '<%= config.bin %> <%= command.id %>   # auto-generates a channelId',
  ]
public static flags = {
    json: Flags.boolean({default: false, description: 'Emit JSON instead of pretty output'}),
    title: Flags.string({description: 'Optional human-readable title'}),
  }

  public async run(): Promise<void> {
    const {args, flags} = await this.parse(ChannelNew)

    try {
      const response = await withChannelClient(async (client) =>
        client.request<ChannelCreateRequest, ChannelCreateResponse>(ChannelEvents.CREATE, {
          channelId: args.channelId,
          title: flags.title,
        }),
      )

      if (flags.json) {
        this.log(JSON.stringify(response, undefined, 2))
        return
      }

      this.log(
        `✓ Channel #${response.channel.channelId} created${response.channel.title === undefined ? '' : ` (${response.channel.title})`}`,
      )
    } catch (error) {
      this.handleError(error, flags.json)
    }
  }

  private handleError(error: unknown, asJson: boolean): never {
    if (error instanceof ChannelClientError) {
      if (asJson) {
        this.log(JSON.stringify({code: error.code, error: error.message, success: false}))
      } else {
        this.logToStderr(`[${error.code}] ${error.message}`)
      }

      this.exit(1)
    }

    throw error
  }
}
