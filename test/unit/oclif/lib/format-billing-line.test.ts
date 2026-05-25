import {expect} from 'chai'

import {formatBillingLine} from '../../../../src/oclif/lib/format-billing-line.js'

describe('formatBillingLine', () => {
  it('renders the other-provider state with just the active provider id', () => {
    expect(formatBillingLine({activeProvider: 'openai', source: 'other-provider'})).to.equal('Using openai')
  })

  it('falls back to a placeholder when activeProvider is missing on other-provider', () => {
    expect(formatBillingLine({source: 'other-provider'})).to.equal('Using another provider')
  })

  it('renders a paid team with credits and tier', () => {
    expect(
      formatBillingLine({
        organizationId: 'org-acme',
        organizationName: 'Acme Corp',
        remaining: 12_400,
        source: 'paid',
        tier: 'PRO',
        total: 100_000,
      }),
    ).to.equal('Billing: Acme Corp (12,400 credits, PRO)')
  })

  it('renders free credits with monthly remaining/total', () => {
    expect(
      formatBillingLine({
        remaining: 950,
        source: 'free',
        total: 1000,
      }),
    ).to.equal('Billing: Personal free credits (950 / 1,000)')
  })

  it('renders a sparse paid source when usage data is missing (stale pin)', () => {
    expect(
      formatBillingLine({
        organizationId: 'org-stale',
        source: 'paid',
      }),
    ).to.equal('Billing: org-stale (usage unavailable)')
  })

  it('renders free credits with placeholder when free limit data is missing', () => {
    expect(formatBillingLine({source: 'free'})).to.equal('Billing: Personal free credits')
  })
})
