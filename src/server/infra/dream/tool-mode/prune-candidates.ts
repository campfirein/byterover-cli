/**
 * Prune candidate generator for tool-mode dream.
 *
 * Sidecar-driven, no LLM. Surfaces topics that look prune-worthy by two
 * deterministic signals:
 *
 *   - Importance below threshold (default 35) → `low-importance`
 *   - Mtime stale past tier threshold (60d draft / 120d validated) → `stale-mtime`
 *
 * A topic hitting both signals is returned once with `reason: 'both'`.
 * `maturity === 'core'` topics are NEVER surfaced — they're load-bearing
 * by definition. The agent decides per candidate whether to ARCHIVE,
 * KEEP (no-op), or MERGE_INTO another topic.
 *
 * Cold-start note: on freshly-installed projects, signals will be defaults
 * and few candidates will surface. That's expected — prune gets useful as
 * sidecar history accumulates.
 */

import type {MaturityTier, RuntimeSignals} from '../../../core/domain/knowledge/runtime-signals-schema.js'

export type PruneCandidateTopic = {
  /** Full HTML for the agent's review. */
  html: string
  /** File modification time in milliseconds since epoch. */
  mtimeMs: number
  /** Relative path under .brv/context-tree/. */
  path: string
  /** Sidecar signals — drives the importance/maturity filter. */
  signals: RuntimeSignals
}

export type PruneReason = 'both' | 'low-importance' | 'stale-mtime'

export type PruneCandidate = {
  daysSinceModified: number
  html: string
  path: string
  reason: PruneReason
  signals: RuntimeSignals
}

export type FindPruneCandidatesOptions = {
  /** Draft topics older than this are stale. Default 60. */
  draftStalenessDays?: number
  /** Importance strictly below this counts as low-importance. Default 35. */
  importanceThreshold?: number
  /** Default 20. */
  maxCandidates?: number
  /** Override clock for testing. Default Date.now(). */
  now?: number
  /** Optional path prefix. */
  scope?: string
  /** Validated topics older than this are stale. Default 120. */
  validatedStalenessDays?: number
}

// Note: these defaults are documented for agents in
// `src/server/templates/skill/SKILL.md` §7 (prune kind description).
// If any of the three threshold values below change, update §7's
// "Low-importance (sidecar `importance < N`) or stale-mtime (draft >Nd
// / validated >Nd)" sentence in lockstep so the agent-facing docs stay
// honest.
const DEFAULT_DRAFT_STALENESS_DAYS = 60
const DEFAULT_VALIDATED_STALENESS_DAYS = 120
const DEFAULT_IMPORTANCE_THRESHOLD = 35
const DEFAULT_MAX_CANDIDATES = 20
const DAY_MS = 24 * 60 * 60 * 1000

export async function findPruneCandidates(params: {
  options?: FindPruneCandidatesOptions
  topics: PruneCandidateTopic[]
}): Promise<PruneCandidate[]> {
  const {options, topics} = params
  const now = options?.now ?? Date.now()
  const draftDays = options?.draftStalenessDays ?? DEFAULT_DRAFT_STALENESS_DAYS
  const validatedDays = options?.validatedStalenessDays ?? DEFAULT_VALIDATED_STALENESS_DAYS
  const importanceThreshold = options?.importanceThreshold ?? DEFAULT_IMPORTANCE_THRESHOLD
  const maxCandidates = options?.maxCandidates ?? DEFAULT_MAX_CANDIDATES
  const scope = options?.scope

  const inScope = scope ? topics.filter((t) => t.path.startsWith(scope)) : topics

  const candidates: PruneCandidate[] = []
  for (const t of inScope) {
    if (t.signals.maturity === 'core') continue

    // Clamp negative deltas (future-dated mtimes from clock skew or
    // restored backups) to zero so the sort below produces a strictly
    // stalest-first list with no surprises.
    const daysSinceModified = Math.max(0, (now - t.mtimeMs) / DAY_MS)
    const lowImportance = t.signals.importance < importanceThreshold
    const staleMtime = isStaleForMaturity(t.signals.maturity, daysSinceModified, draftDays, validatedDays)

    if (!lowImportance && !staleMtime) continue

    candidates.push({
      daysSinceModified,
      html: t.html,
      path: t.path,
      reason: lowImportance && staleMtime ? 'both' : lowImportance ? 'low-importance' : 'stale-mtime',
      signals: t.signals,
    })
  }

  return candidates
    .sort((x, y) => y.daysSinceModified - x.daysSinceModified)
    .slice(0, maxCandidates)
}

function isStaleForMaturity(
  maturity: MaturityTier,
  daysSinceModified: number,
  draftDays: number,
  validatedDays: number,
): boolean {
  switch (maturity) {
    case 'core': {
      return false
    }

    case 'draft': {
      return daysSinceModified >= draftDays
    }

    case 'validated': {
      return daysSinceModified >= validatedDays
    }

    default: {
      // exhaustive
      const _never: never = maturity
      return _never
    }
  }
}
