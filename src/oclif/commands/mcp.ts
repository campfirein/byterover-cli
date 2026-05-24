import {NoInstanceRunningError} from '@campfirein/brv-transport-client'
import {Command} from '@oclif/core'
import {appendFileSync, mkdirSync} from 'node:fs'
import {join} from 'node:path'

import {ByteRoverMcpServer} from '../../server/infra/mcp/index.js'
import {getGlobalDataDir} from '../../server/utils/global-data-path.js'
import {runMcpCleanup} from '../lib/mcp-cleanup.js'
import {createMcpCrashHandlers} from '../lib/mcp-crash-handler.js'

const CLEANUP_TIMEOUT_MS = 2000

/**
 * MCP command - starts the MCP server for coding agent integration.
 *
 * This command is spawned by coding agents (Claude Code, Cursor, Windsurf)
 * and connects to a running brv instance via Socket.IO.
 */
export default class Mcp extends Command {
  public static description = `Start MCP server for coding agent integration

Exposes tools:
- brv-query: Query the context tree
- brv-curate: Curate context to the tree`
  public static examples = [
    '# Start MCP server (typically called by coding agents)',
    '<%= config.bin %> <%= command.id %>',
  ]
  public static hidden = true // Called by agents, not users directly

  public async run(): Promise<void> {
    // Crash handlers exit(1) on any unhandled error so MCP clients can respawn.
    // Without exit, a recurring exception source pegs CPU and SIGTERM is ignored.
    const logsDir = join(getGlobalDataDir(), 'logs')
    const crashLogPath = join(logsDir, 'mcp-crash.log')
    // Ensure the logs directory exists once at boot so the crash path (which
    // may run under EPIPE / OOM pressure) never has to do filesystem setup.
    try {
      mkdirSync(logsDir, {recursive: true})
    } catch {
      // Best-effort. The fileWrite below is wrapped in try/catch by the handler.
    }

    const crashHandlers = createMcpCrashHandlers({
      exit(code) {
        // eslint-disable-next-line n/no-process-exit, unicorn/no-process-exit
        process.exit(code)
      },
      fileWrite(line) {
        appendFileSync(crashLogPath, line)
      },
      now: () => new Date(),
      stderrWrite(chunk) {
        process.stderr.write(chunk)
      },
    })

    process.on('uncaughtException', crashHandlers.onUncaughtException)
    process.on('unhandledRejection', crashHandlers.onUnhandledRejection)

    try {
      const server = new ByteRoverMcpServer({
        version: this.config.version,
        workingDirectory: process.cwd(),
      })

      // Graceful shutdown — race server.stop() against a hard timeout so SIGTERM
      // is always honored even if stop() hangs or rejects.
      const cleanup = (): Promise<void> =>
        runMcpCleanup(() => server.stop(), CLEANUP_TIMEOUT_MS, {
          exit(code) {
            // eslint-disable-next-line n/no-process-exit, unicorn/no-process-exit
            process.exit(code)
          },
        })

      process.on('SIGTERM', cleanup)
      process.on('SIGINT', cleanup)

      await server.start()

      // Keep the process alive - MCP server runs on stdio
      // The process will be terminated by SIGTERM/SIGINT or when the parent process closes stdin
      await new Promise<void>((resolve) => {
        process.stdin.on('close', () => {
          resolve()
        })
        process.stdin.on('end', () => {
          resolve()
        })
      })

      // Route the stdin-close shutdown through the same bounded cleanup helper
      // as SIGTERM/SIGINT so a throw inside server.stop() can't degrade a
      // graceful exit into an uncaughtException(1).
      await cleanup()
    } catch (error) {
      if (error instanceof Error && error.message.startsWith('Failed to start daemon')) {
        this.logToStderr(`Error: ${error.message}`)
        this.logToStderr(`Check daemon logs at: ${join(getGlobalDataDir(), 'logs')}`)
        this.logToStderr("Run 'brv restart' to force a clean restart.")
        // eslint-disable-next-line n/no-process-exit, unicorn/no-process-exit
        process.exit(1)
      }

      if (error instanceof NoInstanceRunningError) {
        this.logToStderr('Error: Daemon was started but connection failed.')
        this.logToStderr('The daemon may have crashed immediately after starting.')
        this.logToStderr(`Check daemon logs at: ${join(getGlobalDataDir(), 'logs')}`)
        this.logToStderr("Run 'brv restart' to force a clean restart.")
        // eslint-disable-next-line n/no-process-exit, unicorn/no-process-exit
        process.exit(1)
      }

      throw error
    }
  }
}
