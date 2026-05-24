import {expect} from 'chai'

import {
  type DurationParseError,
  formatCount,
  formatDuration,
  parseDuration,
} from '../../../../src/shared/utils/format-duration.js'

function assertError(input: string, kind: DurationParseError['kind']): DurationParseError {
  const result = parseDuration(input)
  expect(typeof result).to.equal('object', `expected error object for ${JSON.stringify(input)}`)
  const err = result as DurationParseError
  expect(err.kind).to.equal(kind)
  expect(err.input).to.equal(input)
  expect(err.hint).to.be.a('string').and.not.empty
  return err
}

describe('format-duration', () => {
  describe('formatDuration', () => {
    const cases: ReadonlyArray<{readonly expected: string; readonly input: number}> = [
      {expected: '0s', input: 0},
      {expected: '1m', input: 60_000},
      {expected: '1m 30s', input: 90_000},
      {expected: '2m 5s', input: 125_000},
      {expected: '1h', input: 3_600_000},
      {expected: '1h 30m', input: 5_400_000},
      {expected: '45s', input: 45_000},
      {expected: '2h 5m', input: 7_500_000},
    ]

    for (const c of cases) {
      it(`${c.input} -> "${c.expected}"`, () => {
        expect(formatDuration(c.input)).to.equal(c.expected)
      })
    }
  })

  describe('formatCount', () => {
    const cases: ReadonlyArray<{readonly expected: string; readonly input: number}> = [
      {expected: '0', input: 0},
      {expected: '999', input: 999},
      {expected: '1,000', input: 1000},
      {expected: '10,000', input: 10_000},
      {expected: '100,000', input: 100_000},
    ]

    for (const c of cases) {
      it(`${c.input} -> "${c.expected}"`, () => {
        expect(formatCount(c.input)).to.equal(c.expected)
      })
    }
  })

  describe('parseDuration — happy paths', () => {
    const cases: ReadonlyArray<{readonly expected: number; readonly input: string}> = [
      {expected: 1_800_000, input: '30m'},
      {expected: 3_600_000, input: '1h'},
      {expected: 5_400_000, input: '1h 30m'},
      {expected: 5_400_000, input: '1h30m'},
      {expected: 45_000, input: '45s'},
      {expected: 30_000, input: '30000ms'},
      {expected: 5_400_000, input: '1H 30M'},
      {expected: 1_800_000, input: '1800000'},
      {expected: 0, input: '0'},
      {expected: 60_000, input: '60s'},
    ]

    for (const c of cases) {
      it(`"${c.input}" -> ${c.expected}`, () => {
        expect(parseDuration(c.input)).to.equal(c.expected)
      })
    }
  })

  describe('parseDuration — error paths', () => {
    it('"1.5h" rejected with fraction kind and hint suggesting integer minutes', () => {
      const err = assertError('1.5h', 'fraction')
      expect(err.hint).to.match(/90m/)
    })

    it('"10x" rejected with unknown-unit kind and hint listing accepted units', () => {
      const err = assertError('10x', 'unknown-unit')
      expect(err.hint).to.match(/s|m|h|ms/i)
    })

    it('"" rejected with empty kind', () => {
      assertError('', 'empty')
    })

    it('"   " (whitespace only) rejected with empty kind', () => {
      assertError('   ', 'empty')
    })

    it('"30 m m" rejected as malformed', () => {
      assertError('30 m m', 'malformed')
    })

    it('"abc" rejected as malformed', () => {
      assertError('abc', 'malformed')
    })

    it('returned object carries the raw input verbatim', () => {
      const err = parseDuration('10x') as DurationParseError
      expect(err.input).to.equal('10x')
    })
  })

  describe('parseDuration / formatDuration round-trip', () => {
    it('formatDuration(parseDuration(x)) yields a string parseDuration can re-read', () => {
      const samples = [60_000, 90_000, 125_000, 1_800_000, 3_600_000, 5_400_000, 60_000_000]
      for (const ms of samples) {
        const formatted = formatDuration(ms)
        const reparsed = parseDuration(formatted)
        expect(reparsed).to.equal(ms, `round-trip failed for ${ms} (formatted as "${formatted}")`)
      }
    })
  })
})
