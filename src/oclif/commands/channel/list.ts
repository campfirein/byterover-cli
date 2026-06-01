import {Flags} from '@oclif/core'

import {ChannelEvents} from '../../../shared/transport/events/channel-events.js'
import {ChannelCommand} from '../../lib/channel-command.js'

export default class ChannelList extends ChannelCommand {
  public static description = 'List channels'
public static examples = [
    '<%= config.bin %> <%= command.id %>',
    '<%= config.bin %> <%= command.id %> --archived --json',
  ]
public static flags = {
    archived: Flags.boolean({description: 'Include archived channels'}),
  }

  public async run(): Promise<void> {
    const {flags} = await this.parse(ChannelList)
    await this.dispatch(ChannelEvents.LIST, {archived: flags.archived}, flags.json)
  }
}
