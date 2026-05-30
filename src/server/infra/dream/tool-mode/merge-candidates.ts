/**
 * Merge candidate generator for tool-mode dream.
 *
 * Same BM25 path as `link-candidates` but with a higher default threshold
 * (0.85 vs 0.5) and no awareness of existing `related` edges — merge is
 * for *near-duplicates*, link is for *complementary topics*. An already-
 * linked pair can still be a merge candidate if the similarity is high.
 *
 * The calling agent decides per pair which topic becomes the survivor and
 * authors the merged HTML via `brv curate` UPDATE; the loser is archived
 * later via `brv dream finalize --archive`.
 */

import type {ISearchKnowledgeService} from '../../../../agent/infra/sandbox/tools-sdk.js'

import {type BM25Pair, findBM25Pairs} from './bm25-pair-discovery.js'

export type MergeCandidateTopic = {
  /** Full raw HTML — supplied to the agent so it can author the merge body without a second fetch. */
  html: string
  /** Relative path under .brv/context-tree/. */
  path: string
  /** Topic summary attr value, or empty string. */
  summary: string
  /** Topic title attr value. */
  title: string
}

export type MergeCandidate = BM25Pair

export type FindMergeCandidatesOptions = {
  maxCandidates?: number
  scope?: string
  /** Default 0.85. Higher than link's 0.5 — merge needs near-duplicate similarity. */
  scoreThreshold?: number
}

const DEFAULT_MAX_CANDIDATES = 20
const DEFAULT_SCORE_THRESHOLD = 0.85
const SEARCH_LIMIT_PER_TOPIC = 10

export async function findMergeCandidates(params: {
  options?: FindMergeCandidatesOptions
  searchService: ISearchKnowledgeService
  topics: MergeCandidateTopic[]
}): Promise<MergeCandidate[]> {
  const {options, searchService, topics} = params

  return findBM25Pairs({
    maxCandidates: options?.maxCandidates ?? DEFAULT_MAX_CANDIDATES,
    scope: options?.scope,
    scoreThreshold: options?.scoreThreshold ?? DEFAULT_SCORE_THRESHOLD,
    searchLimitPerTopic: SEARCH_LIMIT_PER_TOPIC,
    searchService,
    topics,
  })
}
