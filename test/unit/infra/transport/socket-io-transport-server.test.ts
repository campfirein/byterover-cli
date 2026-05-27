import {expect} from 'chai'
import {Socket as ClientSocket, io} from 'socket.io-client'

import type {ClientType} from '../../../../src/server/core/domain/client/client-info.js'

import {
  TransportPortInUseError,
  TransportServerAlreadyRunningError,
  TransportServerNotStartedError,
} from '../../../../src/server/core/domain/errors/transport-error.js'
import {getClientKindFromContext} from '../../../../src/server/infra/transport/client-kind-context.js'
import {SocketIOTransportServer} from '../../../../src/server/infra/transport/socket-io-transport-server.js'

describe('SocketIOTransportServer', () => {
  let server: SocketIOTransportServer
  let clientSocket: ClientSocket | undefined

  before(() => {
    process.env.BRV_SESSION_LOG = '/dev/null'
  })

  after(() => {
    delete process.env.BRV_SESSION_LOG
  })

  beforeEach(() => {
    server = new SocketIOTransportServer()
  })

  afterEach(async () => {
    if (clientSocket?.connected) {
      clientSocket.disconnect()
    }

    if (server.isRunning()) {
      await server.stop()
    }
  })

  describe('start', () => {
    it('should start server on specified port', async () => {
      await server.start(9900)

      expect(server.isRunning()).to.be.true
      expect(server.getPort()).to.equal(9900)
    })

    it('should throw error if server is already running', async () => {
      await server.start(9901)

      try {
        await server.start(9902)
        expect.fail('Should have thrown error')
      } catch (error) {
        expect(error).to.be.instanceOf(TransportServerAlreadyRunningError)
        expect((error as TransportServerAlreadyRunningError).name).to.equal('TransportServerAlreadyRunningError')
        expect((error as TransportServerAlreadyRunningError).port).to.equal(9901)
      }
    })

    it('should throw error if port is in use', async () => {
      await server.start(9903)

      const server2 = new SocketIOTransportServer()
      try {
        await server2.start(9903)
        expect.fail('Should have thrown error')
      } catch (error) {
        expect(error).to.be.instanceOf(TransportPortInUseError)
        expect((error as TransportPortInUseError).name).to.equal('TransportPortInUseError')
        expect((error as TransportPortInUseError).port).to.equal(9903)
      }
    })
  })

  describe('stop', () => {
    it('should stop running server', async () => {
      await server.start(9910)
      await server.stop()

      expect(server.isRunning()).to.be.false
      expect(server.getPort()).to.be.undefined
    })

    it('should be safe to call stop on non-running server', async () => {
      await server.stop()
      expect(server.isRunning()).to.be.false
    })

    it('should disconnect all clients on stop', async () => {
      await server.start(9911)

      clientSocket = io('http://127.0.0.1:9911')
      await new Promise<void>((resolve) => {
        clientSocket!.on('connect', resolve)
      })

      expect(clientSocket.connected).to.be.true

      await server.stop()

      // Wait for disconnect
      await new Promise<void>((resolve) => {
        setTimeout(resolve, 15)
      })

      expect(clientSocket.connected).to.be.false
    })
  })

  describe('onConnection and onDisconnection', () => {
    it('should call connection handler when client connects', async () => {
      await server.start(9920)

      let connectedClientId: string | undefined
      server.onConnection((clientId) => {
        connectedClientId = clientId
      })

      clientSocket = io('http://127.0.0.1:9920')
      await new Promise<void>((resolve) => {
        clientSocket!.on('connect', resolve)
      })

      // Wait for handler to be called
      await new Promise((resolve) => {
        setTimeout(resolve, 10)
      })

      expect(connectedClientId).to.equal(clientSocket.id)
    })

    it('should call disconnection handler when client disconnects', async () => {
      await server.start(9921)

      let disconnectedClientId: string | undefined
      server.onDisconnection((clientId) => {
        disconnectedClientId = clientId
      })

      clientSocket = io('http://127.0.0.1:9921')
      await new Promise<void>((resolve) => {
        clientSocket!.on('connect', resolve)
      })

      const clientId = clientSocket.id
      clientSocket.disconnect()

      // Wait for handler to be called
      await new Promise((resolve) => {
        setTimeout(resolve, 10)
      })

      expect(disconnectedClientId).to.equal(clientId)
    })
  })

  describe('onRequest', () => {
    it('should handle requests with callback response', async () => {
      await server.start(9930)

      server.onRequest<{value: number}, {doubled: number}>('double', (data) => ({doubled: data.value * 2}))

      clientSocket = io('http://127.0.0.1:9930')
      await new Promise<void>((resolve) => {
        clientSocket!.on('connect', resolve)
      })

      const response = await new Promise<{data: {doubled: number}; success: boolean}>((resolve) => {
        clientSocket!.emit('double', {value: 5}, resolve)
      })

      expect(response.success).to.be.true
      expect(response.data.doubled).to.equal(10)
    })

    it('should handle async request handlers', async () => {
      await server.start(9931)

      server.onRequest<{delay: number}, {result: string}>('async-op', async (data) => {
        await new Promise((resolve) => {
          setTimeout(resolve, data.delay)
        })
        return {result: 'done'}
      })

      clientSocket = io('http://127.0.0.1:9931')
      await new Promise<void>((resolve) => {
        clientSocket!.on('connect', resolve)
      })

      const response = await new Promise<{data: {result: string}; success: boolean}>((resolve) => {
        clientSocket!.emit('async-op', {delay: 10}, resolve)
      })

      expect(response.success).to.be.true
      expect(response.data.result).to.equal('done')
    })

    it('should return error when handler throws', async () => {
      await server.start(9932)

      server.onRequest('error-op', () => {
        throw new Error('Test error')
      })

      clientSocket = io('http://127.0.0.1:9932')
      await new Promise<void>((resolve) => {
        clientSocket!.on('connect', resolve)
      })

      const response = await new Promise<{error: string; success: boolean}>((resolve) => {
        clientSocket!.emit('error-op', {}, resolve)
      })

      expect(response.success).to.be.false
      expect(response.error).to.equal('Test error')
    })

    it('accepts onRequest before start() and applies the handler to sockets that connect after', async () => {
      expect(() =>
        server.onRequest('pre-registered', (data: {n: number}, _clientId: string) => ({doubled: data.n * 2})),
      ).to.not.throw()

      await server.start(9941)
      const client = io('http://127.0.0.1:9941')
      try {
        await new Promise<void>((resolve) => {
          client.on('connect', resolve)
        })

        const response = await new Promise<{data: {doubled: number}; success: boolean}>((resolve) => {
          client.emit('pre-registered', {n: 7}, resolve)
        })
        expect(response.success).to.be.true
        expect(response.data.doubled).to.equal(14)
      } finally {
        client.disconnect()
      }
    })
  })

  describe('broadcast', () => {
    it('should broadcast to all connected clients', async () => {
      await server.start(9940)

      const client1 = io('http://127.0.0.1:9940')
      const client2 = io('http://127.0.0.1:9940')

      await Promise.all([
        new Promise<void>((resolve) => {
          client1.on('connect', resolve)
        }),
        new Promise<void>((resolve) => {
          client2.on('connect', resolve)
        }),
      ])

      const received1 = new Promise<{message: string}>((resolve) => {
        client1.on('notification', resolve)
      })
      const received2 = new Promise<{message: string}>((resolve) => {
        client2.on('notification', resolve)
      })

      server.broadcast('notification', {message: 'Hello everyone'})

      const [data1, data2] = await Promise.all([received1, received2])

      expect(data1.message).to.equal('Hello everyone')
      expect(data2.message).to.equal('Hello everyone')

      client1.disconnect()
      client2.disconnect()
    })

    it('should throw error if server not started', () => {
      expect(() => server.broadcast('test', {})).to.throw(TransportServerNotStartedError)
    })
  })

  describe('broadcastTo (rooms)', () => {
    it('should broadcast only to clients in specific room', async () => {
      await server.start(9950)

      const client1 = io('http://127.0.0.1:9950')
      const client2 = io('http://127.0.0.1:9950')

      await Promise.all([
        new Promise<void>((resolve) => {
          client1.on('connect', resolve)
        }),
        new Promise<void>((resolve) => {
          client2.on('connect', resolve)
        }),
      ])

      // Client1 joins room
      await new Promise<void>((resolve) => {
        client1.emit('room:join', 'task-123', () => resolve())
      })

      let client1Received = false
      let client2Received = false

      client1.on('task:update', () => {
        client1Received = true
      })
      client2.on('task:update', () => {
        client2Received = true
      })

      server.broadcastTo('task-123', 'task:update', {status: 'running'})

      // Wait for potential messages
      await new Promise((resolve) => {
        setTimeout(resolve, 15)
      })

      expect(client1Received).to.be.true
      expect(client2Received).to.be.false

      client1.disconnect()
      client2.disconnect()
    })

    it('should throw error if server not started', () => {
      expect(() => server.broadcastTo('room', 'event', {})).to.throw(TransportServerNotStartedError)
    })
  })

  describe('addToRoom and removeFromRoom', () => {
    it('should add client to room server-side', async () => {
      await server.start(9960)

      let connectedClientId: string | undefined
      server.onConnection((clientId) => {
        connectedClientId = clientId
      })

      clientSocket = io('http://127.0.0.1:9960')
      await new Promise<void>((resolve) => {
        clientSocket!.on('connect', resolve)
      })

      // Wait for connection handler
      await new Promise((resolve) => {
        setTimeout(resolve, 10)
      })

      // Add client to room server-side
      server.addToRoom(connectedClientId!, 'admin-room')

      const received = new Promise<{data: string}>((resolve) => {
        clientSocket!.on('admin:message', resolve)
      })

      server.broadcastTo('admin-room', 'admin:message', {data: 'admin only'})

      const result = await received
      expect(result.data).to.equal('admin only')
    })

    it('should remove client from room', async () => {
      await server.start(9961)

      let connectedClientId: string | undefined
      server.onConnection((clientId) => {
        connectedClientId = clientId
      })

      clientSocket = io('http://127.0.0.1:9961')
      await new Promise<void>((resolve) => {
        clientSocket!.on('connect', resolve)
      })

      // Wait for connection handler
      await new Promise((resolve) => {
        setTimeout(resolve, 10)
      })

      // Add then remove from room
      server.addToRoom(connectedClientId!, 'temp-room')
      server.removeFromRoom(connectedClientId!, 'temp-room')

      let received = false
      clientSocket.on('temp:message', () => {
        received = true
      })

      server.broadcastTo('temp-room', 'temp:message', {})

      // Wait to verify no message received
      await new Promise((resolve) => {
        setTimeout(resolve, 15)
      })

      expect(received).to.be.false
    })
  })

  describe('sendTo (direct client messaging)', () => {
    it('should send event directly to specific client', async () => {
      await server.start(9965)

      let connectedClientId: string | undefined
      server.onConnection((clientId) => {
        connectedClientId = clientId
      })

      clientSocket = io('http://127.0.0.1:9965')
      await new Promise<void>((resolve) => {
        clientSocket!.on('connect', resolve)
      })

      // Wait for connection handler
      await new Promise((resolve) => {
        setTimeout(resolve, 10)
      })

      const received = new Promise<{message: string}>((resolve) => {
        clientSocket!.on('direct:message', resolve)
      })

      server.sendTo(connectedClientId!, 'direct:message', {message: 'hello directly'})

      const data = await received
      expect(data.message).to.equal('hello directly')
    })

    it('should not throw when client does not exist', () => {
      // Should silently ignore non-existent client
      expect(() => server.sendTo('non-existent-id', 'event', {})).to.not.throw()
    })
  })

  describe('getPort and isRunning', () => {
    it('should return undefined port when not running', () => {
      expect(server.getPort()).to.be.undefined
      expect(server.isRunning()).to.be.false
    })

    it('should return correct port when running', async () => {
      await server.start(9970)

      expect(server.getPort()).to.equal(9970)
      expect(server.isRunning()).to.be.true
    })
  })

  describe('client_kind context wrap (M15.1)', () => {
    it('exposes the registered ClientType inside the request handler via getClientKindFromContext', async () => {
      const typeByClientId = new Map<string, ClientType>()
      server.setGetClientKind((clientId) => typeByClientId.get(clientId))
      await server.start(9980)

      let observed: ClientType | undefined
      server.onRequest('client-kind:probe', () => {
        observed = getClientKindFromContext()
        return {ok: true}
      })

      clientSocket = io('http://127.0.0.1:9980')
      await new Promise<void>((resolve) => {
        clientSocket!.on('connect', resolve)
      })

      typeByClientId.set(clientSocket.id!, 'cli')

      await new Promise<void>((resolve) => {
        clientSocket!.emit('client-kind:probe', {}, () => resolve())
      })

      expect(observed).to.equal('cli')
    })

    it('omits the wrap when the lookup returns undefined (no context set)', async () => {
      // eslint-disable-next-line unicorn/no-useless-undefined
      const noopLookup: (clientId: string) => ClientType | undefined = () => undefined
      server.setGetClientKind(noopLookup)
      await server.start(9981)

      let observed: 'sentinel' | ClientType | undefined = 'sentinel'
      server.onRequest('client-kind:probe', () => {
        observed = getClientKindFromContext()
        return {ok: true}
      })

      clientSocket = io('http://127.0.0.1:9981')
      await new Promise<void>((resolve) => {
        clientSocket!.on('connect', resolve)
      })

      await new Promise<void>((resolve) => {
        clientSocket!.emit('client-kind:probe', {}, () => resolve())
      })

      expect(observed).to.equal(undefined)
    })

    it('skips the wrap entirely when no getClientKind callback is registered (backward compat)', async () => {
      await server.start(9982)

      let observed: 'sentinel' | ClientType | undefined = 'sentinel'
      server.onRequest('client-kind:probe', () => {
        observed = getClientKindFromContext()
        return {ok: true}
      })

      clientSocket = io('http://127.0.0.1:9982')
      await new Promise<void>((resolve) => {
        clientSocket!.on('connect', resolve)
      })

      await new Promise<void>((resolve) => {
        clientSocket!.emit('client-kind:probe', {}, () => resolve())
      })

      expect(observed).to.equal(undefined)
    })
  })
})
