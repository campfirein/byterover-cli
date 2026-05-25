import {Args, Command, Flags} from '@oclif/core'

import type {
  ChannelPermissionDecisionRequest,
  ChannelPermissionDecisionResponse,
} from '../../../shared/transport/events/channel-events.js'

import {ChannelEvents} from '../../../shared/transport/events/channel-events.js'
import {ChannelClientError, withChannelClient} from '../../lib/channel-client.js'
import {resolveOptionId} from './approve.js'

export default class ChannelDeny extends Command {
  /* eslint-disable perfectionist/sort-objects -- oclif positional args are ORDER-sensitive */
  public static args = {
    channelId: Args.string({description: 'Channel handle', required: true}),
    turnId: Args.string({description: 'Turn id', required: true}),
    permissionId: Args.string({description: 'permissionRequestId from the permission_request event', required: true}),
  }
  /* eslint-enable perfectionist/sort-objects */
public static description = 'Deny a pending permission request via the first reject-flavoured option'
public static examples = [
    '<%= config.bin %> <%= command.id %> pi-test 01HX... 01HY...',
  ]
public static flags = {
    json: Flags.boolean({default: false, description: 'Emit JSON instead of pretty output'}),
  }

  public async run(): Promise<void> {
    const {args, flags} = await this.parse(ChannelDeny)

    try {
      const response = await withChannelClient(async (client) => {
        const optionId = await resolveOptionId({
          channelId: args.channelId,
          findKind: 'reject',
          permissionRequestId: args.permissionId,
          request: (event, data) => client.request(event, data),
          turnId: args.turnId,
        })

        return client.request<ChannelPermissionDecisionRequest, ChannelPermissionDecisionResponse>(
          ChannelEvents.PERMISSION_DECISION,
          {
            channelId: args.channelId,
            outcome: {optionId, outcome: 'selected'},
            permissionRequestId: args.permissionId,
            turnId: args.turnId,
          },
        )
      })

      if (flags.json) {
        this.log(JSON.stringify(response, undefined, 2))
        return
      }

      this.log('✓ denied')
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

    if (error instanceof Error) {
      this.logToStderr(error.message)
      this.exit(1)
    }

    throw error
  }
}
