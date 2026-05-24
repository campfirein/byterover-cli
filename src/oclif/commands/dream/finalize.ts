import type {TaskAck} from '@campfirein/brv-transport-client'

import {Command, Flags} from '@oclif/core'
import {randomUUID} from 'node:crypto'
import {readFile, stat} from 'node:fs/promises'

import {TaskEvents} from '../../../shared/transport/events/index.js'
import {type DaemonClientOptions, formatConnectionError, withDaemonRetry} from '../../lib/daemon-client.js'
import {writeJsonResponse} from '../../lib/json-response.js'
import {DEFAULT_TIMEOUT_SECONDS, MAX_TIMEOUT_SECONDS, MIN_TIMEOUT_SECONDS, waitForTaskCompletion} from '../../lib/task-client.js'

export default class DreamFinalize extends Command {
  public static description =
    'Phase 3 of tool-mode dream — archive the loser topics the agent chose from the merge candidates.'
public static examples = [
    '# Archive specific topics, closing a session.',
    '# Paths must match exactly what `brv dream scan` emits — full relative path including the .html extension.',
    '<%= config.bin %> <%= command.id %> --session drm-abc --archive testing/old-notes.html,redis/eviction.html',
    '',
    '# Read archive list from a file (one path per line).',
    '<%= config.bin %> <%= command.id %> --session drm-abc --archive-file losers.txt',
  ]
public static flags = {
    archive: Flags.string({description: 'Comma-separated topic paths to move to .brv/archive/'}),
    'archive-file': Flags.string({description: 'Read archive paths from a file (one per line).'}),
    format: Flags.string({default: 'text', description: 'Output format (text or json)', options: ['text', 'json']}),
    session: Flags.string({description: 'Session id from a prior scan', required: true}),
    timeout: Flags.integer({
      default: DEFAULT_TIMEOUT_SECONDS,
      description: 'Maximum seconds to wait for completion',
      max: MAX_TIMEOUT_SECONDS,
      min: MIN_TIMEOUT_SECONDS,
    }),
  }

  protected getDaemonClientOptions(): DaemonClientOptions {
    return {}
  }

  public async run(): Promise<void> {
    const {flags: raw} = await this.parse(DreamFinalize)
    const format = raw.format === 'json' ? 'json' : 'text'

    // Conflict guard: --archive and --archive-file are mutually exclusive.
    // Without this, --archive silently wins and --archive-file is dropped.
    if (raw.archive && raw['archive-file']) {
      const msg = '--archive and --archive-file are mutually exclusive; pick one.'
      if (format === 'json') {
        writeJsonResponse({command: 'dream-finalize', data: {error: msg, status: 'error'}, success: false})
      } else {
        this.log(msg)
      }

      return
    }

    // Require one of --archive or --archive-file. Without this, a stray
    // `dream finalize --session X` exits 0 with archived:[] — a silent no-op
    // that hides a typo'd flag in scripting.
    if (!raw.archive && !raw['archive-file']) {
      const msg = 'Either --archive or --archive-file is required.'
      if (format === 'json') {
        writeJsonResponse({command: 'dream-finalize', data: {error: msg, status: 'error'}, success: false})
      } else {
        this.log(msg)
      }

      return
    }

    // Pre-read size guard for --archive-file. 200 paths * ~1 KB per path
    // gives ~200 KB of legitimate input; 256 KB covers that with headroom
    // while bailing early on multi-GB files or fifos (without this, readFile
    // would slurp arbitrary bytes into memory before the line-count cap fires).
    const MAX_ARCHIVE_FILE_BYTES = 256 * 1024

    let archive: string[] = []
    if (raw.archive) {
      archive = raw.archive.split(',').map((s) => s.trim()).filter(Boolean)
    } else if (raw['archive-file']) {
      try {
        const stats = await stat(raw['archive-file'])
        if (stats.size > MAX_ARCHIVE_FILE_BYTES) {
          const msg = `--archive-file too large: ${stats.size} bytes (max ${MAX_ARCHIVE_FILE_BYTES}). Split into multiple finalize calls.`
          if (format === 'json') {
            writeJsonResponse({command: 'dream-finalize', data: {error: msg, status: 'error'}, success: false})
          } else {
            this.log(msg)
          }

          return
        }

        const fileContent = await readFile(raw['archive-file'], 'utf8')
        archive = fileContent.split('\n').map((s) => s.trim()).filter(Boolean)
      } catch (error) {
        const msg = `Failed to read --archive-file: ${error instanceof Error ? error.message : String(error)}`
        if (format === 'json') {
          writeJsonResponse({command: 'dream-finalize', data: {error: msg, status: 'error'}, success: false})
        } else {
          this.log(msg)
        }

        return
      }
    }

    // Cap batch size to keep the daemon socket message bounded. 200 covers
    // realistic dream sessions (10s of candidates per kind, 4 kinds) with
    // headroom; beyond that the call would risk hitting the transport's
    // payload limit and disconnecting the daemon. Users with very large
    // archive lists should call finalize in multiple batches.
    const MAX_ARCHIVE_BATCH = 200
    if (archive.length > MAX_ARCHIVE_BATCH) {
      const msg = `--archive list too large: ${archive.length} entries (max ${MAX_ARCHIVE_BATCH}). Split across multiple finalize calls.`
      if (format === 'json') {
        writeJsonResponse({command: 'dream-finalize', data: {error: msg, status: 'error'}, success: false})
      } else {
        this.log(msg)
      }

      return
    }

    try {
      await withDaemonRetry(
        async (client, projectRoot, worktreeRoot) => {
          const taskId = randomUUID()
          const taskPayload = {
            content: JSON.stringify({archive, sessionId: raw.session}),
            ...(projectRoot ? {projectPath: projectRoot} : {}),
            taskId,
            type: 'dream-finalize' as const,
            ...(worktreeRoot ? {worktreeRoot} : {}),
          }

          const completionPromise = waitForTaskCompletion(
            {
              client,
              command: 'dream-finalize',
              format,
              onCompleted: ({result}) => {
                if (format === 'json') {
                  this.log(result ?? '{}')
                } else {
                  renderFinalizeText(this, result)
                }
              },
              onError: ({error}) => {
                const msg = error?.message ?? 'dream-finalize failed'
                if (format === 'json') {
                  writeJsonResponse({command: 'dream-finalize', data: {error: msg, status: 'error'}, success: false})
                } else {
                  this.log(`dream-finalize failed: ${msg}`)
                }
              },
              taskId,
            },
            (msg) => this.log(msg),
          )

          await client.requestWithAck<TaskAck>(TaskEvents.CREATE, taskPayload)
          await completionPromise
        },
        this.getDaemonClientOptions(),
      )
    } catch (error) {
      const message = error instanceof Error ? error.message : 'dream-finalize failed'
      if (format === 'json') {
        writeJsonResponse({command: 'dream-finalize', data: {error: message, status: 'error'}, success: false})
      } else {
        this.log(formatConnectionError(error))
      }
    }
  }
}

function renderFinalizeText(command: Command, raw: string | undefined): void {
  if (!raw) {
    command.log('(no result)')
    return
  }

  let parsed: {
    archived?: string[]
    error?: string
    skipped?: Array<{path: string; reason: string}>
    status?: string
  }
  try {
    parsed = JSON.parse(raw)
  } catch {
    command.log(raw)
    return
  }

  // Daemon-side failures encode as {status:'error', error:'...'}. Surface
  // them as errors rather than printing "Archived: 0" which looks like a
  // successful no-op finalize.
  if (parsed.status === 'error') {
    command.log(`dream-finalize failed: ${parsed.error ?? 'unknown error'}`)
    return
  }

  command.log(`Archived: ${parsed.archived?.length ?? 0}`)
  for (const p of parsed.archived ?? []) command.log(`  ⌫  ${p}`)
  if ((parsed.skipped?.length ?? 0) > 0) {
    command.log(`Skipped: ${parsed.skipped?.length}`)
    for (const s of parsed.skipped ?? []) command.log(`  ⚠  ${s.path} (${s.reason})`)
  }
}
