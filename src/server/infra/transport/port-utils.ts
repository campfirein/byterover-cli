import {createServer} from 'node:net'

import {TRANSPORT_HOST} from '../../constants.js'

/**
 * Checks if a port is available for binding.
 *
 * @param port - The port number to check
 * @param host - The host interface to probe. Defaults to the loopback constant
 *   `TRANSPORT_HOST`; pass the same host the real server will bind on so the
 *   probe is accurate when the daemon is reconfigured to listen on `0.0.0.0`.
 * @returns Promise resolving to true if available, false otherwise
 */
export function isPortAvailable(port: number, host: string = TRANSPORT_HOST): Promise<boolean> {
  return new Promise((resolve) => {
    const server = createServer()

    server.once('error', () => {
      resolve(false)
    })

    server.once('listening', () => {
      server.close(() => {
        resolve(true)
      })
    })

    server.listen(port, host)
  })
}
