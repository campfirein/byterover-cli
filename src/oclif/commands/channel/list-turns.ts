import {Args, Flags} from '@oclif/core'

import {ChannelEvents} from '../../../shared/transport/events/channel-events.js'
import {ChannelCommand} from '../../lib/channel-command.js'

export default class ChannelListTurns extends ChannelCommand {
  public static args = {
    channel: Args.string({description: 'Channel id', required: true}),
  }
public static description = 'List turns in a channel'
public static examples = ['<%= config.bin %> <%= command.id %> my-channel --limit 20 --json']
public static flags = {
    cursor: Flags.string({description: 'Pagination cursor from a previous page'}),
    limit: Flags.integer({description: 'Maximum number of turns to return'}),
  }

  public async run(): Promise<void> {
    const {args, flags} = await this.parse(ChannelListTurns)
    await this.dispatch(
      ChannelEvents.LIST_TURNS,
      {channelId: args.channel, cursor: flags.cursor, limit: flags.limit},
      flags.json,
    )
  }
}
