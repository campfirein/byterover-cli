import {instrument} from '@socket.io/admin-ui'
import {createServer, Server as HttpServer, type RequestListener} from 'node:http'
import {Server, Socket} from 'socket.io'

import type {TransportServerConfig} from '../../core/domain/transport/types.js'
import type {
  ConnectionHandler,
  ConnectionMetadata,
  ITransportServer,
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
 * Wrapper type for storing request handlers with unknown types.
 * This allows us to store handlers in a Map without type assertions.
 */
type StoredRequestHandler = (data: unknown, clientId: string) => Promise<unknown> | unknown

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
  private host: string | undefined
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

  getHost(): string | undefined {
    return this.host
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
    const wrappedHandler: StoredRequestHandler = (data, clientId) => handler(data as TRequest, clientId)
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

  async start(port: number, host: string = TRANSPORT_HOST): Promise<void> {
    if (this.running) {
      throw new TransportServerAlreadyRunningError(this.port ?? port)
    }

    return new Promise((resolve, reject) => {
      this.httpServer = this.httpRequestHandler ? createServer(this.httpRequestHandler) : createServer()

      // In development mode, allow admin.socket.io for debugging
      const corsOrigin = isDevelopment() ? [this.config.corsOrigin, 'https://admin.socket.io'] : this.config.corsOrigin

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

      this.httpServer.listen(port, host, () => {
        this.port = port
        this.host = host
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
          this.host = undefined
          this.sockets.clear()
          resolve()
        })
      })
    })
  }

  private registerEventHandler(socket: Socket, event: string, handler: StoredRequestHandler): void {
    socket.on(event, async (data: unknown, callback?: (response: unknown) => void) => {
      try {
        const result = await handler(data, socket.id)

        // Support both callback style and event-based response
        if (callback) {
          callback({data: result, success: true})
        } else {
          socket.emit(`${event}${RESPONSE_EVENT_SUFFIX}`, {data: result, success: true})
        }
      } catch (error) {
        const errorMessage = error instanceof Error ? error.message : 'Unknown error'
        const errorCode = error instanceof Error && 'code' in error ? (error.code as string) : undefined
        const errorPayload = errorCode
          ? {code: errorCode, error: errorMessage, success: false}
          : {error: errorMessage, success: false}

        if (callback) {
          callback(errorPayload)
        } else {
          socket.emit(`${event}${ERROR_EVENT_SUFFIX}`, errorPayload)
        }
      }
    })
  }
}
