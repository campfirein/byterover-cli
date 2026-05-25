import {Command, Flags} from '@oclif/core'

import type {
  ChannelProfileListRequest,
  ChannelProfileListResponse,
} from '../../../../shared/transport/events/channel-events.js'

import {ChannelEvents} from '../../../../shared/transport/events/channel-events.js'
import {ChannelClientError, withChannelClient} from '../../../lib/channel-client.js'

export default class ChannelProfileList extends Command {
  public static description = 'List persisted driver profiles (Phase 3)'
public static examples = ['<%= config.bin %> <%= command.id %>', '<%= config.bin %> <%= command.id %> --json']
public static flags = {
    json: Flags.boolean({default: false, description: 'Emit JSON instead of pretty output'}),
  }

  public async run(): Promise<void> {
    const {flags} = await this.parse(ChannelProfileList)
    try {
      const response = await withChannelClient(async (client) =>
        client.request<ChannelProfileListRequest, ChannelProfileListResponse>(
          ChannelEvents.PROFILE_LIST,
          {},
        ),
      )

      if (flags.json) {
        this.log(JSON.stringify(response, undefined, 2))
        return
      }

      if (response.profiles.length === 0) {
        this.log('No driver profiles. Run `brv channel onboard <name> -- <command>` to add one.')
        return
      }

      for (const p of response.profiles) {
        const caps = p.capabilities?.length ? ` capabilities=[${p.capabilities.join(', ')}]` : ''
        this.log(`  ${p.name} (class: ${p.driverClass}, ${p.displayName})${caps}`)
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
