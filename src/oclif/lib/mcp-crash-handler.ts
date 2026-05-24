export type McpCrashHandlerDeps = {
  readonly exit: (code: number) => void
  readonly fileWrite: (line: string) => void
  readonly now: () => Date
  readonly stderrWrite: (chunk: string) => void
}

export type McpCrashHandlers = {
  readonly onUncaughtException: (error: unknown) => void
  readonly onUnhandledRejection: (reason: unknown) => void
}

const UNPRINTABLE = '<unprintable error>'

function safeStack(err: unknown): string {
  try {
    if (err instanceof Error) {
      const {stack} = err
      if (typeof stack === 'string') return stack
      const {message} = err
      if (typeof message !== 'string') return UNPRINTABLE
      const {name} = err
      if (typeof name === 'string' && name.length > 0) return `${name}: ${message}`
      return message
    }

    return String(err)
  } catch {
    return UNPRINTABLE
  }
}

/**
 * Build process-level crash handlers for `brv mcp`.
 *
 * Each handler logs once and then exits with code 1. Every side effect is
 * isolated in its own try/catch so a failing logger cannot re-fire the
 * uncaughtException event. A module-instance re-entry flag adds defense in
 * depth: once a crash is being handled, subsequent invocations short-circuit
 * so `exit` is only called once.
 *
 * MCP clients (Claude Code / Cursor / Windsurf) respawn the server on demand,
 * so log-and-exit is the protocol-correct behavior for this child process.
 */
export function createMcpCrashHandlers(deps: McpCrashHandlerDeps): McpCrashHandlers {
  let crashed = false

  const handle = (label: string, value: unknown): void => {
    if (crashed) return
    crashed = true

    const message = safeStack(value)
    const stderrLine = `[brv-mcp] ${label}: ${message}\n`

    try {
      deps.stderrWrite(stderrLine)
    } catch {
      // stderr might be closed (EPIPE) when the parent has torn down stdio
    }

    try {
      deps.fileWrite(`${deps.now().toISOString()} [${label}] ${message}\n`)
    } catch {
      // crash log is best-effort; do not block exit on filesystem errors
    }

    try {
      deps.exit(1)
    } catch {
      // process.exit should not throw, but never let it break the handler
    }
  }

  return {
    onUncaughtException(error: unknown) {
      handle('Uncaught exception', error)
    },
    onUnhandledRejection(reason: unknown) {
      handle('Unhandled rejection', reason)
    },
  }
}
