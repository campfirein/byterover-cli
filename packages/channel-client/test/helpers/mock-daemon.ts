import {promises as fs} from 'node:fs'
import {createServer, type Server as HttpServer} from 'node:http'
import {mkdtemp, rm} from 'node:fs/promises'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import {AddressInfo} from 'node:net'

import {Server as SocketIOServer, type Socket} from 'socket.io'

/**
 * Tiny mock brv daemon for Phase-7 client tests.
 *
 * Starts a real Socket.IO server on an ephemeral port, writes a
 * `daemon.json` + `state/daemon-auth-token` into a per-test data dir,
 * and exposes hooks to register event handlers + force-emit broadcasts.
 *
 * Caller owns lifecycle: `await rig = await startMockDaemon(); ...; await rig.stop()`.
 */

export type MockHandler = (data: unknown, ack?: (resp: unknown) => void) => void | Promise<void>

export type MockDaemon = {
  readonly authToken: string
  readonly daemonUrl: string
  readonly dataDir: string
  readonly emit: (event: string, payload: unknown) => void
  readonly emitToRoom: (room: string, event: string, payload: unknown) => void
  readonly handle: (event: string, handler: MockHandler) => void
  readonly latestSocket: () => Socket | undefined
  readonly receivedAuthTokens: string[]
  readonly stop: () => Promise<void>
}

export const startMockDaemon = async (opts: {authToken?: string; tokenValidator?: (token: string | undefined) => boolean} = {}): Promise<MockDaemon> => {
  const authToken = opts.authToken ?? 'test-token-deadbeef'
  const tokenValidator = opts.tokenValidator ?? ((t) => t === authToken)

  const dataDir = await mkdtemp(join(tmpdir(), 'brv-cc-test-'))
  await fs.mkdir(join(dataDir, 'state'), {recursive: true})

  const httpServer: HttpServer = createServer()
  const ioServer = new SocketIOServer(httpServer, {transports: ['websocket']})
  const handlers = new Map<string, MockHandler>()
  const receivedAuthTokens: string[] = []
  let latestSocket: Socket | undefined

  ioServer.use((socket, next) => {
    const token = (socket.handshake.auth as {token?: string}).token
    receivedAuthTokens.push(token ?? '<missing>')
    if (!tokenValidator(token)) {
      next(new Error('unauthorized'))
      return
    }

    next()
  })

  ioServer.on('connection', (socket) => {
    latestSocket = socket
    for (const [event, handler] of handlers) {
      socket.on(event, async (data, ack) => {
        await handler(data, ack)
      })
    }

    // room:join/leave acks — mirror the byterover-cli transport server.
    socket.on('room:join', (room: string, ack?: (r: unknown) => void) => {
      socket.join(room)
      ack?.({success: true})
    })
    socket.on('room:leave', (room: string, ack?: (r: unknown) => void) => {
      socket.leave(room)
      ack?.({success: true})
    })
  })

  await new Promise<void>((resolve) => {
    httpServer.listen(0, '127.0.0.1', () => resolve())
  })

  const addr = httpServer.address() as AddressInfo
  const port = addr.port
  const daemonUrl = `http://127.0.0.1:${port}`

  // Write daemon.json + token file the way the real daemon does.
  await fs.writeFile(join(dataDir, 'daemon.json'), JSON.stringify({port, pid: process.pid}), {mode: 0o600})
  await fs.writeFile(join(dataDir, 'state', 'daemon-auth-token'), authToken, {mode: 0o600})

  return {
    authToken,
    daemonUrl,
    dataDir,
    emit(event, payload) {
      ioServer.emit(event, payload)
    },
    emitToRoom(room, event, payload) {
      ioServer.to(room).emit(event, payload)
    },
    handle(event, handler) {
      handlers.set(event, handler)
      // Hot-attach to already-connected sockets.
      for (const sock of ioServer.sockets.sockets.values()) {
        sock.on(event, async (data, ack) => {
          await handler(data, ack)
        })
      }
    },
    latestSocket: () => latestSocket,
    receivedAuthTokens,
    async stop() {
      ioServer.close()
      await new Promise<void>((resolve) => {
        httpServer.close(() => resolve())
      })
      await rm(dataDir, {force: true, recursive: true})
    },
  }
}
