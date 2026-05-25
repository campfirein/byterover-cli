/**
 * SearchExecutor - Executes context tree searches via SearchKnowledgeService.
 *
 * Unlike QueryExecutor (Tier 0-4 with LLM synthesis), SearchExecutor is
 * pure retrieval: BM25 index lookup → scored results. No LLM, no agent
 * session, no sandbox, no token cost.
 *
 * This is the engine behind `brv search`. The CLI command and transport
 * layer handle I/O; this module handles the search logic.
 *
 * Note on sidecar bumping: `SearchKnowledgeService.search()` already
 * accumulates access hits and mirrors them to the sidecar via
 * `flushAccessHits` → `mirrorHitsToSignalStore` inside `acquireIndex`'s
 * cache-refresh path. We do NOT add a second bump here — doing so would
 * double-count importance and prematurely promote topics to higher
 * maturity tiers (observed end-to-end during PR #677 testing).
 */

import type {ISearchKnowledgeService, SearchKnowledgeResult} from '../../../agent/infra/sandbox/tools-sdk.js'
import type {ISearchExecutor, SearchExecuteOptions} from '../../core/interfaces/executor/i-search-executor.js'

const DEFAULT_LIMIT = 10
const MAX_LIMIT = 50

export class SearchExecutor implements ISearchExecutor {
  private readonly searchService: ISearchKnowledgeService

  constructor(searchService: ISearchKnowledgeService) {
    this.searchService = searchService
  }

  async execute(options: SearchExecuteOptions): Promise<SearchKnowledgeResult> {
    const query = options.query.trim()
    if (!query) {
      return {message: 'Empty query', results: [], totalFound: 0}
    }

    const scope = options.scope?.trim() || undefined
    const limit = Math.min(
      MAX_LIMIT,
      Math.max(1, Math.trunc(options.limit ?? DEFAULT_LIMIT)),
    )

    return this.searchService.search(query, {
      limit,
      ...(scope ? {scope} : {}),
    })
  }
}
