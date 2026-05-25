import {Command, Flags} from '@oclif/core'

import type {
  ChannelListRequest,
  ChannelListResponse,
} from '../../../shared/transport/events/channel-events.js'

import {ChannelEvents} from '../../../shared/transport/events/channel-events.js'
import {ChannelClientError, withChannelClient} from '../../lib/channel-client.js'

export default class ChannelList extends Command {
  public static description = 'List channels in the current project'
public static examples = [
    '<%= config.bin %> <%= command.id %>',
    '<%= config.bin %> <%= command.id %> --archived',
    '<%= config.bin %> <%= command.id %> --json',
  ]
public static flags = {
    archived: Flags.boolean({default: false, description: 'Include archived channels'}),
    json: Flags.boolean({default: false, description: 'Emit JSON instead of pretty output'}),
  }

  public async run(): Promise<void> {
    const {flags} = await this.parse(ChannelList)

    try {
      const response = await withChannelClient(async (client) =>
        client.request<ChannelListRequest, ChannelListResponse>(ChannelEvents.LIST, {
          archived: flags.archived,
        }),
      )

      if (flags.json) {
        this.log(JSON.stringify(response, undefined, 2))
        return
      }

      if (response.channels.length === 0) {
        this.log('(no channels in this project)')
        return
      }

      for (const c of response.channels) {
        const archived = c.archivedAt === undefined ? '' : ' [archived]'
        this.log(`#${c.channelId}${archived}  members:${c.memberCount}  ${c.title ?? ''}`)
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
