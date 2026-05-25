import type {ITransportClient} from '@campfirein/brv-transport-client'

import {expect} from 'chai'
import sinon, {restore, stub} from 'sinon'

import type {SettingsListResponse} from '../../../../src/shared/transport/events/settings-events.js'

import {
  getAgentSettingValue,
  loadAgentSettingsSnapshot,
  resetAgentSettingsSnapshotForTests,
} from '../../../../src/agent/infra/settings/agent-settings-snapshot.js'
import {SettingsEvents} from '../../../../src/shared/transport/events/settings-events.js'

function makeClient(response: Error | SettingsListResponse): {
  client: ITransportClient
  requestStub: sinon.SinonStub
} {
  const requestStub = stub()
  if (response instanceof Error) {
    requestStub.rejects(response)
  } else {
    requestStub.resolves(response)
  }

  const client = {requestWithAck: requestStub} as unknown as ITransportClient
  return {client, requestStub}
}

describe('agent-settings-snapshot', () => {
  beforeEach(() => {
    resetAgentSettingsSnapshotForTests()
  })

  afterEach(() => {
    resetAgentSettingsSnapshotForTests()
    restore()
  })

  it('returns undefined for any key when the snapshot has not been loaded', () => {
    expect(getAgentSettingValue('agentPool.maxSize')).to.be.undefined
    expect(getAgentSettingValue('llm.iterationBudgetMs')).to.be.undefined
  })

  it('dispatches SettingsEvents.LIST when loadAgentSettingsSnapshot runs', async () => {
    const {client, requestStub} = makeClient({items: []})
    await loadAgentSettingsSnapshot(client)
    expect(requestStub.calledOnceWith(SettingsEvents.LIST)).to.be.true
  })

  it('caches the LIST response so subsequent getAgentSettingValue calls return the value', async () => {
    const {client} = makeClient({
      items: [
        {
          current: 25,
          default: 10,
          description: 'pool',
          key: 'agentPool.maxSize',
          max: 100,
          min: 1,
          restartRequired: true,
          type: 'integer',
        },
      ],
    })

    await loadAgentSettingsSnapshot(client)

    expect(getAgentSettingValue('agentPool.maxSize')).to.equal(25)
    expect(getAgentSettingValue('llm.iterationBudgetMs')).to.be.undefined
  })

  it('does not re-fetch on a second loadAgentSettingsSnapshot call within the same process', async () => {
    const {client, requestStub} = makeClient({items: []})

    await loadAgentSettingsSnapshot(client)
    await loadAgentSettingsSnapshot(client)

    expect(requestStub.callCount).to.equal(1)
  })

  it('leaves the cache empty when the transport request rejects', async () => {
    const {client} = makeClient(new Error('boom'))

    await loadAgentSettingsSnapshot(client)

    expect(getAgentSettingValue('agentPool.maxSize')).to.be.undefined
  })

  it('resetAgentSettingsSnapshotForTests clears every cached value', async () => {
    const {client} = makeClient({
      items: [
        {
          current: 9999,
          default: 10,
          description: 'pool',
          key: 'agentPool.maxSize',
          max: 100_000,
          min: 1,
          restartRequired: true,
          type: 'integer',
        },
      ],
    })

    await loadAgentSettingsSnapshot(client)
    expect(getAgentSettingValue('agentPool.maxSize')).to.equal(9999)

    resetAgentSettingsSnapshotForTests()
    expect(getAgentSettingValue('agentPool.maxSize')).to.be.undefined
  })
})
