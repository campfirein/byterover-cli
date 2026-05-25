import {expect} from 'chai'

import type {BillingUsageDTO} from '../../../../../../src/shared/transport/types/dto'

import {getBillingTone} from '../../../../../../src/webui/features/provider/utils/get-billing-tone'

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

describe('getBillingTone', () => {
  it('returns "inactive" when usage data is missing', () => {
    expect(getBillingTone()).to.equal('inactive')
  })

  it('returns "ok" when remaining is comfortable', () => {
    expect(getBillingTone(usage())).to.equal('ok')
  })

  it('returns "warn" when at or above the warning threshold', () => {
    expect(getBillingTone(usage({percentUsed: 90, remaining: 10_000, used: 90_000}))).to.equal('warn')
  })

  it('returns "danger" when remaining hits zero', () => {
    expect(getBillingTone(usage({percentUsed: 100, remaining: 0, used: 100_000}))).to.equal('danger')
  })

  it('returns "danger" when the billing service flags the limit as exceeded', () => {
    expect(getBillingTone(usage({limitExceeded: true, remaining: 5}))).to.equal('danger')
  })
})
