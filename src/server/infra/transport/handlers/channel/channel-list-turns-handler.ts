import type {ITransportServer} from '../../../../core/interfaces/transport/index.js'
import type {ITransportHandler} from '../i-transport-handler.js'

import {
  ChannelEvents,
  ChannelListTurnsRequest,
  ChannelListTurnsRequestSchema,
  ChannelListTurnsResponse,
} from '../../../../../shared/transport/events/channel-events.js'
import {ChannelNotImplementedError} from '../../../../core/domain/channel/errors.js'
import {parseOrThrow} from './parse-or-throw.js'

/**
 * Handles `channel:list-turns`. `handle` validates the payload, then throws
 * {@link ChannelNotImplementedError}; the list-turns behavior lands in a later
 * milestone, written after the validation step in `handle`.
 */
export class ChannelListTurnsHandler
  implements ITransportHandler<ChannelListTurnsRequest, ChannelListTurnsResponse>
{
  private readonly event: string
  private readonly transportServer: ITransportServer

  public constructor(transportServer: ITransportServer) {
    this.event = ChannelEvents.LIST_TURNS
    this.transportServer = transportServer
  }

  public async handle(request: ChannelListTurnsRequest): Promise<ChannelListTurnsResponse> {
    parseOrThrow(ChannelListTurnsRequestSchema, request)
    throw new ChannelNotImplementedError(this.event)
  }

  public setup(): void {
    this.transportServer.onRequest<ChannelListTurnsRequest, ChannelListTurnsResponse>(
      this.event,
      (request) => this.handle(request),
    )
  }
}
