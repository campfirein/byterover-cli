/**
 * Transport bootstrap for the browser.
 *
 * Fetches /api/ui/config to discover the daemon port, then connects
 * via socket.io-client to the daemon's transport server.
 */

import {io, type Socket} from 'socket.io-client'

export interface UiConfig {
  daemonPort: number
  projectCwd: string
  version: string
}

export class UiConfigError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'UiConfigError'
  }
}

export async function fetchUiConfig(): Promise<UiConfig> {
  const response = await fetch('/api/ui/config')
  if (!response.ok) {
    throw new UiConfigError(`Failed to fetch UI config: ${response.statusText}`)
  }

  return response.json() as Promise<UiConfig>
}

export interface ConnectResult {
  config: UiConfig
  socket: Socket
}

function registerClient(socket: Socket, projectPath: string) {
  socket.emit('client:register', {clientType: 'webui', projectPath}, () => {
    // Registration acknowledged — daemon associates the project at register time
  })

  socket.emit('room:join', 'broadcast-room')
}

/**
 * Hostname the browser uses to reach the daemon transport. Falls back to
 * `127.0.0.1` only when there's no `location` global (Node SSR / Vite dev
 * pre-render). Exposed for unit-test coverage of the SSR fallback.
 */
export function resolveDaemonHost(): string {
  const loc = globalThis.location
  return loc === undefined ? '127.0.0.1' : loc.hostname
}

export async function connectToTransport(projectPath: string): Promise<ConnectResult> {
  const config = await fetchUiConfig()

  // Use the same hostname the WebUI page was loaded from so the browser
  // works regardless of whether the daemon binds to 127.0.0.1 (default) or
  // 0.0.0.0 (Docker / LAN access via `network.host` setting or
  // `BRV_TRANSPORT_HOST` env). `typeof` keeps SSR / Vite dev safe even
  // though DOM lib types `location` as mandatory.
  const daemonHost = resolveDaemonHost()
  const socket = io(`http://${daemonHost}:${config.daemonPort}`, {
    reconnection: true,
    reconnectionAttempts: 30,
    reconnectionDelay: 50,
    reconnectionDelayMax: 1000,
    transports: ['websocket'],
  })

  // Socket.IO fires "connect" after the initial handshake and after reconnects,
  // so this keeps the client/project association and broadcast room membership fresh.
  socket.on('connect', () => registerClient(socket, projectPath))

  await new Promise<void>((resolve, reject) => {
    const cleanup = () => {
      clearTimeout(timeout)
      socket.off('connect', handleConnect)
      socket.off('connect_error', handleError)
    }

    const handleConnect = () => {
      cleanup()
      resolve()
    }

    const handleError = (error: Error) => {
      cleanup()
      reject(error)
    }

    const timeout = setTimeout(() => {
      cleanup()
      reject(new Error('Connection timeout'))
    }, 5000)

    socket.once('connect', handleConnect)
    socket.once('connect_error', handleError)
  })

  return {config, socket}
}
