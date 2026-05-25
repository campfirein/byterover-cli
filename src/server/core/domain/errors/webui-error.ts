export class WebUiError extends Error {
  public constructor(message: string) {
    super(message)
    this.name = 'WebUiError'
  }
}

export class WebUiPortInUseError extends WebUiError {
  public readonly port: number

  public constructor(port: number) {
    super(`Web UI port ${port} is already in use`)
    this.name = 'WebUiPortInUseError'
    this.port = port
  }
}
