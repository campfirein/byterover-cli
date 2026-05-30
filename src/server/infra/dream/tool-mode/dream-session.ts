/**
 * Tool-mode dream session manager — orchestrates scan + finalize.
 *
 * `scanDreamCandidates` loads every topic in the context tree, runs the
 * requested per-kind candidate generators in parallel, and returns a
 * unified envelope keyed by kind. The calling agent then decides what to
 * do per candidate (link via brv-curate UPDATE, merge via brv-curate
 * MERGE, etc.) and finally calls `finalizeDreamSession` with the loser
 * paths to archive.
 *
 * The session id is opaque — a uuid the agent passes through scan →
 * finalize so future versions can persist per-session state for resume
 * support. v1 doesn't persist it; the session is effectively stateless on
 * the daemon side.
 */

import {randomUUID} from 'node:crypto'
import {existsSync} from 'node:fs'
import {mkdir, readFile, rename, stat} from 'node:fs/promises'
import {dirname, join} from 'node:path'

import type {ISearchKnowledgeService} from '../../../../agent/infra/sandbox/tools-sdk.js'
import type {RuntimeSignals} from '../../../core/domain/knowledge/runtime-signals-schema.js'
import type {IRuntimeSignalStore} from '../../../core/interfaces/storage/i-runtime-signal-store.js'

import {isDescendantOf} from '../../../utils/path-utils.js'
import {findLinkCandidates, type LinkCandidate} from './link-candidates.js'
import {findMergeCandidates, type MergeCandidate} from './merge-candidates.js'
import {findPruneCandidates, type PruneCandidate} from './prune-candidates.js'
import {findSynthesizeCandidates, type SynthesizeCandidates} from './synthesize-candidates.js'
import {loadToolModeTopics} from './topic-loader.js'

export type DreamKind = 'link' | 'merge' | 'prune' | 'synthesize'

export const ALL_DREAM_KINDS: readonly DreamKind[] = ['link', 'merge', 'prune', 'synthesize']

/** Tool-mode dream archive lives under `.brv/archive/` so undo can find it. */
const ARCHIVE_SUBDIR = 'archive'

export type DreamScanInput = {
  contextTreeRoot: string
  options?: {
    /** Default: all four. */
    kinds?: DreamKind[]
    maxCandidates?: number
    scope?: string
  }
  runtimeSignalStore: IRuntimeSignalStore
  searchService: ISearchKnowledgeService
}

export type DreamCandidateBundle = {
  link: LinkCandidate[]
  merge: MergeCandidate[]
  prune: PruneCandidate[]
  synthesize: SynthesizeCandidates
}

export type DreamScanResult = {
  candidates: DreamCandidateBundle
  sessionId: string
}

/**
 * Load topics + run all requested candidate generators in parallel.
 *
 * Returns one envelope with four keys — each key is empty when its kind
 * isn't requested via `options.kinds`. Empty kinds keep the shape stable
 * for the CLI / agent consumer.
 */
export async function scanDreamCandidates(input: DreamScanInput): Promise<DreamScanResult> {
  const {contextTreeRoot, options, runtimeSignalStore, searchService} = input
  const requestedKinds = new Set<DreamKind>(options?.kinds ?? ALL_DREAM_KINDS)

  const topics = await loadToolModeTopics({contextTreeRoot, runtimeSignalStore})

  // Force the search service to rebuild its MiniSearch index before
  // pair-discovery runs. The service's TTL fast-path (5s) would
  // otherwise serve a cached index that pre-dates the just-loaded
  // topics — surfacing zero candidates on the first scan and warming
  // up only on the second invocation.
  await searchService.refreshIndex()

  const empty: DreamCandidateBundle = {link: [], merge: [], prune: [], synthesize: {domains: [], existingSyntheses: []}}

  const [link, merge, prune, synthesize] = await Promise.all([
    requestedKinds.has('link')
      ? findLinkCandidates({
          options: {maxCandidates: options?.maxCandidates, scope: options?.scope},
          searchService,
          topics: topics.map((t) => ({
            alreadyLinkedTo: t.related,
            html: t.html,
            path: t.path,
            summary: t.summary,
            title: t.title,
          })),
        })
      : Promise.resolve(empty.link),
    requestedKinds.has('merge')
      ? findMergeCandidates({
          options: {maxCandidates: options?.maxCandidates, scope: options?.scope},
          searchService,
          topics: topics.map((t) => ({html: t.html, path: t.path, summary: t.summary, title: t.title})),
        })
      : Promise.resolve(empty.merge),
    requestedKinds.has('prune')
      ? findPruneCandidates({
          options: {maxCandidates: options?.maxCandidates, scope: options?.scope},
          topics: topics.map((t) => ({html: t.html, mtimeMs: t.mtimeMs, path: t.path, signals: t.signals})),
        })
      : Promise.resolve(empty.prune),
    requestedKinds.has('synthesize')
      ? findSynthesizeCandidates({
          options: {scope: options?.scope},
          topics: topics.map((t) => ({path: t.path, summary: t.summary, title: t.title})),
        })
      : Promise.resolve(empty.synthesize),
  ])

  return {
    candidates: {link, merge, prune, synthesize},
    sessionId: randomUUID(),
  }
}

export type DreamFinalizeInput = {
  /** Relative paths under .brv/context-tree/ to archive. */
  archive: string[]
  /** Absolute path to `.brv` (parent of `context-tree/` and `archive/`). */
  brvDir: string
  contextTreeRoot: string
  runtimeSignalStore: IRuntimeSignalStore
  /** Opaque session id; v1 doesn't persist sessions but downstream tooling may track it. */
  sessionId: string
}

export type DreamFinalizeSkipped = {
  path: string
  reason: 'already-archived' | 'not-found' | 'rename-failed' | 'unsafe-path'
}

export type DreamFinalizeResult = {
  archived: string[]
  /**
   * mtime (ms since epoch) of each archived file captured before the
   * rename. Keys are relative paths. Consumed by `undoPrune` so the
   * restored file gets its original mtime via `utimes()` rather than
   * the restore-time wall-clock from `writeFile`. Without this, a
   * topic archived as `stale-mtime` (≥60d for draft / ≥120d for
   * validated) returns with mtime=now and falls below the prune
   * threshold on the next scan.
   */
  previousMtimes: Record<string, number>
  /**
   * Snapshot of each archived file's runtime signals (importance,
   * maturity, accessCount, etc.) captured before the sidecar is
   * deleted. Consumed by `undoPrune` to restore via
   * `runtimeSignalStore.set()` so signal-driven prune candidates
   * (e.g. `importance < 35`) re-surface after undo. Without this, a
   * topic archived as `low-importance` returns with default
   * `importance=50` and never re-surfaces.
   */
  previousSignals: Record<string, RuntimeSignals>
  /**
   * Original file content keyed by relative path, captured before the rename.
   * Empty entries are not included (skipped files have no previous content
   * to restore). Consumed by `undoPrune` for tool-mode undo without needing
   * an archive service.
   */
  previousTexts: Record<string, string>
  /** Files that weren't archived, with a coarse reason for each. */
  skipped: DreamFinalizeSkipped[]
}

/**
 * Move each named topic from `.brv/context-tree/<path>` to
 * `.brv/archive/<path>`, preserving the relative directory structure.
 * Drops the sidecar entry on success. Skips (rather than throws) when a
 * named path is missing or unreadable so partial failure is recoverable
 * via re-scan.
 */
export async function finalizeDreamSession(input: DreamFinalizeInput): Promise<DreamFinalizeResult> {
  const {archive, brvDir, contextTreeRoot, runtimeSignalStore} = input
  const archiveRoot = join(brvDir, ARCHIVE_SUBDIR)

  type ArchivedOutcome = {
    content: string
    mtimeMs: number
    path: string
    result: 'archived'
    signals: RuntimeSignals
  }
  type SkippedOutcome = {path: string; reason: DreamFinalizeSkipped['reason']; result: 'skipped'}

  const outcomes = await Promise.all(
    archive.map(async (relPath): Promise<ArchivedOutcome | SkippedOutcome> => {
      const source = join(contextTreeRoot, relPath)
      const target = join(archiveRoot, relPath)
      // Guard against agent-supplied path traversal (e.g. relPath = "../../etc/passwd").
      // Both source and target must resolve inside their respective roots.
      if (!isDescendantOf(source, contextTreeRoot) || !isDescendantOf(target, archiveRoot)) {
        return {path: relPath, reason: 'unsafe-path', result: 'skipped'}
      }

      if (!existsSync(source)) return {path: relPath, reason: 'not-found', result: 'skipped'}

      // Read content + capture pre-archive metadata (mtime + signals)
      // before the rename so undo can fully restore the topic — not
      // just its bytes, but its observable state (stale mtime, low
      // importance, etc.) that drove the prune decision in the first
      // place. If we capture after the rename, the source is gone and
      // the sidecar is deleted, losing the metadata forever.
      let content: string
      let mtimeMs: number
      let signals: RuntimeSignals
      try {
        content = await readFile(source, 'utf8')
        const stats = await stat(source)
        mtimeMs = stats.mtimeMs
        signals = await runtimeSignalStore.get(relPath)
      } catch (error) {
        // ENOENT here means another finalize moved the file between our
        // existsSync check and our reads — same race window as below.
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
          return {path: relPath, reason: 'already-archived', result: 'skipped'}
        }

        return {path: relPath, reason: 'rename-failed', result: 'skipped'}
      }

      try {
        await mkdir(dirname(target), {recursive: true})
        await rename(source, target)
      } catch (error) {
        // ENOENT during rename means a concurrent finalize won the race
        // and archived this file before us. Surface that distinctly so
        // agents triaging skipped paths don't re-scan to figure out
        // which 'rename-failed' entries were really benign races.
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
          return {path: relPath, reason: 'already-archived', result: 'skipped'}
        }

        return {path: relPath, reason: 'rename-failed', result: 'skipped'}
      }

      try {
        await runtimeSignalStore.delete(relPath)
      } catch {
        // best-effort sidecar cleanup; the topic is already archived
      }

      return {content, mtimeMs, path: relPath, result: 'archived', signals}
    }),
  )

  const archived: string[] = []
  const previousTexts: Record<string, string> = {}
  const previousMtimes: Record<string, number> = {}
  const previousSignals: Record<string, RuntimeSignals> = {}
  const skipped: DreamFinalizeSkipped[] = []
  for (const outcome of outcomes) {
    if (outcome.result === 'archived') {
      archived.push(outcome.path)
      previousTexts[outcome.path] = outcome.content
      previousMtimes[outcome.path] = outcome.mtimeMs
      previousSignals[outcome.path] = outcome.signals
    } else {
      skipped.push({path: outcome.path, reason: outcome.reason})
    }
  }

  return {archived, previousMtimes, previousSignals, previousTexts, skipped}
}
