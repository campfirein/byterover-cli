/**
 * Link candidate generator for tool-mode dream.
 *
 * Deterministic — no LLM. Reuses the shared BM25 pair-discovery helper and
 * adds one filter: already-linked pairs are dropped, since link's purpose
 * is to surface *new* complementary relationships. Merge does NOT apply
 * that filter — see `merge-candidates.ts` for the higher-threshold counterpart.
 */

import type {ISearchKnowledgeService} from '../../../../agent/infra/sandbox/tools-sdk.js'

import {type BM25Pair, findBM25Pairs} from './bm25-pair-discovery.js'

export type LinkCandidateTopic = {
  /** Parsed `related=` attribute on <bv-topic>, lowercase paths. Empty if no related attr. */
  alreadyLinkedTo: string[]
  /** Full raw HTML of the topic — included in candidates so the agent reads without a second round-trip. */
  html: string
  /** Relative path under .brv/context-tree/, e.g. "security/jwt.html". */
  path: string
  /** Topic summary attr value, or empty string. */
  summary: string
  /** Topic title attr value. */
  title: string
}

export type LinkCandidate = BM25Pair

export type FindLinkCandidatesOptions = {
  /** Default 20. Cap on returned candidates after sorting by score desc. */
  maxCandidates?: number
  /** Optional path prefix; topics outside it are neither sources nor targets. */
  scope?: string
  /** Default 0.5. Pairs below this score are dropped. */
  scoreThreshold?: number
}

const DEFAULT_MAX_CANDIDATES = 20
const DEFAULT_SCORE_THRESHOLD = 0.5
/** BM25 limit per source-topic search. Generous so we don't miss high-score hits. */
const SEARCH_LIMIT_PER_TOPIC = 10

export async function findLinkCandidates(params: {
  options?: FindLinkCandidatesOptions
  searchService: ISearchKnowledgeService
  topics: LinkCandidateTopic[]
}): Promise<LinkCandidate[]> {
  const {options, searchService, topics} = params

  const linksByPath = new Map<string, Set<string>>(
    topics.map((t) => [t.path, new Set(t.alreadyLinkedTo)]),
  )

  return findBM25Pairs({
    maxCandidates: options?.maxCandidates ?? DEFAULT_MAX_CANDIDATES,
    scope: options?.scope,
    scoreThreshold: options?.scoreThreshold ?? DEFAULT_SCORE_THRESHOLD,
    searchLimitPerTopic: SEARCH_LIMIT_PER_TOPIC,
    searchService,
    skipPair(sourcePath, hitPath) {
      // Drop pairs where either side already lists the other in its
      // `related=` edges. Link is for *new* connections only.
      return Boolean(linksByPath.get(sourcePath)?.has(hitPath)) || Boolean(linksByPath.get(hitPath)?.has(sourcePath))
    },
    topics: topics.map((t) => ({html: t.html, path: t.path, summary: t.summary, title: t.title})),
  })
}
