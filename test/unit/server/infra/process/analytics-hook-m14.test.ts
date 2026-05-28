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

    it('task_failed payload carries duration_ms + task_id + canonical task_type + failure_kind', async () => {
      const task = buildTask('query', {taskId: 'task-query-err'})
      await hook.onTaskCreate(task)
      trackStub.resetHistory()
      await hook.onTaskError(task.taskId, 'kaboom', task)

      const failed = trackStub.getCalls().find((c) => c.args[0] === AnalyticsEventNames.TASK_FAILED)
      const props = failed?.args[1] as Record<string, unknown>
      expect(props.task_id).to.equal('task-query-err')
      expect(props.task_type).to.equal('query')
      expect(props.duration_ms).to.equal(1234)
      // 'kaboom' classifies to 'unknown' — no recognised sentinel substring
      expect(props.failure_kind).to.equal('unknown')
    })

    it('failure_kind is "cancelled" on onTaskCancelled regardless of state', async () => {
      const task = buildTask('curate', {taskId: 'task-cancel-fk'})
      await hook.onTaskCreate(task)
      trackStub.resetHistory()
      await hook.onTaskCancelled(task.taskId, task)

      const failed = trackStub.getCalls().find((c) => c.args[0] === AnalyticsEventNames.TASK_FAILED)
      expect((failed?.args[1] as Record<string, unknown>).failure_kind).to.equal('cancelled')
    })

    it('failure_kind is "timeout" when the error message names a timeout', async () => {
      const task = buildTask('search', {taskId: 'task-timeout'})
      await hook.onTaskCreate(task)
      trackStub.resetHistory()
      await hook.onTaskError(task.taskId, 'request timed out after 30s', task)

      const failed = trackStub.getCalls().find((c) => c.args[0] === AnalyticsEventNames.TASK_FAILED)
      expect((failed?.args[1] as Record<string, unknown>).failure_kind).to.equal('timeout')
    })

    it('failure_kind is "agent_error" when the error message points at the agent layer', async () => {
      const task = buildTask('search', {taskId: 'task-agent-err'})
      await hook.onTaskCreate(task)
      trackStub.resetHistory()
      await hook.onTaskError(task.taskId, 'provider rejected the LLM call', task)

      const failed = trackStub.getCalls().find((c) => c.args[0] === AnalyticsEventNames.TASK_FAILED)
      expect((failed?.args[1] as Record<string, unknown>).failure_kind).to.equal('agent_error')
    })

    it('classifier uses word-boundary matching: "tooltip" / "engagement" do NOT bucket into agent_error (PR #722)', async () => {
      const task = buildTask('search', {taskId: 'task-tooltip'})
      await hook.onTaskCreate(task)
      trackStub.resetHistory()
      await hook.onTaskError(task.taskId, 'could not render tooltip in engagement panel', task)

      const failed = trackStub.getCalls().find((c) => c.args[0] === AnalyticsEventNames.TASK_FAILED)
      expect((failed?.args[1] as Record<string, unknown>).failure_kind).to.equal('unknown')
    })

    it('classifier precedence pinned: timeout wins over agent_error when both substrings present (PR #722)', async () => {
      const task = buildTask('search', {taskId: 'task-both'})
      await hook.onTaskCreate(task)
      trackStub.resetHistory()
      await hook.onTaskError(task.taskId, 'llm provider timeout after 30s', task)

      const failed = trackStub.getCalls().find((c) => c.args[0] === AnalyticsEventNames.TASK_FAILED)
      expect((failed?.args[1] as Record<string, unknown>).failure_kind).to.equal('timeout')
    })
  })

  describe('toAnalyticsTaskType drift guard (PR #722)', () => {
    it('emits the "unknown" sentinel for an un-enumerated daemon task type instead of silently failing the wire enum', async () => {
      const task = buildTask('not-a-real-daemon-type', {taskId: 'task-drift'})
      await hook.onTaskCreate(task)

      const created = trackStub.getCalls().find((c) => c.args[0] === AnalyticsEventNames.TASK_CREATED)
      expect((created?.args[1] as Record<string, unknown>).task_type).to.equal('unknown')
    })
  })

  describe('toRelativePath outside-project guard (PR #722)', () => {
    it('replaces escaping ../ paths with <outside-project>/basename sentinel', async () => {
      const task = buildTask('curate', {projectPath: '/Users/dev/proj', taskId: 'task-outside'})
      await hook.onTaskCreate(task)
      const result: LlmToolResultEvent = {
        callId: 'c1',
        result: JSON.stringify({
          applied: [{filePath: '/tmp/x.md', needsReview: false, path: 'x', status: 'success', type: 'ADD'}],
        }),
        sessionId: 's1',
        taskId: 'task-outside',
        timestamp: FIXED_NOW,
        toolName: 'curate' as const,
      } as unknown as LlmToolResultEvent
      await hook.onToolResult('task-outside', result)

      const op = trackStub.getCalls().find((c) => c.args[0] === AnalyticsEventNames.CURATE_OPERATION_APPLIED)
      expect((op?.args[1] as Record<string, unknown>).relative_path).to.equal('<outside-project>/x.md')
    })

    it('replaces raw absolute path with <outside-project>/basename when projectPath is undefined', async () => {
      const task = buildTask('curate', {projectPath: undefined, taskId: 'task-no-proj'})
      await hook.onTaskCreate(task)
      const result: LlmToolResultEvent = {
        callId: 'c1',
        result: JSON.stringify({
          applied: [{filePath: '/home/u/secret.md', needsReview: false, path: 'x', status: 'success', type: 'ADD'}],
        }),
        sessionId: 's1',
        taskId: 'task-no-proj',
        timestamp: FIXED_NOW,
        toolName: 'curate' as const,
      } as unknown as LlmToolResultEvent
      await hook.onToolResult('task-no-proj', result)

      const op = trackStub.getCalls().find((c) => c.args[0] === AnalyticsEventNames.CURATE_OPERATION_APPLIED)
      expect((op?.args[1] as Record<string, unknown>).relative_path).to.equal('<outside-project>/secret.md')
    })
  })

  describe('project_path_hash (M17 follow-up): join-key parity with other handler-emitted events', () => {
    it('stamps the sha256(projectPath) on every emit when task.projectPath is set', async () => {
      const task = buildTask('curate', {projectPath: '/Users/dev/example-project', taskId: 'task-pph-1'})
      await hook.onTaskCreate(task)
      await hook.onToolResult('task-pph-1', buildCurateOpToolResult())
      await hook.onTaskCompleted('task-pph-1', '', task)

      const expectedHash = '8c8c8c'
      const events = trackStub.getCalls().map((c) => ({
        name: c.args[0] as string,
        props: c.args[1] as Record<string, unknown>,
      }))

      // Every payload carries project_path_hash matching the sha256 hex regex.
      for (const {name, props} of events) {
        expect(props.project_path_hash, `${name} should carry project_path_hash`).to.be.a('string').and.match(/^[0-9a-f]{64}$/)
      }

      // All payloads share the same hash (same projectPath).
      const hashes = new Set(events.map((e) => e.props.project_path_hash))
      expect(hashes.size, 'all emits for one task share the same project_path_hash').to.equal(1)
      // The value is NOT a placeholder string.
      expect([...hashes][0]).to.not.equal(expectedHash)
    })

    it('omits the field when task.projectPath is undefined', async () => {
      const task = buildTask('search', {projectPath: undefined, taskId: 'task-pph-noproj'})
      await hook.onTaskCreate(task)
      await hook.onTaskCompleted('task-pph-noproj', '', task)

      const events = trackStub.getCalls().map((c) => c.args[1] as Record<string, unknown>)
      for (const props of events) {
        expect(props).to.not.have.property('project_path_hash')
      }
    })

    it('matches hashProjectPath(projectPath) — verifiable from the public utility', async () => {
      const {hashProjectPath} = await import('../../../../../src/server/utils/hash-path.js')
      const projectPath = '/Users/dev/some/other/proj'
      const expected = hashProjectPath(projectPath)

      const task = buildTask('curate', {projectPath, taskId: 'task-pph-match'})
      await hook.onTaskCreate(task)

      const created = trackStub.getCalls().find((c) => c.args[0] === AnalyticsEventNames.TASK_CREATED)
      const props = created?.args[1] as Record<string, unknown>
      expect(props.project_path_hash).to.equal(expected)
    })
  })
})
