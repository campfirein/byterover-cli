import {expect} from 'chai'
import express from 'express'
import {restore, type SinonStub, stub} from 'sinon'

import {WebUiPortInUseError} from '../../../../src/server/core/domain/errors/webui-error.js'
import {startWebUiWithFallback} from '../../../../src/server/infra/daemon/start-webui-with-fallback.js'
import {WebUiServer} from '../../../../src/server/infra/webui/webui-server.js'

describe('startWebUiWithFallback', () => {
  let server: WebUiServer
  let startStub: SinonStub

  beforeEach(() => {
    server = new WebUiServer(express())
    startStub = stub(server, 'start')
  })

  afterEach(() => {
    restore()
  })

  it('returns the preferred port on first-attempt success', async () => {
    startStub.resolves()

    const outcome = await startWebUiWithFallback(server, 7700, 10)

    expect(outcome).to.deep.equal({actualPort: 7700, requestedPort: 7700, status: 'ok'})
    expect(startStub.calledOnceWithExactly(7700)).to.be.true
  })

  it('falls back to the next port when the preferred port is in use', async () => {
    startStub.onFirstCall().rejects(new WebUiPortInUseError(7700))
    startStub.onSecondCall().resolves()

    const outcome = await startWebUiWithFallback(server, 7700, 10)

    expect(outcome).to.deep.equal({actualPort: 7701, requestedPort: 7700, status: 'ok'})
    expect(startStub.callCount).to.equal(2)
    expect(startStub.firstCall.args[0]).to.equal(7700)
    expect(startStub.secondCall.args[0]).to.equal(7701)
  })

  it('returns the last error when every attempt fails with EADDRINUSE', async () => {
    startStub.rejects(new WebUiPortInUseError(7700))

    const outcome = await startWebUiWithFallback(server, 7700, 3)

    expect(outcome.status).to.equal('error')
    if (outcome.status === 'error') {
      expect(outcome.error).to.be.an.instanceOf(WebUiPortInUseError)
    }

    expect(startStub.callCount).to.equal(3)
  })

  it('treats maxAttempts=1 as strict mode (no fallback)', async () => {
    startStub.rejects(new WebUiPortInUseError(9090))

    const outcome = await startWebUiWithFallback(server, 9090, 1)

    expect(outcome.status).to.equal('error')
    expect(startStub.calledOnceWithExactly(9090)).to.be.true
  })

  it('breaks immediately on non-EADDRINUSE errors', async () => {
    const genericError = new Error('permission denied')
    startStub.rejects(genericError)

    const outcome = await startWebUiWithFallback(server, 7700, 10)

    expect(outcome.status).to.equal('error')
    if (outcome.status === 'error') {
      expect(outcome.error).to.equal(genericError)
    }

    expect(startStub.calledOnce).to.be.true
  })
})
