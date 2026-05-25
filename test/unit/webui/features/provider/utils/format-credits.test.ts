import {expect} from 'chai'

import {formatCredits} from '../../../../../../src/webui/features/provider/utils/format-credits'

describe('formatCredits', () => {
  it('returns the literal number for values under 1,000', () => {
    expect(formatCredits(0)).to.equal('0')
    expect(formatCredits(42)).to.equal('42')
    expect(formatCredits(999)).to.equal('999')
  })

  it('formats thousands with one decimal place', () => {
    expect(formatCredits(1000)).to.equal('1k')
    expect(formatCredits(12_400)).to.equal('12.4k')
    expect(formatCredits(999_999)).to.equal('1m')
  })

  it('formats millions with one decimal place', () => {
    expect(formatCredits(1_000_000)).to.equal('1m')
    expect(formatCredits(2_500_000)).to.equal('2.5m')
  })

  it('drops a trailing .0 for whole-thousand values', () => {
    expect(formatCredits(1000)).to.equal('1k')
    expect(formatCredits(50_000)).to.equal('50k')
  })

  it('clamps negatives to zero', () => {
    expect(formatCredits(-50)).to.equal('0')
  })
})
