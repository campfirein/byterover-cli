import {expect} from 'chai'
import {createSandbox, type SinonSandbox} from 'sinon'

import type {IProviderConfigStore} from '../../../../../src/server/core/interfaces/i-provider-config-store.js'
import type {IBillingService} from '../../../../../src/server/core/interfaces/services/i-billing-service.js'
import type {IBillingConfigStore} from '../../../../../src/server/core/interfaces/storage/i-billing-config-store.js'
import type {BillingFreeUserLimitDTO, BillingUsageDTO} from '../../../../../src/shared/transport/types/dto.js'

import {TransportDaemonEventNames} from '../../../../../src/server/core/domain/transport/schemas.js'
import {BillingHandler} from '../../../../../src/server/infra/transport/handlers/billing-handler.js'
import {BillingEvents} from '../../../../../src/shared/transport/events/billing-events.js'
import {createMockAuthStateStore, createMockTransportServer} from '../../../../helpers/mock-factories.js'

const PROJECT_A = '/proj-A'

const usageFixture = (overrides: Partial<BillingUsageDTO> = {}): BillingUsageDTO => ({
  addOnRemaining: 0,
  isTrialing: false,
  limit: 100_000,
  limitExceeded: false,
  organizationId: 'org-123',
  organizationName: 'Acme Corp',
  organizationStatus: 'ACTIVE',
  percentUsed: 12.4,
  remaining: 87_600,
  tier: 'PRO',
  totalLimit: 100_000,
  used: 12_400,
  ...overrides,
})

const freeUserLimitFixture: BillingFreeUserLimitDTO = {
  daily: {limit: 50, limitExceeded: false, percentUsed: 20, remaining: 40, used: 10},
  limitExceeded: false,
  monthly: {limit: 1000, limitExceeded: false, percentUsed: 5, remaining: 950, used: 50},
}

describe('BillingHandler', () => {
  let sandbox: SinonSandbox
  let transport: ReturnType<typeof createMockTransportServer>
  let billingService: IBillingService
  let billingConfigStore: IBillingConfigStore
  let getUsagesStub: ReturnType<SinonSandbox['stub']>
  let getFreeUserLimitStub: ReturnType<SinonSandbox['stub']>
  let getPinnedStub: ReturnType<SinonSandbox['stub']>
  let setPinnedStub: ReturnType<SinonSandbox['stub']>
  let storeFactoryStub: ReturnType<SinonSandbox['stub']>
  let resolveProjectPathStub: ReturnType<SinonSandbox['stub']>

  beforeEach(() => {
    sandbox = createSandbox()
    transport = createMockTransportServer()
    getUsagesStub = sandbox.stub()
    getFreeUserLimitStub = sandbox.stub()
    getPinnedStub = sandbox.stub().resolves()
    setPinnedStub = sandbox.stub().resolves()
    billingService = {
      getFreeUserLimit: getFreeUserLimitStub as IBillingService['getFreeUserLimit'],
      getTiers: sandbox.stub().resolves([]) as unknown as IBillingService['getTiers'],
      getUsages: getUsagesStub as IBillingService['getUsages'],
    }
    billingConfigStore = {
      getPinnedTeamId: getPinnedStub as IBillingConfigStore['getPinnedTeamId'],
      setPinnedTeamId: setPinnedStub as IBillingConfigStore['setPinnedTeamId'],
    }
    storeFactoryStub = sandbox.stub().returns(billingConfigStore)
    resolveProjectPathStub = sandbox.stub().returns(PROJECT_A)
  })

  afterEach(() => {
    sandbox.restore()
  })

  function createHandler(options?: {isAuthenticated?: boolean}): BillingHandler {
    const providerConfigStore = {
      getActiveProvider: sandbox.stub().resolves(''),
    } as unknown as IProviderConfigStore

    const handler = new BillingHandler({
      authStateStore: createMockAuthStateStore(sandbox, options),
      billingConfigStoreFactory: storeFactoryStub as unknown as (projectPath: string) => IBillingConfigStore,
      billingService,
      providerConfigStore,
      resolveProjectPath: resolveProjectPathStub as unknown as (clientId: string) => string | undefined,
      transport,
    })
    handler.setup()
    return handler
  }

  describe('billing:getUsage', () => {
    it('registers the handler on setup', () => {
      createHandler()
      expect(transport._handlers.has(BillingEvents.GET_USAGE)).to.equal(true)
    })

    it('returns the matching org from the bulk fetch when authenticated', async () => {
      const orgA = usageFixture({organizationId: 'org-a'})
      const orgB = usageFixture({organizationId: 'org-b'})
      getUsagesStub.resolves([orgA, orgB])
      createHandler()

      const handler = transport._handlers.get(BillingEvents.GET_USAGE)
      const result = await handler!({organizationId: 'org-b'}, 'client-1')

      expect(getUsagesStub.calledOnceWith('session')).to.equal(true)
      expect(result).to.deep.equal({usage: orgB})
    })

    it('returns an error envelope when the requested org is not in the response', async () => {
      getUsagesStub.resolves([usageFixture({organizationId: 'org-a'})])
      createHandler()

      const handler = transport._handlers.get(BillingEvents.GET_USAGE)
      const result = await handler!({organizationId: 'org-missing'}, 'client-1')

      expect(result).to.have.property('error').that.matches(/org-missing/)
      expect(result).to.not.have.property('usage')
    })

    it('returns an error response when the user is not authenticated', async () => {
      createHandler({isAuthenticated: false})

      const handler = transport._handlers.get(BillingEvents.GET_USAGE)
      const result = await handler!({organizationId: 'org-123'}, 'client-1')

      expect(getUsagesStub.called).to.equal(false)
      expect(result).to.have.property('error').that.matches(/sign in|authent/i)
      expect(result).to.not.have.property('usage')
    })

    it('returns an error response when the billing service throws', async () => {
      getUsagesStub.rejects(new Error('boom'))
      createHandler()

      const handler = transport._handlers.get(BillingEvents.GET_USAGE)
      const result = await handler!({organizationId: 'org-123'}, 'client-1')

      expect(result).to.have.property('error').that.equals('boom')
      expect(result).to.not.have.property('usage')
    })
  })

  describe('billing:listUsage', () => {
    it('registers the handler on setup', () => {
      createHandler()
      expect(transport._handlers.has(BillingEvents.LIST_USAGE)).to.equal(true)
    })

    it('returns a usage map keyed by organization id when authenticated', async () => {
      const orgA = usageFixture({organizationId: 'org-a'})
      const orgB = usageFixture({organizationId: 'org-b'})
      getUsagesStub.resolves([orgA, orgB])
      createHandler()

      const handler = transport._handlers.get(BillingEvents.LIST_USAGE)
      const result = await handler!(undefined, 'client-1')

      expect(getUsagesStub.calledOnceWith('session')).to.equal(true)
      expect(result).to.deep.equal({usage: {'org-a': orgA, 'org-b': orgB}})
    })

    it('returns an empty map when the user has no organizations', async () => {
      getUsagesStub.resolves([])
      createHandler()

      const handler = transport._handlers.get(BillingEvents.LIST_USAGE)
      const result = await handler!(undefined, 'client-1')

      expect(result).to.deep.equal({usage: {}})
    })

    it('returns an error envelope when the user is not authenticated', async () => {
      createHandler({isAuthenticated: false})

      const handler = transport._handlers.get(BillingEvents.LIST_USAGE)
      const result = await handler!(undefined, 'client-1')

      expect(getUsagesStub.called).to.equal(false)
      expect(result).to.have.property('error').that.matches(/sign in|authent/i)
      expect(result).to.not.have.property('usage')
    })

    it('returns an error envelope when the billing service throws', async () => {
      getUsagesStub.rejects(new Error('upstream down'))
      createHandler()

      const handler = transport._handlers.get(BillingEvents.LIST_USAGE)
      const result = await handler!(undefined, 'client-1')

      expect(result).to.deep.equal({error: 'upstream down'})
    })
  })

  describe('billing:getFreeUserLimit', () => {
    it('registers the handler on setup', () => {
      createHandler()
      expect(transport._handlers.has(BillingEvents.GET_FREE_USER_LIMIT)).to.equal(true)
    })

    it('returns the free-user limit when authenticated', async () => {
      getFreeUserLimitStub.resolves(freeUserLimitFixture)
      createHandler()

      const handler = transport._handlers.get(BillingEvents.GET_FREE_USER_LIMIT)
      const result = await handler!(undefined, 'client-1')

      expect(getFreeUserLimitStub.calledOnceWith('session')).to.equal(true)
      expect(result).to.deep.equal({limit: freeUserLimitFixture})
    })

    it('returns an error envelope when not authenticated', async () => {
      createHandler({isAuthenticated: false})

      const handler = transport._handlers.get(BillingEvents.GET_FREE_USER_LIMIT)
      const result = await handler!(undefined, 'client-1')

      expect(getFreeUserLimitStub.called).to.equal(false)
      expect(result).to.have.property('error').that.matches(/sign in|authent/i)
    })

    it('returns an error envelope when the service throws', async () => {
      getFreeUserLimitStub.rejects(new Error('quota service offline'))
      createHandler()

      const handler = transport._handlers.get(BillingEvents.GET_FREE_USER_LIMIT)
      const result = await handler!(undefined, 'client-1')

      expect(result).to.deep.equal({error: 'quota service offline'})
    })
  })

  describe('billing:getPinnedTeam', () => {
    it('registers the handler on setup', () => {
      createHandler()
      expect(transport._handlers.has(BillingEvents.GET_PINNED_TEAM)).to.equal(true)
    })

    it('uses the projectPath from the request and returns the persisted team id', async () => {
      getPinnedStub.resolves('org-pinned')
      createHandler()

      const handler = transport._handlers.get(BillingEvents.GET_PINNED_TEAM)
      const result = await handler!({projectPath: PROJECT_A}, 'client-1')

      expect(storeFactoryStub.calledOnceWith(PROJECT_A)).to.equal(true)
      expect(result).to.deep.equal({teamId: 'org-pinned'})
    })

    it('returns an empty envelope when no pin is set', async () => {
      getPinnedStub.resolves()
      createHandler()

      const handler = transport._handlers.get(BillingEvents.GET_PINNED_TEAM)
      const result = await handler!({projectPath: PROJECT_A}, 'client-1')

      expect(result).to.deep.equal({})
    })

    it('returns an error envelope when the store throws', async () => {
      getPinnedStub.rejects(new Error('disk read error'))
      createHandler()

      const handler = transport._handlers.get(BillingEvents.GET_PINNED_TEAM)
      const result = await handler!({projectPath: PROJECT_A}, 'client-1')

      expect(result).to.deep.equal({error: 'disk read error'})
    })

    it('returns an error envelope when projectPath is empty', async () => {
      createHandler()

      const handler = transport._handlers.get(BillingEvents.GET_PINNED_TEAM)
      const result = await handler!({projectPath: ''}, 'client-1')

      expect(storeFactoryStub.called).to.equal(false)
      expect(getPinnedStub.called).to.equal(false)
      expect(result).to.have.property('error').that.matches(/projectPath/i)
    })
  })

  describe('billing:setPinnedTeam', () => {
    it('registers the handler on setup', () => {
      createHandler()
      expect(transport._handlers.has(BillingEvents.SET_PINNED_TEAM)).to.equal(true)
    })

    it('writes the new pin to the requested project store and returns success', async () => {
      createHandler()

      const handler = transport._handlers.get(BillingEvents.SET_PINNED_TEAM)
      const result = await handler!({projectPath: PROJECT_A, teamId: 'org-new'}, 'client-1')

      expect(storeFactoryStub.calledOnceWith(PROJECT_A)).to.equal(true)
      expect(setPinnedStub.calledOnceWith('org-new')).to.equal(true)
      expect(result).to.deep.equal({success: true})
    })

    it('clears the pin when teamId is omitted', async () => {
      createHandler()

      const handler = transport._handlers.get(BillingEvents.SET_PINNED_TEAM)
      const result = await handler!({projectPath: PROJECT_A}, 'client-1')

      expect(setPinnedStub.calledOnceWith()).to.equal(true)
      expect(result).to.deep.equal({success: true})
    })

    it('returns an error envelope when the store throws', async () => {
      setPinnedStub.rejects(new Error('disk full'))
      createHandler()

      const handler = transport._handlers.get(BillingEvents.SET_PINNED_TEAM)
      const result = await handler!({projectPath: PROJECT_A, teamId: 'org-new'}, 'client-1')

      expect(result).to.deep.equal({error: 'disk full', success: false})
    })

    it('broadcasts the new pin with projectPath on success', async () => {
      createHandler()

      const handler = transport._handlers.get(BillingEvents.SET_PINNED_TEAM)
      await handler!({projectPath: PROJECT_A, teamId: 'org-new'}, 'client-1')

      expect(
        transport.broadcast.calledOnceWith(TransportDaemonEventNames.BILLING_PIN_CHANGED, {
          projectPath: PROJECT_A,
          teamId: 'org-new',
        }),
      ).to.equal(true)
    })

    it('broadcasts a clear payload (still scoped by projectPath)', async () => {
      createHandler()

      const handler = transport._handlers.get(BillingEvents.SET_PINNED_TEAM)
      await handler!({projectPath: PROJECT_A}, 'client-1')

      expect(
        transport.broadcast.calledOnceWith(TransportDaemonEventNames.BILLING_PIN_CHANGED, {
          projectPath: PROJECT_A,
        }),
      ).to.equal(true)
    })

    it('does not broadcast when the store throws', async () => {
      setPinnedStub.rejects(new Error('disk full'))
      createHandler()

      const handler = transport._handlers.get(BillingEvents.SET_PINNED_TEAM)
      await handler!({projectPath: PROJECT_A, teamId: 'org-new'}, 'client-1')

      expect(transport.broadcast.called).to.equal(false)
    })

    it('returns an error envelope when projectPath is empty', async () => {
      createHandler()

      const handler = transport._handlers.get(BillingEvents.SET_PINNED_TEAM)
      const result = await handler!({projectPath: '', teamId: 'org-new'}, 'client-1')

      expect(storeFactoryStub.called).to.equal(false)
      expect(setPinnedStub.called).to.equal(false)
      expect(transport.broadcast.called).to.equal(false)
      expect(result).to.have.property('error').that.matches(/projectPath/i)
      expect(result).to.have.property('success', false)
    })
  })

  describe('billing:resolve', () => {
    it('registers the handler on setup', () => {
      createHandler()
      expect(transport._handlers.has(BillingEvents.RESOLVE)).to.equal(true)
    })

    it('returns a billing DTO when the chain resolves', async () => {
      getUsagesStub.resolves([
        usageFixture({organizationId: 'org-acme', organizationName: 'Acme Corp', remaining: 87_600, tier: 'PRO'}),
      ])
      getPinnedStub.resolves('org-acme')
      createHandler()

      const handler = transport._handlers.get(BillingEvents.RESOLVE)
      const result = await handler!(undefined, 'client-1')

      expect(result.billing).to.be.an('object')
      expect(result.error).to.equal(undefined)
    })

    it('returns undefined billing with an error when no project context is available', async () => {
      resolveProjectPathStub.returns()
      createHandler()

      const handler = transport._handlers.get(BillingEvents.RESOLVE)
      const result = await handler!(undefined, 'client-1')

      expect(result.billing).to.equal(undefined)
      expect(result.error).to.match(/project/i)
    })
  })

})
