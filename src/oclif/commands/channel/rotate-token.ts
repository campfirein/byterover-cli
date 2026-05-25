import {Command, Flags} from '@oclif/core'

import type {
  ChannelRotateTokenRequest,
  ChannelRotateTokenResponse,
} from '../../../shared/transport/events/channel-events.js'

import {ChannelEvents} from '../../../shared/transport/events/channel-events.js'
import {ChannelClientError, withChannelClient} from '../../lib/channel-client.js'

export default class ChannelRotateToken extends Command {
  public static description = 'Regenerate the daemon-auth-token (disconnects every active client — Phase 3)'
public static examples = ['<%= config.bin %> <%= command.id %> --yes']
public static flags = {
    json: Flags.boolean({default: false, description: 'Emit JSON instead of pretty output'}),
    yes: Flags.boolean({default: false, description: 'Confirm rotation (required — disconnects every active client)'}),
  }

  public async run(): Promise<void> {
    const {flags} = await this.parse(ChannelRotateToken)
    if (!flags.yes) {
      this.error(
        'rotate-token requires --yes (rotation disconnects every active channel client; no interactive prompt)',
        {exit: 1},
      )
    }

    try {
      const response = await withChannelClient(async (client) =>
        client.request<ChannelRotateTokenRequest, ChannelRotateTokenResponse>(
          ChannelEvents.ROTATE_TOKEN,
          {confirm: true},
        ),
      )

      if (flags.json) {
        this.log(JSON.stringify(response, undefined, 2))
        return
      }

      this.log(`✓ daemon-auth-token rotated (fingerprint: ${response.tokenFingerprint}, disconnected: ${response.disconnectedClients})`)
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
