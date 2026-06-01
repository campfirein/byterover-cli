import {Args, Flags} from '@oclif/core'

import {ChannelEvents} from '../../../shared/transport/events/channel-events.js'
import {ChannelCommand} from '../../lib/channel-command.js'

export default class ChannelInvite extends ChannelCommand {
  public static args = {
    channel: Args.string({description: 'Channel id', required: true}),
    handle: Args.string({description: "Agent handle to invite (e.g. '@codex')", required: true}),
  }
public static description = 'Invite an agent into a channel'
public static examples = ['<%= config.bin %> <%= command.id %> my-channel @codex --profile-name codex']
public static flags = {
    'profile-name': Flags.string({description: 'Driver profile to launch the agent with'}),
  }

  public async run(): Promise<void> {
    const {args, flags} = await this.parse(ChannelInvite)
    await this.dispatch(
      ChannelEvents.INVITE,
      {channelId: args.channel, handle: args.handle, profileName: flags['profile-name']},
      flags.json,
    )
  }
}
