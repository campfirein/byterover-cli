import {type ITransportClient, TransportRequestError} from '@campfirein/brv-transport-client'

import {connectToDaemonClient, type DaemonClientOptions, formatConnectionError, withDaemonRetry} from './daemon-client.js'

/** Fallback wire code when a thrown error carries no channel-specific code. */
const CHANNEL_REQUEST_FAILED = 'CHANNEL_REQUEST_FAILED'
/** TransportRequestError appends this suffix to its message; strip it for display. */
const EVENT_SUFFIX_PATTERN = / for event '[^']+'$/

/** Daemon options a channel command forwards to the shared transport layer. */
export type ChannelClientOptions = Pick<
  DaemonClientOptions,
  'maxRetries' | 'projectPath' | 'projectRootFlag' | 'retryDelayMs' | 'transportConnector'
>

/** A channel-domain error surfaced to the CLI, carrying the wire `code`. */
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

/** Minimal channel request seam over the daemon transport. */
export interface ChannelClient {
  disconnect(): Promise<void>
  request<TResponse = unknown>(event: string, payload?: unknown): Promise<TResponse>
}

/**
 * Normalizes any thrown transport/daemon error into a {@link ChannelClientError}.
 * A daemon-thrown channel error arrives as a {@link TransportRequestError} whose
 * `code` is forwarded verbatim from the `{success, code, error}` ack envelope;
 * connection/spawn failures fall back to {@link formatConnectionError}.
 */
export function toChannelClientError(error: unknown): ChannelClientError {
  if (error instanceof ChannelClientError) return error
  if (error instanceof TransportRequestError) {
    return new ChannelClientError(error.code ?? CHANNEL_REQUEST_FAILED, error.message.replace(EVENT_SUFFIX_PATTERN, ''))
  }

  return new ChannelClientError(CHANNEL_REQUEST_FAILED, formatConnectionError(error))
}

function makeChannelClient(client: ITransportClient): ChannelClient {
  return {
    async disconnect(): Promise<void> {
      await client.disconnect()
    },
    request<TResponse = unknown>(event: string, payload?: unknown): Promise<TResponse> {
      return client.requestWithAck<TResponse>(event, payload)
    },
  }
}

/**
 * Connects to the daemon (auto-spawning it if needed) and returns a channel
 * client. The caller owns the lifecycle and must call `disconnect()`. Prefer
 * {@link withChannelClient} when the work is scoped to a single call.
 */
export async function connectChannelClient(options?: ChannelClientOptions): Promise<ChannelClient> {
  try {
    const {client} = await connectToDaemonClient(options)
    return makeChannelClient(client)
  } catch (error) {
    throw toChannelClientError(error)
  }
}

/**
 * Runs `fn` against a connected channel client, reusing the shared daemon
 * spawn/retry infrastructure ({@link withDaemonRetry}). Any thrown transport or
 * daemon error is normalized to a {@link ChannelClientError}.
 */
export async function withChannelClient<T>(
  fn: (client: ChannelClient) => Promise<T>,
  options?: ChannelClientOptions,
): Promise<T> {
  try {
    return await withDaemonRetry<T>((client) => fn(makeChannelClient(client)), options)
  } catch (error) {
    throw toChannelClientError(error)
  }
}
