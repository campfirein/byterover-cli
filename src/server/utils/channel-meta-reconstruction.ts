
import {promises as fs} from 'node:fs'
import {join} from 'node:path'
import {z} from 'zod'

import type {ChannelMeta} from '../../shared/types/channel.js'

import {type IChannelStore} from '../core/interfaces/channel/i-channel-store.js'
import {channelPaths} from '../infra/channel/storage/paths.js'

/**
 * Phase 9.5.10 — Defensive channel meta reconstruction (fixes 9.5.9 §2.6).
 *
 * On daemon startup, scan `.brv/channel-history/<id>/` directories. For each
 * that exists but lacks `.brv/context-tree/channel/<id>/meta.json`, build a
 * minimal meta from the `turn_snapshot` + `delivery_snapshot` NDJSON records
 * and publish it via `channelStore.reconstructIfMissing`.
 *
 * Why: the `.brv/context-tree/channel/` directory occasionally vanishes (root
 * cause still unknown). Without meta.json the channel is invisible to
 * `brv channel list` and all mention dispatch. Reconstruction restores a
 * usable stub so the daemon can operate.
 *
 * Guarantees:
 *   - Race-safe: `reconstructIfMissing` takes the same per-channel write
 *     lock as `createChannel`, so the kimi-flagged overwrite race is closed.
 *   - Idempotent: existing meta.json is preserved untouched.
 *   - Schema-honest: `members: []` (we cannot reconstruct `memberKind` /
 *     `peerId` / `multiaddr` from history). The stub carries
 *     `reconstructionStatus: 'reconstructed-from-history'` plus an
 *     `inferredHandles[]` list of participants observed in history.
 *   - Loud INFO log on every reconstruction.
 *   - Tolerates corrupt NDJSON lines and unreadable files.
 *
 * Single-daemon-per-data-dir is enforced by `daemon.json` advisory lock;
 * cross-process reconstruction is out of scope.
 */

export interface ReconstructMissingMetasArgs {
  readonly channelStore: IChannelStore
  readonly log: (msg: string) => void
  readonly projectRoot: string
}

interface ScanResult {
  inferredHandles: string[]
  startedAtCandidates: string[]
}

const HANDLE_RE = /^@/

// Validates a startedAt value byte-identically to ChannelMetaSchema.createdAt
// (z.string().datetime() — Z-only by default; rejects `+HH:MM` offsets). If
// we accepted offsets, the persisted meta would fail to re-parse on read.
// codex impl-review r2: delegate to zod directly so the guard cannot drift
// from the schema.
const isoDatetimeSchema = z.string().datetime()
function isIsoDatetime(value: string): boolean {
  return isoDatetimeSchema.safeParse(value).success
}

async function scanTurnsDir(turnsDir: string): Promise<ScanResult> {
  const result: ScanResult = {inferredHandles: [], startedAtCandidates: []}
  let turnFiles: string[] = []
  try {
    turnFiles = (await fs.readdir(turnsDir)).filter((f) => f.endsWith('.ndjson'))
  } catch {
    return result
  }

  const handles = new Set<string>()

  // Read each NDJSON file once; iterate ALL non-empty lines (not just
  // first) — real turn files have many event lines BEFORE the terminal
  // `turn_snapshot`.
  const fileResults = await Promise.allSettled(
    turnFiles.map(async (filename) => {
      const raw = await fs.readFile(join(turnsDir, filename), 'utf8')
      const localStartedAt: string[] = []
      const localHandles: string[] = []
      for (const line of raw.split('\n')) {
        const trimmed = line.trim()
        if (trimmed.length === 0) continue
        let record: Record<string, unknown>
        try {
          record = JSON.parse(trimmed) as Record<string, unknown>
        } catch {
          // Corrupt NDJSON line — skip, don't abort.
          continue
        }

        const recordType = record._recordType
        if (recordType === 'turn_snapshot') {
          const turn = record.turn as
            | undefined
            | {author?: {handle?: unknown}; mentions?: unknown; startedAt?: unknown}
          if (turn === undefined) continue
          if (typeof turn.startedAt === 'string' && isIsoDatetime(turn.startedAt)) {
            localStartedAt.push(turn.startedAt)
          }

          const author = turn.author?.handle
          if (typeof author === 'string') localHandles.push(author)
          if (Array.isArray(turn.mentions)) {
            for (const m of turn.mentions) if (typeof m === 'string') localHandles.push(m)
          }
        } else if (recordType === 'delivery_snapshot') {
          const delivery = record.delivery as undefined | {memberHandle?: unknown}
          const memberHandle = delivery?.memberHandle
          if (typeof memberHandle === 'string') localHandles.push(memberHandle)
        }
      }

      return {handles: localHandles, startedAt: localStartedAt}
    }),
  )

  for (const r of fileResults) {
    if (r.status === 'rejected') continue
    result.startedAtCandidates.push(...r.value.startedAt)
    for (const h of r.value.handles) handles.add(h)
  }

  result.inferredHandles = [...handles].filter((h) => HANDLE_RE.test(h)).sort()
  return result
}

function pickEarliest(candidates: string[]): string | undefined {
  if (candidates.length === 0) return undefined
  // kimi second-eyes: lexicographic sort is wrong across mixed subsecond
  // precision — `2026-05-24T10:00:00.001Z` lex-sorts BEFORE
  // `2026-05-24T10:00:00Z` ('.' = 0x2E vs 'Z' = 0x5A), but the latter is
  // chronologically earlier. Compare via Date.parse instead.
  let earliest = candidates[0]
  let earliestMs = Date.parse(earliest)
  for (let i = 1; i < candidates.length; i++) {
    const ms = Date.parse(candidates[i])
    if (ms < earliestMs) {
      earliest = candidates[i]
      earliestMs = ms
    }
  }

  return earliest
}

async function reconstructOne(args: {
  channelId: string
  channelStore: IChannelStore
  log: (msg: string) => void
  projectRoot: string
}): Promise<void> {
  const metaPath = channelPaths.metaFile(args.projectRoot, args.channelId)

  // Cheap pre-check: skip the NDJSON scan when meta already exists.
  // The authoritative idempotence guarantee is `reconstructIfMissing`'s
  // lock-protected re-check.
  try {
    await fs.access(metaPath)
    return
  } catch { /* meta absent — proceed */ }

  const turnsDir = channelPaths.historyTurnsDir(args.projectRoot, args.channelId)
  const scan = await scanTurnsDir(turnsDir)

  const now = new Date().toISOString()
  const createdAt = pickEarliest(scan.startedAtCandidates) ?? now

  const stub: ChannelMeta = {
    channelId: args.channelId,
    createdAt,
    inferredHandles: scan.inferredHandles,
    members: [],
    reconstructedAt: now,
    reconstructionStatus: 'reconstructed-from-history',
    updatedAt: now,
  }

  const result = await args.channelStore.reconstructIfMissing({meta: stub, projectRoot: args.projectRoot})
  if (result === 'wrote') {
    args.log(
      `[channel-meta-reconstruction] reconstruct: wrote minimal meta.json for channel ${args.channelId} ` +
        `(channel-history present but meta.json was absent; inferred ${scan.inferredHandles.length} participant(s))`,
    )
  }
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

  // kimi second-eyes: inspect allSettled results so a per-channel disk
  // error or `reconstructIfMissing` throw is not silently swallowed.
  // (The outer call site already swallows + logs; emit detail here so the
  // operator sees WHICH channel failed.)
  const results = await Promise.allSettled(
    entries.map((channelId) =>
      reconstructOne({channelId, channelStore: args.channelStore, log: args.log, projectRoot: args.projectRoot}),
    ),
  )
  for (const [i, r] of results.entries()) {
    if (r.status === 'rejected') {
      args.log(
        `[channel-meta-reconstruction] reconstruct error for channel ${entries[i]} (continuing): ` +
          `${r.reason instanceof Error ? r.reason.message : String(r.reason)}`,
      )
    }
  }
}
