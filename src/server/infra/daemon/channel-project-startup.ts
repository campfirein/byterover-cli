
import {BrvDirWatcher} from '../../utils/brv-dir-watcher.js'
import {reconstructMissingMetas} from '../../utils/channel-meta-reconstruction.js'
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
 *   0. reconstructMissingMetas    — Phase 9.5.10. Rebuild meta.json stubs
 *                                    from channel-history for channels whose
 *                                    meta vanished. Runs FIRST so the
 *                                    inbound-only migration sees them.
 *                                    Race-safe via ChannelStore.reconstructIfMissing
 *                                    (same per-channel lock as createChannel).
 *   1. runMarkInboundOnlyMigration — opportunistic upgrade of partial
 *                                    remote-peer members to addressability=
 *                                    inbound-only. Runs before warm so the
 *                                    channel registry sees the upgraded form.
 *   2. BrvDirWatcher.start()       — observability; starts after the migration.
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

  // Step 0 (Phase 9.5.10): reconstruct any meta.json files missing from
  // channel-history. Best-effort; daemon startup must not be gated on this.
  try {
    await reconstructMissingMetas({channelStore, log, projectRoot})
  } catch (error) {
    log(
      `[channel-project-startup] reconstructMissingMetas error (continuing): ` +
        `${error instanceof Error ? error.message : String(error)}`,
    )
  }

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
