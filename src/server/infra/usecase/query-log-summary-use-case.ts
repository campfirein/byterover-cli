import type {QueryLogEntry} from '../../core/domain/entities/query-log-entry.js'
import type {ITerminal} from '../../core/interfaces/i-terminal.js'
import type {IQueryLogStore} from '../../core/interfaces/storage/i-query-log-store.js'
import type {
  IQueryLogSummaryUseCase,
  QueryLogSummary,
} from '../../core/interfaces/usecase/i-query-log-summary-use-case.js'

import {
  CACHE_TIERS,
  emptyByTier,
  QUERY_LOG_TIER_SHORT_LABELS,
  QUERY_LOG_TIERS,
} from '../../core/domain/entities/query-log-entry.js'
import {describePeriod, formatDurationMs, formatQueryLogSummaryNarrative} from './query-log-summary-narrative-formatter.js'

type QueryLogSummaryUseCaseDeps = {
  queryLogStore: IQueryLogStore
  terminal: ITerminal
}

const TOP_LIMIT = 10
const MAX_EXAMPLE_QUERIES = 3
const MIN_KEYWORD_LENGTH = 3

const STOPWORDS = new Set([
  'about',
  'all',
  'and',
  'any',
  'are',
  'but',
  'can',
  'did',
  'does',
  'for',
  'from',
  'get',
  'had',
  'has',
  'have',
  'how',
  'into',
  'just',
  'like',
  'not',
  'our',
  'set',
  'that',
  'the',
  'this',
  'use',
  'using',
  'was',
  'were',
  'what',
  'when',
  'where',
  'which',
  'who',
  'why',
  'with',
  'you',
  'your',
])

export class QueryLogSummaryUseCase implements IQueryLogSummaryUseCase {
  constructor(private readonly deps: QueryLogSummaryUseCaseDeps) {}

  async run(options: Parameters<IQueryLogSummaryUseCase['run']>[0]): Promise<void> {
    const entries = await this.deps.queryLogStore.list({after: options.after, before: options.before})
    const summary = computeSummary(entries, {after: options.after, before: options.before})
    const format = options.format ?? 'text'

    if (format === 'narrative') {
      this.deps.terminal.log(formatQueryLogSummaryNarrative(summary))
      return
    }

    if (format === 'json') {
      this.deps.terminal.log(JSON.stringify(summary, null, 2))
      return
    }

    this.deps.terminal.log(formatSummaryText(summary))
  }
}

// ── Aggregation ─────────────────────────────────────────────────────────────

function computeSummary(entries: QueryLogEntry[], range: {after?: number; before?: number}): QueryLogSummary {
  const summary: QueryLogSummary = {
    byStatus: {cancelled: 0, completed: 0, error: 0},
    byTier: emptyByTier(),
    cacheHitRate: 0,
    coverageRate: 0,
    knowledgeGaps: [],
    period: {from: range.after ?? 0, to: range.before ?? 0},
    queriesWithoutMatches: 0,
    responseTime: {avgMs: 0, p50Ms: 0, p95Ms: 0},
    topRecalledDocs: [],
    topTopics: [],
    totalMatchedDocs: 0,
    totalQueries: 0,
  }

  if (entries.length === 0) {
    return summary
  }

  const durations: number[] = []
  const topicCounts = new Map<string, number>()
  const docCounts = new Map<string, number>()
  const gapBuckets = new Map<string, {count: number; exampleQueries: string[]}>()
  let completedWithMatches = 0

  for (const entry of entries) {
    if (entry.status === 'processing') continue

    summary.totalQueries += 1
    summary.byStatus[entry.status] += 1

    if (entry.status !== 'completed') continue

    // ── completed-only aggregations ──
    // Prefer canonical `totalMs`; fall back to legacy `durationMs` for
    // legacy entries. Skip when neither is present (shouldn't happen
    // for completed entries but we guard for safety).
    const duration = entry.timing?.totalMs ?? entry.timing?.durationMs
    if (duration !== undefined) {
      durations.push(duration)
    }

    if (entry.tier === undefined) {
      summary.byTier.unknown += 1
    } else {
      summary.byTier[`tier${entry.tier}`] += 1
    }

    summary.totalMatchedDocs += entry.matchedDocs.length

    if (entry.matchedDocs.length > 0) {
      completedWithMatches += 1
      for (const doc of entry.matchedDocs) {
        const topic = doc.path.split('/')[0]
        topicCounts.set(topic, (topicCounts.get(topic) ?? 0) + 1)
        docCounts.set(doc.path, (docCounts.get(doc.path) ?? 0) + 1)
      }
    } else {
      collectGapKeywords(entry.query, gapBuckets)
    }
  }

  if (summary.byStatus.completed > 0) {
    const cacheHits = CACHE_TIERS.reduce<number>((sum, t) => sum + summary.byTier[`tier${t}`], 0)
    summary.cacheHitRate = cacheHits / summary.byStatus.completed
    summary.coverageRate = completedWithMatches / summary.byStatus.completed
    summary.queriesWithoutMatches = summary.byStatus.completed - completedWithMatches
  }

  summary.responseTime = computeResponseTime(durations)
  summary.topTopics = sortAndLimitCounts(topicCounts, 'topic')
  summary.topRecalledDocs = sortAndLimitCounts(docCounts, 'path')
  summary.knowledgeGaps = sortAndLimitGaps(gapBuckets)

  return summary
}

function computeResponseTime(durations: number[]): QueryLogSummary['responseTime'] {
  if (durations.length === 0) {
    return {avgMs: 0, p50Ms: 0, p95Ms: 0}
  }

  const sorted = [...durations].sort((a, b) => a - b)
  const sum = sorted.reduce((acc, v) => acc + v, 0)
  return {
    avgMs: Math.round(sum / sorted.length),
    p50Ms: sorted[Math.ceil(sorted.length * 0.5) - 1],
    p95Ms: sorted[Math.ceil(sorted.length * 0.95) - 1],
  }
}

function sortAndLimitCounts<K extends 'path' | 'topic'>(
  counts: Map<string, number>,
  key: K,
): Array<Record<K, string> & {count: number}> {
  return [...counts.entries()]
    .map(([value, count]) => ({count, [key]: value}) as Record<K, string> & {count: number})
    .sort((a, b) => b.count - a.count || a[key].localeCompare(b[key]))
    .slice(0, TOP_LIMIT)
}

function sortAndLimitGaps(
  buckets: Map<string, {count: number; exampleQueries: string[]}>,
): QueryLogSummary['knowledgeGaps'] {
  return [...buckets.entries()]
    .map(([topic, {count, exampleQueries}]) => ({count, exampleQueries, topic}))
    .sort((a, b) => b.count - a.count || a.topic.localeCompare(b.topic))
    .slice(0, TOP_LIMIT)
}

function collectGapKeywords(query: string, buckets: Map<string, {count: number; exampleQueries: string[]}>): void {
  const seen = new Set<string>()
  for (const token of query.toLowerCase().split(/[^a-z0-9]+/)) {
    if (token.length < MIN_KEYWORD_LENGTH || STOPWORDS.has(token) || seen.has(token)) continue
    seen.add(token)

    const bucket = buckets.get(token) ?? {count: 0, exampleQueries: []}
    bucket.count += 1
    if (bucket.exampleQueries.length < MAX_EXAMPLE_QUERIES) {
      bucket.exampleQueries.push(query)
    }

    buckets.set(token, bucket)
  }
}

// ── Text formatting ─────────────────────────────────────────────────────────

function formatSummaryText(summary: QueryLogSummary): string {
  const periodLabel = describePeriod(summary.period, 'short')
  const header = periodLabel ? `Query Recall Summary (${periodLabel})` : 'Query Recall Summary'

  if (summary.totalQueries === 0) {
    return `${header}\n(no entries yet)`
  }

  const cacheHits = CACHE_TIERS.reduce<number>((sum, t) => sum + summary.byTier[`tier${t}`], 0)
  const cachePct = Math.round(summary.cacheHitRate * 100)
  const coveragePct = Math.round(summary.coverageRate * 100)
  const matchedCount = summary.byStatus.completed - summary.queriesWithoutMatches
  const lines: string[] = [
    header,
    '='.repeat(header.length),
    `Total queries:        ${summary.totalQueries}`,
    `  Completed:          ${summary.byStatus.completed}`,
    `  Failed:             ${summary.byStatus.error}`,
    `  Cancelled:          ${summary.byStatus.cancelled}`,
    '',
    `Cache hit rate:       ${cachePct}% (${cacheHits}/${summary.byStatus.completed})`,
  ]

  const maxTierLen = Math.max(...QUERY_LOG_TIERS.map((t) => `Tier ${t} (${QUERY_LOG_TIER_SHORT_LABELS[t]}):`.length))
  for (const t of QUERY_LOG_TIERS) {
    const label = `Tier ${t} (${QUERY_LOG_TIER_SHORT_LABELS[t]}):`
    lines.push(`  ${label.padEnd(maxTierLen)}  ${summary.byTier[`tier${t}`]}`)
  }

  lines.push(
    '',
    'Response time:',
    `  Average:            ${formatDurationMs(summary.responseTime.avgMs)}`,
    `  p50:                ${formatDurationMs(summary.responseTime.p50Ms)}`,
    `  p95:                ${formatDurationMs(summary.responseTime.p95Ms)}`,
    '',
    `Knowledge coverage:   ${coveragePct}% (${matchedCount}/${summary.byStatus.completed} queries had relevant results)`,
  )

  if (summary.topTopics.length > 0) {
    lines.push('', 'Top queried topics:')
    for (const [i, t] of summary.topTopics.entries()) {
      lines.push(`  ${i + 1}. ${t.topic} — ${t.count} queries`)
    }
  }

  if (summary.topRecalledDocs.length > 0) {
    lines.push('', 'Top recalled documents:')
    for (const [i, d] of summary.topRecalledDocs.entries()) {
      lines.push(`  ${i + 1}. ${d.path} — ${d.count} queries`)
    }
  }

  if (summary.knowledgeGaps.length > 0) {
    lines.push('', 'Knowledge gaps (asked but unanswered):')
    for (const [i, g] of summary.knowledgeGaps.entries()) {
      lines.push(`  ${i + 1}. "${g.topic}" — ${g.count} unanswered queries`)
    }

    lines.push("  → Run 'brv curate' on these topics to close the gap")
  }

  return lines.join('\n')
}

