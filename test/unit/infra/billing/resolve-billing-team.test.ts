import {expect} from 'chai'

import {resolveBillingTeamId} from '../../../../src/server/infra/billing/resolve-billing-team.js'

/**
 * `resolveBillingTeamId` predicts which team the BILLING SERVER will charge for the
 * next request given the daemon-side state. It does NOT apply workspace fallback —
 * workspace handling is a client-side pre-selection concern only. The daemon sends
 * the pin (or nothing); the server applies its own rules.
 */
describe('resolveBillingTeamId', () => {
  describe('pinned team', () => {
    it('returns the pinned team when set', () => {
      expect(
        resolveBillingTeamId({
          paidOrganizationIds: ['org-A', 'org-B'],
          pinnedTeamId: 'org-pin',
        }),
      ).to.equal('org-pin')
    })

    it('returns the pin even when it is not in the user\'s paid orgs (BE rejects later)', () => {
      expect(
        resolveBillingTeamId({
          paidOrganizationIds: ['org-A'],
          pinnedTeamId: 'org-stale',
        }),
      ).to.equal('org-stale')
    })
  })

  describe('server auto-pick: single paid team', () => {
    it('returns the single paid org when no pin is set', () => {
      expect(
        resolveBillingTeamId({
          paidOrganizationIds: ['org-only'],
          pinnedTeamId: undefined,
        }),
      ).to.equal('org-only')
    })
  })

  describe('free fallback', () => {
    it('returns undefined when no pin and multiple paid orgs (server charges free credits)', () => {
      expect(
        resolveBillingTeamId({
          paidOrganizationIds: ['org-A', 'org-B'],
          pinnedTeamId: undefined,
        }),
      ).to.equal(undefined)
    })

    it('returns undefined when the user has no paid orgs', () => {
      expect(
        resolveBillingTeamId({
          paidOrganizationIds: [],
          pinnedTeamId: undefined,
        }),
      ).to.equal(undefined)
    })
  })
})
