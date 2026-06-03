/**
 * Canonical wire codes for channel-domain errors.
 *
 * The daemon transport forwards a thrown {@link ChannelError}'s `code` verbatim
 * in its `{success: false, code, error}` envelope, so these strings are part of
 * the client-facing contract. Trimmed to the codes the skeleton needs; more
 * land with the milestones that introduce them.
 */
export const CHANNEL_ERROR_CODE = {
  ACP_SESSION_FAILED: 'CHANNEL_ACP_SESSION_FAILED',
  AGENT_BINARY_NOT_FOUND: 'CHANNEL_AGENT_BINARY_NOT_FOUND',
  AGENT_HANDSHAKE_FAILED: 'CHANNEL_AGENT_HANDSHAKE_FAILED',
  DELIVERY_FAILED: 'CHANNEL_DELIVERY_FAILED',
  DISABLED: 'CHANNEL_DISABLED',
  DRIVER_NOT_REGISTERED: 'CHANNEL_DRIVER_NOT_REGISTERED',
  DRIVER_PROFILE_NOT_FOUND: 'CHANNEL_DRIVER_PROFILE_NOT_FOUND',
  INVALID_REQUEST: 'CHANNEL_INVALID_REQUEST',
  MENTION_EMPTY: 'CHANNEL_MENTION_EMPTY',
  NOT_FOUND: 'CHANNEL_NOT_FOUND',
  NOT_IMPLEMENTED: 'CHANNEL_NOT_IMPLEMENTED',
  SYNC_TIMEOUT: 'CHANNEL_SYNC_TIMEOUT'
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

/** Signals that an agent spawned + initialized but its `session/new` probe failed. */
export class AcpSessionFailedError extends ChannelError {
  public constructor(reason: string) {
    super(reason, CHANNEL_ERROR_CODE.ACP_SESSION_FAILED)
    this.name = 'AcpSessionFailedError'
  }
}

/** Signals that no channel exists for the requested id. */
export class ChannelNotFoundError extends ChannelError {
  public constructor(channelId: string) {
    super(`channel #${channelId} not found`, CHANNEL_ERROR_CODE.NOT_FOUND, {channelId})
    this.name = 'ChannelNotFoundError'
  }
}

/** Signals that a mention resolved to no addressable channel member. */
export class ChannelMentionEmptyError extends ChannelError {
  public constructor() {
    super(
      'no addressable member was mentioned (address an agent with @handle)',
      CHANNEL_ERROR_CODE.MENTION_EMPTY,
    )
    this.name = 'ChannelMentionEmptyError'
  }
}

/** Signals that `invite --profile <name>` referenced a profile that does not exist. */
export class AgentDriverProfileNotFoundError extends ChannelError {
  public constructor(profileName: string) {
    super(
      `driver profile '${profileName}' not found (run: brv channel onboard ${profileName} -- <command>)`,
      CHANNEL_ERROR_CODE.DRIVER_PROFILE_NOT_FOUND,
      {profileName},
    )
    this.name = 'AgentDriverProfileNotFoundError'
  }
}

/** Signals that a synchronous mention exceeded its wait budget before completing. */
export class ChannelSyncTimeoutError extends ChannelError {
  public constructor(turnId: string, timeoutMs: number) {
    super(
      `synchronous mention for turn ${turnId} timed out after ${timeoutMs}ms`,
      CHANNEL_ERROR_CODE.SYNC_TIMEOUT,
      {timeoutMs, turnId},
    )
    this.name = 'ChannelSyncTimeoutError'
  }
}

/**
 * Signals that a turn reached a terminal state with a failed delivery, so the
 * synchronous caller gets a real failure instead of a misleading empty answer.
 */
export class ChannelDeliveryFailedError extends ChannelError {
  public constructor(turnId: string, details?: unknown) {
    super(`delivery failed for turn ${turnId}`, CHANNEL_ERROR_CODE.DELIVERY_FAILED, details)
    this.name = 'ChannelDeliveryFailedError'
  }
}