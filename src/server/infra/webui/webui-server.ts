import type {Express} from 'express'

import {createServer, type Server as HttpServer} from 'node:http'

import {TRANSPORT_HOST} from '../../constants.js'

/**
 * Standalone HTTP server for the web UI.
 *
 * Runs on a stable, fixed port (default 7700) separate from the
 * dynamic Socket.IO transport port. Serves static web UI files,
 * the config API, and the review API.
 */
export class WebUiServer {
  private host: string | undefined
  private httpServer: HttpServer | undefined
  private port: number | undefined
  private running = false

  constructor(private readonly app: Express) {}

  getHost(): string | undefined {
    return this.host
  }

  getPort(): number | undefined {
    return this.port
  }

  isRunning(): boolean {
    return this.running
  }

  async start(port: number, host: string = TRANSPORT_HOST): Promise<void> {
    if (this.running) {
      throw new Error('Web UI server is already running')
    }

    return new Promise((resolve, reject) => {
      this.httpServer = createServer(this.app)

      this.httpServer.on('error', (err: NodeJS.ErrnoException) => {
        if (err.code === 'EADDRINUSE') {
          reject(new Error(`Web UI port ${port} is already in use`))
        } else {
          reject(err)
        }
      })

      this.httpServer.listen(port, host, () => {
        const addr = this.httpServer?.address()
        this.port = typeof addr === 'object' && addr !== null ? addr.port : port
        this.host = host
        this.running = true
        resolve()
      })
    })
  }

  async stop(): Promise<void> {
    if (!this.running || !this.httpServer) {
      return
    }

    return new Promise((resolve) => {
      this.httpServer!.close(() => {
        this.running = false
        this.port = undefined
        this.host = undefined
        this.httpServer = undefined
        resolve()
      })
    })
  }
}
