import {Args, Command, Flags} from '@oclif/core'

import type {
  ChannelListTurnsRequest,
  ChannelListTurnsResponse,
} from '../../../shared/transport/events/channel-events.js'

import {ChannelEvents} from '../../../shared/transport/events/channel-events.js'
import {ChannelClientError, withChannelClient} from '../../lib/channel-client.js'

export default class ChannelListTurns extends Command {
  public static args = {
    channelId: Args.string({description: 'Channel handle', required: true}),
  }
public static description = 'List turns posted to a channel (most recent first)'
public static examples = [
    '<%= config.bin %> <%= command.id %> pi-test',
    '<%= config.bin %> <%= command.id %> pi-test --tail 5',
    '<%= config.bin %> <%= command.id %> pi-test --tail 1 --json',
  ]
public static flags = {
    cursor: Flags.string({description: 'Opaque pagination cursor from a prior response'}),
    json: Flags.boolean({default: false, description: 'Emit JSON instead of pretty output'}),
    tail: Flags.integer({
      description: 'Return at most N most-recent turns',
      min: 1,
    }),
  }

  public async run(): Promise<void> {
    const {args, flags} = await this.parse(ChannelListTurns)

    try {
      const response = await withChannelClient(async (client) =>
        client.request<ChannelListTurnsRequest, ChannelListTurnsResponse>(
          ChannelEvents.LIST_TURNS,
          {
            channelId: args.channelId,
            cursor: flags.cursor,
            limit: flags.tail,
          },
        ),
      )

      if (flags.json) {
        this.log(JSON.stringify(response, undefined, 2))
        return
      }

      if (response.turns.length === 0) {
        this.log('(no turns)')
        return
      }

      for (const t of response.turns) {
        const author = t.author.kind === 'local-user' ? '@you' : t.author.handle
        const firstBlock = t.promptBlocks[0]
        const preview =
          firstBlock !== undefined && firstBlock.type === 'text'
            ? firstBlock.text.replaceAll('\n', ' ').slice(0, 60)
            : '[structured]'
        this.log(`${t.turnId}  ${author}  (${t.state})  ${preview}`)
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
