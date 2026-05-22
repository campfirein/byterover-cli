import {Args, Command, Flags} from '@oclif/core'

import type {
  ChannelUninviteRequest,
  ChannelUninviteResponse,
} from '../../../shared/transport/events/channel-events.js'

import {ChannelEvents} from '../../../shared/transport/events/channel-events.js'
import {ChannelClientError, withChannelClient} from '../../lib/channel-client.js'

export default class ChannelUninvite extends Command {
  public static args = {
    channelId: Args.string({description: 'Channel handle', required: true}),
    handle: Args.string({description: 'Member handle to uninvite (must start with @)', required: true}),
  }
public static description =
    'Remove an agent member from a channel. Cancels any in-flight deliveries to that member, releases the warm driver from the pool, and drops the membership row. The channel and its other members are unaffected. Common operator use case: a remote-peer member whose libp2p multiaddr has gone stale (e.g. the peer\'s daemon restarted and re-randomised its TCP port) — uninvite + re-invite with the fresh multiaddr is faster than re-creating the whole channel.'
public static examples = [
    '<%= config.bin %> <%= command.id %> pi-test @mock',
    '<%= config.bin %> <%= command.id %> pi-test @mock --json',
    '# Drop a stale remote-peer after the peer\'s daemon restarted on a new libp2p port:',
    '<%= config.bin %> <%= command.id %> team-review @bob',
  ]
public static flags = {
    json: Flags.boolean({default: false, description: 'Emit JSON instead of pretty output'}),
  }

  public async run(): Promise<void> {
    const {args, flags} = await this.parse(ChannelUninvite)
    if (!args.handle.startsWith('@')) {
      this.error(`Member handle must start with @ (got "${args.handle}")`, {exit: 1})
    }

    try {
      const response = await withChannelClient(async (client) =>
        client.request<ChannelUninviteRequest, ChannelUninviteResponse>(ChannelEvents.UNINVITE, {
          channelId: args.channelId,
          memberHandle: args.handle,
        }),
      )

      if (flags.json) {
        this.log(JSON.stringify(response, undefined, 2))
        return
      }

      this.log(`✓ Member ${args.handle} left #${args.channelId}`)
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
