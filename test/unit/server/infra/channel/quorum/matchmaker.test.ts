import {expect} from 'chai'

import {
  DEFAULT_STRENGTHS,
  LocalMatchmaker,
  resolveStrengths,
  type StrengthAgent,
} from '../../../../../../src/server/infra/channel/quorum/matchmaker.js'

function agent(handle: string, strengths?: ReadonlyArray<string>): StrengthAgent {
  return strengths === undefined ? {handle} : {handle, strengths}
}

describe('quorum/matchmaker', () => {
  const matchmaker = new LocalMatchmaker()

  describe('default strength profiles', () => {
    it('has known profiles for kimi, codex, opencode, pi, claude-code', () => {
      expect(DEFAULT_STRENGTHS.has('@kimi')).to.equal(true)
      expect(DEFAULT_STRENGTHS.has('@codex')).to.equal(true)
      expect(DEFAULT_STRENGTHS.has('@opencode')).to.equal(true)
      expect(DEFAULT_STRENGTHS.has('@pi')).to.equal(true)
      expect(DEFAULT_STRENGTHS.has('@claude-code')).to.equal(true)
    })

    it('resolveStrengths returns explicit override when present', () => {
      const a = agent('@kimi', ['custom-strength'])
      expect(resolveStrengths(a)).to.deep.equal(['custom-strength'])
    })

    it('resolveStrengths falls back to DEFAULT_STRENGTHS for known handles', () => {
      const a = agent('@kimi')
      expect(resolveStrengths(a)).to.deep.equal(DEFAULT_STRENGTHS.get('@kimi'))
    })

    it('resolveStrengths returns empty for unknown handles with no override', () => {
      expect(resolveStrengths(agent('@unknown'))).to.deep.equal([])
    })
  })

  describe('matchAgents', () => {
    it('returns first targetSize members in input order when neededTags is empty', () => {
      const pool = [agent('@kimi'), agent('@codex'), agent('@pi')]
      const result = matchmaker.matchAgents({neededTags: [], poolMembers: pool, targetSize: 2})
      expect(result.map(m => m.handle)).to.deep.equal(['@kimi', '@codex'])
    })

    it('codex Q3 plan example: --needs integration-bugs picks kimi over pi', () => {
      const pool = [agent('@kimi'), agent('@pi'), agent('@opencode')]
      const result = matchmaker.matchAgents({
        neededTags: ['integration-bugs'],
        poolMembers: pool,
        targetSize: 1,
      })
      expect(result.map(m => m.handle)).to.deep.equal(['@kimi'])
    })

    it('coverage: --needs integration-bugs,type-safety picks kimi + codex', () => {
      const pool = [agent('@kimi'), agent('@codex'), agent('@pi'), agent('@opencode')]
      const result = matchmaker.matchAgents({
        neededTags: ['integration-bugs', 'type-safety'],
        poolMembers: pool,
        targetSize: 2,
      })
      expect(result.map(m => m.handle).sort()).to.deep.equal(['@codex', '@kimi'])
    })

    it('fallback: no agent matches the requested tags → picks first targetSize alphabetically (score=0 tie)', () => {
      const pool = [agent('@kimi'), agent('@codex'), agent('@pi')]
      const result = matchmaker.matchAgents({
        neededTags: ['nonexistent-tag'],
        poolMembers: pool,
        targetSize: 2,
      })
      // All score 0; tie-break is alphabetical → @codex, @kimi.
      expect(result.map(m => m.handle)).to.deep.equal(['@codex', '@kimi'])
    })

    it('tags are case-insensitive in both agent strengths and needs', () => {
      const a = agent('@case', ['Integration-Bugs', 'TYPE-SAFETY'])
      const pool = [a, agent('@other')]
      const result = matchmaker.matchAgents({
        neededTags: ['integration-bugs'],
        poolMembers: pool,
        targetSize: 1,
      })
      expect(result.map(m => m.handle)).to.deep.equal(['@case'])
    })

    it('deterministic tie-break: same-score agents return in alphabetical handle order', () => {
      const pool = [
        agent('@z', ['planning']),
        agent('@a', ['planning']),
        agent('@m', ['planning']),
      ]
      const result = matchmaker.matchAgents({
        neededTags: ['planning'],
        poolMembers: pool,
        targetSize: 3,
      })
      expect(result.map(m => m.handle)).to.deep.equal(['@a', '@m', '@z'])
    })

    it('honours explicit strengths override on individual agents', () => {
      const pool = [
        agent('@kimi'), // default profile: integration-bugs etc.
        agent('@codex', ['integration-bugs']), // explicit override matching needed tag
      ]
      const result = matchmaker.matchAgents({
        neededTags: ['integration-bugs'],
        poolMembers: pool,
        targetSize: 2,
      })
      // Both score 1 — tie-break alphabetical.
      expect(result.map(m => m.handle).sort()).to.deep.equal(['@codex', '@kimi'])
    })

    it('returns empty when targetSize <= 0 or pool empty', () => {
      expect(matchmaker.matchAgents({neededTags: [], poolMembers: [], targetSize: 5})).to.have.lengthOf(0)
      expect(matchmaker.matchAgents({neededTags: [], poolMembers: [agent('@a')], targetSize: 0})).to.have.lengthOf(0)
    })

    it('targetSize larger than pool returns the whole (sorted) pool', () => {
      const pool = [agent('@kimi'), agent('@codex')]
      const result = matchmaker.matchAgents({
        neededTags: ['type-safety'],
        poolMembers: pool,
        targetSize: 10,
      })
      expect(result.map(m => m.handle).sort()).to.deep.equal(['@codex', '@kimi'])
    })
  })
})
