/**
 * Canonical wire codes for channel-domain errors.
 *
 * The daemon transport forwards a thrown {@link ChannelError}'s `code` verbatim
 * in its `{success: false, code, error}` envelope, so these strings are part of
 * the client-facing contract. Trimmed to the codes the skeleton needs; more
 * land with the milestones that introduce them.
 */
export const CHANNEL_ERROR_CODE = {
  AGENT_BINARY_NOT_FOUND: 'CHANNEL_AGENT_BINARY_NOT_FOUND',
  AGENT_HANDSHAKE_FAILED: 'CHANNEL_AGENT_HANDSHAKE_FAILED',
  DISABLED: 'CHANNEL_DISABLED',
  INVALID_REQUEST: 'CHANNEL_INVALID_REQUEST',
  NOT_IMPLEMENTED: 'CHANNEL_NOT_IMPLEMENTED'
} as const

/**
 * Represents any channel-domain error. Carries the canonical wire `code` and
 * optional structured `details` for the transport error envelope.
 */
export class ChannelError extends Error {
  public readonly code: string
  public readonly details?: unknown

  public constructor(message: string, code: string, details?: unknown) {
    super(message)
    this.name = 'ChannelError'
    this.code = code
    this.details = details
  }
}

/**
 * Signals that a `channel:*` event is registered but has no behavior yet. The
 * skeleton throws this from every handler once the payload validates, so the
 * wire surface stays stable while later milestones supply behavior.
 */
export class ChannelNotImplementedError extends ChannelError {
  public constructor(event?: string) {
    super(
      event === undefined
        ? 'channel operation is not implemented yet'
        : `channel operation '${event}' is not implemented yet`,
      CHANNEL_ERROR_CODE.NOT_IMPLEMENTED
    )
    this.name = 'ChannelNotImplementedError'
  }
}

/**
 * Signals that the channel surface is administratively disabled on this host
 * (`BRV_CHANNELS_ENABLED` is set to a falsy value). A stub throwing this is
 * registered for every `channel:*` event so the Socket.IO ack still fires
 * instead of hanging.
 */
export class ChannelDisabledError extends ChannelError {
  public constructor(message?: string) {
    super(
      message ??
        'channel surface is disabled on this host (BRV_CHANNELS_ENABLED is set to a falsy value)',
      CHANNEL_ERROR_CODE.DISABLED,
    )
    this.name = 'ChannelDisabledError'
  }
}

/**
 * Signals that a request payload failed schema validation at the wire boundary.
 * `details` carries the flattened zod error so clients can surface specific
 * field problems.
 */
export class ChannelInvalidRequestError extends ChannelError {
  public constructor(message: string, details?: unknown) {
    super(message, CHANNEL_ERROR_CODE.INVALID_REQUEST, details)
    this.name = 'ChannelInvalidRequestError'
  }
}

/**
 * Signals that an agent binary could not be spawned because the executable was
 * not found (`spawn … ENOENT`). Driver-agnostic by design: the raw Node error
 * is cryptic at the CLI surface, so a concrete driver translates ENOENT into
 * this typed error carrying the offending `command`. Kept ACP-free so any
 * future driver (headless adapter, remote peer) can raise the same shape.
 */
export class AgentBinaryNotFoundError extends ChannelError {
  public constructor(command: string) {
    super(
      `agent binary not found: '${command}' (is it installed and on PATH?)`,
      CHANNEL_ERROR_CODE.AGENT_BINARY_NOT_FOUND,
      {command},
    )
    this.name = 'AgentBinaryNotFoundError'
  }
}

/**
 * Signals that an agent failed its startup handshake — it spawned but did not
 * complete the driver's initialize exchange (no response within the timeout, a
 * transport error, or a protocol-level rejection). Carries the member `handle`
 * and a human-readable `reason`. Driver-agnostic so local and remote drivers
 * report startup failures uniformly.
 */
export class AgentHandshakeFailedError extends ChannelError {
  public constructor(handle: string, reason: string) {
    super(
      `agent '${handle}' failed its startup handshake: ${reason}`,
      CHANNEL_ERROR_CODE.AGENT_HANDSHAKE_FAILED,
      {handle, reason},
    )
    this.name = 'AgentHandshakeFailedError'
  }
}