import {expect} from 'chai'
import {createSandbox, type SinonSandbox, type SinonStub} from 'sinon'

import type {BrvApiClient} from '../../../../../../src/webui/lib/api-client.js'

import {GlobalConfigEvents} from '../../../../../../src/shared/transport/events/global-config-events.js'
import {getGlobalConfig} from '../../../../../../src/webui/features/analytics/api/get-global-config.js'
import {useTransportStore} from '../../../../../../src/webui/stores/transport-store.js'

describe('getGlobalConfig', () => {
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

  it('emits globalConfig:get with no payload', async () => {
    request.resolves({analytics: false, deviceId: 'dev-1', version: '1'})
    await getGlobalConfig()
    expect(request.firstCall.args[0]).to.equal(GlobalConfigEvents.GET)
  })

  it('returns the analytics, deviceId, and version from the daemon response', async () => {
    request.resolves({analytics: true, deviceId: 'dev-2', version: '2'})
    const result = await getGlobalConfig()
    expect(result).to.deep.equal({analytics: true, deviceId: 'dev-2', version: '2'})
  })

  it('rejects when the transport is not connected', async () => {
    useTransportStore.setState({apiClient: null})
    await getGlobalConfig().then(
      () => expect.fail('expected promise to reject'),
      (error: Error) => expect(error.message).to.equal('Not connected'),
    )
  })
})
