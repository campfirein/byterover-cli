import type {ITransportClient, TaskAck} from '@campfirein/brv-transport-client'

import {Command, Flags} from '@oclif/core'
import {randomUUID} from 'node:crypto'
import {join} from 'node:path'

import type {ILogger} from '../../agent/core/interfaces/i-logger.js'

import {NoOpLogger} from '../../agent/core/interfaces/i-logger.js'
import {ConsoleLogger} from '../../agent/infra/logger/console-logger.js'
import {FileKeyStorage} from '../../agent/infra/storage/file-key-storage.js'
import {BRV_DIR, CONTEXT_TREE_DIR} from '../../server/constants.js'
import {type ProviderConfigResponse, TransportStateEventNames} from '../../server/core/domain/transport/schemas.js'
import {FileContextTreeArchiveService} from '../../server/infra/context-tree/file-context-tree-archive-service.js'
import {FileContextTreeManifestService} from '../../server/infra/context-tree/file-context-tree-manifest-service.js'
import {RuntimeSignalStore} from '../../server/infra/context-tree/runtime-signal-store.js'
import {DreamLogStore} from '../../server/infra/dream/dream-log-store.js'
import {DreamStateService} from '../../server/infra/dream/dream-state-service.js'
import {undoLastDream} from '../../server/infra/dream/dream-undo.js'
import {resolveProject} from '../../server/infra/project/resolve-project.js'
import {FileCurateLogStore} from '../../server/infra/storage/file-curate-log-store.js'
import {FileReviewBackupStore} from '../../server/infra/storage/file-review-backup-store.js'
import {getProjectDataDir} from '../../server/utils/path-utils.js'
/* eslint-disable camelcase */
import {TaskEvents} from '../../shared/transport/events/index.js'
import {buildCliMetadata} from '../lib/build-cli-metadata.js'
import {
  type DaemonClientOptions,
  formatConnectionError,
  hasLeakedHandles,
  type ProviderErrorContext,
  providerMissingMessage,
  withDaemonRetry,
} from '../lib/daemon-client.js'
import {writeJsonResponse} from '../lib/json-response.js'
import {
  DEFAULT_TIMEOUT_SECONDS,
  MAX_TIMEOUT_SECONDS,
  MIN_TIMEOUT_SECONDS,
  waitForTaskCompletion,
} from '../lib/task-client.js'
import {TIMEOUT_DEPRECATION_HELP, warnIfTimeoutFlagUsed} from '../lib/timeout-deprecation.js'

/** Build the dep bundle for `undoLastDream` on the CLI-direct path; exported for wiring tests. */
export async function buildUndoDeps(
  projectRoot: string,
  logger: ILogger = new ConsoleLogger(),
): Promise<Parameters<typeof undoLastDream>[0]> {
  const brvDir = join(projectRoot, BRV_DIR)
  const contextTreeDir = join(brvDir, CONTEXT_TREE_DIR)
  const projectDataDir = getProjectDataDir(projectRoot)

  // Runtime-signal sidecar — keeps archive/restore from leaking orphan
  // signal entries on the CLI-direct `brv dream --undo` path. Mirrors the
  // daemon wiring in agent-process.ts.
  const keyStorage = new FileKeyStorage({storageDir: projectDataDir})
  await keyStorage.initialize()
  const runtimeSignalStore = new RuntimeSignalStore(keyStorage, logger)

  return {
    archiveService: new FileContextTreeArchiveService(runtimeSignalStore),
    contextTreeDir,
    curateLogStore: new FileCurateLogStore({baseDir: projectDataDir}),
    dreamLogStore: new DreamLogStore({baseDir: brvDir}),
    dreamStateService: new DreamStateService({baseDir: brvDir}),
    manifestService: new FileContextTreeManifestService({baseDirectory: projectRoot, runtimeSignalStore}),
    projectRoot,
    reviewBackupStore: new FileReviewBackupStore(brvDir),
  }
}

export default class Dream extends Command {
  public static description = 'Run background memory consolidation on the context tree'
  public static examples = [
    '# Run dream (checks time, activity, and queue gates)',
    '<%= config.bin %> <%= command.id %>',
    '',
    '# Force dream (skip time/activity/queue gates, lock still checked)',
    '<%= config.bin %> <%= command.id %> --force',
    '',
    '# Revert the last dream',
    '<%= config.bin %> <%= command.id %> --undo',
    '',
    '# Queue dream and exit immediately',
    '<%= config.bin %> <%= command.id %> --detach',
    '',
    '# Force dream and exit immediately',
    '<%= config.bin %> <%= command.id %> --force --detach',
    '',
    '# JSON output',
    '<%= config.bin %> <%= command.id %> --format json',
  ]
  public static flags = {
    detach: Flags.boolean({
      default: false,
      description: 'Queue task and exit without waiting for completion',
    }),
    force: Flags.boolean({
      char: 'f',
      default: false,
      description: 'Skip time and activity gates (lock still checked)',
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
    undo: Flags.boolean({
      default: false,
      description: 'Revert the last dream',
    }),
  }

  protected getDaemonClientOptions(): DaemonClientOptions {
    return {}
  }

  public async run(): Promise<void> {
    const {flags: rawFlags, metadata} = await this.parse(Dream)
    const format = rawFlags.format === 'json' ? 'json' : 'text'

    warnIfTimeoutFlagUsed({
      defaultValue: DEFAULT_TIMEOUT_SECONDS,
      log: (message) => this.log(message),
      userValue: rawFlags.timeout,
    })

    if (rawFlags.undo) {
      await this.runUndo(format)
      return
    }

    const cliMetadata = buildCliMetadata(this.id ?? 'dream', {flags: rawFlags, metadata})
    let providerContext: ProviderErrorContext | undefined

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

          await this.submitTask({
            client,
            cliMetadata,
            detach: rawFlags.detach,
            force: rawFlags.force,
            format,
            projectRoot,
            worktreeRoot,
          })
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
    }
  }

  private reportError(error: unknown, format: 'json' | 'text', providerContext?: ProviderErrorContext): void {
    const errorMessage = error instanceof Error ? error.message : 'Dream failed'

    if (format === 'json') {
      writeJsonResponse({command: 'dream', data: {error: errorMessage, status: 'error'}, success: false})
    } else {
      this.log(formatConnectionError(error, providerContext))
    }

    if (hasLeakedHandles(error)) {
      // eslint-disable-next-line n/no-process-exit, unicorn/no-process-exit
      process.exit(1)
    }
  }

  private async runUndo(format: 'json' | 'text'): Promise<void> {
    const projectRoot = resolveProject()?.projectRoot ?? process.cwd()
    // JSON mode: route sidecar warnings to a no-op so structured stdout
    // is never paired with stderr noise that breaks downstream parsers.
    const logger: ILogger = format === 'json' ? new NoOpLogger() : new ConsoleLogger()
    const deps = await buildUndoDeps(projectRoot, logger)

    try {
      const result = await undoLastDream(deps)

      if (format === 'json') {
        writeJsonResponse({command: 'dream', data: {...result, status: 'undone'}, success: true})
      } else {
        this.log(`Undone dream ${result.dreamId}`)
        this.log(`  Restored: ${result.restoredFiles.length} files`)
        this.log(`  Deleted: ${result.deletedFiles.length} files`)
        this.log(`  Restored archives: ${result.restoredArchives.length} files`)
        if (result.errors.length > 0) {
          this.log(`  Errors: ${result.errors.length}`)
          for (const e of result.errors) {
            this.log(`    - ${e}`)
          }
        }
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Undo failed'
      if (format === 'json') {
        writeJsonResponse({command: 'dream', data: {error: message, status: 'error'}, success: false})
      } else {
        this.log(`Undo failed: ${message}`)
      }
    }
  }

  private async submitTask(props: {
    client: ITransportClient
    cliMetadata: ReturnType<typeof buildCliMetadata>
    detach: boolean
    force: boolean
    format: 'json' | 'text'
    projectRoot?: string
    worktreeRoot?: string
  }): Promise<void> {
    const {client, cliMetadata, detach, force, format, projectRoot, worktreeRoot} = props
    const taskId = randomUUID()
    const taskPayload = {
      cli_metadata: cliMetadata,
      content: force ? 'Memory consolidation (force)' : 'Memory consolidation',
      ...(force ? {force: true} : {}),
      ...(projectRoot ? {projectPath: projectRoot} : {}),
      taskId,
      type: 'dream',
      ...(worktreeRoot ? {worktreeRoot} : {}),
    }

    if (detach) {
      const ack = await client.requestWithAck<TaskAck>(TaskEvents.CREATE, taskPayload)
      const {logId} = ack

      if (format === 'json') {
        writeJsonResponse({
          command: 'dream',
          data: {logId, message: 'Dream queued for processing', status: 'queued', taskId},
          success: true,
        })
      } else {
        const logSuffix = logId ? ` (Log: ${logId})` : ''
        this.log(`✓ Dream queued for processing.${logSuffix}`)
      }
    } else {
      const completionPromise = waitForTaskCompletion(
        {
          client,
          command: 'dream',
          format,
          onCompleted: ({logId, result, taskId: tid}) => {
            const skipped = result?.startsWith('Dream skipped:')
            if (format === 'json') {
              writeJsonResponse({
                command: 'dream',
                data: skipped
                  ? {reason: result, status: 'skipped', taskId: tid}
                  : {logId, result, status: 'completed', taskId: tid},
                success: true,
              })
            } else {
              this.log(result ?? '')
            }
          },
          onError: ({error}) => {
            if (format === 'json') {
              writeJsonResponse({
                command: 'dream',
                data: {event: 'error', message: error.message, status: 'error'},
                success: false,
              })
            } else {
              this.log(`Dream failed: ${error.message}`)
            }
          },
          taskId,
        },
        (msg) => this.log(msg),
      )
      await client.requestWithAck<TaskAck>(TaskEvents.CREATE, taskPayload)
      await completionPromise
    }
  }
}
