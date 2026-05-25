import {expect} from 'chai'
import express from 'express'
import {createServer} from 'node:http'

import {WebUiPortInUseError, WebUiServerAlreadyRunningError} from '../../../../src/server/core/domain/errors/webui-error.js'
import {WebUiServer} from '../../../../src/server/infra/webui/webui-server.js'

describe('WebUiServer', () => {
  let server: WebUiServer

  afterEach(async () => {
    if (server?.isRunning()) {
      await server.stop()
    }
  })

  it('should start on specified port', async () => {
    const app = express()
    app.get('/health', (_req, res) => res.json({ok: true}))
    server = new WebUiServer(app)

    await server.start(0) // port 0 = OS picks available port
    expect(server.isRunning()).to.be.true
    expect(server.getPort()).to.be.a('number')
    expect(server.getPort()).to.be.greaterThan(0)
  })

  it('should stop gracefully', async () => {
    server = new WebUiServer(express())
    await server.start(0)
    expect(server.isRunning()).to.be.true

    await server.stop()
    expect(server.isRunning()).to.be.false
    expect(server.getPort()).to.be.undefined
  })

  it('should reject with WebUiPortInUseError when port is in use', async () => {
    // Occupy a port first
    const blockingServer = createServer()
    const occupiedPort = await new Promise<number>((resolve, reject) => {
      blockingServer.on('error', reject)
      blockingServer.listen(0, '127.0.0.1', () => {
        const addr = blockingServer.address()
        if (typeof addr === 'object' && addr !== null) {
          resolve(addr.port)
        }
      })
    })

    try {
      server = new WebUiServer(express())
      try {
        await server.start(occupiedPort)
        expect.fail('Expected start to reject')
      } catch (error) {
        expect(error).to.be.an.instanceOf(WebUiPortInUseError)
        expect((error as WebUiPortInUseError).port).to.equal(occupiedPort)
        expect((error as Error).message).to.include('in use')
      }

      expect(server.isRunning()).to.be.false
      expect(server.getPort()).to.be.undefined
    } finally {
      blockingServer.close()
    }
  })

  it('should not allow double start', async () => {
    server = new WebUiServer(express())
    await server.start(0)
    try {
      await server.start(0)
      expect.fail('Expected start to reject')
    } catch (error) {
      expect(error).to.be.an.instanceOf(WebUiServerAlreadyRunningError)
    }
  })

  it('should be a no-op to stop when not running', async () => {
    server = new WebUiServer(express())
    await server.stop() // should not throw
  })

  it('should ignore post-startup error emissions so stop() still cleans up', async () => {
    server = new WebUiServer(express())
    await server.start(0)
    const boundPort = server.getPort()
    expect(boundPort).to.be.a('number')

    const internal = server as unknown as {httpServer?: {emit(event: string, err: Error): boolean}}
    internal.httpServer?.emit('error', Object.assign(new Error('ECONNRESET'), {code: 'ECONNRESET'}))

    expect(server.isRunning()).to.be.true
    expect(server.getPort()).to.equal(boundPort)

    await server.stop()
    expect(server.isRunning()).to.be.false
    expect(server.getPort()).to.be.undefined
  })
})
