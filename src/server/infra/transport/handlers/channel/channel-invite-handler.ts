import type {IChannelOrchestrator} from '../../../../core/interfaces/channel/i-channel-orchestrator.js'
import type {ITransportServer} from '../../../../core/interfaces/transport/index.js'
import type {ProjectPathResolver} from '../handler-types.js'
import type {ITransportHandler} from '../i-transport-handler.js'

import {
  ChannelEvents,
  type ChannelInviteRequest,
  ChannelInviteRequestSchema,
  type ChannelInviteResponse,
} from '../../../../../shared/transport/events/channel-events.js'
import {resolveRequiredProjectPath} from '../handler-types.js'
import {parseOrThrow} from './parse-or-throw.js'

export type ChannelInviteHandlerDeps = {
  readonly getOrchestrator: (projectRoot: string) => IChannelOrchestrator
  readonly resolveProjectPath: ProjectPathResolver
  readonly transport: ITransportServer
}

/** Handles `channel:invite` by spawning + registering the agent's driver. */
export class ChannelInviteHandler implements ITransportHandler<ChannelInviteRequest, ChannelInviteResponse> {
  private readonly deps: ChannelInviteHandlerDeps
  private readonly event = ChannelEvents.INVITE

  public constructor(deps: ChannelInviteHandlerDeps) {
    this.deps = deps
  }

  public async handle(request: ChannelInviteRequest, clientId: string): Promise<ChannelInviteResponse> {
    const valid = parseOrThrow(ChannelInviteRequestSchema, request)
    const projectRoot = resolveRequiredProjectPath(this.deps.resolveProjectPath, clientId)
    const member = await this.deps.getOrchestrator(projectRoot).inviteMember({
      channelId: valid.channelId,
      handle: valid.handle,
      invocation: valid.invocation,
      profileName: valid.profileName,
    })
    return {member}
  }

  public setup(): void {
    this.deps.transport.onRequest<ChannelInviteRequest, ChannelInviteResponse>(this.event, (request, clientId) =>
      this.handle(request, clientId),
    )
  }
}
