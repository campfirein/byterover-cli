import {expect} from 'chai'
import express from 'express'
import {createServer} from 'node:http'

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

  it('should reject with error when port is in use', async () => {
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
        expect(error).to.be.an.instanceOf(Error)
        expect((error as Error).message).to.include('in use')
      }

      expect(server.isRunning()).to.be.false
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
      expect(error).to.be.an.instanceOf(Error)
      expect((error as Error).message).to.include('already running')
    }
  })

  it('should be a no-op to stop when not running', async () => {
    server = new WebUiServer(express())
    await server.stop() // should not throw
  })

  describe('host parameter (ENG-2968)', () => {
    it('defaults to 127.0.0.1 when no host is passed', async () => {
      server = new WebUiServer(express())
      await server.start(0)
      expect(server.getHost()).to.equal('127.0.0.1')
    })

    it('binds to the passed host', async () => {
      server = new WebUiServer(express())
      await server.start(0, '0.0.0.0')
      expect(server.getHost()).to.equal('0.0.0.0')
    })

    it('returns undefined host when not running', () => {
      server = new WebUiServer(express())
      expect(server.getHost()).to.be.undefined
    })
  })
})
