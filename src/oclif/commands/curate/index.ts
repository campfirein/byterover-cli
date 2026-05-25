import type {ITransportClient, TaskAck} from '@campfirein/brv-transport-client'

import {Args, Command, Flags} from '@oclif/core'
import {randomUUID} from 'node:crypto'

import type {CurateLogOperation} from '../../../server/core/domain/entities/curate-log-entry.js'

import {BRV_DIR, CONTEXT_TREE_DIR} from '../../../server/constants.js'
import {ProviderConfigResponse, TransportStateEventNames} from '../../../server/core/domain/transport/index.js'
import {extractCurateOperations} from '../../../server/utils/curate-result-parser.js'
import {TaskEvents} from '../../../shared/transport/events/index.js'
import {printBillingLine} from '../../lib/billing-line.js'
import {runCancelBranchWithRetry} from '../../lib/cancel-task.js'
import {
  type DaemonClientOptions,
  formatConnectionError,
  hasLeakedHandles,
  type ProviderErrorContext,
  providerMissingMessage,
  withDaemonRetry,
} from '../../lib/daemon-client.js'
import {ensureBillingFunds} from '../../lib/insufficient-credits.js'
import {writeJsonResponse} from '../../lib/json-response.js'
import {DEFAULT_TIMEOUT_SECONDS, MAX_TIMEOUT_SECONDS, MIN_TIMEOUT_SECONDS, type ToolCallRecord, waitForTaskCompletion} from '../../lib/task-client.js'
import {TIMEOUT_DEPRECATION_HELP, warnIfTimeoutFlagUsed} from '../../lib/timeout-deprecation.js'

/** Parsed flags type */
type CurateFlags = {
  detach?: boolean
  files?: string[]
  folder?: string[]
  format?: 'json' | 'text'
  timeout?: number
}

export default class Curate extends Command {
  public static args = {
    context: Args.string({
      description: 'Knowledge context: patterns, decisions, errors, or insights',
      required: false,
    }),
  }
  public static description = `Curate context to the context tree

Good examples:
- "Auth uses JWT with 24h expiry. Tokens stored in httpOnly cookies via authMiddleware.ts"
- "API rate limit is 100 req/min per user. Implemented using Redis with sliding window in rateLimiter.ts"
Bad examples:
- "Authentication" or "JWT tokens" (too vague, lacks context)
- "Rate limiting" (no implementation details or file references)`
  public static examples = [
    '# Curate context - queues task for background processing',
    '<%= config.bin %> <%= command.id %> "Auth uses JWT with 24h expiry. Tokens stored in httpOnly cookies via authMiddleware.ts"',
    '',
    '# Include relevant files for comprehensive context (max 5 files)',
    '<%= config.bin %> <%= command.id %> "Authentication middleware validates JWT tokens" -f src/middleware/auth.ts',
    '',
    '# Multiple files',
    '<%= config.bin %> <%= command.id %> "JWT authentication implementation" --files src/auth/jwt.ts --files docs/auth.md',
    '',
    '# Folder pack - analyze and curate entire folder',
    '<%= config.bin %> <%= command.id %> --folder src/auth/',
    '',
    '# Folder pack with context',
    '<%= config.bin %> <%= command.id %> "Analyze authentication module" -d src/auth/',
    '',
    '# Increase timeout for slow models (in seconds)',
    '<%= config.bin %> <%= command.id %> "context here" --timeout 600',
    '',
    '# View curate history',
    '<%= config.bin %> curate view',
    '<%= config.bin %> curate view --status completed --since 1h',
  ]
  public static flags = {
    cancel: Flags.string({
      description: 'Cancel a running task by id. Short-circuits the create flow — no new task is created.',
      exclusive: ['files', 'folder', 'detach'],
    }),
    detach: Flags.boolean({
      default: false,
      description: 'Queue task and exit without waiting for completion',
    }),
    files: Flags.string({
      char: 'f',
      description: 'Include specific file paths for critical context (max 5 files)',
      multiple: true,
    }),
    folder: Flags.string({
      char: 'd',
      description: 'Folder path to pack and analyze (triggers folder pack flow)',
      multiple: true,
    }),
    format: Flags.string({
      default: 'text',
      description: 'Output format (text or json)',
      options: ['text', 'json'],
    }),
    timeout: Flags.integer({
      default: DEFAULT_TIMEOUT_SECONDS,
      description: TIMEOUT_DEPRECATION_HELP,
      max: MAX_TIMEOUT_SECONDS,
      min: MIN_TIMEOUT_SECONDS,
    }),
  }

  protected getDaemonClientOptions(): DaemonClientOptions {
    return {}
  }

  public async run(): Promise<void> {
    const {args, flags: rawFlags} = await this.parse(Curate)
    const flags: CurateFlags = {
      detach: rawFlags.detach,
      files: rawFlags.files,
      folder: rawFlags.folder,
      format: rawFlags.format === 'json' ? 'json' : rawFlags.format === 'text' ? 'text' : undefined,
      timeout: rawFlags.timeout,
    }
    const format: 'json' | 'text' = flags.format ?? 'text'

    if (rawFlags.cancel) {
      const ok = await runCancelBranchWithRetry({
        command: 'curate',
        daemonClientOptions: this.getDaemonClientOptions(),
        format,
        log: (msg) => this.log(msg),
        onTransportError: (error) => this.reportError(error, format),
        taskId: rawFlags.cancel,
      })
      if (!ok) this.exit(1)
      return
    }

    warnIfTimeoutFlagUsed({
      defaultValue: DEFAULT_TIMEOUT_SECONDS,
      log: (message) => this.log(message),
      userValue: rawFlags.timeout,
    })

    if (!this.validateInput(args, flags, format)) return

    const resolvedContent = args.context?.trim()
      ? args.context
      : flags.folder?.length
        ? 'Analyze this folder and extract all relevant knowledge, patterns, and documentation.'
        : ''
    const taskType = flags.folder?.length ? 'curate-folder' : 'curate'

    let providerContext: ProviderErrorContext | undefined
    let wasCancelled = false

    try {
      await withDaemonRetry(
        async (client, projectRoot, worktreeRoot) => {
          const active = await client.requestWithAck<ProviderConfigResponse>(
            TransportStateEventNames.GET_PROVIDER_CONFIG,
          )
          providerContext = {activeModel: active.activeModel, activeProvider: active.activeProvider}

          if (!active.activeProvider) {
            throw new Error(
              'No provider connected. Run "brv providers connect byterover" to use the free built-in provider, or connect another provider.',
            )
          }

          if (active.providerKeyMissing) {
            throw new Error(providerMissingMessage(active.activeProvider, active.authMethod))
          }

          const billing = await printBillingLine({client, format, log: (msg) => this.log(msg)})

          if (billing) {
            await ensureBillingFunds({billing, client})
          }

          const result = await this.submitTask({
            client,
            content: resolvedContent,
            flags,
            format,
            projectRoot,
            taskType,
            worktreeRoot,
          })
          if (result.wasCancelled) wasCancelled = true
        },
        {
          ...this.getDaemonClientOptions(),
          onRetry:
            format === 'text'
              ? (attempt, maxRetries) =>
                  this.log(`\nConnection lost. Restarting daemon... (attempt ${attempt}/${maxRetries})`)
              : undefined,
        },
      )
    } catch (error) {
      this.reportError(error, format, providerContext)
      return
    }

    // Throw the SIGINT-conventional exit AFTER the daemon-retry try/catch so
    // the ExitError isn't swallowed by reportError. Routine completions and
    // errors fall through here naturally.
    if (wasCancelled) this.exit(130)
  }

  /**
   * Build the pendingReview JSON payload for --format json output.
   * Uses server-authoritative count; files list is best-effort enrichment from tool results.
   */
  private buildPendingReviewJson(
    pendingCount: number,
    pendingOps: CurateLogOperation[],
    taskId: string,
  ): {count: number; files: unknown[]; taskId: string} {
    return {
      count: pendingCount,
      files: pendingOps.map((op) => ({
        after: op.summary,
        before: op.previousSummary,
        filePath: this.extractContextTreeRelativePath(op.filePath) ?? op.path,
        impact: op.impact,
        path: op.path,
        reason: op.reason,
        type: op.type,
      })),
      taskId,
    }
  }

  /**
   * Collect all operations requiring review from the completed tool calls.
   * Best-effort enrichment: returns per-file detail when tool results include needsReview.
   * The authoritative signal for whether review is required comes from ReviewEvents.NOTIFY.
   */
  private collectPendingReviewOps(toolCalls: ToolCallRecord[]): CurateLogOperation[] {
    const pending: CurateLogOperation[] = []

    for (const tc of toolCalls) {
      if (tc.status !== 'completed') continue
      const ops = extractCurateOperations({result: tc.result, toolName: tc.toolName})
      for (const op of ops) {
        if (op.needsReview === true) pending.push(op)
      }
    }

    return pending
  }

  /**
   * Extract file changes from collected tool calls (same logic as TUI useActivityLogs).
   */
  private composeChangesFromToolCalls(toolCalls: ToolCallRecord[]): {created: string[]; updated: string[]} {
    const changes: {created: string[]; updated: string[]} = {created: [], updated: []}

    for (const tc of toolCalls) {
      if (tc.status !== 'completed') continue
      const ops = extractCurateOperations({result: tc.result, toolName: tc.toolName})
      this.extractChangesFromApplied(ops, changes)
    }

    return changes
  }

  private extractChangesFromApplied(
    applied: CurateLogOperation[],
    changes: {created: string[]; updated: string[]},
  ): void {
    for (const op of applied) {
      if (op.status !== 'success' || !op.filePath) continue

      switch (op.type) {
        case 'ADD': {
          changes.created.push(op.filePath)
          break
        }

        case 'UPDATE':
        case 'UPSERT': {
          changes.updated.push(op.filePath)
          break
        }

        default: {
          break
        }
      }
    }
  }

  private extractContextTreeRelativePath(filePath?: string): string | undefined {
    if (!filePath) return undefined
    const marker = `${BRV_DIR}/${CONTEXT_TREE_DIR}/`
    const idx = filePath.indexOf(marker)
    if (idx === -1) return undefined
    return filePath.slice(idx + marker.length)
  }

  /**
   * Print a human-readable pending review summary to stdout.
   * Called after successful curate completion when review is required.
   * pendingCount is server-authoritative; pendingOps provides best-effort per-file detail.
   */
  private printPendingReviewSummary(pendingCount: number, pendingOps: CurateLogOperation[], taskId: string): void {
    this.log(
      `\n⚠  ${pendingCount} operation${pendingCount === 1 ? '' : 's'} require${pendingCount === 1 ? 's' : ''} review (task: ${taskId})`,
    )

    for (const op of pendingOps) {
      const impact = op.impact === 'high' ? ' · HIGH IMPACT' : ''
      const displayPath = this.extractContextTreeRelativePath(op.filePath) ?? op.path
      this.log(`\n  [${op.type}${impact}] - path: ${displayPath}`)
      if (op.reason) this.log(`  Why:   ${op.reason}`)
      if (op.previousSummary) this.log(`  Before: ${op.previousSummary.replaceAll('\n', '\n          ')}`)
      if (op.summary) this.log(`  After:  ${op.summary.replaceAll('\n', '\n          ')}`)
    }

    this.log(`\n  To approve all:  brv review approve ${taskId}`)
    this.log(`  To reject all:   brv review reject ${taskId}`)
    this.log(`  Per file:        brv review approve/reject ${taskId} --file <path> [--file <path>]`)
  }

  private reportError(error: unknown, format: 'json' | 'text', providerContext?: ProviderErrorContext): void {
    const errorMessage = error instanceof Error ? error.message : 'Curate failed'

    if (format === 'json') {
      writeJsonResponse({command: 'curate', data: {error: errorMessage, status: 'error'}, success: false})
    } else {
      this.log(formatConnectionError(error, providerContext))
    }

    if (hasLeakedHandles(error)) {
      // eslint-disable-next-line n/no-process-exit, unicorn/no-process-exit
      process.exit(1)
    }
  }

  private async submitTask(props: {
    client: ITransportClient
    content: string
    flags: CurateFlags
    format: 'json' | 'text'
    projectRoot?: string
    taskType: string
    worktreeRoot?: string
  }): Promise<{wasCancelled: boolean}> {
    const {client, content, flags, format, projectRoot, taskType, worktreeRoot} = props
    const hasFolders = Boolean(flags.folder?.length)
    const taskId = randomUUID()
    const taskPayload = {
      clientCwd: process.cwd(),
      content,
      ...(flags.files?.length ? {files: flags.files} : {}),
      ...(hasFolders && flags.folder ? {folderPath: flags.folder[0]} : {}),
      ...(projectRoot ? {projectPath: projectRoot} : {}),
      taskId,
      type: taskType,
      ...(worktreeRoot ? {worktreeRoot} : {}),
    }

    if (flags.detach) {
      const ack = await client.requestWithAck<TaskAck>(TaskEvents.CREATE, taskPayload)
      const {logId} = ack

      if (format === 'json') {
        writeJsonResponse({
          command: 'curate',
          data: {logId, message: 'Context queued for processing', status: 'queued', taskId},
          success: true,
        })
      } else {
        const suffix = logId ? ` (Task: ${taskId} · Log: ${logId})` : ` (Task: ${taskId})`
        this.log(`✓ Context queued for processing.${suffix}`)
      }
    } else {
      let wasCancelled = false
      const completionPromise = waitForTaskCompletion(
        {
          client,
          command: 'curate',
          format,
          onCancelled: ({taskId: tid}) => {
            wasCancelled = true
            if (format === 'json') {
              // success: false because the JSON top-level field tracks the exit
              // code (130 on cancel). Cancellation semantics live in data.status.
              writeJsonResponse({
                command: 'curate',
                data: {event: 'cancelled', message: 'Curate cancelled', status: 'cancelled', taskId: tid},
                success: false,
              })
            } else {
              this.log(`✗ Curate cancelled (Task: ${tid})`)
            }
          },
          onCompleted: ({logId, pendingReview, taskId: tid, toolCalls}) => {
            const changes = this.composeChangesFromToolCalls(toolCalls)
            // Per-file detail is best-effort enrichment; server notify is authoritative
            const pendingOps = pendingReview ? this.collectPendingReviewOps(toolCalls) : []

            if (format === 'text') {
              for (const file of changes.created) {
                this.log(`  add ${file}`)
              }

              for (const file of changes.updated) {
                this.log(`  update ${file}`)
              }

              const suffix = logId ? ` (Task: ${tid} · Log: ${logId})` : ` (Task: ${tid})`
              this.log(`✓ Context curated successfully.${suffix}`)

              if (pendingReview) {
                this.printPendingReviewSummary(pendingReview.pendingCount, pendingOps, tid)
              }
            } else {
              writeJsonResponse({
                command: 'curate',
                data: {
                  changes: changes.created.length > 0 || changes.updated.length > 0 ? changes : undefined,
                  event: 'completed',
                  logId,
                  message: 'Context curated successfully',
                  ...(pendingReview
                    ? {pendingReview: this.buildPendingReviewJson(pendingReview.pendingCount, pendingOps, tid)}
                    : {}),
                  status: 'completed',
                  taskId: tid,
                },
                success: true,
              })
            }
          },
          onError({error, logId}) {
            if (format === 'json') {
              writeJsonResponse({
                command: 'curate',
                data: {event: 'error', logId, message: error.message, status: 'error'},
                success: false,
              })
            }
          },
          taskId,
        },
        (msg) => this.log(msg),
      )
      await client.requestWithAck<TaskAck>(TaskEvents.CREATE, taskPayload)
      await completionPromise
      return {wasCancelled}
    }

    return {wasCancelled: false}
  }

  private validateInput(args: {context?: string}, flags: CurateFlags, format: 'json' | 'text'): boolean {
    const hasContext = Boolean(args.context?.trim())
    const hasFiles = Boolean(flags.files?.length)
    const hasFolders = Boolean(flags.folder?.length)

    if (hasContext || hasFiles || hasFolders) return true

    if (format === 'json') {
      writeJsonResponse({
        command: 'curate',
        data: {
          message: 'Either a context argument, file reference, or folder reference is required.',
          status: 'error',
        },
        success: false,
      })
    } else {
      this.log('Either a context argument, file reference, or folder reference is required.')
      this.log('Usage:')
      this.log('  brv curate "your context here"')
      this.log('  brv curate "your context" -f src/file.ts')
      this.log('  brv curate -d src/             # folder pack')
      this.log('  brv curate "context with files" -f src/file.ts -f src/other.ts')
    }

    return false
  }
}
