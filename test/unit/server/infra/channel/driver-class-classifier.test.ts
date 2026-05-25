import {expect} from 'chai'

import {advertisedCapabilities, classifyDriver} from '../../../../../src/server/infra/channel/driver-class-classifier.js'

// Slice 3.2 — driver-class classifier.
//
// Rules (CHANNEL_PROTOCOL.md §4.2 ChannelMember + Phase-3 plan §3.2):
//   Class A     — initialize OK, session/new OK, AND advertises
//                 embeddedContext=true AND at least one of {image,
//                 toolCallSupport}.
//   Class B     — initialize OK, session/new OK, baseline ACP only.
//   Class C-prime — initialize OK BUT session/new errored, OR the agent
//                  explicitly advertises `_meta.brv.driverClass === 'C-prime'`.

describe('Driver-class classifier (Phase 3)', () => {
describe('classifyDriver', () => {
  it('returns A when sessionNewSucceeded AND embeddedContext=true AND image=true', () => {
    expect(
      classifyDriver({
        agentCapabilities: {
          promptCapabilities: {embeddedContext: true, image: true},
        },
        sessionNewSucceeded: true,
      }),
    ).to.equal('A')
  })

  it('returns A when sessionNewSucceeded AND embeddedContext=true AND toolCallSupport=true', () => {
    expect(
      classifyDriver({
        agentCapabilities: {
          promptCapabilities: {embeddedContext: true},
          toolCallSupport: true,
        },
        sessionNewSucceeded: true,
      }),
    ).to.equal('A')
  })

  it('returns B when sessionNewSucceeded AND baseline capabilities (no embeddedContext, no image)', () => {
    expect(
      classifyDriver({
        agentCapabilities: {promptCapabilities: {embeddedContext: false}},
        sessionNewSucceeded: true,
      }),
    ).to.equal('B')
  })

  it('returns B when capabilities object is absent', () => {
    expect(classifyDriver({sessionNewSucceeded: true})).to.equal('B')
  })

  it('returns C-prime when session/new failed regardless of capabilities', () => {
    expect(
      classifyDriver({
        agentCapabilities: {promptCapabilities: {embeddedContext: true, image: true}},
        sessionNewSucceeded: false,
      }),
    ).to.equal('C-prime')
  })

  it('returns C-prime when the agent explicitly advertises driverClass=C-prime in _meta', () => {
    expect(
      classifyDriver({
        _meta: {'brv.driverClass': 'C-prime'},
        agentCapabilities: {promptCapabilities: {embeddedContext: true, image: true}},
        sessionNewSucceeded: true,
      }),
    ).to.equal('C-prime')
  })

  it('returns B when embeddedContext=true but NEITHER image NOR toolCallSupport is advertised', () => {
    // Class-A requires `embeddedContext` PLUS at least one of {image,
    // toolCallSupport}. A profile that advertises just embeddedContext
    // tops out at Class B.
    expect(
      classifyDriver({
        agentCapabilities: {promptCapabilities: {embeddedContext: true, image: false}},
        sessionNewSucceeded: true,
      }),
    ).to.equal('B')
  })
})

describe('advertisedCapabilities', () => {
  it('returns the detected capability names suitable for AgentDriverProfile.capabilities', () => {
    expect(
      advertisedCapabilities({
        agentCapabilities: {
          promptCapabilities: {embeddedContext: true, image: false},
          toolCallSupport: true,
        },
        sessionNewSucceeded: true,
      }),
    ).to.deep.equal(['embeddedContext', 'toolCallSupport'])
  })

  it('returns [] when nothing is advertised', () => {
    expect(advertisedCapabilities({sessionNewSucceeded: true})).to.deep.equal([])
  })
})
})
