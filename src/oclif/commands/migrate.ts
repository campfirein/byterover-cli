import {Command, Flags} from '@oclif/core'
import {createInterface} from 'node:readline'

import {
  MigrateEvents,
  type MigrateRollbackRequest,
  type MigrateRollbackResponse,
  type MigrateRunReport,
  type MigrateRunRequest,
  type MigrateRunResponse,
} from '../../shared/transport/events/migrate-events.js'
import {type DaemonClientOptions, formatConnectionError, withDaemonRetry} from '../lib/daemon-client.js'

/**
 * Concurrency notice for the help text — the migrator is NOT mutex'd
 * against concurrent `brv curate` / `brv dream` writes on the same
 * `.brv/context-tree/`. Operators must avoid running those concurrently.
 */
const CONCURRENCY_NOTE =
  'Important: `brv migrate` is a one-shot tool and is NOT mutex-protected ' +
  'against concurrent `brv curate` or `brv dream` writes on the same ' +
  'context-tree. Run it when no other ByteRover writes are in flight.'

export default class Migrate extends Command {
  public static description =
    'Migrate `.brv/context-tree/` from Markdown topic files to `<bv-topic>` HTML. ' +
    CONCURRENCY_NOTE
public static examples = [
    '<%= config.bin %> <%= command.id %>',
    '<%= config.bin %> <%= command.id %> --dry-run',
    '<%= config.bin %> <%= command.id %> --rollback',
    '<%= config.bin %> <%= command.id %> --rollback --yes',
    '<%= config.bin %> <%= command.id %> --dry-run --format json',
  ]
public static flags = {
    'dry-run': Flags.boolean({
      default: false,
      description: 'Classify and convert in memory; write nothing to disk.',
    }),
    format: Flags.string({
      default: 'text',
      description: 'Output format.',
      options: ['json', 'text'],
    }),
    'project-root': Flags.string({
      description:
        'Project root containing `.brv/`. Defaults to the current directory.',
    }),
    rollback: Flags.boolean({
      default: false,
      description:
        'Reverse the most recent migration: restore archived .md files, ' +
        'delete generated .html siblings (except those that pre-existed).',
    }),
    yes: Flags.boolean({
      default: false,
      description:
        'Skip the interactive confirmation prompt for --rollback. ' +
        'REQUIRED when stdin is not a TTY (CI / piped invocations).',
    }),
  }

  // Visibility: `protected` so unit tests can exercise the gate
  // combinations without spinning up the daemon transport.
  protected displayForwardResult(report: MigrateRunReport, format: string, dryRun: boolean): void {
    if (format === 'json') {
      this.log(JSON.stringify(report, null, 2))
      return
    }

    this.log(summarizeReportLine(report))
    if (report.summary.failed > 0) {
      this.warn(
        `${report.summary.failed} file(s) failed — sources moved to the archive at ${report.archiveRoot ?? '(none)'}`,
      )
      for (const f of report.files) {
        if (f.outcome === 'failed') {
          this.warn(`  - ${f.sourceRelPath}: ${f.reason ?? '(no reason)'}`)
        }
      }
    }

    // VC-sync hint: text mode only (JSON consumers parse the envelope),
    // skip when nothing actually changed on disk (dry-run, or `migrated=0`
    // which means no .md topics were eligible). Also skip on partial
    // failure (`failed > 0`) — the run exits 2 below, so "successfully
    // migrated" wording would contradict the exit code and might nudge
    // users to push a tree the command itself reports as failed.
    if (!dryRun && report.summary.migrated > 0 && report.summary.failed === 0) {
      this.logVcSyncHint()
    }
  }

  // Stderr (not stdout) so the hint stays out of pipes like
  // `brv migrate | grep migrated`; logToStderr (not `this.warn`)
  // because it's a tip, not a warning.
  protected logVcSyncHint(): void {
    this.logToStderr('')
    this.logToStderr('Tip: the context tree was successfully migrated. Sync the new HTML topics to ByteRover cloud:')
    this.logToStderr('  brv vc status')
    this.logToStderr('  brv vc add . && brv vc commit -m "Migrate context tree to HTML"')
    this.logToStderr('  brv vc push')
    this.logToStderr('(Run `brv vc remote add origin <url>` first if no remote is configured.)')
  }

  public async run(): Promise<void> {
    const {flags} = await this.parse(Migrate)
    // Project resolution mirrors `status` / `vc`:
    //   - `projectRootFlag` triggers `resolveProject({projectRootFlag})`
    //     inside `withDaemonRetry` — walks up from cwd to find `.brv/`,
    //     canonicalizes, validates. Without this, a raw `--project-root .`
    //     or a sub-directory run silently targets the wrong tree.
    //   - `projectPath: process.cwd()` is just the connector's registration
    //     hint when no .brv/ is found yet (init flow).
    // The request payload itself carries NO projectRoot — the handler reads
    // back the registered path via the standard ProjectPathResolver, so an
    // untrusted client can't ask the daemon to migrate arbitrary directories.
    //
    // `maxRetries: 1` on both run and rollback: each is a non-idempotent
    // disk mutation, and retrying after a TransportRequestTimeoutError
    // could re-enter mid-archive and clobber partially-moved files.
    const daemonOptions: DaemonClientOptions = {
      maxRetries: 1,
      projectPath: process.cwd(),
      projectRootFlag: flags['project-root'],
    }
    const {format} = flags

    if (flags.rollback) {
      await this.runRollback({
        daemonOptions,
        dryRun: flags['dry-run'],
        format,
        yes: flags.yes,
      })
      return
    }

    await this.runForward({
      daemonOptions,
      dryRun: flags['dry-run'],
      format,
    })
  }

  private emitError(format: string, message: string, exitCode = 2): never {
    if (format === 'json') {
      this.log(JSON.stringify({error: message, ok: false}, null, 2))
    } else {
      this.logToStderr(message)
    }

    this.exit(exitCode)
  }

  private async rollbackRequest(input: {
    daemonOptions: DaemonClientOptions
    dryRun: boolean
    format: string
  }): Promise<MigrateRollbackResponse> {
    try {
      return await withDaemonRetry<MigrateRollbackResponse>(
        async (client) =>
          client.requestWithAck<MigrateRollbackResponse>(MigrateEvents.ROLLBACK, {
            dryRun: input.dryRun,
          } satisfies MigrateRollbackRequest),
        input.daemonOptions,
      )
    } catch (error) {
      // "No archive to roll back" is a benign user state, not a
      // connection failure — render it cleanly with exit 1 (Python
      // parity), without the misleading "Unexpected error:" prefix.
      const msg = error instanceof Error ? error.message : String(error)
      if (msg.includes('No archive to roll back')) {
        this.emitError(input.format, msg, 1)
      }

      this.emitError(input.format, formatConnectionError(error))
    }
  }

  private async runForward(input: {
    daemonOptions: DaemonClientOptions
    dryRun: boolean
    format: string
  }): Promise<void> {
    const {daemonOptions, dryRun, format} = input
    let response: MigrateRunResponse
    try {
      response = await withDaemonRetry<MigrateRunResponse>(
        async (client) =>
          client.requestWithAck<MigrateRunResponse>(MigrateEvents.RUN, {
            dryRun,
          } satisfies MigrateRunRequest),
        daemonOptions,
      )
    } catch (error) {
      // "Migration already ran today" is a benign user state, not a
      // connection failure — render cleanly with exit 1 instead of
      // "Unexpected error: ..." via formatConnectionError.
      const msg = error instanceof Error ? error.message : String(error)
      if (msg.includes('Migration already ran today')) {
        this.emitError(format, msg, 1)
      }

      this.emitError(format, formatConnectionError(error))
    }

    this.displayForwardResult(response.report, format, dryRun)

    // Force termination with exit 2 on failure. The daemon-client tail
    // (Socket.IO reconnect timers) keeps the event loop alive, so
    // letting Node exit naturally with `process.exitCode = 2` doesn't
    // work — the loop never drains. Match the Python oracle's
    // behavior (lines 2021-2031): hard-exit with the failure code.
    if (response.report.summary.failed > 0) {
      // eslint-disable-next-line n/no-process-exit, unicorn/no-process-exit
      process.exit(2)
    }
  }

  private async runRollback(input: {
    daemonOptions: DaemonClientOptions
    dryRun: boolean
    format: string
    yes: boolean
  }): Promise<void> {
    const {daemonOptions, dryRun, format, yes} = input

    // Dry-run preview short-circuit — never destructive, never prompts.
    // Text preview goes to STDOUT (mirrors the forward `--dry-run` path)
    // so operators can `brv migrate --rollback --dry-run > preview.txt`.
    // The interactive "Proceed?" prompt below uses stderr — different code
    // path, different intent.
    if (dryRun) {
      const preview = await this.rollbackRequest({daemonOptions, dryRun: true, format})
      if (format === 'json') {
        this.log(JSON.stringify(preview, null, 2))
      } else {
        this.log(formatRollbackDryRunPreview(preview))
        emitRollbackWarnings(this, preview, format)
      }

      return
    }

    // Destructive — require explicit confirmation.
    if (!yes) {
      if (!process.stdin.isTTY) {
        this.emitError(
          format,
          'error: --rollback requires --yes when stdin is not a TTY ' +
            '(CI / piped invocations). Re-run with --yes if you intend to ' +
            'roll back without an interactive prompt.',
        )
      }

      const preview = await this.rollbackRequest({daemonOptions, dryRun: true, format})
      this.logToStderr(formatInteractivePrompt(preview))
      emitRollbackWarnings(this, preview, 'text')
      process.stderr.write("Proceed? Type 'yes' to confirm: ")
      const answer = await readSingleLine()
      if (answer.trim().toLowerCase() !== 'yes') {
        this.logToStderr('Aborted.')
        this.exit(1)
      }
    }

    const result = await this.rollbackRequest({daemonOptions, dryRun: false, format})
    if (format === 'json') {
      this.log(JSON.stringify(result, null, 2))
    } else {
      this.log(`Rolled back from ${result.archiveRoot}: restored ${result.restored} file(s).`)
      emitRollbackWarnings(this, result, format)
    }
  }
}

function emitRollbackWarnings(
  cmd: {warn: (input: string) => void},
  resp: MigrateRollbackResponse,
  format: string,
): void {
  // Skip in JSON mode: the warnings are already present in the JSON
  // envelope written to stdout — mirroring them on stderr would just
  // pollute pipes.
  if (format === 'json') return
  for (const w of resp.warnings) cmd.warn(w)
}

function summarizeReportLine(report: MigrateRunReport): string {
  const mode = report.dryRun ? 'dry-run' : 'applied'
  const s = report.summary
  return `[${mode}] migrated=${s.migrated} archived=${s.archived} skipped=${s.skipped} failed=${s.failed}`
}

function formatRollbackDryRunPreview(preview: MigrateRollbackResponse): string {
  const skipped =
    preview.skippedHtml.length > 0
      ? `; SKIP deletion of ${preview.skippedHtml.length} (preserve manifest missing)`
      : ''
  return (
    `[dry-run] would restore ${preview.restored} file(s) from ${preview.archiveRoot}\n` +
    `[dry-run] would delete ${preview.deletedHtml.length} .html sibling(s); ` +
    `preserve ${preview.preservedHtml.length} pre-existing${skipped}`
  )
}

function formatInteractivePrompt(preview: MigrateRollbackResponse): string {
  const skippedLine =
    preview.skippedHtml.length > 0
      ? `\n  SKIP deletion of ${preview.skippedHtml.length} .html sibling(s) (preserve manifest missing — manual cleanup needed)`
      : ''
  return (
    `About to roll back migration at ${preview.archiveRoot}:\n` +
    `  restore ${preview.restored} file(s) into the live tree\n` +
    `  delete ${preview.deletedHtml.length} generated .html sibling(s)\n` +
    `  preserve ${preview.preservedHtml.length} pre-existing .html sibling(s)${skippedLine}`
  )
}

async function readSingleLine(): Promise<string> {
  return new Promise((resolve) => {
    const rl = createInterface({input: process.stdin, output: process.stderr})
    rl.once('line', (line) => {
      rl.close()
      resolve(line)
    })
    rl.once('close', () => resolve(''))
  })
}
