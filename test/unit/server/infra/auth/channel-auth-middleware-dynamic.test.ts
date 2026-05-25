import {expect} from 'chai'

import type {RequestContext} from '../../../../../src/server/core/interfaces/transport/i-transport-server.js'

import {ChannelUnauthorizedError} from '../../../../../src/server/core/domain/channel/errors.js'
import {makeChannelAuthMiddleware} from '../../../../../src/server/infra/auth/channel-auth-middleware.js'

// Slice 3.5a — auth middleware reads the expected token via a provider
// callback so token rotation takes effect WITHOUT re-registering handlers.

describe('makeChannelAuthMiddleware (dynamic provider)', () => {
  const cwd = '/tmp/scratch'

  it('reads the current token via the provider on every request', async () => {
    let current = 'token-A'
    const mw = makeChannelAuthMiddleware(() => current)
    const handler = mw<unknown, string>(async () => 'ok')

    // Pass token-A → ok.
    const okCtx: RequestContext = {auth: {token: 'token-A'}, cwd, transport: 'socket.io'}
    expect(await handler({}, 'c1', okCtx)).to.equal('ok')

    // Rotate the provider's token. The middleware MUST pick up the change
    // without re-registering the handler.
    current = 'token-B'

    // Old token now fails.
    const badCtx: RequestContext = {auth: {token: 'token-A'}, cwd, transport: 'socket.io'}
    let thrown: unknown
    try {
      await handler({}, 'c1', badCtx)
    } catch (error) {
      thrown = error
    }

    expect(thrown).to.be.instanceOf(ChannelUnauthorizedError)
  })

  it('still accepts the literal-string signature for back-compat', async () => {
    const mw = makeChannelAuthMiddleware('static-token')
    const handler = mw<unknown, string>(async () => 'ok')
    const ctx: RequestContext = {auth: {token: 'static-token'}, cwd, transport: 'socket.io'}
    expect(await handler({}, 'c1', ctx)).to.equal('ok')

    let thrown: unknown
    try {
      await handler({}, 'c1', {auth: {token: 'wrong'}, cwd, transport: 'socket.io'})
    } catch (error) {
      thrown = error
    }

    expect(thrown).to.be.instanceOf(ChannelUnauthorizedError)
  })
})
