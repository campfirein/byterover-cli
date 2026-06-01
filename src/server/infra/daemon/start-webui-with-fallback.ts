import {WebUiPortInUseError} from '../../core/domain/errors/webui-error.js'

export interface WebUiStarter {
  start(port: number): Promise<void>
}

export type StartWebUiOutcome = {actualPort: number; requestedPort: number} | {error: unknown}

export async function startWebUiWithFallback(
  server: WebUiStarter,
  preferredPort: number,
  maxAttempts: number,
): Promise<StartWebUiOutcome> {
  let lastError: unknown
  for (let offset = 0; offset < maxAttempts; offset++) {
    const attemptPort = preferredPort + offset
    try {
      // eslint-disable-next-line no-await-in-loop -- intentional sequential fallback
      await server.start(attemptPort)
      return {actualPort: attemptPort, requestedPort: preferredPort}
    } catch (error) {
      lastError = error
      if (error instanceof WebUiPortInUseError) continue
      break
    }
  }

  return {error: lastError}
}
