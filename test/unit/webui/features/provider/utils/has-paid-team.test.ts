import {expect} from 'chai'

import type {BillingUsageDTO} from '../../../../../../src/shared/transport/types/dto'

import {hasPaidTeam} from '../../../../../../src/webui/features/provider/utils/has-paid-team'

const usage = (overrides: Partial<BillingUsageDTO> = {}): BillingUsageDTO => ({
  addOnRemaining: 0,
  isTrialing: false,
  limit: 100_000,
  limitExceeded: false,
  organizationId: 'org-1',
  organizationName: 'org-1',
  organizationStatus: 'ACTIVE',
  percentUsed: 10,
  remaining: 90_000,
  tier: 'PRO',
  totalLimit: 100_000,
  used: 10_000,
  ...overrides,
})

describe('hasPaidTeam', () => {
  it('returns false when usage is undefined', () => {
    expect(hasPaidTeam()).to.be.false
  })

  it('returns false for empty usage map', () => {
    expect(hasPaidTeam({})).to.be.false
  })

  it('returns false when every team is on the FREE tier', () => {
    expect(hasPaidTeam({a: usage({tier: 'FREE'}), b: usage({tier: 'FREE'})})).to.be.false
  })

  it('returns true when at least one team is on a paid tier', () => {
    expect(hasPaidTeam({a: usage({tier: 'FREE'}), b: usage({tier: 'PRO'})})).to.be.true
  })

  it('returns true for TEAM tier', () => {
    expect(hasPaidTeam({a: usage({tier: 'TEAM'})})).to.be.true
  })
})
