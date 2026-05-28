import {expect} from 'chai'
import sinon from 'sinon'

import type {TaskInfo} from '../../../../../src/server/core/domain/transport/task-info.js'
import type {IAnalyticsClient} from '../../../../../src/server/core/interfaces/analytics/i-analytics-client.js'

import {AnalyticsBatch} from '../../../../../src/server/core/domain/analytics/batch.js'
import {AnalyticsHook} from '../../../../../src/server/infra/process/analytics-hook.js'
import {AnalyticsEventNames} from '../../../../../src/shared/analytics/event-names.js'
import {TaskTypes} from '../../../../../src/shared/analytics/task-types.js'

const FIXED_NOW = 1_700_000_000_000

function buildAnalyticsClient(): {client: IAnalyticsClient; trackStub: sinon.SinonStub} {
  const trackStub = sinon.stub()
  return {
    client: {
      abort() {
        /* unused here */
      },
      flush: sinon.stub().resolves(AnalyticsBatch.create([])),
      getRuntimeState: () => Promise.resolve({droppedCount: 0, lastSuccessfulFlushAt: undefined, queueDepth: 0}),
      onAuthTransition: sinon.stub().resolves(),
      track: trackStub,
    },
    trackStub,
  }
}

const buildMcpQueryTask = (overrides: Partial<TaskInfo> = {}): TaskInfo =>
  ({
    clientId: 'sock-1',
    clientName: 'Cursor',
    clientType: 'mcp',
    completedAt: FIXED_NOW + 2500,
    content: 'query',
    createdAt: FIXED_NOW,
    projectPath: '/proj',
    taskId: 'task-1',
    type: TaskTypes.QUERY_TOOL_MODE,
    ...overrides,
  }) as TaskInfo

const buildMcpCurateTask = (overrides: Partial<TaskInfo> = {}): TaskInfo =>
  ({
    clientId: 'sock-1',
    clientName: 'Claude Code',
    clientType: 'mcp',
    completedAt: FIXED_NOW + 8000,
    content: 'curate',
    createdAt: FIXED_NOW,
    projectPath: '/proj',
    taskId: 'task-c',
    type: TaskTypes.CURATE_TOOL_MODE,
    ...overrides,
  }) as TaskInfo

const mcpToolCalledCalls = (trackStub: sinon.SinonStub): sinon.SinonSpyCall[] =>
  trackStub.getCalls().filter((c) => c.args[0] === AnalyticsEventNames.MCP_TOOL_CALLED)

describe('AnalyticsHook MCP_TOOL_CALLED emit (M15.8)', () => {
  let trackStub: sinon.SinonStub
  let hook: AnalyticsHook

  beforeEach(() => {
    const bundle = buildAnalyticsClient()
    trackStub = bundle.trackStub
    hook = new AnalyticsHook()
    hook.setAnalyticsClient(bundle.client)
  })

  it('on success: emits mcp_tool_called with tool_name=brv-query for QUERY_TOOL_MODE', async () => {
    const task = buildMcpQueryTask()
    await hook.onTaskCreate(task)
    await hook.onTaskCompleted(task.taskId, '', task)

    const calls = mcpToolCalledCalls(trackStub)
    expect(calls.length).to.equal(1)
    const props = calls[0].args[1] as {
      client_name: string
      duration_ms: number
      success: boolean
      tool_name: string
    }
    expect(props.tool_name).to.equal('brv-query')
    expect(props.client_name).to.equal('Cursor')
    expect(props.success).to.equal(true)
    expect(props.duration_ms).to.equal(2500)
  })

  it('on success: emits mcp_tool_called with tool_name=brv-curate for CURATE_TOOL_MODE', async () => {
    const task = buildMcpCurateTask()
    await hook.onTaskCreate(task)
    await hook.onTaskCompleted(task.taskId, '', task)

    const calls = mcpToolCalledCalls(trackStub)
    expect(calls.length).to.equal(1)
    const props = calls[0].args[1] as {client_name: string; duration_ms: number; success: boolean; tool_name: string}
    expect(props.tool_name).to.equal('brv-curate')
    expect(props.client_name).to.equal('Claude Code')
    expect(props.success).to.equal(true)
    expect(props.duration_ms).to.equal(8000)
  })

  it('on error: emits mcp_tool_called with success=false (still surfaces the call)', async () => {
    const task = buildMcpQueryTask()
    await hook.onTaskCreate(task)
    await hook.onTaskError(task.taskId, 'boom', task)

    const calls = mcpToolCalledCalls(trackStub)
    expect(calls.length).to.equal(1)
    const props = calls[0].args[1] as {success: boolean; tool_name: string}
    expect(props.success).to.equal(false)
    expect(props.tool_name).to.equal('brv-query')
  })

  it('on cancellation: emits mcp_tool_called with success=false (user-cancel is a not-completed tool call)', async () => {
    const task = buildMcpQueryTask()
    await hook.onTaskCreate(task)
    await hook.onTaskCancelled(task.taskId, task)

    const calls = mcpToolCalledCalls(trackStub)
    expect(calls.length).to.equal(1)
    const props = calls[0].args[1] as {client_name: string; success: boolean; tool_name: string}
    expect(props.success).to.equal(false)
    expect(props.tool_name).to.equal('brv-query')
    expect(props.client_name).to.equal('Cursor')
  })

  it('does NOT emit when clientType is not "mcp"', async () => {
    const task = buildMcpQueryTask({clientType: 'cli'})
    await hook.onTaskCreate(task)
    await hook.onTaskCompleted(task.taskId, '', task)
    expect(mcpToolCalledCalls(trackStub).length).to.equal(0)
  })

  it('does NOT emit when clientType is undefined', async () => {
    const task = buildMcpQueryTask({clientType: undefined})
    await hook.onTaskCreate(task)
    await hook.onTaskCompleted(task.taskId, '', task)
    expect(mcpToolCalledCalls(trackStub).length).to.equal(0)
  })

  it('does NOT emit for non-tool-mode task types (e.g. CURATE, QUERY, DREAM_SCAN, SEARCH)', async () => {
    const types = [TaskTypes.CURATE, TaskTypes.QUERY, TaskTypes.DREAM_SCAN, TaskTypes.SEARCH]
    for (const t of types) {
      const task = buildMcpQueryTask({taskId: `t-${t}`, type: t})
      // eslint-disable-next-line no-await-in-loop -- sequential setup for sinon stub assertions
      await hook.onTaskCreate(task)
      // eslint-disable-next-line no-await-in-loop
      await hook.onTaskCompleted(task.taskId, '', task)
    }

    expect(mcpToolCalledCalls(trackStub).length).to.equal(0)
  })

  it('falls back to "unknown" for client_name when the snapshot is missing', async () => {
    const task = buildMcpQueryTask({clientName: undefined})
    await hook.onTaskCreate(task)
    await hook.onTaskCompleted(task.taskId, '', task)

    const calls = mcpToolCalledCalls(trackStub)
    expect(calls.length).to.equal(1)
    expect((calls[0].args[1] as {client_name: string}).client_name).to.equal('unknown')
  })

  it('duration_ms uses durationMs helper (clamps at 0 on clock skew)', async () => {
    const task = buildMcpQueryTask({completedAt: FIXED_NOW - 1000})
    await hook.onTaskCreate(task)
    await hook.onTaskCompleted(task.taskId, '', task)

    const calls = mcpToolCalledCalls(trackStub)
    expect((calls[0].args[1] as {duration_ms: number}).duration_ms).to.equal(0)
  })
})
