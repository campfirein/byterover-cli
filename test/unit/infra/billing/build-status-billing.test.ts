import {expect} from 'chai'

import type {BillingFreeUserLimitDTO, BillingUsageDTO} from '../../../../src/shared/transport/types/dto.js'

import {buildStatusBilling} from '../../../../src/server/infra/billing/build-status-billing.js'

const usage = (overrides: Partial<BillingUsageDTO> = {}): BillingUsageDTO => ({
  addOnRemaining: 0,
  isTrialing: false,
  limit: 100_000,
  limitExceeded: false,
  organizationId: 'org-acme',
  organizationName: 'Acme Corp',
  organizationStatus: 'ACTIVE',
  percentUsed: 12.4,
  remaining: 87_600,
  tier: 'PRO',
  totalLimit: 100_000,
  used: 12_400,
  ...overrides,
})

const freeLimit: BillingFreeUserLimitDTO = {
  daily: {limit: 50, limitExceeded: false, percentUsed: 20, remaining: 40, used: 10},
  limitExceeded: false,
  monthly: {limit: 1000, limitExceeded: false, percentUsed: 5, remaining: 950, used: 50},
}

describe('buildStatusBilling', () => {
  it('returns undefined when the user is not signed in', () => {
    const result = buildStatusBilling({
      activeProvider: 'byterover',
      isAuthenticated: false,
      paidUsages: [],
    })

    expect(result).to.equal(undefined)
  })

  it('returns other-provider when byterover is not active, regardless of auth', () => {
    const result = buildStatusBilling({
      activeProvider: 'openai',
      isAuthenticated: true,
      paidUsages: [usage()],
    })

    expect(result).to.deep.equal({activeProvider: 'openai', source: 'other-provider'})
  })

  it('returns the paid source when a pin is set and matches a paid usage', () => {
    const result = buildStatusBilling({
      activeProvider: 'byterover',
      isAuthenticated: true,
      paidUsages: [usage()],
      pinnedTeamId: 'org-acme',
    })

    expect(result).to.deep.equal({
      organizationId: 'org-acme',
      organizationName: 'Acme Corp',
      remaining: 87_600,
      source: 'paid',
      tier: 'PRO',
      total: 100_000,
    })
  })

  it("returns paid even when the pin is not in the user's paid usages (BE will reject)", () => {
    const result = buildStatusBilling({
      activeProvider: 'byterover',
      isAuthenticated: true,
      paidUsages: [usage({organizationId: 'org-acme'})],
      pinnedTeamId: 'org-stale',
    })

    expect(result).to.deep.equal({organizationId: 'org-stale', source: 'paid'})
  })

  it('returns free when no pin and multiple paid usages exist (server cannot disambiguate)', () => {
    const result = buildStatusBilling({
      activeProvider: 'byterover',
      freeUserLimit: freeLimit,
      isAuthenticated: true,
      paidUsages: [
        usage({organizationId: 'org-acme', organizationName: 'Acme Corp'}),
        usage({organizationId: 'org-other', organizationName: 'Other'}),
      ],
    })

    expect(result?.source).to.equal('free')
  })

  it('returns paid when no pin/workspace and there is exactly one paid org', () => {
    const result = buildStatusBilling({
      activeProvider: 'byterover',
      isAuthenticated: true,
      paidUsages: [usage()],
    })

    expect(result?.source).to.equal('paid')
    expect(result && 'organizationId' in result ? result.organizationId : undefined).to.equal('org-acme')
  })

  it('returns the free source with monthly remaining/total when there are no paid orgs', () => {
    const result = buildStatusBilling({
      activeProvider: 'byterover',
      freeUserLimit: freeLimit,
      isAuthenticated: true,
      paidUsages: [],
    })

    expect(result).to.deep.equal({
      remaining: 950,
      source: 'free',
      total: 1000,
    })
  })

  it('returns the free source with no credits when free limit data is missing', () => {
    const result = buildStatusBilling({
      activeProvider: 'byterover',
      isAuthenticated: true,
      paidUsages: [],
    })

    expect(result).to.deep.equal({source: 'free'})
  })

  it('returns the free source when no pin and multiple paid orgs exist', () => {
    const result = buildStatusBilling({
      activeProvider: 'byterover',
      freeUserLimit: freeLimit,
      isAuthenticated: true,
      paidUsages: [
        usage({organizationId: 'org-A', organizationName: 'A'}),
        usage({organizationId: 'org-B', organizationName: 'B'}),
      ],
    })

    expect(result?.source).to.equal('free')
    expect(result && result.source === 'free' ? result.remaining : undefined).to.equal(950)
  })
})
