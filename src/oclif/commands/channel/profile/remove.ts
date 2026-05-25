import {Args, Command, Flags} from '@oclif/core'

import type {
  ChannelProfileRemoveRequest,
  ChannelProfileRemoveResponse,
} from '../../../../shared/transport/events/channel-events.js'

import {ChannelEvents} from '../../../../shared/transport/events/channel-events.js'
import {ChannelClientError, withChannelClient} from '../../../lib/channel-client.js'

export default class ChannelProfileRemove extends Command {
  public static args = {
    name: Args.string({description: 'Profile name', required: true}),
  }
public static description = 'Remove a driver profile by name (idempotent — Phase 3)'
public static examples = ['<%= config.bin %> <%= command.id %> mock']
public static flags = {
    json: Flags.boolean({default: false, description: 'Emit JSON instead of pretty output'}),
  }

  public async run(): Promise<void> {
    const {args, flags} = await this.parse(ChannelProfileRemove)
    try {
      const response = await withChannelClient(async (client) =>
        client.request<ChannelProfileRemoveRequest, ChannelProfileRemoveResponse>(
          ChannelEvents.PROFILE_REMOVE,
          {name: args.name},
        ),
      )

      if (flags.json) {
        this.log(JSON.stringify(response, undefined, 2))
        return
      }

      this.log(response.removed
        ? `✓ Profile \`${args.name}\` removed.`
        : `Profile \`${args.name}\` was not in the registry — nothing to do.`)
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
