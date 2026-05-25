import {expect} from 'chai'
import nock from 'nock'
import * as sinon from 'sinon'

import {HttpBillingService} from '../../../../src/server/infra/billing/http-billing-service.js'
import {ProxyConfig} from '../../../../src/server/infra/http/proxy-config.js'

describe('HttpBillingService', () => {
  const apiBaseUrl = 'https://api.example.com/api/v1'
  const sessionKey = 'test-session-key'
  let service: HttpBillingService

  beforeEach(() => {
    sinon.stub(ProxyConfig, 'getProxyAgent').returns(undefined as never)
    service = new HttpBillingService({apiBaseUrl})
  })

  afterEach(() => {
    sinon.restore()
    nock.cleanAll()
  })

  describe('getUsages', () => {
    const usagesResponse = {
      organizations: [
        {
          addOnRemaining: 0,
          limit: 3000,
          limitExceeded: false,
          organizationId: 'org-1',
          organizationName: 'wzl',
          organizationStatus: 'ACTIVE',
          percentUsed: 0.13,
          remaining: 2996,
          totalLimit: 3000,
          used: 4,
        },
        {
          addOnRemaining: 0,
          limit: 0,
          limitExceeded: true,
          organizationId: 'org-2',
          organizationName: 'kkkjh',
          organizationStatus: 'ACTIVE',
          percentUsed: 0,
          remaining: 0,
          totalLimit: 0,
          used: 0,
        },
      ],
    }

    it('joins tier info with usage from the bulk endpoint', async () => {
      nock(apiBaseUrl)
        .get('/billing/usages')
        .matchHeader('x-byterover-session-id', sessionKey)
        .reply(200, usagesResponse)
      nock(apiBaseUrl)
        .get('/billing/organizations/tiers')
        .matchHeader('x-byterover-session-id', sessionKey)
        .reply(200, {
          organizations: [
            {isTrialing: false, organizationId: 'org-1', tier: 'PRO'},
            {isTrialing: true, organizationId: 'org-2', tier: 'TEAM'},
          ],
        })

      const result = await service.getUsages(sessionKey)

      expect(result).to.have.lengthOf(2)
      expect(result[0]).to.include({isTrialing: false, organizationId: 'org-1', tier: 'PRO'})
      expect(result[1]).to.include({isTrialing: true, organizationId: 'org-2', tier: 'TEAM'})
    })

    it('defaults missing tier entries to FREE', async () => {
      nock(apiBaseUrl).get('/billing/usages').reply(200, usagesResponse)
      nock(apiBaseUrl)
        .get('/billing/organizations/tiers')
        .reply(200, {organizations: [{isTrialing: false, organizationId: 'org-1', tier: 'PRO'}]})

      const result = await service.getUsages(sessionKey)

      expect(result[1]).to.include({isTrialing: false, organizationId: 'org-2', tier: 'FREE'})
    })

    it('wraps non-200 responses in a descriptive error', async () => {
      nock(apiBaseUrl)
        .get('/billing/usages')
        .matchHeader('x-byterover-session-id', sessionKey)
        .reply(500, {message: 'Billing service unavailable'})
      nock(apiBaseUrl).get('/billing/organizations/tiers').reply(200, {organizations: []})

      try {
        await service.getUsages(sessionKey)
        expect.fail('expected getUsages to throw')
      } catch (error) {
        expect(error).to.be.instanceOf(Error)
        expect((error as Error).message).to.match(/Failed to fetch billing usages/)
      }
    })
  })

  describe('getTiers', () => {
    it('returns the organizations tier list', async () => {
      nock(apiBaseUrl)
        .get('/billing/organizations/tiers')
        .matchHeader('x-byterover-session-id', sessionKey)
        .reply(200, {
          organizations: [
            {isTrialing: false, organizationId: 'org-1', tier: 'PRO'},
            {isTrialing: true, organizationId: 'org-2', tier: 'TEAM'},
          ],
        })

      const result = await service.getTiers(sessionKey)

      expect(result).to.deep.equal([
        {isTrialing: false, organizationId: 'org-1', tier: 'PRO'},
        {isTrialing: true, organizationId: 'org-2', tier: 'TEAM'},
      ])
    })

    it('wraps non-200 responses in a descriptive error', async () => {
      nock(apiBaseUrl)
        .get('/billing/organizations/tiers')
        .matchHeader('x-byterover-session-id', sessionKey)
        .reply(500, {message: 'tiers down'})

      try {
        await service.getTiers(sessionKey)
        expect.fail('expected getTiers to throw')
      } catch (error) {
        expect(error).to.be.instanceOf(Error)
        expect((error as Error).message).to.match(/Failed to fetch billing tiers/)
      }
    })
  })

  describe('getFreeUserLimit', () => {
    it('returns the free-user limit payload', async () => {
      const mockResponse = {
        daily: {limit: 0, limitExceeded: true, percentUsed: 0, remaining: 0, used: 0},
        limitExceeded: true,
        monthly: {limit: 0, limitExceeded: true, percentUsed: 0, remaining: 0, used: 0},
      }

      nock(apiBaseUrl)
        .get('/billing/usage/free-user/limit')
        .matchHeader('x-byterover-session-id', sessionKey)
        .reply(200, mockResponse)

      const result = await service.getFreeUserLimit(sessionKey)

      expect(result.limitExceeded).to.equal(true)
      expect(result.daily.remaining).to.equal(0)
      expect(result.monthly.limitExceeded).to.equal(true)
    })

    it('wraps non-200 responses in a descriptive error', async () => {
      nock(apiBaseUrl)
        .get('/billing/usage/free-user/limit')
        .matchHeader('x-byterover-session-id', sessionKey)
        .reply(500, {message: 'Billing service unavailable'})

      try {
        await service.getFreeUserLimit(sessionKey)
        expect.fail('expected getFreeUserLimit to throw')
      } catch (error) {
        expect(error).to.be.instanceOf(Error)
        expect((error as Error).message).to.match(/Failed to fetch free-user limit/)
      }
    })
  })
})
