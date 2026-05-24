
import type {FSWatcher} from 'node:fs'

import {access, watch} from 'node:fs'
import {join} from 'node:path'

/**
 * Phase 9.5.9 §2.6 — `.brv/` lifecycle observability.
 *
 * Registers two `fs.watch` listeners at daemon startup:
 *
 *   1. Recursive watcher on `<projectRoot>/.brv/` — emits structured log
 *      lines on `rename` events for lifecycle-meaningful paths
 *      (`context-tree/channel/<id>`, `channel-history`).
 *   2. Non-recursive watcher on `<projectRoot>/` — catches `.brv/` itself
 *      being deleted (the recursive watcher dies the moment its root is
 *      removed, so we need a parent-dir watcher as a backstop).
 *
 * Codex round-2 correction: the watcher cannot tell WHO caused a deletion —
 * only that the daemon OBSERVED it. Log wording is purely observational:
 * "OBSERVED deletion … cause unknown — check daemon logs + external tools".
 *
 * Default: lifecycle events only. All-writes verbose mode: set
 * `BRV_DEBUG_DIR_WATCH=1` in env.
 */

const LIFECYCLE_PATHS: Set<string> = new Set([
  'channel-history',
  'context-tree',
  'context-tree/channel',
])

function isLifecyclePath(filename: string): boolean {
  if (LIFECYCLE_PATHS.has(filename)) return true
  // e.g. context-tree/channel/my-channel or context-tree/channel/my-channel/
  return /^context-tree\/channel\/[^/]+\/?$/.test(filename)
}

export interface BrvDirWatcherArgs {
  readonly info: (msg: string) => void
  readonly projectRoot: string
  readonly warn: (msg: string) => void
}

export class BrvDirWatcher {
  private brvWatcher: FSWatcher | undefined
  private readonly info: (msg: string) => void
  private parentWatcher: FSWatcher | undefined
  private readonly projectRoot: string
  private readonly warn: (msg: string) => void

  public constructor(args: BrvDirWatcherArgs) {
    this.projectRoot = args.projectRoot
    this.info = args.info
    this.warn = args.warn
  }

  public start(): void {
    const brvDir = join(this.projectRoot, '.brv')
    const verbose = process.env.BRV_DEBUG_DIR_WATCH === '1'

    // ── Recursive watcher on .brv/ ──────────────────────────────────────
    try {
      this.brvWatcher = watch(brvDir, {recursive: true}, (eventType, filename) => {
        if (eventType !== 'rename') return
        if (filename === null) return

        const norm = filename.replaceAll('\\', '/') // normalise Windows path seps

        if (!isLifecyclePath(norm) && !verbose) return

        const fullPath = join(brvDir, norm)
        // Use access() to check existence without throwing.
        access(fullPath, (err) => {
          if (err === null) {
            this.info(`[brv-dir] created ${norm}`)
          } else {
            const isChannelState =
              norm.startsWith('context-tree/channel/') || norm === 'context-tree/channel'

            if (isChannelState) {
              // Codex round-2 wording — observational only, no attribution.
              this.warn(
                `[brv-dir] OBSERVED deletion of channel state at ${norm} ` +
                  `(daemon PID=${process.pid}); cause unknown — check daemon logs + ` +
                  `external tools (IDE sync, git operations, manual rm).`,
              )
            } else {
              this.info(`[brv-dir] observed deletion of ${norm}`)
            }
          }
        })
      })
    } catch {
      // .brv/ may not exist yet — watcher will just not fire.
    }

    // ── Parent-dir watcher (catches .brv/ itself being deleted) ─────────
    try {
      this.parentWatcher = watch(this.projectRoot, {recursive: false}, (eventType, filename) => {
        if (filename !== '.brv' && filename !== null && filename !== '') return
        if (eventType !== 'rename') return

        access(brvDir, (err) => {
          if (err !== null) {
            this.warn(
              `[brv-dir] OBSERVED deletion of ENTIRE .brv/ directory at ${brvDir} ` +
                `(daemon PID=${process.pid}). Daemon will not detect future channel ` +
                `writes until restart + recreation.`,
            )
          }
        })
      })
    } catch {
      // projectRoot may not be watchable — best effort.
    }
  }

  public stop(): void {
    try { this.brvWatcher?.close() } catch { /* ignore */ }

    try { this.parentWatcher?.close() } catch { /* ignore */ }

    this.brvWatcher = undefined
    this.parentWatcher = undefined
  }
}
