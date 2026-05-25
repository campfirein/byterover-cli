import {expect} from 'chai'

import {
  DEFAULT_STAKE,
  isStake,
  resolveStakeGroupSize,
  resolveStakeMatrix,
  type Stake,
  STAKE_VALUES,
} from '../../../../../../src/server/infra/channel/quorum/stake.js'

describe('quorum/stake', () => {
  describe('default matrix', () => {
    it('low → 1 local, 0 remote', () => {
      expect(resolveStakeGroupSize('low', {})).to.deep.equal({local: 1, remote: 0})
    })

    it('medium → 2 local, 0 remote', () => {
      expect(resolveStakeGroupSize('medium', {})).to.deep.equal({local: 2, remote: 0})
    })

    it('high → 2 local, 1 remote', () => {
      expect(resolveStakeGroupSize('high', {})).to.deep.equal({local: 2, remote: 1})
    })

    it('critical → 3 local, 2 remote', () => {
      expect(resolveStakeGroupSize('critical', {})).to.deep.equal({local: 3, remote: 2})
    })

    it('default stake is medium', () => {
      expect(DEFAULT_STAKE).to.equal('medium')
    })

    it('STAKE_VALUES enumerates every grade in ascending order', () => {
      expect(STAKE_VALUES).to.deep.equal(['low', 'medium', 'high', 'critical'])
    })
  })

  describe('env override', () => {
    it('honours BRV_QUORUM_STAKE_<STAKE>_LOCAL overrides', () => {
      const env = {BRV_QUORUM_STAKE_LOW_LOCAL: '3'}
      expect(resolveStakeGroupSize('low', env)).to.deep.equal({local: 3, remote: 0})
    })

    it('honours BRV_QUORUM_STAKE_<STAKE>_REMOTE overrides', () => {
      const env = {BRV_QUORUM_STAKE_CRITICAL_REMOTE: '5'}
      expect(resolveStakeGroupSize('critical', env)).to.deep.equal({local: 3, remote: 5})
    })

    it('mixes overrides with defaults (only specified cells change)', () => {
      const env = {BRV_QUORUM_STAKE_HIGH_REMOTE: '3'}
      expect(resolveStakeGroupSize('high', env)).to.deep.equal({local: 2, remote: 3})
    })

    it('ignores invalid env values (NaN, negative, empty)', () => {
      expect(resolveStakeGroupSize('medium', {BRV_QUORUM_STAKE_MEDIUM_LOCAL: 'abc'})).to.deep.equal({local: 2, remote: 0})
      expect(resolveStakeGroupSize('medium', {BRV_QUORUM_STAKE_MEDIUM_LOCAL: '-1'})).to.deep.equal({local: 2, remote: 0})
      expect(resolveStakeGroupSize('medium', {BRV_QUORUM_STAKE_MEDIUM_LOCAL: ''})).to.deep.equal({local: 2, remote: 0})
    })

    it('accepts 0 as a valid override (zero-remote for cost-sensitive critical)', () => {
      const env = {BRV_QUORUM_STAKE_CRITICAL_REMOTE: '0'}
      expect(resolveStakeGroupSize('critical', env)).to.deep.equal({local: 3, remote: 0})
    })
  })

  describe('resolveStakeMatrix', () => {
    it('returns all four stakes in one call', () => {
      const matrix = resolveStakeMatrix({})
      expect(Object.keys(matrix).sort()).to.deep.equal(['critical', 'high', 'low', 'medium'])
    })

    it('applies env overrides across stakes', () => {
      const env = {
        BRV_QUORUM_STAKE_HIGH_LOCAL: '5',
        BRV_QUORUM_STAKE_LOW_LOCAL: '4',
      }
      const matrix = resolveStakeMatrix(env)
      expect(matrix.low.local).to.equal(4)
      expect(matrix.high.local).to.equal(5)
      // Unchanged cells retain defaults
      expect(matrix.medium).to.deep.equal({local: 2, remote: 0})
    })
  })

  describe('isStake', () => {
    it('accepts known values', () => {
      expect(isStake('low')).to.equal(true)
      expect(isStake('medium')).to.equal(true)
      expect(isStake('high')).to.equal(true)
      expect(isStake('critical')).to.equal(true)
    })

    it('rejects unknown values', () => {
      expect(isStake('LOW')).to.equal(false)
      expect(isStake('extreme')).to.equal(false)
      expect(isStake('')).to.equal(false)
    })

    it('narrows the type', () => {
      const v: string = 'high'
      if (isStake(v)) {
        const s: Stake = v
        expect(s).to.equal('high')
      } else {
        expect.fail('isStake should have narrowed')
      }
    })
  })
})
