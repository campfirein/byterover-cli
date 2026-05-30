import {Command} from '@oclif/core'
import {join} from 'node:path'

import type {ILogger} from '../../agent/core/interfaces/i-logger.js'

import {ConsoleLogger} from '../../agent/infra/logger/console-logger.js'
import {FileKeyStorage} from '../../agent/infra/storage/file-key-storage.js'
import {BRV_DIR, CONTEXT_TREE_DIR} from '../../server/constants.js'
import {FileContextTreeArchiveService} from '../../server/infra/context-tree/file-context-tree-archive-service.js'
import {FileContextTreeManifestService} from '../../server/infra/context-tree/file-context-tree-manifest-service.js'
import {RuntimeSignalStore} from '../../server/infra/context-tree/runtime-signal-store.js'
import {DreamLogStore} from '../../server/infra/dream/dream-log-store.js'
import {DreamStateService} from '../../server/infra/dream/dream-state-service.js'
import {undoLastDream} from '../../server/infra/dream/dream-undo.js'
import {FileCurateLogStore} from '../../server/infra/storage/file-curate-log-store.js'
import {FileReviewBackupStore} from '../../server/infra/storage/file-review-backup-store.js'
import {getProjectDataDir} from '../../server/utils/path-utils.js'
import {writeJsonResponse} from '../lib/json-response.js'
import {argvRequestsJsonFormat, DREAM_REMOVED_FLAGS, findRemovedFlagMessage} from '../lib/removed-flags.js'

/**
 * Build the dep bundle for `undoLastDream` on the CLI-direct path —
 * consumed by the `brv dream undo` subcommand. Exported here (and not
 * from a dedicated helper module) because the topic root is the
 * natural home for shared dream-pipeline wiring.
 */
export async function buildUndoDeps(
  projectRoot: string,
  logger: ILogger = new ConsoleLogger(),
): Promise<Parameters<typeof undoLastDream>[0]> {
  const brvDir = join(projectRoot, BRV_DIR)
  const contextTreeDir = join(brvDir, CONTEXT_TREE_DIR)
  const projectDataDir = getProjectDataDir(projectRoot)

  // Runtime-signal sidecar — keeps archive/restore from leaking orphan
  // signal entries on the CLI-direct `brv dream undo` path.
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
    // Wired through so undoPrune can restore each archived topic's
    // sidecar signals (importance, maturity, accessCount, ...) — the
    // PRUNE op captures them via `previousSignals` and `previousMtimes`
    // so signal-driven prune candidates re-qualify after undo.
    runtimeSignalStore,
  }
}

/**
 * Topic root for the `brv dream` command tree. The LLM-driven
 * no-subcommand entry was removed (see Linear ENG-2884); use the
 * tool-mode subcommands instead:
 *
 *   brv dream scan       — surface cleanup candidates (read-only)
 *   brv dream finalize   — archive topics from a scan session
 *   brv dream undo       — revert the last dream
 *   brv dream sessions   — list active scan sessions
 *   brv dream cancel     — discard a scan session
 *
 * Running `brv dream` with no subcommand prints this listing and exits.
 */
export default class Dream extends Command {
  public static description =
    'Memory consolidation over the context tree. Tool-mode subcommands drive the pipeline; the calling agent makes the semantic calls.'
  public static examples = [
    '# Surface link / merge / prune / synthesize candidates',
    '<%= config.bin %> <%= command.id %> scan --format json',
    '',
    '# Archive topics chosen from a scan session',
    '<%= config.bin %> <%= command.id %> finalize --session <id> --archive <paths>',
    '',
    '# Revert the most recent dream',
    '<%= config.bin %> <%= command.id %> undo',
  ]

  public async run(): Promise<void> {
    // Reject any flag carried over from the legacy LLM-driven path
    // (`--timeout`, etc.). Matches the curate/query precedent: emit a
    // JSON envelope when the caller asked for JSON, this.error() otherwise.
    // `this.argv` is oclif's per-instance argv (defaults to process.argv;
    // overridable by test wrappers).
    const removed = findRemovedFlagMessage(this.argv, DREAM_REMOVED_FLAGS)
    if (removed) {
      if (argvRequestsJsonFormat(this.argv)) {
        writeJsonResponse({command: 'dream', data: {error: removed, status: 'error'}, success: false})
        return
      }

      this.error(removed, {exit: 1})
    }

    // No-op body: topic roots default to oclif's subcommand listing.
    // We print a one-liner here so `brv dream` (no args, no flags) makes
    // the migration target obvious without users digging into --help.
    // Exits 0 — consistent with oclif's topic-root default; scripts
    // running `brv dream && echo ok` will print "ok", which is the same
    // behaviour any other topic root produces.
    this.log(
      'Use a subcommand: brv dream {scan|finalize|undo|sessions [v1 stub]|cancel [v1 stub]}. Run `brv dream --help` for details.',
    )
  }
}
