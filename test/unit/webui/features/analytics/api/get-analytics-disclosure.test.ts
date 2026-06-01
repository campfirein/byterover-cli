import {expect} from 'chai'
import {createSandbox, type SinonSandbox, type SinonStub} from 'sinon'

import type {BrvApiClient} from '../../../../../../src/webui/lib/api-client.js'

import {AnalyticsEvents} from '../../../../../../src/shared/transport/events/analytics-events.js'
import {getAnalyticsDisclosure} from '../../../../../../src/webui/features/analytics/api/get-analytics-disclosure.js'
import {useTransportStore} from '../../../../../../src/webui/stores/transport-store.js'

describe('getAnalyticsDisclosure', () => {
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

  it('emits analytics:getDisclosure with no payload', async () => {
    request.resolves({markdown: '# Disclosure'})
    await getAnalyticsDisclosure()
    expect(request.firstCall.args[0]).to.equal(AnalyticsEvents.GET_DISCLOSURE)
  })

  it('returns the markdown body from the daemon response', async () => {
    request.resolves({markdown: '# Title\n\nBody.'})
    const result = await getAnalyticsDisclosure()
    expect(result).to.deep.equal({markdown: '# Title\n\nBody.'})
  })

  it('rejects when the transport is not connected', async () => {
    useTransportStore.setState({apiClient: null})
    await getAnalyticsDisclosure().then(
      () => expect.fail('expected promise to reject'),
      (error: Error) => expect(error.message).to.equal('Not connected'),
    )
  })
})
