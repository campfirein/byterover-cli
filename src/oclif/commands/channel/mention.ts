import {Args, Flags} from '@oclif/core'

import type {ChannelMentionResponse} from '../../../shared/transport/events/channel-events.js'

import {ChannelEvents} from '../../../shared/transport/events/channel-events.js'
import {ChannelCommand} from '../../lib/channel-command.js'

export default class ChannelMention extends ChannelCommand {
  public static args = {
    channel: Args.string({description: 'Channel id', required: true}),
    prompt: Args.string({description: 'Prompt text; address agents with @mentions', required: true}),
  }
  public static description = 'Send a prompt turn to a channel, addressing agents with @mentions'
  public static examples = ['<%= config.bin %> <%= command.id %> my-channel "@codex review this" --mode sync --json']
  public static flags = {
    mention: Flags.string({description: 'Agent handle to address (repeatable)', multiple: true}),
    mode: Flags.string({default: 'sync', description: 'Dispatch mode', options: ['async', 'sync']}),
    'suppress-thoughts': Flags.boolean({description: 'Drop agent thinking from the wire and transcript'}),
  }

  public async run(): Promise<void> {
    const {args, flags} = await this.parse(ChannelMention)
    await this.dispatchAndRender<ChannelMentionResponse>({
      asJson: flags.json,
      event: ChannelEvents.MENTION,
      payload: {
        channelId: args.channel,
        mentions: flags.mention,
        mode: flags.mode,
        prompt: args.prompt,
        suppressThoughts: flags['suppress-thoughts'],
      },
      render: (response) => {
        if (response.kind === 'sync') {
          this.log(response.result.finalAnswer)
          return
        }

        this.log(`✓ Turn ${response.turn.turnId} dispatched`)
      },
      // In sync mode emit the bare result so callers parse `{endedState, finalAnswer, …}`.
      toJson: (response) => (response.kind === 'sync' ? response.result : response),
    })
  }
}
