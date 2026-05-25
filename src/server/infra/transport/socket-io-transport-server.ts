import {instrument} from '@socket.io/admin-ui'
import {createServer, Server as HttpServer, type RequestListener} from 'node:http'
import {Server, Socket} from 'socket.io'

import type {TransportServerConfig} from '../../core/domain/transport/types.js'
import type {
  ConnectionHandler,
  ConnectionMetadata,
  ITransportServer,
  RequestContext,
  RequestHandler,
} from '../../core/interfaces/transport/index.js'

import {isDevelopment} from '../../config/environment.js'
import {TRANSPORT_HOST, TRANSPORT_PING_INTERVAL_MS, TRANSPORT_PING_TIMEOUT_MS} from '../../constants.js'
import {
  TransportPortInUseError,
  TransportServerAlreadyRunningError,
  TransportServerNotStartedError,
} from '../../core/domain/errors/transport-error.js'
import {transportLog} from '../../utils/process-logger.js'

/**
 * Internal protocol constants for request/response pattern.
 */
const RESPONSE_EVENT_SUFFIX = ':response'
const ERROR_EVENT_SUFFIX = ':error'

/**
 * The static (non-callback) shapes of {@link TransportServerConfig.corsOrigin}.
 * Used to narrow the input of {@link mergeAdminOrigin} so the helper does not
 * need internal type assertions; callers MUST exclude the function variant
 * before invoking.
 */
type StaticCorsOrigin = RegExp | RegExp[] | string | string[]

/**
 * Dev-mode helper: flatten a static `corsOrigin` value into an array that also
 * permits `https://admin.socket.io`, regardless of whether the input is a
 * single value or an array. Callbacks are excluded by the input type; the
 * caller filters them out and passes them through verbatim instead.
 */
const mergeAdminOrigin = (base: StaticCorsOrigin | undefined): (RegExp | string)[] => {
  const ADMIN = 'https://admin.socket.io'
  if (base === undefined) return [ADMIN]
  if (typeof base === 'string') return [base, ADMIN]
  if (base instanceof RegExp) return [base, ADMIN]
  return [...base, ADMIN]
}

/**
 * Build a {@link RequestContext} from a connected socket's handshake.
 * Reads `auth.token` (Socket.IO client `auth` option) and the `Origin` header.
 * Channel handlers consume this for auth and origin allowlisting; non-channel
 * handlers may ignore it without breaking changes.
 */
const buildRequestContext = (socket: Socket): RequestContext => {
  const handshakeAuth = socket.handshake.auth as Record<string, unknown> | undefined
  const tokenValue = handshakeAuth && typeof handshakeAuth.token === 'string' ? handshakeAuth.token : undefined

  const originHeader = socket.handshake.headers.origin
  const origin = typeof originHeader === 'string' ? originHeader : undefined

  const cwdQuery = socket.handshake.query.cwd
  const cwd = typeof cwdQuery === 'string' ? cwdQuery : undefined

  return {
    auth: tokenValue === undefined ? undefined : {token: tokenValue},
    cwd,
    origin,
    transport: 'socket.io',
  }
}

/**
 * Wrapper type for storing request handlers with unknown types.
 * This allows us to store handlers in a Map without type assertions.
 * The optional `ctx` carries per-request handshake metadata; the wrapper layer
 * inside {@link SocketIOTransportServer.registerEventHandler} builds it from
 * the underlying `Socket` and passes it through.
 */
type StoredRequestHandler = (
  data: unknown,
  clientId: string,
  ctx?: RequestContext,
) => Promise<unknown> | unknown

/**
 * Socket.IO implementation of ITransportServer.
 *
 * Architecture notes:
 * - Uses an HTTP server internally for Socket.IO
 * - Request/response pattern: client emits "event", server emits "event:response" or "event:error"
 * - Rooms are used for targeted broadcasts (e.g., per-task events)
 */
export class SocketIOTransportServer implements ITransportServer {
  private readonly config: Required<TransportServerConfig>
  private connectionHandlers: ConnectionHandler[] = []
  private disconnectionHandlers: ConnectionHandler[] = []
  private httpRequestHandler?: RequestListener
  private httpServer: HttpServer | undefined
  private io: Server | undefined
  private port: number | undefined
  private requestHandlers: Map<string, StoredRequestHandler> = new Map()
  private running = false
  private sockets: Map<string, Socket> = new Map()

  constructor(config?: TransportServerConfig) {
    this.config = {
      corsOrigin: config?.corsOrigin ?? '*',
      handshakeMiddleware: config?.handshakeMiddleware ?? ((_socket, next) => { next() }),
      pingIntervalMs: config?.pingIntervalMs ?? TRANSPORT_PING_INTERVAL_MS,
      pingTimeoutMs: config?.pingTimeoutMs ?? TRANSPORT_PING_TIMEOUT_MS,
    }
  }

  addToRoom(clientId: string, room: string): void {
    const socket = this.sockets.get(clientId)
    if (socket) {
      socket.join(room)
    }
  }

  broadcast<T = unknown>(event: string, data: T): void {
    const {io} = this
    if (!io) {
      throw new TransportServerNotStartedError('broadcast')
    }

    io.emit(event, data)
  }

  broadcastTo<T = unknown>(room: string, event: string, data: T, except?: string): void {
    const {io} = this
    if (!io) {
      throw new TransportServerNotStartedError('broadcastTo')
    }

    if (except) {
      io.to(room).except(except).emit(event, data)
    } else {
      io.to(room).emit(event, data)
    }
  }

  /**
   * Returns the number of currently connected sockets.
   * Used by daemon:getState handler in brv-server.ts.
   */
  getConnectedSocketCount(): number {
    return this.sockets.size
  }

  getPort(): number | undefined {
    return this.port
  }

  isRunning(): boolean {
    return this.running
  }

  onConnection(handler: ConnectionHandler): void {
    this.connectionHandlers.push(handler)
  }

  onDisconnection(handler: ConnectionHandler): void {
    this.disconnectionHandlers.push(handler)
  }

  onRequest<TRequest = unknown, TResponse = unknown>(
    event: string,
    handler: RequestHandler<TRequest, TResponse>,
  ): void {
    // Pre-start registration is supported: start()'s connection handler iterates this.requestHandlers.
    const wrappedHandler: StoredRequestHandler = (data, clientId, ctx) =>
      handler(data as TRequest, clientId, ctx)
    this.requestHandlers.set(event, wrappedHandler)

    for (const socket of this.sockets.values()) {
      this.registerEventHandler(socket, event, wrappedHandler)
    }
  }

  removeFromRoom(clientId: string, room: string): void {
    const socket = this.sockets.get(clientId)
    if (socket) {
      socket.leave(room)
    }
  }

  sendTo<T = unknown>(clientId: string, event: string, data: T): void {
    const socket = this.sockets.get(clientId)
    if (socket) {
      socket.emit(event, data)
    }
  }

  /**
   * Sets an HTTP request handler (e.g., Express app) to handle non-Socket.IO HTTP requests.
   * Must be called before start().
   */
  setHttpRequestHandler(handler: RequestListener): void {
    if (this.running) {
      throw new TransportServerAlreadyRunningError(this.port ?? 0)
    }

    this.httpRequestHandler = handler
  }

  async start(port: number): Promise<void> {
    if (this.running) {
      throw new TransportServerAlreadyRunningError(this.port ?? port)
    }

    return new Promise((resolve, reject) => {
      this.httpServer = this.httpRequestHandler ? createServer(this.httpRequestHandler) : createServer()

      // In development mode, allow admin.socket.io for debugging.
      // Function-shaped origins are passed through verbatim — the admin UI is
      // a dev-only convenience and a custom origin callback already controls
      // who may connect, so we trust the user's callback as-is.
      const baseOrigin = this.config.corsOrigin
      const corsOrigin = isDevelopment() && typeof baseOrigin !== 'function'
        ? mergeAdminOrigin(baseOrigin)
        : baseOrigin

      this.io = new Server(this.httpServer, {
        cors: {
          credentials: isDevelopment(), // Required for admin UI authentication
          origin: corsOrigin,
        },
        // Aggressive ping for faster disconnect detection (real-time)
        pingInterval: this.config.pingIntervalMs,
        pingTimeout: this.config.pingTimeoutMs,
      })

      // Enable Socket.IO Admin UI in development mode only
      if (isDevelopment()) {
        instrument(this.io, {
          auth: false, // No authentication for local dev
          mode: 'development',
        })
        transportLog('Socket.IO Admin UI enabled - connect at https://admin.socket.io')
      }

      // Phase-3 (Slice 3.5b): handshake middleware runs BEFORE the
      // `connection` event so middleware that calls next(err) rejects the
      // handshake outright. The channel-protocol Origin allowlist plugs
      // in here. Socket.IO's Socket type carries variadic generics that
      // don't align with the structural type our config exposes; we cast
      // through `unknown` because we only read `socket.handshake.headers`.
      this.io.use((socket, next) => {
        this.config.handshakeMiddleware(
          socket as unknown as {handshake: {headers: Record<string, string | undefined>}},
          next,
        )
      })

      this.io.on('connection', (socket) => {
        const clientId = socket.id
        this.sockets.set(clientId, socket)

        // Extract connection metadata from handshake query
        const metadata: ConnectionMetadata = {
          cwd: typeof socket.handshake.query.cwd === 'string' ? socket.handshake.query.cwd : undefined,
        }

        // Apply all registered request handlers to new socket
        for (const [event, handler] of this.requestHandlers) {
          this.registerEventHandler(socket, event, handler)
        }

        // Notify connection handlers with metadata
        for (const handler of this.connectionHandlers) {
          handler(clientId, metadata)
        }

        socket.on('disconnect', () => {
          this.sockets.delete(clientId)
          // Notify disconnection handlers (no metadata on disconnect)
          for (const handler of this.disconnectionHandlers) {
            handler(clientId, {})
          }
        })

        // Handle room join requests
        socket.on('room:join', (room: string, callback?: (result: {success: boolean}) => void) => {
          socket.join(room)
          callback?.({success: true})
        })

        // Handle room leave requests
        socket.on('room:leave', (room: string, callback?: (result: {success: boolean}) => void) => {
          socket.leave(room)
          callback?.({success: true})
        })

        // Handle ping requests for health checks
        socket.on('ping', (_data: unknown, callback?: (result: {pong: boolean; timestamp: number}) => void) => {
          callback?.({pong: true, timestamp: Date.now()})
        })
      })

      this.httpServer.on('error', (err: NodeJS.ErrnoException) => {
        if (err.code === 'EADDRINUSE') {
          reject(new TransportPortInUseError(port))
        } else {
          reject(err)
        }
      })

      this.httpServer.listen(port, TRANSPORT_HOST, () => {
        this.port = port
        this.running = true
        resolve()
      })
    })
  }

  async stop(): Promise<void> {
    const {httpServer, io} = this

    if (!this.running || !io || !httpServer) {
      return
    }

    return new Promise((resolve) => {
      // Disconnect all sockets
      io.disconnectSockets(true)

      // Close Socket.IO server
      io.close(() => {
        // Close HTTP server
        httpServer.close(() => {
          this.running = false
          this.port = undefined
          this.sockets.clear()
          resolve()
        })
      })
    })
  }

  private registerEventHandler(socket: Socket, event: string, handler: StoredRequestHandler): void {
    socket.on(event, async (data: unknown, callback?: (response: unknown) => void) => {
      try {
        const ctx = buildRequestContext(socket)
        const result = await handler(data, socket.id, ctx)

        // Support both callback style and event-based response
        if (callback) {
          callback({data: result, success: true})
        } else {
          socket.emit(`${event}${RESPONSE_EVENT_SUFFIX}`, {data: result, success: true})
        }
      } catch (error) {
        const errorMessage = error instanceof Error ? error.message : 'Unknown error'
        const errorCode = error instanceof Error && 'code' in error ? (error.code as string) : undefined
        // Phase-4 (Slice 4.2): preserve structured `details` so the client
        // can render auth-method remediation hints, validation field lists,
        // etc. The CHANNEL_PROTOCOL.md §11 error envelope is `{code, message,
        // details?}` — keeping `details` off the wire silently dropped
        // AcpAuthRequiredError.authMethods.
        const errorDetails =
          error instanceof Error && 'details' in error
            ? (error as Error & {details?: unknown}).details
            : undefined
        const basePayload = errorCode
          ? {code: errorCode, error: errorMessage, success: false}
          : {error: errorMessage, success: false}
        const errorPayload =
          errorDetails === undefined ? basePayload : {...basePayload, details: errorDetails}

        if (callback) {
          callback(errorPayload)
        } else {
          socket.emit(`${event}${ERROR_EVENT_SUFFIX}`, errorPayload)
        }
      }
    })
  }
}
