import {Args, Flags} from '@oclif/core'

import type {ChannelInviteResponse} from '../../../shared/transport/events/channel-events.js'

import {ChannelEvents} from '../../../shared/transport/events/channel-events.js'
import {ChannelCommand} from '../../lib/channel-command.js'

export default class ChannelInvite extends ChannelCommand {
  public static args = {
    channel: Args.string({description: 'Channel id', required: true}),
    handle: Args.string({description: "Agent handle to invite (e.g. '@codex')", required: true}),
  }
  public static description = 'Invite an agent into a channel by profile or inline invocation'
  public static examples = [
    '<%= config.bin %> <%= command.id %> my-channel @codex --profile codex',
    '<%= config.bin %> <%= command.id %> my-channel @mock -- node test/fixtures/mock-acp.js',
  ]
  public static flags = {
    profile: Flags.string({description: 'Saved driver profile to launch the agent with'}),
  }
  // Accept an optional inline invocation after `--`.
  public static strict = false

  public async run(): Promise<void> {
    const {args, argv, flags} = await this.parse(ChannelInvite)
    const tail = argv.slice(2).filter((token): token is string => typeof token === 'string')
    const invocation = tail.length > 0 ? {args: tail.slice(1), command: tail[0], cwd: process.cwd()} : undefined

    await this.dispatchAndRender<ChannelInviteResponse>({
      asJson: flags.json,
      event: ChannelEvents.INVITE,
      payload: {channelId: args.channel, handle: args.handle, invocation, profileName: flags.profile},
      render: (response) => {
        const {member} = response
        const driver = member.memberKind === 'acp-agent' ? ` (driver: ${member.driverClass})` : ''
        this.log(`✓ ${member.handle} joined #${args.channel}${driver}`)
      },
    })
  }
}
