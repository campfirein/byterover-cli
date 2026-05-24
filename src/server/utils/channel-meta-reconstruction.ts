
import {promises as fs} from 'node:fs'
import {dirname, join} from 'node:path'

import {channelPaths} from '../infra/channel/storage/paths.js'

/**
 * Phase 9.5.9 §2.6 — Defensive channel meta reconstruction.
 *
 * On daemon startup, scan `.brv/channel-history/<id>/` directories. For each
 * that exists but lacks a corresponding `.brv/context-tree/channel/<id>/meta.json`,
 * reconstruct a minimal meta from the first turn NDJSON snapshot record.
 *
 * Why: the `.brv/context-tree/channel/` directory occasionally vanishes (root
 * cause still unknown at time of writing). Without meta.json the channel is
 * invisible to `brv channel list` and all mention dispatch. Reconstruction
 * restores a usable stub so the daemon can operate.
 *
 * Guarantees:
 *   - Idempotent: will not overwrite an existing meta.json.
 *   - Loud INFO log on every reconstruction so operators know the daemon noticed + acted.
 *   - Silently tolerates missing or unreadable NDJSON files.
 */

export interface ReconstructMissingMetasArgs {
  readonly log: (msg: string) => void
  readonly projectRoot: string
}

export async function reconstructMissingMetas(args: ReconstructMissingMetasArgs): Promise<void> {
  const historyRoot = channelPaths.channelHistoryRoot(args.projectRoot)
  let entries: string[]
  try {
    entries = await fs.readdir(historyRoot)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return
    throw error
  }

  await Promise.allSettled(
    entries.map((channelId) => reconstructOne({channelId, log: args.log, projectRoot: args.projectRoot})),
  )
}

async function reconstructOne(args: {channelId: string; log: (msg: string) => void; projectRoot: string}): Promise<void> {
  const metaPath = channelPaths.metaFile(args.projectRoot, args.channelId)

  // Check if meta.json already exists — if so, do NOT overwrite.
  try {
    await fs.access(metaPath)
    return // meta exists; nothing to reconstruct
  } catch {
    // meta.json absent — proceed with reconstruction
  }

  const now = new Date().toISOString()
  const minimal = {
    channelId: args.channelId,
    createdAt: now,
    members: [],
    reconstructedAt: now,
    updatedAt: now,
  }

  // Best-effort: try to pull a richer createdAt from the first turn snapshot.
  const turnsDir = channelPaths.historyTurnsDir(args.projectRoot, args.channelId)
  let turnFiles: string[] = []
  try {
    turnFiles = (await fs.readdir(turnsDir)).filter((f) => f.endsWith('.ndjson')).sort()
  } catch { /* ignore */ }

  // Read all turn files in parallel (Promise.allSettled avoids await-in-loop)
  const turnReadResults = await Promise.allSettled(
    turnFiles.map(async (turnFile) => {
      const raw = await fs.readFile(join(turnsDir, turnFile), 'utf8')
      const firstLine = raw.split('\n').find((l) => l.trim().length > 0)
      if (firstLine === undefined) return
      const record = JSON.parse(firstLine) as {_recordType?: string; turn?: {startedAt?: string}}
      if (record._recordType === 'snapshot' && record.turn?.startedAt !== undefined) {
        return record.turn.startedAt
      }
    }),
  )
  for (const r of turnReadResults) {
    if (r.status === 'fulfilled' && r.value !== undefined) {
      minimal.createdAt = r.value
      break
    }
  }

  // Atomic rename write.
  await fs.mkdir(dirname(metaPath), {recursive: true})
  const tmp = `${metaPath}.reconstruct.tmp`
  await fs.writeFile(tmp, JSON.stringify(minimal, null, 2), 'utf8')
  await fs.rename(tmp, metaPath)

  args.log(
    `[channel-meta-reconstruction] reconstruct: wrote minimal meta.json for channel ${args.channelId} ` +
      `(channel-history present but meta.json was absent)`,
  )
}
