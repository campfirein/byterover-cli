import {io, type Socket} from 'socket.io-client'

import {discoverDaemon, type DiscoverDaemonOptions} from './discovery.js'
import {CHANNEL_CLIENT_ERROR_CODE, ChannelClientError} from './errors.js'

/**
 * TS client for the brv channel-protocol wire surface.
 *
 * Use this from any Node host (Pi extension, kimi-cli wrapper, custom
 * CLI, etc.) to drive `channel:*` requests and subscribe to `channel:*`
 * broadcasts. The client does NOT spawn the brv daemon — it expects one
 * to be running already (`brv channel list` once on first use).
 *
 * @example
 * ```typescript
 * const client = await ChannelClient.connect()
 * try {
 *   const {channels} = await client.request('channel:list', {})
 *   console.log(channels)
 * } finally {
 *   await client.close()
 * }
 * ```
 */

/**
 * Slice 8.0 — typed options for {@link ChannelClient.mention}. Mirrors the
 * `channel:mention` wire schema in `src/shared/transport/events/channel-events.ts`.
 */
export type ChannelMentionOptions = {
  readonly channelId: string
  readonly prompt: string
  /** Default: `'stream'`. `'sync'` makes the ack wait for terminal + return finalAnswer. */
  readonly mode?: 'stream' | 'sync'
  /** Default: `false`. Drops `agent_thought_chunk` events at the daemon. */
  readonly suppressThoughts?: boolean
  /** Sync-mode timeout in milliseconds. Default: 300_000. Ignored when `mode === 'stream'`. */
  readonly timeout?: number
}

/** Stream-mode ack: the §8.4 `ChannelTurnAcceptedResponse` shape. */
export type ChannelMentionStreamAck = {
  readonly turn: {readonly turnId: string; readonly channelId: string; readonly [k: string]: unknown}
  readonly deliveries: ReadonlyArray<{readonly deliveryId: string; readonly [k: string]: unknown}>
}

/** Sync-mode ack: the §8.4 `ChannelMentionSyncResponse` shape. */
export type ChannelMentionSyncResponse = {
  readonly channelId: string
  readonly durationMs: number
  readonly endedState: 'completed' | 'cancelled'
  readonly finalAnswer: string
  readonly toolCalls: ReadonlyArray<{
    readonly callId: string
    readonly name: string
    readonly status?: string
  }>
  readonly turnId: string
}

type ChannelMentionPayload = {
  channelId: string
  prompt: string
  mode?: 'stream' | 'sync'
  suppressThoughts?: boolean
  timeout?: number
}

export type ChannelClientConnectOptions = DiscoverDaemonOptions & {
  /** Override the daemon URL (skips disk discovery). Useful for tests. */
  readonly daemonUrl?: string
  /** Override the daemon-auth-token (skips disk discovery). Useful for tests. */
  readonly authToken?: string
  /** Working directory passed to the daemon as `?cwd=`. Default: `process.cwd()`. */
  readonly cwd?: string
  /**
   * How many times to retry the Socket.IO connect attempt before giving up.
   * Bridges the window between `brv` daemon boot and Socket.IO listening.
   * Default: 30 (3s total at 100ms backoff).
   */
  readonly maxConnectAttempts?: number
  /** Backoff per attempt in ms. Default: 100. */
  readonly connectAttemptDelayMs?: number
  /**
   * Per-request ack timeout. Honors `BRV_CHANNEL_REQUEST_TIMEOUT_MS` env
   * var as a default (60_000ms if unset). Override per `request()` via
   * this constructor option.
   */
  readonly requestTimeoutMs?: number
}

type AckEnvelopeSuccess = {
  readonly code?: string
  readonly data?: unknown
  readonly details?: unknown
  readonly error?: string
  readonly success: true
}

type AckEnvelopeFailure = {
  readonly code?: string
  readonly data?: unknown
  readonly details?: unknown
  readonly error?: string
  readonly success: false
}

type AckEnvelope = AckEnvelopeFailure | AckEnvelopeSuccess

const isAckEnvelope = (value: unknown): value is AckEnvelope =>
  typeof value === 'object' && value !== null && 'success' in value

/**
 * Wire default for `channel:mention` sync-mode turn timeout. Mirrors
 * the daemon-side default (`ChannelMentionRequest.timeout` fallback in
 * `src/shared/transport/events/channel-events.ts`); kept in sync by
 * convention. Used when the caller invokes `mention({mode: 'sync'})`
 * without an explicit `timeout`.
 */
const SYNC_DEFAULT_TURN_TIMEOUT_MS = 300_000

/**
 * Grace added on top of the daemon-side turn timeout when computing the
 * transport-level request timeout in sync mode. Covers the round-trip
 * of the resolved ack envelope after the daemon settles the pending
 * sync entry. Without this the client could time out exactly when the
 * daemon would have answered.
 */
const SYNC_TIMEOUT_GRACE_MS = 5_000

const resolveDefaultRequestTimeoutMs = (override?: number): number => {
  if (override !== undefined && override > 0) return override
  const env = process.env.BRV_CHANNEL_REQUEST_TIMEOUT_MS
  if (env === undefined || env === '') return 60_000
  const parsed = Number.parseInt(env, 10)
  if (!Number.isFinite(parsed) || parsed <= 0) return 60_000
  return parsed
}

export class ChannelClient {
  /**
   * Connect to a running brv daemon. Auto-discovers URL + token from
   * `<dataDir>/daemon.json` + `<dataDir>/state/daemon-auth-token`
   * unless `daemonUrl` + `authToken` are explicitly provided.
   *
   * Throws `ChannelClientError(BRV_DAEMON_NOT_INITIALISED)` if the
   * daemon hasn't been started yet, or
   * `ChannelClientError(BRV_CHANNEL_CONNECT_FAILED)` if the Socket.IO
   * handshake fails after `maxConnectAttempts`.
   */
  public static async connect(options: ChannelClientConnectOptions = {}): Promise<ChannelClient> {
    let daemonUrl = options.daemonUrl
    let authToken = options.authToken
    if (daemonUrl === undefined || authToken === undefined) {
      const discovered = await discoverDaemon({dataDir: options.dataDir})
      daemonUrl = daemonUrl ?? discovered.daemonUrl
      authToken = authToken ?? discovered.authToken
    }

    const cwd = options.cwd ?? process.cwd()
    const maxAttempts = options.maxConnectAttempts ?? 30
    const attemptDelayMs = options.connectAttemptDelayMs ?? 100

    let lastError: Error | undefined
    let socket: Socket | undefined
    for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
      const candidate = io(daemonUrl, {
        auth: {token: authToken},
        forceNew: true,
        query: {cwd},
        reconnection: false,
        transports: ['websocket'],
      })

      try {
        // eslint-disable-next-line no-await-in-loop
        await new Promise<void>((resolveAttempt, rejectAttempt) => {
          const onConnect = (): void => {
            candidate.off('connect_error', onError)
            resolveAttempt()
          }

          const onError = (err: Error): void => {
            candidate.off('connect', onConnect)
            rejectAttempt(err)
          }

          candidate.once('connect', onConnect)
          candidate.once('connect_error', onError)
        })
        socket = candidate
        lastError = undefined
        break
      } catch (error) {
        lastError = error as Error
        candidate.close()
        if (attempt < maxAttempts) {
          // eslint-disable-next-line no-await-in-loop
          await new Promise<void>((r) => {
            setTimeout(r, attemptDelayMs)
          })
        }
      }
    }

    if (socket === undefined) {
      throw new ChannelClientError(
        CHANNEL_CLIENT_ERROR_CODE.CONNECT_FAILED,
        `Failed to connect to the brv daemon at ${daemonUrl} after ${maxAttempts} attempts: ${lastError?.message ?? 'unknown error'}`,
      )
    }

    return new ChannelClient(socket, options.requestTimeoutMs)
  }

  private readonly socket: Socket
  private readonly defaultRequestTimeoutMs: number
  private closed = false

  /** @internal use {@link ChannelClient.connect} */
  private constructor(socket: Socket, requestTimeoutMs?: number) {
    this.socket = socket
    this.defaultRequestTimeoutMs = resolveDefaultRequestTimeoutMs(requestTimeoutMs)
  }

  /**
   * Disconnect and release the socket. Idempotent.
   */
  public async close(): Promise<void> {
    if (this.closed) return
    this.closed = true
    if (this.socket.connected) this.socket.disconnect()
  }

  /**
   * Whether the underlying socket is still connected. Useful for callers
   * that want to verify state before issuing requests.
   */
  public get connected(): boolean {
    return !this.closed && this.socket.connected
  }

  /**
   * Subscribe to a raw Socket.IO event from the daemon (broadcasts).
   * Returns an unsubscribe function. Most callers should use
   * {@link subscribeTurn} or {@link subscribeChannel} instead.
   */
  public on<TData = unknown>(event: string, listener: (data: TData) => void): () => void {
    const wrapped = (data: TData): void => listener(data)
    this.socket.on(event, wrapped)
    return () => {
      this.socket.off(event, wrapped)
    }
  }

  /**
   * Emit a `channel:*` request and await the daemon's ack response.
   *
   * Resolves with the `data` payload on `{success: true}`.
   * Rejects with `ChannelClientError(code, message, details)` on
   * `{success: false}`. Honors a per-request timeout.
   *
   * @param options.timeoutMs - Override the client's default request
   *   timeout for this call. Use when the daemon-side operation has its
   *   own (longer) deadline — e.g. `channel:mention` in `mode: 'sync'`
   *   holds the ack until the turn completes, so the transport timeout
   *   must be ≥ the daemon-side turn timeout. See Bug 1 follow-up in
   *   `plan/channel-protocol/IMPLEMENTATION_PHASE_8_FOLLOWUPS.md`.
   */
  public request<TReq = unknown, TRes = unknown>(
    event: string,
    data: TReq,
    options?: {timeoutMs?: number},
  ): Promise<TRes> {
    if (this.closed) {
      return Promise.reject(
        new ChannelClientError(
          CHANNEL_CLIENT_ERROR_CODE.CONNECT_FAILED,
          `ChannelClient is closed; cannot request "${event}".`,
        ),
      )
    }

    return new Promise<TRes>((resolve, reject) => {
      let settled = false
      const timeoutMs =
        options?.timeoutMs !== undefined && options.timeoutMs > 0
          ? options.timeoutMs
          : this.defaultRequestTimeoutMs
      const timer = setTimeout(() => {
        if (settled) return
        settled = true
        reject(
          new ChannelClientError(
            CHANNEL_CLIENT_ERROR_CODE.REQUEST_TIMEOUT,
            `Channel request "${event}" did not receive a response within ${timeoutMs}ms`,
          ),
        )
      }, timeoutMs)

      const settle = <T>(action: (value: T) => void, value: T): void => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        action(value)
      }

      this.socket.emit(event, data, (response: unknown) => {
        if (!isAckEnvelope(response)) {
          settle(
            reject,
            new ChannelClientError(
              CHANNEL_CLIENT_ERROR_CODE.MALFORMED_RESPONSE,
              `Malformed response from daemon for ${event}`,
            ),
          )
          return
        }

        if (response.success) {
          settle(resolve, response.data as TRes)
          return
        }

        settle(
          reject,
          new ChannelClientError(
            response.code ?? CHANNEL_CLIENT_ERROR_CODE.MALFORMED_RESPONSE,
            response.error ?? 'Channel request failed',
            response.details,
          ),
        )
      })
    })
  }

  /**
   * Slice 8.0 — ergonomic `channel:mention` wrapper. In `'sync'` mode the
   * daemon buffers the turn and returns the assembled
   * `ChannelMentionSyncResponse`; in `'stream'` mode it returns the
   * dispatch acknowledgement (`ChannelTurnAcceptedResponse`) immediately
   * and events flow over the broadcast channel.
   *
   * Defaults: `mode = 'stream'` (Phase 1–7 behaviour), `suppressThoughts = false`.
   *
   * Errors:
   *  - sync timeout, overflow, external cancel, daemon shutdown surface as
   *    `ChannelClientError` with the daemon-supplied code preserved.
   */
  public mention<TSync extends ChannelMentionSyncResponse = ChannelMentionSyncResponse, TStream extends ChannelMentionStreamAck = ChannelMentionStreamAck>(
    options: ChannelMentionOptions,
  ): Promise<TSync | TStream> {
    const {channelId, mode, prompt, suppressThoughts, timeout} = options
    const payload: ChannelMentionPayload = {channelId, prompt}
    if (mode !== undefined) payload.mode = mode
    if (suppressThoughts !== undefined) payload.suppressThoughts = suppressThoughts
    if (timeout !== undefined) payload.timeout = timeout

    // Bug 1 follow-up: in sync mode the daemon holds the ack until the
    // turn settles, so the transport request-timeout must be >= the
    // daemon-side turn timeout. Otherwise the caller passing
    // `--timeout 300000` would still see CHANNEL_REQUEST_TIMEOUT at the
    // default transport timeout (60s). Add a 5s grace so the round-trip
    // of the resolved ack itself doesn't race the deadline.
    const requestOptions = mode === 'sync' ? {timeoutMs: (timeout ?? SYNC_DEFAULT_TURN_TIMEOUT_MS) + SYNC_TIMEOUT_GRACE_MS} : undefined

    return this.request<ChannelMentionPayload, TSync | TStream>('channel:mention', payload, requestOptions)
  }

  /**
   * Join the Socket.IO room for a channel so broadcasts
   * (`channel:turn-event`, `channel:member-update`, `channel:state-change`)
   * reach this client. Returns when the daemon acks the join.
   */
  public async subscribe(channelId: string): Promise<void> {
    await this.roomEmit('room:join', channelId)
  }

  /** Leave the channel's Socket.IO room. */
  public async unsubscribe(channelId: string): Promise<void> {
    await this.roomEmit('room:leave', channelId)
  }

  /**
   * Subscribe to a turn and yield each `channel:turn-event` broadcast in
   * `seq` order. The iterator ends when a terminal `turn_state_change`
   * arrives (`to === 'completed' | 'cancelled'`).
   *
   * Joins the channel room on entry, leaves on exit.
   */
  public async *subscribeTurn<TEvent = TurnEvent>(
    channelId: string,
    turnId: string,
  ): AsyncIterableIterator<TEvent> {
    await this.subscribe(channelId)
    const queue: TEvent[] = []
    let resolveNext: (() => void) | undefined
    let done = false

    const wakeup = (): void => {
      if (resolveNext !== undefined) {
        const r = resolveNext
        resolveNext = undefined
        r()
      }
    }

    const detach = this.on<{channelId: string; event: TEvent}>('channel:turn-event', (payload) => {
      if (payload.channelId !== channelId) return
      const evt = payload.event as TEvent & {kind: string; turnId?: string; to?: string}
      if (evt.turnId !== turnId) return
      queue.push(evt as TEvent)
      if (
        evt.kind === 'turn_state_change' &&
        (evt.to === 'completed' || evt.to === 'cancelled')
      ) {
        done = true
      }

      wakeup()
    })

    // Wake the parked iterator if the socket dies mid-turn (daemon
    // crash, network blip, or an external `close()`). Without this,
    // `subscribeTurn` would hang forever on the next `await` because
    // no broadcast can arrive on a dead socket.
    const onDisconnect = (): void => {
      done = true
      wakeup()
    }

    this.socket.on('disconnect', onDisconnect)

    try {
      while (queue.length > 0 || !done) {
        if (queue.length > 0) {
          const next = queue.shift()
          if (next !== undefined) yield next
          continue
        }

        // eslint-disable-next-line no-await-in-loop
        await new Promise<void>((resolve) => {
          resolveNext = resolve
        })
      }
    } finally {
      this.socket.off('disconnect', onDisconnect)
      detach()
      // Only unsubscribe if the socket is still alive — otherwise the
      // ack callback would never fire and we'd hang the cleanup path.
      if (this.connected) {
        await this.unsubscribe(channelId).catch(() => undefined)
      }
    }
  }

  private roomEmit(event: 'room:join' | 'room:leave', channelId: string): Promise<void> {
    const room = `channel:${channelId}`
    return new Promise((resolve, reject) => {
      this.socket.emit(event, room, (response: unknown) => {
        if (
          typeof response === 'object' &&
          response !== null &&
          'success' in response &&
          (response as {success: unknown}).success === true
        ) {
          resolve()
          return
        }

        reject(
          new ChannelClientError(
            CHANNEL_CLIENT_ERROR_CODE.CONNECT_FAILED,
            `${event} for ${room} failed: ${JSON.stringify(response)}`,
          ),
        )
      })
    })
  }
}

/**
 * Minimal type for the `event` field in `channel:turn-event` broadcasts.
 * The full union lives in `CHANNEL_PROTOCOL.md` §7.1; callers can narrow
 * via `event.kind`.
 */
export type TurnEvent = {
  readonly channelId: string
  readonly deliveryId: string | null
  readonly emittedAt: string
  readonly kind: string
  readonly memberHandle: string | null
  readonly seq: number
  readonly turnId: string
  // Variant-specific fields (content, status, from/to, etc.) — caller
  // narrows via `kind`.
  readonly [key: string]: unknown
}
