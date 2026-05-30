import {expect} from 'chai'

import {createDefaultRuntimeSignals} from '../../../../../src/server/core/domain/knowledge/runtime-signals-schema.js'
import {
  findPruneCandidates,
  type PruneCandidateTopic,
} from '../../../../../src/server/infra/dream/tool-mode/prune-candidates.js'

const DAY_MS = 24 * 60 * 60 * 1000
const NOW = 1_780_000_000_000 // fixed point for deterministic tests

function topic(overrides: Partial<PruneCandidateTopic>): PruneCandidateTopic {
  return {
    html: '<bv-topic path="x" title="x"/>',
    mtimeMs: NOW,
    path: 'x.html',
    signals: createDefaultRuntimeSignals(),
    ...overrides,
  }
}

describe('findPruneCandidates', () => {
  it('returns empty when no topics qualify', async () => {
    const result = await findPruneCandidates({
      options: {now: NOW},
      topics: [topic({})],
    })
    expect(result).to.deep.equal([])
  })

  it('surfaces a topic with importance below threshold (default 35)', async () => {
    const t = topic({
      path: 'old/topic.html',
      signals: {...createDefaultRuntimeSignals(), importance: 20, maturity: 'draft'},
    })

    const result = await findPruneCandidates({options: {now: NOW}, topics: [t]})

    expect(result).to.have.length(1)
    expect(result[0].path).to.equal('old/topic.html')
    expect(result[0].reason).to.equal('low-importance')
  })

  it('surfaces a draft topic stale beyond 60 days', async () => {
    const t = topic({
      mtimeMs: NOW - 70 * DAY_MS,
      path: 'stale/topic.html',
      signals: {...createDefaultRuntimeSignals(), importance: 80, maturity: 'draft'},
    })

    const result = await findPruneCandidates({options: {now: NOW}, topics: [t]})

    expect(result).to.have.length(1)
    expect(result[0].reason).to.equal('stale-mtime')
    expect(result[0].daysSinceModified).to.be.closeTo(70, 0.001)
  })

  it('surfaces a validated topic stale beyond 120 days', async () => {
    const t = topic({
      mtimeMs: NOW - 150 * DAY_MS,
      path: 'old/validated.html',
      signals: {...createDefaultRuntimeSignals(), importance: 80, maturity: 'validated'},
    })

    const result = await findPruneCandidates({options: {now: NOW}, topics: [t]})

    expect(result).to.have.length(1)
    expect(result[0].reason).to.equal('stale-mtime')
  })

  it('does NOT surface a draft within 60 days even when importance is moderate', async () => {
    const t = topic({
      mtimeMs: NOW - 30 * DAY_MS,
      signals: {...createDefaultRuntimeSignals(), importance: 60, maturity: 'draft'},
    })

    const result = await findPruneCandidates({options: {now: NOW}, topics: [t]})
    expect(result).to.deep.equal([])
  })

  it('NEVER surfaces a core-maturity topic, even if low-importance and very stale', async () => {
    const t = topic({
      mtimeMs: NOW - 365 * DAY_MS,
      signals: {...createDefaultRuntimeSignals(), importance: 5, maturity: 'core'},
    })

    const result = await findPruneCandidates({options: {now: NOW}, topics: [t]})
    expect(result).to.deep.equal([])
  })

  it('marks a topic with both signals as reason="both" (single entry)', async () => {
    const t = topic({
      mtimeMs: NOW - 90 * DAY_MS,
      signals: {...createDefaultRuntimeSignals(), importance: 10, maturity: 'draft'},
    })

    const result = await findPruneCandidates({options: {now: NOW}, topics: [t]})
    expect(result).to.have.length(1)
    expect(result[0].reason).to.equal('both')
  })

  it('sorts candidates stalest-first', async () => {
    const topics = [
      topic({mtimeMs: NOW - 70 * DAY_MS, path: 'mid.html', signals: {...createDefaultRuntimeSignals(), maturity: 'draft'}}),
      topic({mtimeMs: NOW - 200 * DAY_MS, path: 'oldest.html', signals: {...createDefaultRuntimeSignals(), maturity: 'draft'}}),
      topic({mtimeMs: NOW - 100 * DAY_MS, path: 'middle.html', signals: {...createDefaultRuntimeSignals(), maturity: 'draft'}}),
    ]
    const result = await findPruneCandidates({options: {now: NOW}, topics})

    expect(result.map((c) => c.path)).to.deep.equal(['oldest.html', 'middle.html', 'mid.html'])
  })

  it('respects maxCandidates cap', async () => {
    const topics: PruneCandidateTopic[] = Array.from({length: 25}, (_, i) =>
      topic({
        mtimeMs: NOW - (200 - i) * DAY_MS,
        path: `t${i}.html`,
        signals: {...createDefaultRuntimeSignals(), maturity: 'draft'},
      }),
    )

    const result = await findPruneCandidates({options: {maxCandidates: 5, now: NOW}, topics})

    expect(result).to.have.length(5)
    // Stalest five (largest mtime delta = smallest i)
    expect(result[0].path).to.equal('t0.html')
  })

  it('respects scope filter (paths outside scope are skipped)', async () => {
    const topics = [
      topic({mtimeMs: NOW - 70 * DAY_MS, path: 'security/old.html', signals: {...createDefaultRuntimeSignals(), maturity: 'draft'}}),
      topic({mtimeMs: NOW - 70 * DAY_MS, path: 'other/old.html', signals: {...createDefaultRuntimeSignals(), maturity: 'draft'}}),
    ]
    const result = await findPruneCandidates({options: {now: NOW, scope: 'security/'}, topics})

    expect(result).to.have.length(1)
    expect(result[0].path).to.equal('security/old.html')
  })

  it('returns daysSinceModified for every candidate', async () => {
    const t = topic({
      mtimeMs: NOW - 42 * DAY_MS,
      signals: {...createDefaultRuntimeSignals(), importance: 20, maturity: 'draft'},
    })
    const result = await findPruneCandidates({options: {now: NOW}, topics: [t]})
    expect(result[0].daysSinceModified).to.be.closeTo(42, 0.001)
  })
})
