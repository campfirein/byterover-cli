import {expect} from 'chai'
import {createSandbox, type SinonSandbox, type SinonStub} from 'sinon'

import type {BrvApiClient} from '../../../../../../src/webui/lib/api-client.js'

import {SettingsEvents} from '../../../../../../src/shared/transport/events/settings-events.js'
import {listSettings} from '../../../../../../src/webui/features/settings/api/list-settings.js'
import {useTransportStore} from '../../../../../../src/webui/stores/transport-store.js'

describe('listSettings', () => {
  let sandbox: SinonSandbox
  let request: SinonStub

  beforeEach(() => {
    sandbox = createSandbox()
    request = sandbox.stub()
    useTransportStore.setState({
      apiClient: {on: sandbox.stub(), request} as unknown as BrvApiClient,
    })
  })

  afterEach(() => {
    sandbox.restore()
    useTransportStore.setState({apiClient: null})
  })

  it('emits settings:list with no payload', async () => {
    request.resolves({items: []})
    await listSettings()
    expect(request.firstCall.args[0]).to.equal(SettingsEvents.LIST)
  })

  it('resolves with the daemon response on success', async () => {
    const items = [
      {
        category: 'concurrency',
        current: 10,
        default: 10,
        description: 'desc',
        key: 'agentPool.maxSize',
        max: 100,
        min: 1,
        restartRequired: true,
        type: 'integer',
      },
    ]
    request.resolves({items})
    const result = await listSettings()
    expect(result).to.deep.equal({items})
  })

  it('rejects when not connected to the daemon', async () => {
    useTransportStore.setState({apiClient: null})
    try {
      await listSettings()
      expect.fail('expected to reject')
    } catch (error) {
      expect((error as Error).message).to.equal('Not connected')
    }
  })
})
