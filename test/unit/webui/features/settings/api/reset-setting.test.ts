import {expect} from 'chai'
import {createSandbox, type SinonSandbox, type SinonStub} from 'sinon'

import type {BrvApiClient} from '../../../../../../src/webui/lib/api-client.js'

import {SettingsEvents} from '../../../../../../src/shared/transport/events/settings-events.js'
import {resetSetting} from '../../../../../../src/webui/features/settings/api/reset-setting.js'
import {useTransportStore} from '../../../../../../src/webui/stores/transport-store.js'

describe('resetSetting', () => {
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

  it('emits settings:reset with the {key} payload', async () => {
    request.resolves({ok: true, restartRequired: true})
    await resetSetting({key: 'agentPool.maxSize'})
    expect(request.firstCall.args[0]).to.equal(SettingsEvents.RESET)
    expect(request.firstCall.args[1]).to.deep.equal({key: 'agentPool.maxSize'})
  })

  it('resolves with the success response unchanged', async () => {
    const response = {ok: true, restartRequired: true} as const
    request.resolves(response)
    const result = await resetSetting({key: 'agentPool.maxSize'})
    expect(result).to.deep.equal(response)
  })

  it('resolves with the error response unchanged (no throw on ok:false)', async () => {
    const response = {
      error: {code: 'unknown_key', key: 'bogus', message: 'unknown'},
      ok: false,
    } as const
    request.resolves(response)
    const result = await resetSetting({key: 'bogus'})
    expect(result).to.deep.equal(response)
  })

  it('rejects when not connected to the daemon', async () => {
    useTransportStore.setState({apiClient: null})
    try {
      await resetSetting({key: 'agentPool.maxSize'})
      expect.fail('expected to reject')
    } catch (error) {
      expect((error as Error).message).to.equal('Not connected')
    }
  })
})
