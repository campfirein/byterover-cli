import {Args, Command, Flags} from '@oclif/core'

import type {
  ChannelArchiveRequest,
  ChannelArchiveResponse,
} from '../../../shared/transport/events/channel-events.js'

import {ChannelEvents} from '../../../shared/transport/events/channel-events.js'
import {ChannelClientError, withChannelClient} from '../../lib/channel-client.js'

export default class ChannelArchive extends Command {
  public static args = {
    channelId: Args.string({description: 'Channel handle to archive', required: true}),
  }
public static description = 'Archive a channel (sets archivedAt; preserves history)'
public static examples = [
    '<%= config.bin %> <%= command.id %> pi-test',
    '<%= config.bin %> <%= command.id %> pi-test --json',
  ]
public static flags = {
    json: Flags.boolean({default: false, description: 'Emit JSON instead of pretty output'}),
  }

  public async run(): Promise<void> {
    const {args, flags} = await this.parse(ChannelArchive)

    try {
      const response = await withChannelClient(async (client) =>
        client.request<ChannelArchiveRequest, ChannelArchiveResponse>(ChannelEvents.ARCHIVE, {
          channelId: args.channelId,
        }),
      )

      if (flags.json) {
        this.log(JSON.stringify(response, undefined, 2))
        return
      }

      this.log(`✓ Channel #${response.channel.channelId} archived`)
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
