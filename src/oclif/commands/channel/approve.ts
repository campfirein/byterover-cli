import {Args, Command, Flags} from '@oclif/core'

import type {
  ChannelGetTurnRequest,
  ChannelGetTurnResponse,
  ChannelPermissionDecisionRequest,
  ChannelPermissionDecisionResponse,
} from '../../../shared/transport/events/channel-events.js'

import {ChannelEvents} from '../../../shared/transport/events/channel-events.js'
import {ChannelClientError, withChannelClient} from '../../lib/channel-client.js'

export default class ChannelApprove extends Command {
  /* eslint-disable perfectionist/sort-objects -- oclif positional args are ORDER-sensitive */
  public static args = {
    channelId: Args.string({description: 'Channel handle', required: true}),
    turnId: Args.string({description: 'Turn id', required: true}),
    permissionId: Args.string({description: 'permissionRequestId from the permission_request event', required: true}),
  }
  /* eslint-enable perfectionist/sort-objects */
public static description = 'Approve a pending permission request (resolves to ACP { outcome: "selected", optionId })'
public static examples = [
    '<%= config.bin %> <%= command.id %> pi-test 01HX... 01HY...',
    '<%= config.bin %> <%= command.id %> pi-test 01HX... 01HY... --option-id opt-allow',
  ]
public static flags = {
    json: Flags.boolean({default: false, description: 'Emit JSON instead of pretty output'}),
    'option-id': Flags.string({description: 'Choose a specific optionId (default: first allow-flavoured option)'}),
  }

  public async run(): Promise<void> {
    const {args, flags} = await this.parse(ChannelApprove)

    try {
      const response = await withChannelClient(async (client) => {
        const optionId = await resolveOptionId({
          channelId: args.channelId,
          findKind: 'allow',
          permissionRequestId: args.permissionId,
          request: (event, data) => client.request(event, data),
          requestedOptionId: flags['option-id'],
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

      this.log('✓ approved')
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

export type OptionResolveArgs = {
  channelId: string
  findKind: 'allow' | 'reject'
  permissionRequestId: string
  request<TReq, TRes>(event: string, data: TReq): Promise<TRes>
  requestedOptionId?: string
  turnId: string
}

/**
 * Two-RPC lookup: fetch the original `RequestPermissionRequest.options` from
 * the persisted `permission_request` event, then pick an optionId by
 * `--option-id` override OR by `findKind` prefix (`allow*` for approve,
 * `reject*` for deny).
 */
export const resolveOptionId = async (args: OptionResolveArgs): Promise<string> => {
  const turn = await args.request<ChannelGetTurnRequest, ChannelGetTurnResponse>(
    ChannelEvents.GET_TURN,
    {channelId: args.channelId, turnId: args.turnId},
  )

  const permissionEvent = turn.events.find(
    (e) => e.kind === 'permission_request' && e.permissionRequestId === args.permissionRequestId,
  )
  if (permissionEvent === undefined) {
    throw new Error(
      `permission_request ${args.permissionRequestId} not found on turn ${args.turnId}; cannot resolve options.`,
    )
  }

  type Option = {kind?: string; optionId: string}
  const options = ((permissionEvent as unknown as {request: {options: Option[]}}).request.options ?? []) as Option[]

  if (args.requestedOptionId !== undefined) {
    const match = options.find((o) => o.optionId === args.requestedOptionId)
    if (match === undefined) {
      throw new Error(
        `optionId "${args.requestedOptionId}" is not in the permission request options [${options.map((o) => o.optionId).join(', ')}]`,
      )
    }

    return match.optionId
  }

  const fallback = options.find((o) => o.kind !== undefined && o.kind.startsWith(args.findKind))
  if (fallback === undefined) {
    if (args.findKind === 'reject') {
      throw new Error(
        `agent did not provide a reject option; use 'brv channel cancel ${args.channelId} ${args.turnId}' to abort the turn entirely`,
      )
    }

    throw new Error(`No ${args.findKind}-flavoured option in the permission request; specify --option-id explicitly.`)
  }

  return fallback.optionId
}
