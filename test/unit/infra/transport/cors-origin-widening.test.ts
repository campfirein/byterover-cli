import {expect} from 'chai'

import type {OriginCallback} from '../../../../src/server/core/domain/transport/types.js'

import {SocketIOTransportServer} from '../../../../src/server/infra/transport/socket-io-transport-server.js'

// Module-scoped to satisfy unicorn/consistent-function-scoping: the callback
// captures no enclosing test state and is reused across runs unchanged.
const loopbackOriginCallback: OriginCallback = (origin, done) => {
  done(null, typeof origin === 'string' && origin.startsWith('http://127.0.0.1'))
}

// Slice 1.0 — proves TransportServerConfig.corsOrigin accepts the widened union.
// Per CHANNEL_PROTOCOL.md auth design (DESIGN §5.6 Layer 1), the daemon must be
// configurable with array/regex/callback CORS shapes; the previous string-only
// type prevented that.
describe('TransportServerConfig.corsOrigin widening', () => {
  let server: SocketIOTransportServer | undefined

  before(() => {
    process.env.BRV_SESSION_LOG = '/dev/null'
  })

  after(() => {
    delete process.env.BRV_SESSION_LOG
  })

  afterEach(async () => {
    if (server?.isRunning()) {
      await server.stop()
    }

    server = undefined
  })

  it('accepts a string (preserves existing behaviour)', async () => {
    server = new SocketIOTransportServer({corsOrigin: '*'})
    await server.start(9920)
    expect(server.isRunning()).to.be.true
  })

  it('accepts a string[] for explicit origin allowlist', async () => {
    server = new SocketIOTransportServer({corsOrigin: ['http://127.0.0.1', 'http://localhost']})
    await server.start(9921)
    expect(server.isRunning()).to.be.true
  })

  it('accepts a single RegExp for wildcard-port loopback', async () => {
    server = new SocketIOTransportServer({corsOrigin: /^http:\/\/(127\.0\.0\.1|localhost)(:\d+)?$/})
    await server.start(9922)
    expect(server.isRunning()).to.be.true
  })

  it('accepts RegExp[] for multiple origin patterns', async () => {
    server = new SocketIOTransportServer({
      corsOrigin: [/^http:\/\/127\.0\.0\.1.*$/, /^http:\/\/localhost.*$/],
    })
    await server.start(9923)
    expect(server.isRunning()).to.be.true
  })

  it('accepts an OriginCallback for dynamic origin checks', async () => {
    server = new SocketIOTransportServer({corsOrigin: loopbackOriginCallback})
    await server.start(9924)
    expect(server.isRunning()).to.be.true
  })
})
