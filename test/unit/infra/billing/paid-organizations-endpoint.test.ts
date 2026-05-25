import {expect} from 'chai'
import {createSandbox, type SinonSandbox} from 'sinon'

import type {IBillingService} from '../../../../src/server/core/interfaces/services/i-billing-service.js'
import type {BillingOrganizationTierDTO} from '../../../../src/shared/transport/types/dto.js'

import {createPaidOrganizationsHandler} from '../../../../src/server/infra/billing/paid-organizations-endpoint.js'
import {createMockAuthStateStore} from '../../../helpers/mock-factories.js'

const tierFixture = (overrides: Partial<BillingOrganizationTierDTO> = {}): BillingOrganizationTierDTO => ({
  isTrialing: false,
  organizationId: 'org-x',
  tier: 'FREE',
  ...overrides,
})

describe('createPaidOrganizationsHandler', () => {
  let sandbox: SinonSandbox
  let getTiersStub: ReturnType<SinonSandbox['stub']>
  let billingService: IBillingService

  beforeEach(() => {
    sandbox = createSandbox()
    getTiersStub = sandbox.stub()
    billingService = {
      getFreeUserLimit: sandbox.stub().resolves() as IBillingService['getFreeUserLimit'],
      getTiers: getTiersStub as unknown as IBillingService['getTiers'],
      getUsages: sandbox.stub().resolves([]) as IBillingService['getUsages'],
    }
  })

  afterEach(() => {
    sandbox.restore()
  })

  it('returns an empty list when the user is not authenticated', async () => {
    const handler = createPaidOrganizationsHandler({
      authStateStore: createMockAuthStateStore(sandbox, {isAuthenticated: false}),
      billingService,
    })

    const result = await handler()

    expect(getTiersStub.called).to.equal(false)
    expect(result).to.deep.equal({organizationIds: []})
  })

  it('returns only non-FREE organizations when authenticated', async () => {
    getTiersStub.resolves([
      tierFixture({organizationId: 'org-free', tier: 'FREE'}),
      tierFixture({organizationId: 'org-pro', tier: 'PRO'}),
      tierFixture({organizationId: 'org-team', tier: 'TEAM'}),
    ])
    const handler = createPaidOrganizationsHandler({
      authStateStore: createMockAuthStateStore(sandbox),
      billingService,
    })

    const result = await handler()

    expect(getTiersStub.calledOnceWith('session')).to.equal(true)
    expect(result).to.deep.equal({organizationIds: ['org-pro', 'org-team']})
  })

  it('counts trialing PRO/TEAM orgs as paid (they still have credits)', async () => {
    getTiersStub.resolves([
      tierFixture({isTrialing: true, organizationId: 'org-pro-trial', tier: 'PRO'}),
    ])
    const handler = createPaidOrganizationsHandler({
      authStateStore: createMockAuthStateStore(sandbox),
      billingService,
    })

    const result = await handler()

    expect(result).to.deep.equal({organizationIds: ['org-pro-trial']})
  })

  it('returns an empty list with an error envelope when the billing service throws', async () => {
    getTiersStub.rejects(new Error('upstream offline'))
    const handler = createPaidOrganizationsHandler({
      authStateStore: createMockAuthStateStore(sandbox),
      billingService,
    })

    const result = await handler()

    expect(result.organizationIds).to.deep.equal([])
    expect(result.error).to.equal('upstream offline')
  })

  it('returns an empty list when the user has no organizations', async () => {
    getTiersStub.resolves([])
    const handler = createPaidOrganizationsHandler({
      authStateStore: createMockAuthStateStore(sandbox),
      billingService,
    })

    const result = await handler()

    expect(result).to.deep.equal({organizationIds: []})
  })
})
