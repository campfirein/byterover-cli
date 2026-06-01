import {Args} from '@oclif/core'

import {ChannelEvents} from '../../../shared/transport/events/channel-events.js'
import {ChannelCommand} from '../../lib/channel-command.js'

export default class ChannelShow extends ChannelCommand {
  public static args = {
    channel: Args.string({description: 'Channel id', required: true}),
    turnId: Args.string({description: 'Turn id', required: true}),
  }
public static description = 'Show a turn and its events'
public static examples = ['<%= config.bin %> <%= command.id %> my-channel turn-123 --json']

  public async run(): Promise<void> {
    const {args, flags} = await this.parse(ChannelShow)
    await this.dispatch(ChannelEvents.SHOW, {channelId: args.channel, turnId: args.turnId}, flags.json)
  }
}
