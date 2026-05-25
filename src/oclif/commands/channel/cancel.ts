import {Args, Command, Flags} from '@oclif/core'

import type {
  ChannelCancelRequest,
  ChannelCancelResponse,
} from '../../../shared/transport/events/channel-events.js'

import {ChannelEvents} from '../../../shared/transport/events/channel-events.js'
import {ChannelClientError, withChannelClient} from '../../lib/channel-client.js'

export default class ChannelCancel extends Command {
  public static args = {
    channelId: Args.string({description: 'Channel handle', required: true}),
    turnId: Args.string({description: 'Turn id to cancel', required: true}),
  }
public static description = 'Cancel an in-flight channel turn (full-turn or per-delivery)'
public static examples = [
    '<%= config.bin %> <%= command.id %> pi-test 01HX...',
    '<%= config.bin %> <%= command.id %> pi-test 01HX... --delivery 01HY...',
  ]
public static flags = {
    delivery: Flags.string({description: 'Cancel a single delivery instead of the full turn'}),
    json: Flags.boolean({default: false, description: 'Emit JSON instead of pretty output'}),
  }

  public async run(): Promise<void> {
    const {args, flags} = await this.parse(ChannelCancel)

    try {
      const response = await withChannelClient(async (client) =>
        client.request<ChannelCancelRequest, ChannelCancelResponse>(ChannelEvents.CANCEL, {
          channelId: args.channelId,
          deliveryId: flags.delivery,
          turnId: args.turnId,
        }),
      )

      if (flags.json) {
        this.log(JSON.stringify(response, undefined, 2))
        return
      }

      this.log(`✓ ${flags.delivery === undefined ? 'turn' : 'delivery'} cancelled`)
    } catch (error) {
      this.handleError(error, flags.json)
    }
  }

  private handleError(error: unknown, asJson: boolean): never {
    if (error instanceof ChannelClientError) {
      if (asJson) {
        this.log(JSON.stringify({code: error.code, error: error.message, success: false}))
      } else {
        this.logToStderr(`[${error.code}] ${error.message}`)
      }

      this.exit(1)
    }

    throw error
  }
}
