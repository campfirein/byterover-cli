import {Args, Command, Flags} from '@oclif/core'

import type {
  ChannelGetTurnRequest,
  ChannelGetTurnResponse,
} from '../../../shared/transport/events/channel-events.js'

import {ChannelEvents} from '../../../shared/transport/events/channel-events.js'
import {ChannelClientError, withChannelClient} from '../../lib/channel-client.js'

export default class ChannelShow extends Command {
  public static args = {
    channelId: Args.string({description: 'Channel handle', required: true}),
    turnId: Args.string({description: 'Turn id to display', required: true}),
  }
public static description = 'Show a single turn with its full event stream'
public static examples = [
    '<%= config.bin %> <%= command.id %> pi-test 01HX...',
    '<%= config.bin %> <%= command.id %> pi-test 01HX... --json',
  ]
public static flags = {
    json: Flags.boolean({default: false, description: 'Emit JSON instead of pretty output'}),
  }

  public async run(): Promise<void> {
    const {args, flags} = await this.parse(ChannelShow)

    try {
      const response = await withChannelClient(async (client) =>
        client.request<ChannelGetTurnRequest, ChannelGetTurnResponse>(ChannelEvents.GET_TURN, {
          channelId: args.channelId,
          turnId: args.turnId,
        }),
      )

      if (flags.json) {
        this.log(JSON.stringify(response, undefined, 2))
        return
      }

      const {turn} = response
      const author = turn.author.kind === 'local-user' ? '@you' : turn.author.handle
      this.log(`turn ${turn.turnId} — ${author} (${turn.state})`)
      for (const block of turn.promptBlocks) {
        if (block.type === 'text') {
          this.log(`  ${block.text}`)
        } else {
          this.log(`  [${block.type}]`)
        }
      }
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
