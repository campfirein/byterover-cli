import type {IChannelOrchestrator} from '../../../../core/interfaces/channel/i-channel-orchestrator.js'
import type {ITransportServer} from '../../../../core/interfaces/transport/index.js'
import type {ProjectPathResolver} from '../handler-types.js'
import type {ITransportHandler} from '../i-transport-handler.js'

import {
  ChannelEvents,
  type ChannelMentionRequest,
  ChannelMentionRequestSchema,
  type ChannelMentionResponse,
} from '../../../../../shared/transport/events/channel-events.js'
import {resolveRequiredProjectPath} from '../handler-types.js'
import {parseOrThrow} from './parse-or-throw.js'

export type ChannelMentionHandlerDeps = {
  readonly getOrchestrator: (projectRoot: string) => IChannelOrchestrator
  readonly resolveProjectPath: ProjectPathResolver
  readonly transport: ITransportServer
}

/**
 * Handles `channel:mention`. Dispatches the turn, then — in `sync` mode —
 * blocks on the assembled result before returning it.
 */
export class ChannelMentionHandler implements ITransportHandler<ChannelMentionRequest, ChannelMentionResponse> {
  private readonly deps: ChannelMentionHandlerDeps
  private readonly event = ChannelEvents.MENTION

  public constructor(deps: ChannelMentionHandlerDeps) {
    this.deps = deps
  }

  public async handle(request: ChannelMentionRequest, clientId: string): Promise<ChannelMentionResponse> {
    const valid = parseOrThrow(ChannelMentionRequestSchema, request)
    const projectRoot = resolveRequiredProjectPath(this.deps.resolveProjectPath, clientId)
    const orchestrator = this.deps.getOrchestrator(projectRoot)
    const mode = valid.mode ?? 'sync'

    const dispatch = await orchestrator.dispatchMention({
      channelId: valid.channelId,
      idempotencyKey: valid.idempotencyKey,
      mentions: valid.mentions,
      mode,
      prompt: valid.prompt,
      promptBlocks: valid.promptBlocks,
      suppressThoughts: valid.suppressThoughts,
      timeoutMs: valid.timeoutMs,
    })

    if (mode === 'sync') {
      const result = await orchestrator.awaitSyncMention(dispatch.turn.turnId)
      return {kind: 'sync', result}
    }

    return {kind: 'accepted', turn: dispatch.turn}
  }

  public setup(): void {
    this.deps.transport.onRequest<ChannelMentionRequest, ChannelMentionResponse>(this.event, (request, clientId) =>
      this.handle(request, clientId),
    )
  }
}
