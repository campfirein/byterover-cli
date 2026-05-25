/**
 * Client-side error envelope. Maps 1:1 to the brv daemon's socket.io
 * ack response shape `{success: false, code, error, details}` per
 * `CHANNEL_PROTOCOL.md` §11.
 */
export class ChannelClientError extends Error {
  public readonly code: string
  public readonly details?: unknown

  public constructor(code: string, message: string, details?: unknown) {
    super(message)
    this.name = 'ChannelClientError'
    this.code = code
    this.details = details
  }
}

/** Sentinel codes the client itself can emit (vs daemon-side codes). */
export const CHANNEL_CLIENT_ERROR_CODE = {
  /** Daemon hasn't been started yet — no `daemon.json` / token file on disk. */
  DAEMON_NOT_INITIALISED: 'BRV_DAEMON_NOT_INITIALISED',
  /** Socket.IO connection failed (daemon down, wrong port, network). */
  CONNECT_FAILED: 'BRV_CHANNEL_CONNECT_FAILED',
  /** Daemon never acked a request inside `BRV_CHANNEL_REQUEST_TIMEOUT_MS`. */
  REQUEST_TIMEOUT: 'CHANNEL_REQUEST_TIMEOUT',
  /** Daemon returned a malformed ack envelope. */
  MALFORMED_RESPONSE: 'CHANNEL_REQUEST_FAILED',
} as const

export type ChannelClientErrorCode = (typeof CHANNEL_CLIENT_ERROR_CODE)[keyof typeof CHANNEL_CLIENT_ERROR_CODE]
