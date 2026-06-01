import {Args} from '@oclif/core'

import {ChannelEvents} from '../../../shared/transport/events/channel-events.js'
import {ChannelCommand} from '../../lib/channel-command.js'

export default class ChannelNew extends ChannelCommand {
  public static args = {
    name: Args.string({description: 'Name or title for the new channel'}),
  }
  public static description = 'Create a new channel'
  public static examples = ['<%= config.bin %> <%= command.id %> my-channel --json']

  public async run(): Promise<void> {
    const {args, flags} = await this.parse(ChannelNew)
    await this.dispatch(ChannelEvents.CREATE, {title: args.name}, flags.json)
  }
}
