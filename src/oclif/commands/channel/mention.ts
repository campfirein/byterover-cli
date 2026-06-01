import {Args, Flags} from '@oclif/core'

import {ChannelEvents} from '../../../shared/transport/events/channel-events.js'
import {ChannelCommand} from '../../lib/channel-command.js'

export default class ChannelMention extends ChannelCommand {
  public static args = {
    channel: Args.string({description: 'Channel id', required: true}),
    prompt: Args.string({description: 'Prompt text; address agents with @mentions', required: true}),
  }
public static description = 'Send a prompt turn to a channel, addressing agents with @mentions'
public static examples = ['<%= config.bin %> <%= command.id %> my-channel "@codex review this" --json']
public static flags = {
    'idempotency-key': Flags.string({description: 'Key to dedupe a re-sent turn'}),
    mention: Flags.string({description: 'Agent handle to address (repeatable)', multiple: true}),
  }

  public async run(): Promise<void> {
    const {args, flags} = await this.parse(ChannelMention)
    await this.dispatch(
      ChannelEvents.MENTION,
      {channelId: args.channel, idempotencyKey: flags['idempotency-key'], mentions: flags.mention, prompt: args.prompt},
      flags.json,
    )
  }
}
