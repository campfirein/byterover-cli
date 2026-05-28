/**
 * Shared BM25 pair-discovery helper for link + merge candidate generators.
 *
 * Both kinds use the same recipe — search each topic by `title + summary`,
 * collect hits above a per-kind threshold, dedup symmetric pairs, sort by
 * score descending, cap. The only behavioral difference is whether already-
 * linked pairs are filtered out (link) or kept (merge), which is supplied
 * via the optional `skipPair` predicate.
 */

import type {ISearchKnowledgeService} from '../../../../agent/infra/sandbox/tools-sdk.js'

export type PairDiscoveryTopic = {
  /** Full raw HTML — preserved on the output candidate so the agent reads without a second round-trip. */
  html: string
  /** Relative path under .brv/context-tree/. */
  path: string
  /** Topic summary attr value, or empty string. */
  summary: string
  /** Topic title attr value. */
  title: string
}

export type BM25Pair = {
  htmlA: string
  htmlB: string
  /** [pathA, pathB], lex-sorted. */
  pair: [string, string]
  score: number
}

export type FindBM25PairsParams = {
  maxCandidates: number
  scope?: string
  scoreThreshold: number
  /** BM25 results requested per source topic. */
  searchLimitPerTopic: number
  searchService: ISearchKnowledgeService
  /**
   * Optional predicate to drop a candidate pair before dedup. Receives the
   * source (the topic the search was issued from) and the hit (the matched
   * topic). Return `true` to skip. Link uses this to honor existing
   * `related=` edges; merge passes nothing.
   */
  skipPair?: (sourcePath: string, hitPath: string) => boolean
  topics: PairDiscoveryTopic[]
}

export async function findBM25Pairs(params: FindBM25PairsParams): Promise<BM25Pair[]> {
  const {maxCandidates, scope, scoreThreshold, searchLimitPerTopic, searchService, skipPair, topics} = params

  const inScope = scope ? topics.filter((t) => t.path.startsWith(scope)) : topics
  if (inScope.length < 2) return []

  const byPath = new Map<string, PairDiscoveryTopic>(inScope.map((t) => [t.path, t]))

  const perTopicHits = await Promise.all(
    inScope.map(async (source) => {
      // Title-only query. Appending the summary makes the query too
      // specific and BM25 ends up ranking only the source topic itself —
      // see regression test in link-candidates.test.ts.
      //
      // combineWith: 'OR' overrides the search service's default
      // AND-first strategy. Multi-word distinctive titles (e.g. "Redis
      // Caching Layer") AND-combine to terms that only the source itself
      // contains, hiding legitimate cross-pairs whose titles share two
      // of the three terms. Pair-discovery wants any-term recall.
      const query = source.title.trim()
      if (!query) return {hits: [], source}
      const result = await searchService.search(query, {combineWith: 'OR', limit: searchLimitPerTopic})
      return {hits: result.results, source}
    }),
  )

  const pairs = new Map<string, {pair: [string, string]; score: number}>()
  for (const {hits, source} of perTopicHits) {
    for (const hit of hits) {
      if (hit.score < scoreThreshold) continue
      if (hit.path === source.path) continue
      if (!byPath.has(hit.path)) continue
      if (skipPair?.(source.path, hit.path)) continue

      const [a, b] = source.path < hit.path ? [source.path, hit.path] : [hit.path, source.path]
      const key = `${a}|${b}`
      const existing = pairs.get(key)
      if (!existing || hit.score > existing.score) {
        pairs.set(key, {pair: [a, b], score: hit.score})
      }
    }
  }

  return [...pairs.values()]
    .sort((x, y) => y.score - x.score)
    .slice(0, maxCandidates)
    .map(({pair, score}): BM25Pair => {
      const topicA = byPath.get(pair[0])
      const topicB = byPath.get(pair[1])
      if (!topicA || !topicB) throw new Error(`bm25-pair-discovery: pair lookup failed for ${pair[0]} or ${pair[1]}`)
      return {htmlA: topicA.html, htmlB: topicB.html, pair, score}
    })
}
