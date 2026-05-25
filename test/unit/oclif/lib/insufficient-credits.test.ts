import type {ITransportClient} from '@campfirein/brv-transport-client'

import {expect} from 'chai'
import sinon, {restore, stub} from 'sinon'

import type {StatusBillingDTO} from '../../../../src/shared/transport/types/dto.js'

import {
  ensureBillingFunds,
  InsufficientCreditsError,
  isBillingExhausted,
} from '../../../../src/oclif/lib/insufficient-credits.js'
import {BillingEvents} from '../../../../src/shared/transport/events/billing-events.js'

const exhaustedPin: StatusBillingDTO = {
  organizationId: 'org-acme',
  organizationName: 'Acme Corp',
  remaining: 0,
  source: 'paid',
  tier: 'PRO',
  total: 100_000,
}

const fineCredits: StatusBillingDTO = {
  ...exhaustedPin,
  remaining: 50_000,
}

describe('insufficient-credits helpers', () => {
  describe('isBillingExhausted', () => {
    it('returns false for the other-provider source', () => {
      expect(isBillingExhausted({source: 'other-provider'})).to.be.false
    })

    it('returns false for paid sources missing remaining', () => {
      expect(isBillingExhausted({organizationId: 'org-stale', source: 'paid'})).to.be.false
    })

    it('returns false when credits remain', () => {
      expect(isBillingExhausted(fineCredits)).to.be.false
    })

    it('returns true when remaining is 0 on a paid source', () => {
      expect(isBillingExhausted(exhaustedPin)).to.be.true
    })

    it('returns true when remaining is 0 on free fallback', () => {
      expect(isBillingExhausted({remaining: 0, source: 'free', total: 1000})).to.be.true
    })
  })

  describe('ensureBillingFunds', () => {
    let mockClient: sinon.SinonStubbedInstance<ITransportClient>

    beforeEach(() => {
      mockClient = {
        requestWithAck: stub().resolves({}),
      } as unknown as sinon.SinonStubbedInstance<ITransportClient>
    })

    afterEach(() => {
      restore()
    })

    it('returns immediately when credits are healthy', async () => {
      await ensureBillingFunds({billing: fineCredits, client: mockClient as unknown as ITransportClient})
      expect(mockClient.requestWithAck.called).to.be.false
    })

    it('throws a free-tier message when free credits are exhausted', async () => {
      let thrown: unknown
      try {
        await ensureBillingFunds({
          billing: {remaining: 0, source: 'free', total: 1000},
          client: mockClient as unknown as ITransportClient,
        })
      } catch (error) {
        thrown = error
      }

      expect(thrown).to.be.instanceOf(InsufficientCreditsError)
      const msg = (thrown as InsufficientCreditsError).message
      expect(msg.toLowerCase()).to.include('free monthly credits')
      expect(msg).to.not.include('--team')
    })

    it('throws a team-flavored message listing other paid teams (excluding the exhausted one)', async () => {
      ;(mockClient.requestWithAck as sinon.SinonStub).withArgs(BillingEvents.LIST_USAGE).resolves({
        usage: {
          'org-acme': {organizationId: 'org-acme', organizationName: 'Acme Corp', remaining: 0, tier: 'PRO'},
          'org-beta': {organizationId: 'org-beta', organizationName: 'Beta Labs', remaining: 50_000, tier: 'TEAM'},
          'org-personal': {organizationId: 'org-personal', organizationName: 'Personal', remaining: 100, tier: 'FREE'},
        },
      })

      let thrown: unknown
      try {
        await ensureBillingFunds({billing: exhaustedPin, client: mockClient as unknown as ITransportClient})
      } catch (error) {
        thrown = error
      }

      expect(thrown).to.be.instanceOf(InsufficientCreditsError)
      const msg = (thrown as InsufficientCreditsError).message
      expect(msg).to.include('out of credits')
      expect(msg).to.include('--team')
      expect(msg).to.include('Beta Labs')
      expect(msg).to.not.include('Acme Corp')
      expect(msg).to.not.include('Personal')
    })

    it('omits the available-teams suffix when the team fetch fails', async () => {
      ;(mockClient.requestWithAck as sinon.SinonStub).withArgs(BillingEvents.LIST_USAGE).rejects(new Error('offline'))

      let thrown: unknown
      try {
        await ensureBillingFunds({billing: exhaustedPin, client: mockClient as unknown as ITransportClient})
      } catch (error) {
        thrown = error
      }

      expect(thrown).to.be.instanceOf(InsufficientCreditsError)
      const msg = (thrown as InsufficientCreditsError).message
      expect(msg).to.include('out of credits')
      expect(msg).to.not.include('Available teams:')
    })
  })
})
