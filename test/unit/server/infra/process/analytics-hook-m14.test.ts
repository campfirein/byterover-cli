import {expect} from 'chai'
import sinon from 'sinon'

import type {LlmToolResultEvent} from '../../../../../src/server/core/domain/transport/schemas.js'
import type {TaskInfo} from '../../../../../src/server/core/domain/transport/task-info.js'
import type {IAnalyticsClient} from '../../../../../src/server/core/interfaces/analytics/i-analytics-client.js'

import {AnalyticsBatch} from '../../../../../src/server/core/domain/analytics/batch.js'
import {AnalyticsHook} from '../../../../../src/server/infra/process/analytics-hook.js'
import {AnalyticsEventNames} from '../../../../../src/shared/analytics/event-names.js'

const FIXED_NOW = 1_700_000_000_000

const buildClient = (): {client: IAnalyticsClient; trackStub: sinon.SinonStub} => {
  const trackStub = sinon.stub()
  const client: IAnalyticsClient = {
    abort() {
      /* noop */
    },
    flush: sinon.stub().resolves(AnalyticsBatch.create([])),
    getRuntimeState: () => Promise.resolve({droppedCount: 0, lastSuccessfulFlushAt: undefined, queueDepth: 0}),
    onAuthTransition: sinon.stub().resolves(),
    track: trackStub,
  }
  return {client, trackStub}
}

const buildTask = (type: string, overrides: Partial<TaskInfo> = {}): TaskInfo =>
  ({
    clientId: 'c1',
    completedAt: FIXED_NOW + 1234,
    content: 'whatever',
    createdAt: FIXED_NOW,
    folderPath: undefined,
    projectPath: '/project',
    taskId: `task-${type}-1`,
    toolCalls: [],
    type,
    ...overrides,
  }) as TaskInfo

const buildCurateOpToolResult = (): LlmToolResultEvent =>
  ({
    callId: 'call-1',
    result: JSON.stringify({
      applied: [
        {filePath: '/a.md', needsReview: false, path: 'a', status: 'success', type: 'ADD'},
      ],
    }),
    sessionId: 's1',
    taskId: 'task-curate-1',
    timestamp: FIXED_NOW,
    toolName: 'curate' as const,
  }) as unknown as LlmToolResultEvent

const eventSequence = (trackStub: sinon.SinonStub): string[] =>
  trackStub.getCalls().map((c) => c.args[0] as string)

describe('AnalyticsHook M14.3 generic task_* emit simulation', () => {
  let hook: AnalyticsHook
  let trackStub: sinon.SinonStub

  beforeEach(() => {
    const bundle = buildClient()
    trackStub = bundle.trackStub
    hook = new AnalyticsHook()
    hook.setAnalyticsClient(bundle.client)
  })

  describe('curate task: full success lifecycle (curate-tool-mode rename simulated)', () => {
    it('emits task_created on entry, then per-op + curate_run_completed + task_completed on terminal', async () => {
      // Daemon dispatches the pre-ENG-2925 name 'curate-html-direct';
      // analytics is expected to alias-translate to 'curate-tool-mode'.
      const task = buildTask('curate-html-direct', {taskId: 'task-curate-1'})

      await hook.onTaskCreate(task)
      await hook.onToolResult(task.taskId, buildCurateOpToolResult())
      await hook.onTaskCompleted(task.taskId, '', task)

      expect(eventSequence(trackStub)).to.deep.equal([
        AnalyticsEventNames.TASK_CREATED,
        AnalyticsEventNames.CURATE_OPERATION_APPLIED,
        AnalyticsEventNames.CURATE_RUN_COMPLETED,
        AnalyticsEventNames.TASK_COMPLETED,
      ])
    })

    it('aliases curate-html-direct → curate-tool-mode on the wire (task_type field)', async () => {
      const task = buildTask('curate-html-direct', {taskId: 'task-curate-1'})
      await hook.onTaskCreate(task)
      await hook.onTaskCompleted(task.taskId, '', task)

      const created = trackStub.getCalls().find((c) => c.args[0] === AnalyticsEventNames.TASK_CREATED)
      const completed = trackStub.getCalls().find((c) => c.args[0] === AnalyticsEventNames.TASK_COMPLETED)
      expect((created?.args[1] as Record<string, unknown>).task_type).to.equal('curate-tool-mode')
      expect((completed?.args[1] as Record<string, unknown>).task_type).to.equal('curate-tool-mode')
    })

    it('emits task_created has_files=true / has_folder=true when set on TaskInfo', async () => {
      const task = buildTask('curate-folder', {
        files: ['/a.ts', '/b.ts'],
        folderPath: '/some/folder',
        taskId: 'task-curate-2',
      })
      await hook.onTaskCreate(task)

      const created = trackStub.getCalls().find((c) => c.args[0] === AnalyticsEventNames.TASK_CREATED)
      const props = created?.args[1] as Record<string, unknown>
      expect(props.has_files).to.equal(true)
      expect(props.has_folder).to.equal(true)
      expect(props.task_type).to.equal('curate-folder')
    })

    it('emits task_created has_files=false / has_folder=false when both are unset', async () => {
      const task = buildTask('curate', {files: undefined, folderPath: undefined, taskId: 'task-curate-3'})
      await hook.onTaskCreate(task)

      const created = trackStub.getCalls().find((c) => c.args[0] === AnalyticsEventNames.TASK_CREATED)
      const props = created?.args[1] as Record<string, unknown>
      expect(props.has_files).to.equal(false)
      expect(props.has_folder).to.equal(false)
    })
  })

  describe('query task: terminal emits include task_completed last', () => {
    it('emits task_created → query_completed → task_completed in order', async () => {
      const task = buildTask('query-tool-mode', {taskId: 'task-query-1'})

      await hook.onTaskCreate(task)
      await hook.onTaskCompleted(task.taskId, '', task)

      expect(eventSequence(trackStub)).to.deep.equal([
        AnalyticsEventNames.TASK_CREATED,
        AnalyticsEventNames.QUERY_COMPLETED,
        AnalyticsEventNames.TASK_COMPLETED,
      ])
    })

    it('emits the same query-tool-mode task_type across all three events', async () => {
      const task = buildTask('query-tool-mode', {taskId: 'task-query-1'})
      await hook.onTaskCreate(task)
      await hook.onTaskCompleted(task.taskId, '', task)

      for (const call of trackStub.getCalls()) {
        const props = call.args[1] as Record<string, unknown>
        expect(props.task_type, `${call.args[0] as string} carried wrong task_type`).to.equal('query-tool-mode')
      }
    })
  })

  describe('dream-scan / dream-finalize / search: only task_* emits fire (no M12 per-flavor)', () => {
    for (const taskType of ['dream-scan', 'dream-finalize', 'search'] as const) {
      it(`${taskType}: task_created → task_completed (no curate/query M12 emit)`, async () => {
        const task = buildTask(taskType, {taskId: `task-${taskType}-1`})
        await hook.onTaskCreate(task)
        await hook.onTaskCompleted(task.taskId, '', task)

        expect(eventSequence(trackStub)).to.deep.equal([
          AnalyticsEventNames.TASK_CREATED,
          AnalyticsEventNames.TASK_COMPLETED,
        ])
      })

      it(`${taskType}: onTaskError emits task_created then task_failed (no curate/query M12 emit)`, async () => {
        const task = buildTask(taskType, {taskId: `task-${taskType}-2`})
        await hook.onTaskCreate(task)
        await hook.onTaskError(task.taskId, 'something blew up', task)

        expect(eventSequence(trackStub)).to.deep.equal([
          AnalyticsEventNames.TASK_CREATED,
          AnalyticsEventNames.TASK_FAILED,
        ])
      })
    }
  })

  describe('failure + cancellation both surface as task_failed', () => {
    it('curate onTaskError emits curate_run_completed(outcome=error) then task_failed', async () => {
      const task = buildTask('curate', {taskId: 'task-curate-err'})
      await hook.onTaskCreate(task)
      trackStub.resetHistory()
      await hook.onTaskError(task.taskId, 'kaboom', task)

      expect(eventSequence(trackStub)).to.deep.equal([
        AnalyticsEventNames.CURATE_RUN_COMPLETED,
        AnalyticsEventNames.TASK_FAILED,
      ])
    })

    it('curate onTaskCancelled also emits task_failed (no distinct cancellation event)', async () => {
      const task = buildTask('curate', {taskId: 'task-curate-cancel'})
      await hook.onTaskCreate(task)
      trackStub.resetHistory()
      await hook.onTaskCancelled(task.taskId, task)

      expect(eventSequence(trackStub)).to.deep.equal([
        AnalyticsEventNames.CURATE_RUN_COMPLETED,
        AnalyticsEventNames.TASK_FAILED,
      ])
    })

    it('task_failed payload carries duration_ms + task_id + canonical task_type', async () => {
      const task = buildTask('query', {taskId: 'task-query-err'})
      await hook.onTaskCreate(task)
      trackStub.resetHistory()
      await hook.onTaskError(task.taskId, 'kaboom', task)

      const failed = trackStub.getCalls().find((c) => c.args[0] === AnalyticsEventNames.TASK_FAILED)
      const props = failed?.args[1] as Record<string, unknown>
      expect(props.task_id).to.equal('task-query-err')
      expect(props.task_type).to.equal('query')
      expect(props.duration_ms).to.equal(1234)
    })
  })
})
