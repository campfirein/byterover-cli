import {Args, Flags} from '@oclif/core'

import type {ChannelCreateResponse} from '../../../shared/transport/events/channel-events.js'

import {ChannelEvents} from '../../../shared/transport/events/channel-events.js'
import {ChannelCommand} from '../../lib/channel-command.js'

export default class ChannelNew extends ChannelCommand {
  public static args = {
    name: Args.string({description: 'Channel id (a fresh id is generated when omitted)'}),
  }
  public static description = 'Create a new channel'
  public static examples = ['<%= config.bin %> <%= command.id %> my-channel']
  public static flags = {
    title: Flags.string({description: 'Human-readable channel title'}),
  }

  public async run(): Promise<void> {
    const {args, flags} = await this.parse(ChannelNew)
    await this.dispatchAndRender<ChannelCreateResponse>({
      asJson: flags.json,
      event: ChannelEvents.CREATE,
      payload: {channelId: args.name, title: flags.title},
      render: (response) => {
        this.log(`✓ Channel #${response.channel.channelId} created`)
      },
    })
  }
}
