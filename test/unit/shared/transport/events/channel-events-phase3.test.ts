import {expect} from 'chai'

import {
  ChannelEvents,
  ChannelProfileListRequestSchema,
  ChannelProfileListResponseSchema,
  ChannelProfileRemoveRequestSchema,
  ChannelProfileRemoveResponseSchema,
  ChannelProfileShowRequestSchema,
  ChannelProfileShowResponseSchema,
  ChannelRotateTokenRequestSchema,
  ChannelRotateTokenResponseSchema,
} from '../../../../../src/shared/transport/events/channel-events.js'

// Slice 3.0 — Phase-3 wire schemas. The plan + CHANNEL_PROTOCOL.md §3 + §8.3.1
// + §8.3.2 require these four new request events to be wired into ChannelEvents
// AND zod schemas to be exported alongside the Phase-1/2 schemas.

describe('ChannelEvents (Phase 3)', () => {
describe('Phase-3 ChannelEvents constants', () => {
  it('exposes the four new Phase-3 request constants', () => {
    expect(ChannelEvents.ROTATE_TOKEN).to.equal('channel:rotate-token')
    expect(ChannelEvents.PROFILE_LIST).to.equal('channel:profile-list')
    expect(ChannelEvents.PROFILE_SHOW).to.equal('channel:profile-show')
    expect(ChannelEvents.PROFILE_REMOVE).to.equal('channel:profile-remove')
  })
})

describe('ChannelRotateTokenRequestSchema', () => {
  it('accepts {confirm: true}', () => {
    expect(ChannelRotateTokenRequestSchema.parse({confirm: true})).to.deep.equal({confirm: true})
  })

  it('rejects {confirm: false} — the literal `true` guards accidental invocation', () => {
    expect(() => ChannelRotateTokenRequestSchema.parse({confirm: false})).to.throw()
  })

  it('rejects an empty payload', () => {
    expect(() => ChannelRotateTokenRequestSchema.parse({})).to.throw()
  })
})

describe('ChannelRotateTokenResponseSchema', () => {
  it('accepts {tokenFingerprint, disconnectedClients}', () => {
    const parsed = ChannelRotateTokenResponseSchema.parse({
      disconnectedClients: 3,
      tokenFingerprint: 'abc123def456',
    })
    expect(parsed.tokenFingerprint).to.equal('abc123def456')
    expect(parsed.disconnectedClients).to.equal(3)
  })

  it('rejects negative disconnectedClients', () => {
    expect(() =>
      ChannelRotateTokenResponseSchema.parse({disconnectedClients: -1, tokenFingerprint: 'x'}),
    ).to.throw()
  })
})

describe('ChannelProfileListRequestSchema', () => {
  it('accepts an empty payload', () => {
    expect(ChannelProfileListRequestSchema.parse({})).to.deep.equal({})
  })
})

describe('ChannelProfileListResponseSchema', () => {
  it('accepts {profiles: []}', () => {
    expect(ChannelProfileListResponseSchema.parse({profiles: []})).to.deep.equal({profiles: []})
  })

  it('accepts an array of AgentDriverProfile', () => {
    const profile = {
      capabilities: ['embeddedContext'],
      detectedAcpVersion: '1',
      displayName: 'Kimi',
      driverClass: 'A' as const,
      invocation: {args: [], command: 'kimi', cwd: '/tmp', env: undefined},
      name: 'kimi',
      probedAt: '2026-05-12T00:00:00.000Z',
    }
    const parsed = ChannelProfileListResponseSchema.parse({profiles: [profile]})
    expect(parsed.profiles).to.have.lengthOf(1)
    expect(parsed.profiles[0].name).to.equal('kimi')
  })
})

describe('ChannelProfileShowRequestSchema', () => {
  it('requires name', () => {
    expect(ChannelProfileShowRequestSchema.parse({name: 'kimi'})).to.deep.equal({name: 'kimi'})
    expect(() => ChannelProfileShowRequestSchema.parse({})).to.throw()
  })
})

describe('ChannelProfileShowResponseSchema', () => {
  it('accepts {profile}', () => {
    const profile = {
      capabilities: [],
      displayName: 'Mock',
      driverClass: 'C-prime' as const,
      invocation: {args: ['mock-acp.js'], command: 'node', cwd: '/tmp', env: undefined},
      name: 'mock',
    }
    const parsed = ChannelProfileShowResponseSchema.parse({profile})
    expect(parsed.profile.name).to.equal('mock')
  })
})

describe('ChannelProfileRemoveRequestSchema', () => {
  it('requires name', () => {
    expect(ChannelProfileRemoveRequestSchema.parse({name: 'kimi'})).to.deep.equal({name: 'kimi'})
    expect(() => ChannelProfileRemoveRequestSchema.parse({})).to.throw()
  })
})

describe('ChannelProfileRemoveResponseSchema', () => {
  it('accepts {removed: true}', () => {
    expect(ChannelProfileRemoveResponseSchema.parse({removed: true})).to.deep.equal({removed: true})
  })

  it('accepts {removed: false} (idempotent remove of a missing profile)', () => {
    expect(ChannelProfileRemoveResponseSchema.parse({removed: false})).to.deep.equal({removed: false})
  })
})
})
