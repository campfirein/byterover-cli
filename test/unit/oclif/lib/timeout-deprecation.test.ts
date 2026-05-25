import {expect} from 'chai'

import {
  TIMEOUT_DEPRECATION_HELP,
  TIMEOUT_DEPRECATION_MESSAGE,
  warnIfTimeoutFlagUsed,
} from '../../../../src/oclif/lib/timeout-deprecation.js'

describe('timeout-deprecation helpers', () => {
  it('exposes a one-line deprecation message without naming any specific setting key', () => {
    expect(TIMEOUT_DEPRECATION_MESSAGE).to.match(/--timeout/)
    expect(TIMEOUT_DEPRECATION_MESSAGE).to.match(/deprecat/i)
    expect(TIMEOUT_DEPRECATION_MESSAGE).to.match(/no effect/i)
    // Per M6 T2: wording deliberately omits any specific setting key so M6
    // ships independently of M1/M2/M3 and survives setting renames.
    expect(TIMEOUT_DEPRECATION_MESSAGE).to.not.include('llm.iterationBudgetMs')
    expect(TIMEOUT_DEPRECATION_MESSAGE.split('\n')).to.have.lengthOf(1)
  })

  it('exposes help text marking the flag deprecated', () => {
    expect(TIMEOUT_DEPRECATION_HELP).to.match(/deprecat/i)
    expect(TIMEOUT_DEPRECATION_HELP).to.match(/no effect/i)
  })

  it('logs the deprecation message exactly once when the user passed --timeout', () => {
    const messages: string[] = []
    warnIfTimeoutFlagUsed({
      defaultValue: 300,
      log: (m) => messages.push(m),
      userValue: 600,
    })

    expect(messages).to.deep.equal([TIMEOUT_DEPRECATION_MESSAGE])
  })

  it('does not log when the flag value matches the default (no user override)', () => {
    const messages: string[] = []
    warnIfTimeoutFlagUsed({
      defaultValue: 300,
      log: (m) => messages.push(m),
      userValue: 300,
    })
    expect(messages).to.deep.equal([])
  })

  it('does not log when userValue is undefined (flag not parsed)', () => {
    const messages: string[] = []
    warnIfTimeoutFlagUsed({
      defaultValue: 300,
      log: (m) => messages.push(m),
      userValue: undefined,
    })
    expect(messages).to.deep.equal([])
  })
})
