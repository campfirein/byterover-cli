export interface ITransportHandler<Request, Response> {
  /**
   * Handles a validated request. `clientId` is supplied for project-scoped
   * handlers that resolve the caller's project; global handlers may ignore it.
   */
  handle(request: Request, clientId?: string): Promise<Response>
  setup(): void
}
