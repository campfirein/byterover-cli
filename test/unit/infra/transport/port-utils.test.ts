import {expect} from 'chai'
import {createServer, Server} from 'node:net'

import {isPortAvailable} from '../../../../src/server/infra/transport/port-utils.js'

describe('Port Utils', () => {
  describe('isPortAvailable', () => {
    let server: Server

    afterEach((done) => {
      if (server?.listening) {
        server.close(() => done())
      } else {
        done()
      }
    })

    it('should return true for an available port', async () => {
      // Use a high ephemeral port unlikely to be in use
      const port = 59_999
      const available = await isPortAvailable(port)
      expect(available).to.be.true
    })

    it('should return false for an occupied port', async () => {
      const port = 59_998

      // Occupy the port
      server = createServer()
      await new Promise<void>((resolve) => {
        server.listen(port, '127.0.0.1', () => resolve())
      })

      const available = await isPortAvailable(port)
      expect(available).to.be.false
    })

    describe('host parameter (ENG-2968)', () => {
      it('reports available when probing a non-loopback host on a free port', async () => {
        const available = await isPortAvailable(59_997, '0.0.0.0')
        expect(available).to.be.true
      })

      it('reports unavailable when the requested port is occupied on 0.0.0.0', async () => {
        const port = 59_996

        server = createServer()
        await new Promise<void>((resolve) => {
          server.listen(port, '0.0.0.0', () => resolve())
        })

        const available = await isPortAvailable(port, '0.0.0.0')
        expect(available).to.be.false
      })
    })
  })
})
