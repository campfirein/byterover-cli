import {expect} from 'chai'
import {createSandbox, type SinonSandbox} from 'sinon'

import type {IProviderConfigStore} from '../../../../src/server/core/interfaces/i-provider-config-store.js'
import type {IBillingService} from '../../../../src/server/core/interfaces/services/i-billing-service.js'
import type {IBillingConfigStore} from '../../../../src/server/core/interfaces/storage/i-billing-config-store.js'

import {resolveBillingForProject} from '../../../../src/server/infra/billing/resolve-billing-source.js'
import {createMockAuthStateStore} from '../../../helpers/mock-factories.js'

const PROJECT = '/proj-A'

interface Stubs {
  billingConfigStore: IBillingConfigStore
  billingService: IBillingService
  getActiveProviderStub: ReturnType<SinonSandbox['stub']>
  getFreeUserLimitStub: ReturnType<SinonSandbox['stub']>
  getPinnedStub: ReturnType<SinonSandbox['stub']>
  getUsagesStub: ReturnType<SinonSandbox['stub']>
  providerConfigStore: IProviderConfigStore
}

function makeStubs(sandbox: SinonSandbox): Stubs {
  const getActiveProviderStub = sandbox.stub().resolves('byterover')
  const getFreeUserLimitStub = sandbox.stub()
  const getPinnedStub = sandbox.stub().resolves()
  const getUsagesStub = sandbox.stub().resolves([])

  return {
    billingConfigStore: {
      getPinnedTeamId: getPinnedStub as IBillingConfigStore['getPinnedTeamId'],
      setPinnedTeamId: sandbox.stub().resolves() as IBillingConfigStore['setPinnedTeamId'],
    },
    billingService: {
      getFreeUserLimit: getFreeUserLimitStub as IBillingService['getFreeUserLimit'],
      getTiers: sandbox.stub().resolves([]) as unknown as IBillingService['getTiers'],
      getUsages: getUsagesStub as IBillingService['getUsages'],
    },
    getActiveProviderStub,
    getFreeUserLimitStub,
    getPinnedStub,
    getUsagesStub,
    providerConfigStore: {
      getActiveProvider: getActiveProviderStub,
    } as unknown as IProviderConfigStore,
  }
}

describe('resolveBillingForProject', () => {
  let sandbox: SinonSandbox

  beforeEach(() => {
    sandbox = createSandbox()
  })

  afterEach(() => {
    sandbox.restore()
  })

  it('returns undefined when no token is loaded', async () => {
    const stubs = makeStubs(sandbox)

    const result = await resolveBillingForProject({
      authStateStore: createMockAuthStateStore(sandbox, {isAuthenticated: false}),
      billingConfigStoreFactory: () => stubs.billingConfigStore,
      billingService: stubs.billingService,
      projectPath: PROJECT,
      providerConfigStore: stubs.providerConfigStore,
    })

    expect(result).to.equal(undefined)
    expect(stubs.getUsagesStub.called).to.be.false
  })

  it('returns other-provider when active provider is not byterover', async () => {
    const stubs = makeStubs(sandbox)
    stubs.getActiveProviderStub.resolves('openai')

    const result = await resolveBillingForProject({
      authStateStore: createMockAuthStateStore(sandbox),
      billingConfigStoreFactory: () => stubs.billingConfigStore,
      billingService: stubs.billingService,
      projectPath: PROJECT,
      providerConfigStore: stubs.providerConfigStore,
    })

    expect(result).to.deep.equal({activeProvider: 'openai', source: 'other-provider'})
    expect(stubs.getUsagesStub.called).to.be.false
  })

  it('returns the paid source when an authed user has a pin matching a paid usage', async () => {
    const stubs = makeStubs(sandbox)
    stubs.getPinnedStub.resolves('org-acme')
    stubs.getUsagesStub.resolves([
      {
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
      },
    ])

    const result = await resolveBillingForProject({
      authStateStore: createMockAuthStateStore(sandbox),
      billingConfigStoreFactory: () => stubs.billingConfigStore,
      billingService: stubs.billingService,
      projectPath: PROJECT,
      providerConfigStore: stubs.providerConfigStore,
    })

    expect(result).to.deep.include({
      organizationId: 'org-acme',
      organizationName: 'Acme Corp',
      remaining: 87_600,
      source: 'paid',
      tier: 'PRO',
      total: 100_000,
    })
  })

  it('falls back to free monthly window when no paid orgs exist', async () => {
    const stubs = makeStubs(sandbox)
    stubs.getUsagesStub.resolves([])
    stubs.getFreeUserLimitStub.resolves({
      daily: {limit: 50, limitExceeded: false, percentUsed: 20, remaining: 40, used: 10},
      limitExceeded: false,
      monthly: {limit: 1000, limitExceeded: false, percentUsed: 5, remaining: 950, used: 50},
    })

    const result = await resolveBillingForProject({
      authStateStore: createMockAuthStateStore(sandbox),
      billingConfigStoreFactory: () => stubs.billingConfigStore,
      billingService: stubs.billingService,
      projectPath: PROJECT,
      providerConfigStore: stubs.providerConfigStore,
    })

    expect(result).to.deep.equal({remaining: 950, source: 'free', total: 1000})
  })

  it('returns undefined when billing service throws', async () => {
    const stubs = makeStubs(sandbox)
    stubs.getUsagesStub.rejects(new Error('upstream offline'))

    const result = await resolveBillingForProject({
      authStateStore: createMockAuthStateStore(sandbox),
      billingConfigStoreFactory: () => stubs.billingConfigStore,
      billingService: stubs.billingService,
      projectPath: PROJECT,
      providerConfigStore: stubs.providerConfigStore,
    })

    expect(result).to.equal(undefined)
  })
})
