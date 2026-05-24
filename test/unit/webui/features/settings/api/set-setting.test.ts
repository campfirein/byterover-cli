import {expect} from 'chai'
import {createSandbox, type SinonSandbox, type SinonStub} from 'sinon'

import type {BrvApiClient} from '../../../../../../src/webui/lib/api-client.js'

import {SettingsEvents} from '../../../../../../src/shared/transport/events/settings-events.js'
import {setSetting} from '../../../../../../src/webui/features/settings/api/set-setting.js'
import {useTransportStore} from '../../../../../../src/webui/stores/transport-store.js'

describe('setSetting', () => {
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

  it('emits settings:set with the {key, value} payload', async () => {
    request.resolves({ok: true, restartRequired: true})
    await setSetting({key: 'agentPool.maxSize', value: 25})
    expect(request.firstCall.args[0]).to.equal(SettingsEvents.SET)
    expect(request.firstCall.args[1]).to.deep.equal({key: 'agentPool.maxSize', value: 25})
  })

  it('resolves with the success response unchanged', async () => {
    const response = {ok: true, restartRequired: true} as const
    request.resolves(response)
    const result = await setSetting({key: 'agentPool.maxSize', value: 25})
    expect(result).to.deep.equal(response)
  })

  it('resolves with the error response unchanged (no throw on ok:false)', async () => {
    const response = {
      error: {code: 'invalid_value', key: 'agentPool.maxSize', message: 'out of range', value: 999},
      ok: false,
    } as const
    request.resolves(response)
    const result = await setSetting({key: 'agentPool.maxSize', value: 999})
    expect(result).to.deep.equal(response)
  })

  it('rejects when not connected to the daemon', async () => {
    useTransportStore.setState({apiClient: null})
    try {
      await setSetting({key: 'agentPool.maxSize', value: 25})
      expect.fail('expected to reject')
    } catch (error) {
      expect((error as Error).message).to.equal('Not connected')
    }
  })
})
