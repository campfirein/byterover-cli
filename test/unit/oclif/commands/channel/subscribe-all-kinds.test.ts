import {expect} from 'chai'

import ChannelSubscribe from '../../../../../src/oclif/commands/channel/subscribe.js'

// Phase 9.5 §3.5 — `brv channel subscribe --all-kinds` structural tests.
//
// Exercises flag contract only; the actual wire behaviour is integration-tested.

describe('ChannelSubscribe --all-kinds flag (§3.5)', () => {
  it('should expose an --all-kinds boolean flag', () => {
    expect(ChannelSubscribe.flags).to.have.property('all-kinds')
  })

  it('--all-kinds should default to false', () => {
    const flag = ChannelSubscribe.flags['all-kinds'] as {default?: boolean}
    expect(flag.default).to.equal(false)
  })

  it('--all-kinds description should mention diagnostics or filter', () => {
    const flag = ChannelSubscribe.flags['all-kinds'] as {description?: string}
    expect(flag.description).to.be.a('string')
    const desc = flag.description!.toLowerCase()
    expect(desc.includes('filter') || desc.includes('diagnostic') || desc.includes('all')).to.equal(true)
  })

  it('--all-kinds and --kinds are both defined (--all-kinds overrides --kinds at runtime)', () => {
    expect(ChannelSubscribe.flags).to.have.property('all-kinds')
    expect(ChannelSubscribe.flags).to.have.property('kinds')
  })
})
