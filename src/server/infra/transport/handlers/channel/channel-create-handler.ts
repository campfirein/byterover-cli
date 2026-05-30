import type {ITransportServer} from "../../../../core/interfaces/transport/index.js";
import type {ITransportHandler} from "../i-transport-handler.js";

import {type ChannelCreateRequest, ChannelCreateRequestSchema, type ChannelCreateResponse, ChannelEvents} from "../../../../../shared/transport/events/channel-events.js";
import {ChannelNotImplementedError} from "../../../../core/domain/channel/errors.js";
import {parseOrThrow} from "./parse-or-throw.js";

export class ChannelCreateHandler implements ITransportHandler<ChannelCreateRequest, ChannelCreateResponse> {
  private readonly event: string
  private readonly transportServer: ITransportServer

  public constructor(transportServer: ITransportServer) {
    this.event = ChannelEvents.CREATE
    this.transportServer = transportServer
  }

  public async handle(request: ChannelCreateRequest): Promise<ChannelCreateResponse> {
    parseOrThrow(ChannelCreateRequestSchema, request)
    throw new ChannelNotImplementedError(this.event)
  }

  public setup(): void {
    this.transportServer.onRequest<ChannelCreateRequest, ChannelCreateResponse>(this.event, request => this.handle(request))
  }
}