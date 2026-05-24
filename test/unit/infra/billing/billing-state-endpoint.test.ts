import {expect} from 'chai'
import {createSandbox, type SinonSandbox} from 'sinon'

import type {IBillingConfigStore} from '../../../../src/server/core/interfaces/storage/i-billing-config-store.js'

import {createBillingStateHandler} from '../../../../src/server/infra/billing/billing-state-endpoint.js'

describe('createBillingStateHandler', () => {
  let sandbox: SinonSandbox
  let getPinnedStub: ReturnType<SinonSandbox['stub']>
  let store: IBillingConfigStore
  let factory: ReturnType<SinonSandbox['stub']>

  beforeEach(() => {
    sandbox = createSandbox()
    getPinnedStub = sandbox.stub()
    store = {
      getPinnedTeamId: getPinnedStub as IBillingConfigStore['getPinnedTeamId'],
      setPinnedTeamId: sandbox.stub().resolves() as IBillingConfigStore['setPinnedTeamId'],
    }
    factory = sandbox.stub().returns(store)
  })

  afterEach(() => {
    sandbox.restore()
  })

  it('constructs a per-project store and returns the pinned id when set', async () => {
    getPinnedStub.resolves('org-pinned')
    const handler = createBillingStateHandler(factory as unknown as (projectPath: string) => IBillingConfigStore)

    const result = await handler({projectPath: '/proj-A'})

    expect(factory.calledOnceWith('/proj-A')).to.equal(true)
    expect(result).to.deep.equal({pinnedTeamId: 'org-pinned'})
  })

  it('returns an empty envelope when the per-project store has no pin', async () => {
    getPinnedStub.resolves()
    const handler = createBillingStateHandler(factory as unknown as (projectPath: string) => IBillingConfigStore)

    const result = await handler({projectPath: '/proj-B'})

    expect(factory.calledOnceWith('/proj-B')).to.equal(true)
    expect(result).to.deep.equal({})
  })
})
