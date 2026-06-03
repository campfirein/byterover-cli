import type {IChannelOrchestrator} from '../../../../core/interfaces/channel/i-channel-orchestrator.js'
import type {ITransportServer} from '../../../../core/interfaces/transport/index.js'
import type {ProjectPathResolver} from '../handler-types.js'
import type {ITransportHandler} from '../i-transport-handler.js'

import {
  type ChannelCreateRequest,
  ChannelCreateRequestSchema,
  type ChannelCreateResponse,
  ChannelEvents,
} from '../../../../../shared/transport/events/channel-events.js'
import {resolveRequiredProjectPath} from '../handler-types.js'
import {parseOrThrow} from './parse-or-throw.js'

export type ChannelCreateHandlerDeps = {
  readonly getOrchestrator: (projectRoot: string) => IChannelOrchestrator
  readonly resolveProjectPath: ProjectPathResolver
  readonly transport: ITransportServer
}

/** Handles `channel:create` by creating a channel via the project's orchestrator. */
export class ChannelCreateHandler implements ITransportHandler<ChannelCreateRequest, ChannelCreateResponse> {
  private readonly deps: ChannelCreateHandlerDeps
  private readonly event = ChannelEvents.CREATE

  public constructor(deps: ChannelCreateHandlerDeps) {
    this.deps = deps
  }

  public async handle(request: ChannelCreateRequest, clientId: string): Promise<ChannelCreateResponse> {
    const valid = parseOrThrow(ChannelCreateRequestSchema, request)
    const projectRoot = resolveRequiredProjectPath(this.deps.resolveProjectPath, clientId)
    const channel = await this.deps.getOrchestrator(projectRoot).createChannel({
      channelId: valid.channelId,
      title: valid.title,
    })
    return {channel}
  }

  public setup(): void {
    this.deps.transport.onRequest<ChannelCreateRequest, ChannelCreateResponse>(this.event, (request, clientId) =>
      this.handle(request, clientId),
    )
  }
}
