
import {promises as fs} from 'node:fs'
import {dirname} from 'node:path'

import {ChannelMetaSchema} from '../../../../shared/types/channel.js'
import {channelPaths} from '../storage/paths.js'

/**
 * Phase 9.5.9 §2.5 — opportunistic on-startup migration.
 *
 * Scans all channel metas. Any `remote-peer` member that has
 * `addressability` absent or `'bootstrap-only'` AND is missing either
 * `multiaddr` OR `remoteL2PubKey` gets upgraded to
 * `addressability='inbound-only'` so the outbound-mention path and
 * channel-doctor both see the explicit marker.
 *
 * Issue 4 fix (codex §4): when a `channelStore` is supplied, the migration
 * routes each write through `channelStore.updateChannelMeta()`, which
 * uses the per-channel write-serializer lock for atomicity and avoids
 * races with concurrent daemon writes. When `channelStore` is absent the
 * migration falls back to direct atomic-rename writes (pre-fix behaviour,
 * kept for contexts where a full ChannelStore is not available).
 *
 * The migration:
 *   - Is idempotent: already-marked `inbound-only` members are skipped.
 *   - Logs every channel it upgrades at INFO level.
 *   - Silently skips channels whose meta.json is missing or unreadable.
 */

/** Minimal interface satisfied by ChannelStore.updateChannelMeta. */
export interface ChannelStoreForMigration {
  updateChannelMeta(args: {
    channelId: string
    mutate: (meta: import('../../../../shared/types/channel.js').ChannelMeta) => import('../../../../shared/types/channel.js').ChannelMeta
    projectRoot: string
  }): Promise<unknown>
}

export interface MarkInboundOnlyMigrationArgs {
  /**
   * When provided, each write is routed through
   * `channelStore.updateChannelMeta()` which uses the per-channel
   * write-serializer lock for atomicity (Issue 4 fix).
   * When absent, falls back to direct atomic-rename writes.
   */
  readonly channelStore?: ChannelStoreForMigration
  readonly log: (msg: string) => void
  readonly projectRoot: string
}

export async function runMarkInboundOnlyMigration(args: MarkInboundOnlyMigrationArgs): Promise<void> {
  const channelsRoot = channelPaths.channelsRoot(args.projectRoot)
  let entries: string[]
  try {
    entries = await fs.readdir(channelsRoot)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return
    throw error
  }

  await Promise.allSettled(
    entries.map((channelId) =>
      migrateOne({
        channelId,
        channelStore: args.channelStore,
        log: args.log,
        projectRoot: args.projectRoot,
      }),
    ),
  )
}

async function migrateOne(args: {
  channelId: string
  channelStore?: ChannelStoreForMigration
  log: (msg: string) => void
  projectRoot: string
}): Promise<void> {
  // Issue 4 fix: route through the channel store's locked update path when available.
  await (args.channelStore === undefined
    ? migrateOneDirectFs(args)
    : migrateOneViaStore(args as typeof args & {channelStore: ChannelStoreForMigration}))
}

/**
 * Locked path — goes through ChannelStore.updateChannelMeta so the
 * write-serializer prevents races with concurrent daemon writes.
 */
async function migrateOneViaStore(args: {
  channelId: string
  channelStore: ChannelStoreForMigration
  log: (msg: string) => void
  projectRoot: string
}): Promise<void> {
  try {
    let upgraded = 0
    await args.channelStore.updateChannelMeta({
      channelId: args.channelId,
      mutate(meta) {
        const updatedMembers = meta.members.map((member) => {
          if (member.memberKind !== 'remote-peer') return member
          if (member.addressability === 'inbound-only') return member
          const partial = member.multiaddr === undefined || member.remoteL2PubKey === undefined
          if (!partial) return member
          upgraded++
          return {...member, addressability: 'inbound-only' as const}
        })
        return {...meta, members: updatedMembers}
      },
      projectRoot: args.projectRoot,
    })

    if (upgraded > 0) {
      args.log(
        `[migration:mark-inbound-only] upgraded ${args.channelId}: ` +
          `${upgraded} member(s) marked inbound-only`,
      )
    }
  } catch (error) {
    // Channel not found (already gone) or parse error — skip silently.
    const message = error instanceof Error ? error.message : String(error)
    if (message.includes('not found') || message.includes('ENOENT')) return
    // Any other error: also skip but log so operators know.
    args.log(`[migration:mark-inbound-only] skipping ${args.channelId}: ${message}`)
  }
}

/**
 * Direct FS path (fallback when no channelStore is available).
 * Uses atomic rename — same pattern as ChannelStore.createChannel.
 */
async function migrateOneDirectFs(args: {
  channelId: string
  log: (msg: string) => void
  projectRoot: string
}): Promise<void> {
  const metaPath = channelPaths.metaFile(args.projectRoot, args.channelId)
  let raw: string
  try {
    raw = await fs.readFile(metaPath, 'utf8')
  } catch {
    // Meta absent or unreadable — skip silently.
    return
  }

  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    return
  }

  const result = ChannelMetaSchema.safeParse(parsed)
  if (!result.success) return

  const meta = result.data
  let changed = false

  const updatedMembers = meta.members.map((member) => {
    if (member.memberKind !== 'remote-peer') return member
    // Already explicitly marked — idempotent no-op.
    if (member.addressability === 'inbound-only') return member
    // Only upgrade if missing multiaddr OR remoteL2PubKey.
    const partial = member.multiaddr === undefined || member.remoteL2PubKey === undefined
    if (!partial) return member

    changed = true
    return {...member, addressability: 'inbound-only' as const}
  })

  if (!changed) return

  const updatedMeta = {...meta, members: updatedMembers}

  // Atomic rename write — same pattern used by ChannelStore.createChannel.
  const tmp = `${metaPath}.migrate.tmp`
  await fs.mkdir(dirname(metaPath), {recursive: true})
  await fs.writeFile(tmp, JSON.stringify(updatedMeta, null, 2), 'utf8')
  await fs.rename(tmp, metaPath)

  args.log(
    `[migration:mark-inbound-only] upgraded ${args.channelId}: ` +
      `${updatedMembers.filter((m) => m.memberKind === 'remote-peer' && m.addressability === 'inbound-only').length} ` +
      `member(s) marked inbound-only`,
  )
}
