/**
 * Synthesize candidate generator for tool-mode dream.
 *
 * Returns a different shape from link / merge / prune: rather than pair
 * candidates, it surfaces *domain overviews* (all topics grouped by
 * domain) plus the list of existing synthesis topics. The calling agent
 * reads the overviews and decides what new cross-cutting patterns are
 * worth writing as a fresh `<bv-topic>` under `synthesis/`.
 *
 * The asymmetry is deliberate — flattening domains into pair-like
 * candidates would hide what the agent actually needs to reason over.
 *
 * Existing synthesis topics are kept separate so the agent can dedup
 * against them before authoring something redundant.
 */

export type SynthesizeCandidateTopic = {
  path: string
  summary: string
  title: string
}

export type DomainOverview = {
  domain: string
  topics: SynthesizeCandidateTopic[]
}

export type ExistingSynthesis = {
  path: string
  summary: string
  title: string
}

export type SynthesizeCandidates = {
  domains: DomainOverview[]
  existingSyntheses: ExistingSynthesis[]
}

export type FindSynthesizeCandidatesOptions = {
  /** Skip domains with fewer topics than this. Default 2. */
  minTopicsPerDomain?: number
  /** Optional path prefix. Topics outside it are ignored for domains; existingSyntheses always returned. */
  scope?: string
}

const DEFAULT_MIN_TOPICS_PER_DOMAIN = 2
/** Path prefix used to recognise an existing synthesis topic. */
const SYNTHESIS_DOMAIN_PREFIX = 'synthesis/'

export async function findSynthesizeCandidates(params: {
  options?: FindSynthesizeCandidatesOptions
  topics: SynthesizeCandidateTopic[]
}): Promise<SynthesizeCandidates> {
  const {options, topics} = params
  const minTopicsPerDomain = options?.minTopicsPerDomain ?? DEFAULT_MIN_TOPICS_PER_DOMAIN
  const scope = options?.scope

  const existingSyntheses: ExistingSynthesis[] = []
  const byDomain = new Map<string, SynthesizeCandidateTopic[]>()

  for (const topic of topics) {
    if (topic.path.startsWith(SYNTHESIS_DOMAIN_PREFIX)) {
      existingSyntheses.push({path: topic.path, summary: topic.summary, title: topic.title})
      continue
    }

    if (scope && !topic.path.startsWith(scope)) continue

    const domain = deriveDomain(topic.path)
    const list = byDomain.get(domain) ?? []
    list.push(topic)
    byDomain.set(domain, list)
  }

  const domains: DomainOverview[] = [...byDomain.entries()]
    .filter(([, list]) => list.length >= minTopicsPerDomain)
    .map(([domain, list]) => ({domain, topics: list}))

  return {domains, existingSyntheses}
}

/** First path segment (e.g. "security/jwt.html" → "security"). Returns "" for paths without a slash. */
function deriveDomain(path: string): string {
  const slashIndex = path.indexOf('/')
  if (slashIndex === -1) return ''
  return path.slice(0, slashIndex)
}
