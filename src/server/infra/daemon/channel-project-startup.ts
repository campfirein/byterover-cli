
import {BrvDirWatcher} from '../../utils/brv-dir-watcher.js'
import {type ChannelStore} from '../channel/channel-store.js'
import {runMarkInboundOnlyMigration} from '../channel/migrations/mark-inbound-only.js'

/**
 * Phase 9.5.9 Issue 1 — per-project startup actions.
 *
 * Run once per unique projectRoot per daemon lifetime (on the first
 * Socket.IO connection from that project). All steps are best-effort:
 * a failure in any step is logged and does NOT prevent the daemon from
 * handling the connection.
 *
 * Order is load-bearing:
 *   1. runMarkInboundOnlyMigration — opportunistic upgrade of partial
 *                                    remote-peer members to addressability=
 *                                    inbound-only. Runs before warm so the
 *                                    channel registry sees the upgraded form.
 *   2. BrvDirWatcher.start()       — observability; starts after the migration.
 *
 * DEFERRED from this slice (held for 9.5.10):
 *   - reconstructMissingMetas — kimi review (turnId 7h-RAyyU6GEy0mRdjI9ay)
 *     flagged two data-corruption vectors in the current implementation:
 *     (1) TOCTOU race between access(metaPath) and rename(tempFile) — if a
 *         real turn fires in the gap and creates meta.json, our rename
 *         overwrites it with the empty stub. Fix: writeFile with `wx` flag
 *         OR acquire a write lock around the check-and-write sequence.
 *     (2) Reconstructed stub uses `members: []` but channel may have had
 *         members. Downstream sees the channel as legitimately empty.
 *         Fix: reconstruct members from turn snapshot records, OR flag
 *         the stub explicitly (e.g. status: 'reconstructed-stub') so
 *         downstream knows the channel is degraded.
 *     The reconstruction function + tests stay in the tree
 *     (`src/server/utils/channel-meta-reconstruction.ts`) for 9.5.10 to
 *     pick up — this file just doesn't call them at startup.
 */

export interface ChannelProjectStartupArgs {
  readonly channelStore: ChannelStore
  readonly log: (msg: string) => void
  readonly projectRoot: string
  readonly warn: (msg: string) => void
}

export interface ChannelProjectStartupResult {
  readonly watcher: BrvDirWatcher
}

export async function runChannelProjectStartup(
  args: ChannelProjectStartupArgs,
): Promise<ChannelProjectStartupResult> {
  const {channelStore, log, projectRoot, warn} = args

  // Step 1: opportunistic migration — mark partial remote-peer members as inbound-only.
  try {
    await runMarkInboundOnlyMigration({channelStore, log, projectRoot})
  } catch (error) {
    log(
      `[channel-project-startup] runMarkInboundOnlyMigration error (continuing): ` +
        `${error instanceof Error ? error.message : String(error)}`,
    )
  }

  // Step 2: start the .brv/ lifecycle watcher (observability only).
  const watcher = new BrvDirWatcher({info: log, projectRoot, warn})
  watcher.start()
  log(`[channel-project-startup] BrvDirWatcher started for ${projectRoot}`)

  return {watcher}
}
