import {Args, Flags} from '@oclif/core'

import {ChannelEvents} from '../../../shared/transport/events/channel-events.js'
import {ChannelCommand} from '../../lib/channel-command.js'

export default class ChannelOnboard extends ChannelCommand {
  public static args = {
    handle: Args.string({description: "Agent handle to onboard (e.g. '@codex')", required: true}),
  }
public static description = 'Onboard an agent profile into a channel'
public static examples = ['<%= config.bin %> <%= command.id %> @codex --channel my-channel']
public static flags = {
    channel: Flags.string({description: 'Channel id to onboard the agent into', required: true}),
  }

  public async run(): Promise<void> {
    const {args, flags} = await this.parse(ChannelOnboard)
    await this.dispatch(ChannelEvents.ONBOARD, {channelId: flags.channel, handle: args.handle}, flags.json)
  }
}
