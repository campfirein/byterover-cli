import {expect} from 'chai'

import {AgentDriverProfileSchema} from '../../../../src/shared/types/channel.js'

// Slice 3.0 — `AgentDriverProfile` zod shape (CHANNEL_PROTOCOL.md §8.3 +
// Phase-3 spec edit). `probedAt` is OPTIONAL for v0.1 back-compat; the
// doctor's freshness check defers to "unknown" when the field is absent.

describe('AgentDriverProfileSchema (Phase 3)', () => {
  const baseProfile = {
    capabilities: [],
    displayName: 'Mock',
    driverClass: 'C-prime' as const,
    invocation: {args: ['mock-acp.js'], command: 'node', cwd: '/tmp'},
    name: 'mock',
  }

  it('accepts a minimal profile (no probedAt)', () => {
    const parsed = AgentDriverProfileSchema.parse(baseProfile)
    expect(parsed.name).to.equal('mock')
    expect(parsed.probedAt).to.equal(undefined)
  })

  it('accepts a profile with probedAt', () => {
    const parsed = AgentDriverProfileSchema.parse({
      ...baseProfile,
      probedAt: '2026-05-12T07:30:00.000Z',
    })
    expect(parsed.probedAt).to.equal('2026-05-12T07:30:00.000Z')
  })

  it('accepts driverClass A / B / C-prime', () => {
    expect(AgentDriverProfileSchema.parse({...baseProfile, driverClass: 'A'}).driverClass).to.equal('A')
    expect(AgentDriverProfileSchema.parse({...baseProfile, driverClass: 'B'}).driverClass).to.equal('B')
    expect(AgentDriverProfileSchema.parse({...baseProfile, driverClass: 'C-prime'}).driverClass).to.equal('C-prime')
  })

  it('rejects an unknown driverClass', () => {
    expect(() => AgentDriverProfileSchema.parse({...baseProfile, driverClass: 'F'})).to.throw()
  })

  it('rejects a profile missing name', () => {
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    const {name, ...withoutName} = baseProfile
    expect(() => AgentDriverProfileSchema.parse(withoutName)).to.throw()
  })

  it('accepts optional detectedAcpVersion + capabilities', () => {
    const parsed = AgentDriverProfileSchema.parse({
      ...baseProfile,
      capabilities: ['embeddedContext', 'image'],
      detectedAcpVersion: '1',
    })
    expect(parsed.detectedAcpVersion).to.equal('1')
    expect(parsed.capabilities).to.deep.equal(['embeddedContext', 'image'])
  })
})
