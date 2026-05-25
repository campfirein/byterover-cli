import {ensureDaemonRunning} from '@campfirein/brv-transport-client'
import {promises as fs} from 'node:fs'
import {join} from 'node:path'
import {io, type Socket} from 'socket.io-client'

import {getGlobalDataDir} from '../../server/utils/global-data-path.js'
import {resolveLocalServerMainPath} from '../../server/utils/server-main-resolver.js'

/**
 * Phase-1 channel-protocol oclif client.
 *
 * The published @campfirein/brv-transport-client does not expose the
 * Socket.IO handshake auth surface (no `auth: { token }` option, no query-
 * param injection). Channel handlers require a daemon-local auth token on
 * EVERY request per CHANNEL_PROTOCOL.md §2, so this slice ships its own
 * thin client that:
 *
 *  1. Ensures the daemon is running (re-uses `ensureDaemonRunning` from the
 *     published library — that part of the API is auth-agnostic).
 *  2. Reads the daemon-auth-token from `<dataDir>/state/daemon-auth-token`
 *     (Slice 1.0 owns the writer). Missing file → fast-fail with
 *     `ERR_BRV_DAEMON_NOT_INITIALISED` BEFORE attempting a connection.
 *  3. Connects with socket.io-client v4 carrying both:
 *       - `auth: { token }`   → consumed by channel-auth-middleware (Slice 1.4)
 *       - `query: { cwd }`    → consumed by ChannelHandler to resolve projectRoot
 *  4. Provides a request/response `emit()` helper using the callback-ack
 *     pattern matched by SocketIOTransportServer.registerEventHandler.
 *
 * Phase-3 hardening can fold this back into the published transport-client
 * once that package exposes handshake auth options.
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

const DAEMON_NOT_INITIALISED = 'ERR_BRV_DAEMON_NOT_INITIALISED'
const CONNECT_FAILED = 'ERR_BRV_CHANNEL_CONNECT_FAILED'

/** Default transport timeout when no per-call override and no env override is set. */
const DEFAULT_REQUEST_TIMEOUT_MS = 60_000

/**
 * Slice 9.7 (codex D6) — pure-function helper that resolves the transport
 * timeout for `request()`. Extracted from the inline expression at the
 * call site so it can be unit-tested directly without spinning up a
 * Socket.IO server.
 *
 * Resolution order:
 *   1. Per-call `options.timeoutMs` (if defined AND > 0) — Bug 1 fix
 *      lets `channel:mention --mode sync` pass turn_timeout + grace so
 *      the transport doesn't time out before the daemon settles the
 *      sync response.
 *   2. `BRV_CHANNEL_REQUEST_TIMEOUT_MS` env (if parseable to a positive
 *      number) — operational knob for daemons under unusual load.
 *   3. {@link DEFAULT_REQUEST_TIMEOUT_MS} (60s) — safety net per Slice
 *      3.5b so a never-acked socket doesn't hang the CLI forever.
 *
 * The Bug 1 regression to catch: a future refactor reintroduces a
 * hardcoded `60_000` that ignores both per-call and env overrides.
 * Unit tests pin all three branches.
 */
export const resolveRequestTimeoutMs = (
  options: undefined | {readonly timeoutMs?: number},
  env: NodeJS.ProcessEnv,
): number => {
  if (options?.timeoutMs !== undefined && options.timeoutMs > 0) {
    return options.timeoutMs
  }

  const envRaw = env.BRV_CHANNEL_REQUEST_TIMEOUT_MS
  if (envRaw !== undefined && envRaw.trim() !== '') {
    const parsed = Number.parseInt(envRaw, 10)
    if (Number.isFinite(parsed) && parsed > 0) return parsed
  }

  return DEFAULT_REQUEST_TIMEOUT_MS
}

const tokenFilePath = (): string => join(getGlobalDataDir(), 'state', 'daemon-auth-token')

const readDaemonTokenOrThrow = async (): Promise<string> => {
  try {
    const raw = await fs.readFile(tokenFilePath(), 'utf8')
    const trimmed = raw.trim()
    if (trimmed === '') {
      throw new ChannelClientError(
        DAEMON_NOT_INITIALISED,
        `Daemon auth token is empty at ${tokenFilePath()}. Run \`brv restart\` to regenerate.`,
      )
    }

    return trimmed
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      throw new ChannelClientError(
        DAEMON_NOT_INITIALISED,
        `Daemon auth token not found at ${tokenFilePath()}. The brv daemon must be started at least once before running channel commands.`,
      )
    }

    if (error instanceof ChannelClientError) throw error
    throw error
  }
}

export type ChannelClient = {
  /** Disconnect and release the socket. Idempotent. */
  disconnect(): void
  /**
   * Subscribe to a server-emitted event (broadcasts on channel:<id>:*).
   * Returns an unsubscribe function. Phase 1 commands use this for live
   * tailing in `brv channel watch` (not yet shipped) and for inline streaming
   * during `brv channel mention` (Phase 2). The current `list-turns` /
   * `show` / `post` paths do not subscribe.
   */
  on<TData = unknown>(event: string, listener: (data: TData) => void): () => void
  /**
   * Emit a request and await the server's response. Resolves with the response
   * data on success; rejects with a {@link ChannelClientError} carrying the
   * canonical wire code (CHANNEL_*, ACP_*, AGENT_DRIVER_PROFILE_*) on failure.
   *
   * `options.timeoutMs` overrides the env-default for this call. Use when the
   * daemon-side operation has its own (longer) deadline — e.g.
   * `channel:mention` in `mode: 'sync'` holds the ack until the turn
   * completes, so the transport timeout must be ≥ the daemon-side turn
   * timeout. See Bug 1 follow-up in
   * `plan/channel-protocol/IMPLEMENTATION_PHASE_8_FOLLOWUPS.md`.
   */
  request<TReq = unknown, TRes = unknown>(event: string, data: TReq, options?: {timeoutMs?: number}): Promise<TRes>
  /**
   * Phase-2: join the Socket.IO room `channel:<channelId>` so broadcasts
   * (`channel:turn-event`, `channel:state-change`, `channel:member-update`)
   * for that channel reach this client. Awaits the server ack so callers
   * can safely send a request that triggers broadcasts immediately after.
   */
  subscribe(channelId: string): Promise<void>
  /** Phase-2: leave the channel's Socket.IO room. */
  unsubscribe(channelId: string): Promise<void>
}

export type ChannelClientOptions = {
  /** Override the working directory the handler will resolve `projectRoot` from. */
  cwd?: string
  /** Override the daemon data dir for token lookup. Used by tests via env. */
  // (Token path itself comes from getGlobalDataDir(), which already honours BRV_DATA_DIR.)
}

/**
 * Connect to the brv daemon's channel surface. Spawns the daemon if needed,
 * authenticates with the persisted daemon-auth-token, and returns a client
 * that speaks the channel request/response protocol.
 *
 * Callers are responsible for calling `client.disconnect()` when done.
 */
export const connectChannelClient = async (options?: ChannelClientOptions): Promise<ChannelClient> => {
  // Spawn the daemon FIRST: it owns the daemon-auth-token file and writes it
  // during startup. Reading the token before this would chicken-and-egg on
  // first-run installs. Once `ensureDaemonRunning` resolves success the token
  // is guaranteed to be on disk.
  const ensure = await ensureDaemonRunning({serverPath: resolveLocalServerMainPath()})
  if (!ensure.success) {
    throw new ChannelClientError(
      CONNECT_FAILED,
      `Failed to start the brv daemon: ${ensure.reason}${ensure.spawnError === undefined ? '' : ` (${ensure.spawnError})`}`,
    )
  }

  const token = await readDaemonTokenOrThrow()

  const url = `http://127.0.0.1:${ensure.info.port}`
  const cwd = options?.cwd ?? process.cwd()

  // `ensureDaemonRunning` returns success as soon as the daemon heartbeat is
  // up, but the Socket.IO transport server boots a little later in the
  // daemon's startup sequence. Retry a handful of times with short backoff
  // to bridge that window on cold starts.
  const MAX_ATTEMPTS = 30
  const ATTEMPT_DELAY_MS = 100

  let socket: Socket | undefined
  let lastError: Error | undefined
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt += 1) {
    socket = io(url, {
      auth: {token},
      forceNew: true,
      query: {cwd},
      reconnection: false,
      transports: ['websocket'],
    })

    try {
      // eslint-disable-next-line no-await-in-loop
      await new Promise<void>((resolveAttempt, rejectAttempt) => {
        const onConnect = (): void => {
          socket!.off('connect_error', onError)
          resolveAttempt()
        }

        const onError = (err: Error): void => {
          socket!.off('connect', onConnect)
          rejectAttempt(err)
        }

        socket!.once('connect', onConnect)
        socket!.once('connect_error', onError)
      })
      lastError = undefined
      break
    } catch (error) {
      lastError = error as Error
      socket.close()
      socket = undefined
      if (attempt < MAX_ATTEMPTS) {
        // eslint-disable-next-line no-await-in-loop
        await new Promise<void>((r) => {
          setTimeout(r, ATTEMPT_DELAY_MS)
        })
      }
    }
  }

  if (socket === undefined) {
    throw new ChannelClientError(
      CONNECT_FAILED,
      `Failed to connect to the brv daemon at ${url} after ${MAX_ATTEMPTS} attempts: ${lastError?.message ?? 'unknown error'}`,
    )
  }

  const connectedSocket = socket

  const roomEmit = (event: 'room:join' | 'room:leave', channelId: string): Promise<void> =>
    new Promise((resolve, reject) => {
      const room = `channel:${channelId}`
      connectedSocket.emit(event, room, (response: unknown) => {
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
            CONNECT_FAILED,
            `${event} for ${room} failed: ${JSON.stringify(response)}`,
          ),
        )
      })
    })

  return {
    disconnect() {
      if (connectedSocket.connected) connectedSocket.disconnect()
    },
    on<TData>(event: string, listener: (data: TData) => void) {
      const wrapped = (data: TData): void => listener(data)
      connectedSocket.on(event, wrapped)
      return () => connectedSocket.off(event, wrapped)
    },
    request: <TReq, TRes>(event: string, data: TReq, options?: {timeoutMs?: number}): Promise<TRes> =>
      new Promise<TRes>((resolve, reject) => {
        // Slice 3.5b safety net: if the daemon never invokes the ack
        // callback (e.g. because it has no registered handler for the
        // event), the promise would hang forever. The timeout below
        // surfaces this as `CHANNEL_REQUEST_TIMEOUT` so the CLI exits
        // non-zero.
        //
        // Per-call `options.timeoutMs` wins (e.g. `channel:mention --mode
        // sync` passes turn_timeout + grace so the transport doesn't time
        // out before the daemon settles the sync response — Bug 1 follow-up
        // in `plan/channel-protocol/IMPLEMENTATION_PHASE_8_FOLLOWUPS.md`).
        // Otherwise fall back to `BRV_CHANNEL_REQUEST_TIMEOUT_MS` env or 60s.
        // Resolution logic factored to `resolveRequestTimeoutMs` so the
        // Bug 1 regression guard has unit-test coverage (Slice 9.7 D6).
        const timeoutMs = resolveRequestTimeoutMs(options, process.env)
        let settled = false
        const timer = Number.isFinite(timeoutMs) && timeoutMs > 0
          ? setTimeout(() => {
              if (settled) return
              settled = true
              reject(
                new ChannelClientError(
                  'CHANNEL_REQUEST_TIMEOUT',
                  `Channel request "${event}" did not receive a response within ${timeoutMs}ms`,
                ),
              )
            }, timeoutMs)
          : undefined
        const settle = <T>(action: (value: T) => void, value: T): void => {
          if (settled) return
          settled = true
          if (timer !== undefined) clearTimeout(timer)
          action(value)
        }

        connectedSocket.emit(event, data, (response: unknown) => {
          // Match the SocketIOTransportServer.registerEventHandler envelope:
          //   success path:   { success: true, data: ... }
          //   failure path:   { success: false, error: '...', code?: '...' }
          if (typeof response === 'object' && response !== null && 'success' in response) {
            const env = response as {
              code?: string
              data?: unknown
              details?: unknown
              error?: string
              success: boolean
            }
            if (env.success) {
              settle(resolve, env.data as TRes)
              return
            }

            settle(
              reject,
              new ChannelClientError(
                env.code ?? 'CHANNEL_REQUEST_FAILED',
                env.error ?? 'Channel request failed',
                env.details,
              ),
            )
            return
          }

          settle(
            reject,
            new ChannelClientError(
              'CHANNEL_REQUEST_FAILED',
              `Malformed response from daemon for ${event}`,
            ),
          )
        })
      }),
    subscribe(channelId: string): Promise<void> {
      return roomEmit('room:join', channelId)
    },
    unsubscribe(channelId: string): Promise<void> {
      return roomEmit('room:leave', channelId)
    },
  }
}

/**
 * Helper for one-shot commands: connects, runs `fn`, disconnects in finally.
 */
export const withChannelClient = async <T>(
  fn: (client: ChannelClient) => Promise<T>,
  options?: ChannelClientOptions,
): Promise<T> => {
  const client = await connectChannelClient(options)
  try {
    return await fn(client)
  } finally {
    client.disconnect()
  }
}
