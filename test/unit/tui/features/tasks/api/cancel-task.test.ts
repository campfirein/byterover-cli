import {expect} from 'chai'
import {createSandbox, type SinonSandbox, type SinonStub} from 'sinon'

import type {BrvApiClient} from '../../../../../../src/tui/lib/api-client.js'

import {TaskEvents} from '../../../../../../src/shared/transport/events/task-events.js'
import {cancelTask} from '../../../../../../src/tui/features/tasks/api/cancel-task.js'
import {useTransportStore} from '../../../../../../src/tui/stores/transport-store.js'

describe('cancelTask (TUI api helper)', () => {
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

  it('emits task:cancel with the taskId payload', async () => {
    request.resolves({success: true})
    await cancelTask({taskId: 'tsk-1'})
    expect(request.firstCall.args[0]).to.equal(TaskEvents.CANCEL)
    expect(request.firstCall.args[1]).to.deep.equal({taskId: 'tsk-1'})
  })

  it('resolves with the daemon response on success', async () => {
    request.resolves({success: true})
    const result = await cancelTask({taskId: 'tsk-1'})
    expect(result).to.deep.equal({success: true})
  })

  it('throws with the daemon-provided error message when success: false', async () => {
    request.resolves({error: 'Task not found', success: false})
    try {
      await cancelTask({taskId: 'tsk-1'})
      expect.fail('expected to throw')
    } catch (error) {
      expect((error as Error).message).to.equal('Task not found')
    }
  })

  it('falls back to "Cancel failed" when success: false has no error string', async () => {
    request.resolves({success: false})
    try {
      await cancelTask({taskId: 'tsk-1'})
      expect.fail('expected to throw')
    } catch (error) {
      expect((error as Error).message).to.equal('Cancel failed')
    }
  })

  it('throws when not connected to the daemon', async () => {
    useTransportStore.setState({apiClient: null})
    try {
      await cancelTask({taskId: 'tsk-1'})
      expect.fail('expected to throw')
    } catch (error) {
      expect((error as Error).message).to.equal('Not connected')
    }
  })
})
