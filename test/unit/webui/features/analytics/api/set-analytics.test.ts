import {expect} from 'chai'
import {createSandbox, type SinonSandbox, type SinonStub} from 'sinon'

import type {BrvApiClient} from '../../../../../../src/webui/lib/api-client.js'

import {GlobalConfigEvents} from '../../../../../../src/shared/transport/events/global-config-events.js'
import {setAnalytics} from '../../../../../../src/webui/features/analytics/api/set-analytics.js'
import {useTransportStore} from '../../../../../../src/webui/stores/transport-store.js'

describe('setAnalytics', () => {
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

  it('emits globalConfig:setAnalytics with the analytics payload', async () => {
    request.resolves({current: true, previous: false})
    await setAnalytics({analytics: true})
    expect(request.firstCall.args[0]).to.equal(GlobalConfigEvents.SET_ANALYTICS)
    expect(request.firstCall.args[1]).to.deep.equal({analytics: true})
  })

  it('forwards false to disable analytics', async () => {
    request.resolves({current: false, previous: true})
    await setAnalytics({analytics: false})
    expect(request.firstCall.args[1]).to.deep.equal({analytics: false})
  })

  it('resolves with the daemon response on success', async () => {
    request.resolves({current: true, previous: false})
    const result = await setAnalytics({analytics: true})
    expect(result).to.deep.equal({current: true, previous: false})
  })

  it('rejects when the transport is not connected', async () => {
    useTransportStore.setState({apiClient: null})
    try {
      await setAnalytics({analytics: true})
      expect.fail('expected promise to reject')
    } catch (error) {
      expect((error as Error).message).to.equal('Not connected')
    }
  })
})
