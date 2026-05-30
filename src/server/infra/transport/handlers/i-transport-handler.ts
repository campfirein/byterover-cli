export interface ITransportHandler<Request, Response> {
  handle(request: Request): Promise<Response>
  setup(): void
}