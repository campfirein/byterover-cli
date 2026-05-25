import {expect} from 'chai'
import {Socket as ClientSocket, io} from 'socket.io-client'

import type {RequestContext} from '../../../../src/server/core/interfaces/transport/i-transport-server.js'

import {SocketIOTransportServer} from '../../../../src/server/infra/transport/socket-io-transport-server.js'

// Slice 1.0 — proves request handlers can read handshake auth token and origin
// via the optional ctx parameter. Required by DESIGN §5.6 step 5 so the
// channel-auth-middleware (Slice 1.4) has hooks to plug into.
describe('SocketIOTransportServer handshake metadata in RequestContext', () => {
  const PORT = 9930
  let server: SocketIOTransportServer
  let client: ClientSocket | undefined

  before(() => {
    process.env.BRV_SESSION_LOG = '/dev/null'
  })

  after(() => {
    delete process.env.BRV_SESSION_LOG
  })

  beforeEach(async () => {
    server = new SocketIOTransportServer()
    await server.start(PORT)
  })

  afterEach(async () => {
    client?.disconnect()
    client = undefined
    if (server.isRunning()) {
      await server.stop()
    }
  })

  const connectClient = (options: Parameters<typeof io>[1]): Promise<ClientSocket> =>
    new Promise((resolve, reject) => {
      const s = io(`http://127.0.0.1:${PORT}`, {
        forceNew: true,
        transports: ['websocket'],
        ...options,
      })
      s.on('connect', () => resolve(s))
      s.on('connect_error', reject)
    })

  it('exposes handshake auth.token to handlers as ctx.auth.token', async () => {
    let observedCtx: RequestContext | undefined
    server.onRequest('test:auth', (_data, _clientId, ctx) => {
      observedCtx = ctx
      return {ok: true}
    })

    client = await connectClient({auth: {token: 'secret-abc'}})
    await new Promise<void>((resolve) => {
      client!.emit('test:auth', {}, () => resolve())
    })

    expect(observedCtx).to.exist
    expect(observedCtx!.auth?.token).to.equal('secret-abc')
    expect(observedCtx!.transport).to.equal('socket.io')
  })

  it('exposes handshake origin to handlers as ctx.origin', async () => {
    let observedCtx: RequestContext | undefined
    server.onRequest('test:origin', (_data, _clientId, ctx) => {
      observedCtx = ctx
      return {ok: true}
    })

    client = await connectClient({extraHeaders: {origin: 'http://127.0.0.1:1234'}})
    await new Promise<void>((resolve) => {
      client!.emit('test:origin', {}, () => resolve())
    })

    expect(observedCtx).to.exist
    expect(observedCtx!.origin).to.equal('http://127.0.0.1:1234')
  })

  it('keeps existing (data, clientId) signature working for handlers that ignore ctx', async () => {
    const observed: {clientId: string; data: unknown;}[] = []
    server.onRequest<{msg: string}>('test:legacy', (data, clientId) => {
      observed.push({clientId, data})
      return {ok: true}
    })

    client = await connectClient({})
    await new Promise<void>((resolve) => {
      client!.emit('test:legacy', {msg: 'hi'}, () => resolve())
    })

    expect(observed).to.have.lengthOf(1)
    expect(observed[0].data).to.deep.equal({msg: 'hi'})
    expect(observed[0].clientId).to.be.a('string').and.not.empty
  })

  it('provides ctx with undefined auth when client sends no auth payload', async () => {
    let observedCtx: RequestContext | undefined
    server.onRequest('test:no-auth', (_data, _clientId, ctx) => {
      observedCtx = ctx
      return {ok: true}
    })

    client = await connectClient({})
    await new Promise<void>((resolve) => {
      client!.emit('test:no-auth', {}, () => resolve())
    })

    expect(observedCtx).to.exist
    // Strict: ctx.auth itself MUST be undefined when no token was supplied,
    // not just ctx.auth.token. This catches accidental drift to {token: undefined}.
    expect(observedCtx!.auth).to.be.undefined
  })
})
