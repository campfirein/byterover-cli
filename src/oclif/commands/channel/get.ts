import {Args, Command, Flags} from '@oclif/core'

import type {
  ChannelGetRequest,
  ChannelGetResponse,
} from '../../../shared/transport/events/channel-events.js'

import {ChannelEvents} from '../../../shared/transport/events/channel-events.js'
import {ChannelClientError, withChannelClient} from '../../lib/channel-client.js'

export default class ChannelGet extends Command {
  public static args = {
    channelId: Args.string({description: 'Channel handle', required: true}),
  }
public static description = 'Show channel metadata + member roster'
public static examples = [
    '<%= config.bin %> <%= command.id %> pi-test',
    '<%= config.bin %> <%= command.id %> pi-test --json',
  ]
public static flags = {
    json: Flags.boolean({default: false, description: 'Emit JSON instead of pretty output'}),
  }

  public async run(): Promise<void> {
    const {args, flags} = await this.parse(ChannelGet)

    try {
      const response = await withChannelClient(async (client) =>
        client.request<ChannelGetRequest, ChannelGetResponse>(ChannelEvents.GET, {
          channelId: args.channelId,
        }),
      )

      if (flags.json) {
        this.log(JSON.stringify(response, undefined, 2))
        return
      }

      const c = response.channel
      this.log(`Channel #${c.channelId}${c.title === undefined ? '' : ` (${c.title})`}`)
      this.log(`  Members:  ${c.memberCount}`)
      this.log(`  Created:  ${c.createdAt}`)
      this.log(`  Updated:  ${c.updatedAt}`)
      if (c.archivedAt !== undefined) {
        this.log(`  Archived: ${c.archivedAt}`)
      }
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
