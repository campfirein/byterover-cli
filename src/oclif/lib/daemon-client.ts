import {
  ConnectionError,
  ConnectionFailedError,
  type ConnectionResult,
  DaemonSpawnError,
  InstanceCrashedError,
  type ITransportClient,
  NoInstanceRunningError,
  TransportRequestError,
  TransportRequestTimeoutError,
} from '@campfirein/brv-transport-client'
import {dirname, join} from 'node:path'
import {fileURLToPath} from 'node:url'

import {TaskErrorCode} from '../../server/core/domain/errors/task-error.js'
import {resolveProject} from '../../server/infra/project/resolve-project.js'
import {createDaemonAwareConnector, type TransportConnector} from '../../server/infra/transport/transport-connector.js'
import {
  getSandboxEnvironmentName,
  isSandboxEnvironment,
  isSandboxNetworkError,
} from '../../server/utils/sandbox-detector.js'
import {assertBuildVersionMatch, type BuildInfoResponse} from '../../shared/build-info-check.js'
import {VcErrorCode} from '../../shared/transport/events/vc-events.js'

/** Guard: only check build version once per CLI process. */
let buildVersionChecked = false

/**
 * Phase 9.5.9 Issue 5 — fire-and-forget build-version mismatch check.
 *
 * Called once per CLI process after the first successful daemon connection.
 * Calls `system:build-info`, compares against the CLI's own
 * `dist/build-info.json`, and prints a staleness warning to stderr if they
 * differ. Errors are swallowed (best-effort observability, not blocking).
 */
function checkBuildVersionOnce(client: ITransportClient): void {
  if (buildVersionChecked) return
  buildVersionChecked = true

  // Wrap the callback-ack request in a Promise.
  const checkPromise = new Promise<void>((resolve) => {
    try {
      client.request<BuildInfoResponse | undefined>('system:build-info', undefined, (daemonBuildInfo) => {
        const cliDir = dirname(fileURLToPath(import.meta.url))
        // dist/oclif/lib/ → dist/ is 3 levels up
        const buildInfoPath = join(cliDir, '..', '..', 'build-info.json')
        assertBuildVersionMatch({
          buildInfoPath,
          daemonBuildInfo,
          printWarning: (msg) => process.stderr.write(msg + '\n'),
        })
          .catch(() => { /* swallow */ })
          .finally(resolve)
      })
    } catch {
      resolve()
    }
  })

  // Fire-and-forget — don't block the calling code path.
  checkPromise.catch(() => { /* swallow */ })
}

/** Max retry attempts. 10 × 1s = 9s budget covers cold-start ECONNREFUSED incl. slow OIDC. */
const MAX_RETRIES = 10
/** Delay between retry attempts (ms). */
const DEFAULT_RETRY_DELAY_MS = 1000

/** Maps handler error codes to user-friendly CLI messages */
const USER_FRIENDLY_MESSAGES: Record<string, string> = {
  [TaskErrorCode.AGENT_NOT_INITIALIZED]: "Agent failed to initialize. Run 'brv restart' to force a clean restart.",
  [TaskErrorCode.CONTEXT_TREE_NOT_INITIALIZED]: 'Context tree not initialized.',
  [TaskErrorCode.LOCAL_CHANGES_EXIST]: 'You have local changes. Run "brv push" to save your changes before pulling.',
  [TaskErrorCode.NOT_AUTHENTICATED]:
    'Not authenticated. Cloud sync features (push/pull/space) require login — local query and curate work without authentication.',
  [TaskErrorCode.OAUTH_REFRESH_FAILED]:
    'OAuth token refresh failed. Run "brv providers connect <provider> --oauth" to reconnect.',
  [TaskErrorCode.OAUTH_TOKEN_EXPIRED]:
    'OAuth token has expired. Run "brv providers connect <provider> --oauth" to reconnect.',
  [TaskErrorCode.PROJECT_NOT_INIT]: 'Project not initialized. Run "brv restart" to reinitialize.',
  [TaskErrorCode.PROVIDER_NOT_CONFIGURED]:
    'No provider connected. Run "brv providers connect byterover" to use the free built-in provider, or connect another provider.',
  [TaskErrorCode.SPACE_NOT_FOUND]: 'Space not found. Check your configuration.',
  [TaskErrorCode.VC_GIT_INITIALIZED]:
    'ByteRover version control is active. Use brv vc commands instead of legacy sync commands.',
  [VcErrorCode.AUTH_FAILED]: 'Authentication failed. Run brv login.',
  [VcErrorCode.CONFIG_KEY_NOT_SET]: 'Config key is not set.',
  [VcErrorCode.CONFLICT_MARKERS_PRESENT]:
    'Conflict markers detected. Resolve conflicts and run brv vc add before pushing.',
  [VcErrorCode.GIT_NOT_INITIALIZED]: 'ByteRover version control not initialized. Run brv vc init first.',
  // INVALID_BRANCH_NAME intentionally omitted: fall through to server's message with actual branch name
  [VcErrorCode.INVALID_CONFIG_KEY]: 'Invalid config key. Allowed: user.name, user.email.',
  [VcErrorCode.NETWORK_ERROR]: 'Network error. Check your connection and try again.',
  [VcErrorCode.NON_FAST_FORWARD]: 'Remote has changes. Run brv vc pull first.',
  [VcErrorCode.NOTHING_STAGED]: 'Nothing staged. Run brv vc add first.',
  [VcErrorCode.NOTHING_TO_PUSH]: 'No commits to push. Run brv vc add and brv vc commit first.',
  [VcErrorCode.REMOTE_ALREADY_EXISTS]: "Remote 'origin' already exists. Use brv vc remote set-url <url> to update.",
  // UNCOMMITTED_CHANGES intentionally omitted: fall through to server's detailed message with file paths
  // USER_NOT_CONFIGURED intentionally omitted: fall through to server's specific hint with actual values
}

export interface DaemonClientOptions {
  /** Max retry attempts. Default: 10 */
  maxRetries?: number
  /** Explicit project path — bypasses walk-up discovery. Use for `init` where .brv/ doesn't exist yet. */
  projectPath?: string
  /** Explicit --project-root flag value to override auto-detection */
  projectRootFlag?: string
  /** Delay between retries in ms. Default: 1000. Set to 0 in tests. */
  retryDelayMs?: number
  /** Optional transport connector for DI/testing */
  transportConnector?: TransportConnector
}

function resolveRequiredProjectPath(projectRootFlag?: string): {projectRoot: string; worktreeRoot: string} {
  const resolution = resolveProject({projectRootFlag})
  if (!resolution) {
    // No .brv found at cwd — fall back to cwd. The daemon will auto-init .brv/ on first connection.
    const cwd = process.cwd()
    return {projectRoot: cwd, worktreeRoot: cwd}
  }

  return resolution
}

/**
 * Connects to the daemon, auto-starting it if needed.
 */
export async function connectToDaemonClient(
  options?: Pick<DaemonClientOptions, 'projectRootFlag' | 'transportConnector'>,
): Promise<ConnectionResult> {
  const connector = options?.transportConnector ?? createDaemonAwareConnector()
  const resolution = resolveRequiredProjectPath(options?.projectRootFlag)
  return connector(undefined, resolution.projectRoot)
}

/**
 * Executes an operation against the daemon with retry logic.
 *
 * Retries on infrastructure failures (daemon spawn timeout, connection dropped,
 * agent disconnected). Does NOT retry on business errors (auth, validation, etc.).
 */
export async function withDaemonRetry<T>(
  fn: (client: ITransportClient, projectRoot?: string, worktreeRoot?: string) => Promise<T>,
  options?: DaemonClientOptions & {
    /** Called before each retry with attempt number (1-indexed) */
    onRetry?: (attempt: number, maxRetries: number) => void
  },
): Promise<T> {
  const maxRetries = options?.maxRetries ?? MAX_RETRIES
  const retryDelayMs = options?.retryDelayMs ?? DEFAULT_RETRY_DELAY_MS
  const connector = options?.transportConnector ?? createDaemonAwareConnector(options?.projectPath)

  // Pre-resolve project (workspace-link-aware) so the connector registers
  // with the correct projectPath and callers get the resolved worktreeRoot.
  const resolution = resolveRequiredProjectPath(options?.projectRootFlag)
  const resolvedProjectPath = resolution.projectRoot
  const resolvedWorkspaceRoot = resolution.worktreeRoot

  let lastError: unknown

  /* eslint-disable no-await-in-loop -- intentional sequential retry loop */
  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    let client: ITransportClient | undefined

    try {
      const {client: connectedClient, projectRoot} = await connector(undefined, resolvedProjectPath)
      client = connectedClient

      // Issue 5: fire-and-forget build-version check on first successful
      // connection per CLI process. Does not block or affect the result.
      checkBuildVersionOnce(client)

      const value = await fn(client, projectRoot ?? resolvedProjectPath, resolvedWorkspaceRoot)

      await client.disconnect().catch(() => {})
      return value
    } catch (error) {
      if (client) {
        await client.disconnect().catch(() => {})
      }

      lastError = error

      if (isRetryableError(error) && attempt < maxRetries) {
        options?.onRetry?.(attempt + 1, maxRetries)

        await new Promise<void>((resolve) => {
          setTimeout(resolve, retryDelayMs)
        })

        continue
      }

      break
    }
  }
  /* eslint-enable no-await-in-loop */

  throw lastError
}

/**
 * Checks if an error is retryable (daemon/agent infrastructure failure).
 */
export function isRetryableError(error: unknown): boolean {
  if (error instanceof DaemonSpawnError || error instanceof ConnectionFailedError) return true
  if (error instanceof TransportRequestTimeoutError) return true
  return hasLeakedHandles(error)
}

/**
 * Checks if an error left leaked Socket.IO handles that prevent Node.js from exiting.
 */
export function hasLeakedHandles(error: unknown): boolean {
  if (!(error instanceof Error)) return false
  if (!('code' in error)) return false
  return error.code === TaskErrorCode.AGENT_DISCONNECTED || error.code === TaskErrorCode.AGENT_NOT_AVAILABLE
}

/**
 * Builds a user-friendly message when provider credentials are missing from storage.
 */
export function providerMissingMessage(activeProvider: string, authMethod?: 'api-key' | 'oauth'): string {
  return authMethod === 'oauth'
    ? `${activeProvider} authentication has expired.\nPlease reconnect: brv providers connect ${activeProvider} --oauth`
    : `${activeProvider} API key is missing from storage.\nPlease reconnect: brv providers connect ${activeProvider} --api-key <your-key>`
}

export interface ProviderErrorContext {
  activeModel?: string
  activeProvider?: string
}

/**
 * Formats a connection error into a user-friendly message.
 */
export function formatConnectionError(error: unknown, providerContext?: ProviderErrorContext): string {
  if (error instanceof NoInstanceRunningError) {
    if (isSandboxEnvironment()) {
      const sandboxName = getSandboxEnvironmentName()
      return (
        `Daemon failed to start automatically.\n` +
        `⚠️  Sandbox environment detected (${sandboxName}).\n\n` +
        `Run 'brv' in a terminal outside the sandbox, then allow network access so this sandbox can connect.`
      )
    }

    return 'Daemon failed to start automatically.\n\nRestart your terminal and retry the command.'
  }

  if (error instanceof InstanceCrashedError) {
    return "Daemon crashed unexpectedly.\n\nRun 'brv restart' to force a clean restart."
  }

  if (error instanceof ConnectionFailedError) {
    const isSandboxError = isSandboxNetworkError(error.originalError ?? error)

    if (isSandboxError) {
      const sandboxName = getSandboxEnvironmentName()
      return (
        `Failed to connect to the daemon.\n` +
        `Port: ${error.port ?? 'unknown'}\n` +
        `⚠️  Sandbox network restriction detected (${sandboxName}).\n\n` +
        `Please allow network access in the sandbox and retry the command.`
      )
    }

    return `Failed to connect to the daemon: ${error.message}\nRun 'brv restart' if the daemon is unresponsive.`
  }

  if (error instanceof ConnectionError) {
    return `Connection error: ${error.message}\nRun 'brv restart' if the daemon is unresponsive.`
  }

  // Business errors from transport handlers (auth, validation, etc.)
  if (error instanceof TransportRequestError) {
    // Strip the " for event '...'" suffix that TransportRequestError appends
    const baseMessage = error.message.replace(/ for event '[^']+'$/, '')

    if (error.code && typeof error.code === 'string') {
      return USER_FRIENDLY_MESSAGES[error.code] ?? baseMessage
    }

    return baseMessage
  }

  // Task errors (from task-client.ts waitForTaskCompletion) arrive as plain Error with .code property.
  // Check code-based lookup before text-matching — mirrors TUI's formatTaskError behavior.
  if (error instanceof Error && 'code' in error) {
    const {code} = error as unknown as Record<string, unknown>
    if (typeof code === 'string') {
      return USER_FRIENDLY_MESSAGES[code] ?? error.message
    }
  }

  const message = error instanceof Error ? error.message : String(error)
  const lowerMessage = message.toLowerCase()

  if (lowerMessage.includes('401') || lowerMessage.includes('unauthorized')) {
    return "Authentication required for cloud sync. Run 'brv login' to connect your account."
  }

  if (lowerMessage.includes('api key') || lowerMessage.includes('invalid key')) {
    return formatApiKeyError(providerContext)
  }

  return `Unexpected error: ${message}`
}

function formatApiKeyError(providerContext?: ProviderErrorContext): string {
  const provider = providerContext?.activeProvider ?? '<provider>'
  const model = providerContext?.activeModel
  const currentInfo = model ? `Provider: ${provider}  Model: ${model}\n\n` : `Provider: ${provider}\n\n`

  return (
    `LLM provider API key is missing or invalid.\n${currentInfo}` +
    '  Reconnect with your API key:\n' +
    `    brv providers connect ${provider} --api-key <key>\n\n` +
    '  Switch to a different provider:\n' +
    '    brv providers switch <provider>\n\n' +
    '  See all options:  brv providers --help'
  )
}
