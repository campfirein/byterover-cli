import {Args, Command, Flags} from '@oclif/core'

import type {
  ChannelPostRequest,
  ChannelPostResponse,
} from '../../../shared/transport/events/channel-events.js'

import {ChannelEvents} from '../../../shared/transport/events/channel-events.js'
import {ChannelClientError, withChannelClient} from '../../lib/channel-client.js'

export default class ChannelPost extends Command {
  public static args = {
    channelId: Args.string({description: 'Channel handle to post into', required: true}),
    text: Args.string({description: 'Prompt text', required: true}),
  }
public static description = 'Post a passive turn into a channel (no agent dispatch)'
public static examples = [
    '<%= config.bin %> <%= command.id %> pi-test "this is a note for later"',
    '<%= config.bin %> <%= command.id %> pi-test "scripted note" --idempotency-key abc-1',
    '<%= config.bin %> <%= command.id %> pi-test "json mode" --json',
  ]
public static flags = {
    'idempotency-key': Flags.string({description: 'Optional dedupe key (CHANNEL_PROTOCOL.md §12)'}),
    json: Flags.boolean({default: false, description: 'Emit JSON instead of pretty output'}),
  }

  public async run(): Promise<void> {
    const {args, flags} = await this.parse(ChannelPost)

    try {
      const response = await withChannelClient(async (client) =>
        client.request<ChannelPostRequest, ChannelPostResponse>(ChannelEvents.POST, {
          channelId: args.channelId,
          idempotencyKey: flags['idempotency-key'],
          prompt: args.text,
        }),
      )

      if (flags.json) {
        this.log(JSON.stringify(response, undefined, 2))
        return
      }

      this.log(`turn ${response.turn.turnId} posted`)
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
