/* eslint-disable camelcase */
import {expect} from 'chai'
import sinon from 'sinon'

import type {LlmToolResultEvent} from '../../../../../src/server/core/domain/transport/schemas.js'
import type {TaskInfo} from '../../../../../src/server/core/domain/transport/task-info.js'
import type {IAnalyticsClient} from '../../../../../src/server/core/interfaces/analytics/i-analytics-client.js'
import type {QueryResultMetadata} from '../../../../../src/server/infra/process/query-log-handler.js'

import {AnalyticsBatch} from '../../../../../src/server/core/domain/analytics/batch.js'
import {AnalyticsHook} from '../../../../../src/server/infra/process/analytics-hook.js'

const NOW = 1_700_000_000_000

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

const buildToolModeCurateTask = (overrides: Partial<TaskInfo> = {}): TaskInfo =>
  ({
    clientId: 'agent-1',
    completedAt: NOW + 4321,
    content: 'JSON envelope describing the html the calling agent already wrote',
    createdAt: NOW,
    // Daemon today still dispatches the pre-ENG-2925 name; analytics
    // aliases it to 'curate-tool-mode' on the wire via toAnalyticsTaskType.
    projectPath: '/Users/dev/example-project',
    taskId: 'task-curate-tm-1',
    type: 'curate-html-direct',
    ...overrides,
  }) as TaskInfo

const buildToolModeQueryTask = (overrides: Partial<TaskInfo> = {}): TaskInfo =>
  ({
    clientId: 'agent-1',
    completedAt: NOW + 987,
    content: 'how does the auth middleware work',
    createdAt: NOW,
    projectPath: '/Users/dev/example-project',
    taskId: 'task-query-tm-1',
    toolCalls: [],
    type: 'query-tool-mode',
    ...overrides,
  }) as TaskInfo

async function fakeReadFileForInspection(filePath: string): Promise<string> {
  if (filePath === '/Users/dev/example-project/.brv/notes/auth.md') {
    return '---\nkeywords: ["jwt", "session"]\nrelated: ["auth/middleware", "users"]\ntags: ["security"]\n---\nbody\n'
  }

  if (filePath === '/Users/dev/example-project/.brv/context-tree/analytics/m16.html') {
    // M16 follow-up: curate-tool-mode writes HTML topic files whose
    // tags/keywords/related live as comma-separated attrs on `<bv-topic>`.
    return '<bv-topic path="analytics/m16" title="M16" tags="analytics, m16, tool-mode" keywords="synthetic, broadcast-skip" related="@analytics/related.html, @analytics/another.html"><bv-task>noop</bv-task></bv-topic>'
  }

  return '---\n---\nempty\n'
}

/**
 * PR #722 review: gated behind `DUMP_ANALYTICS=1` so `npm test` stays quiet
 * by default. The shape assertions in each `it()` still execute; the dump
 * is an opt-in diagnostic for inspecting payloads (`DUMP_ANALYTICS=1 npx
 * mocha test/unit/.../analytics-hook-toolmode-inspection.test.ts`).
 */
const DUMP_ENABLED = process.env.DUMP_ANALYTICS === '1'

const dumpEvents = (label: string, trackStub: sinon.SinonStub): void => {
  if (!DUMP_ENABLED) return
  console.log(`\n┌─ ${label} ${'─'.repeat(Math.max(0, 70 - label.length))}`)
  for (const [i, call] of trackStub.getCalls().entries()) {
    const eventName = call.args[0] as string
    const props = call.args[1] as Record<string, unknown>
    console.log(`│ [${i}] ${eventName}`)
    console.log(`│     ${JSON.stringify(props, null, 2).replaceAll('\n', '\n│     ')}`)
  }

  console.log(`└${'─'.repeat(72)}\n`)
}

describe('analytics-hook tool-mode event inspection (M14)', () => {
  it('curate-tool-mode: prints every event + payload the daemon emits to analytics', async () => {
    const {client, trackStub} = buildClient()
    const hook = new AnalyticsHook()
    hook.setAnalyticsClient(client)

    const task = buildToolModeCurateTask()
    await hook.onTaskCreate(task)
    await hook.onTaskCompleted(task.taskId, '', task)

    dumpEvents('curate-tool-mode — success path', trackStub)

    // Sanity: every event carries the canonical post-rename task_type
    for (const call of trackStub.getCalls()) {
      const props = call.args[1] as Record<string, unknown>
      expect(props.task_type, `${call.args[0] as string} task_type`).to.equal('curate-tool-mode')
    }

    // Counters all-zero today because onToolResult never fires for
    // tool-mode (no LLM tool calls) — that's the FU-1 follow-up.
    //
    // FU-1 forward-compat note (PR #722 review): once FU-1 lands and the
    // daemon synthesises a curate op from `task.result`, these asserts
    // will flip from `=== 0` to non-zero. That is a FEATURE, not a
    // regression — update the expectations in the FU-1 PR.
    const runCompleted = trackStub.getCalls().find((c) => c.args[0] === 'curate_run_completed')
    const counters = runCompleted?.args[1] as Record<string, number>
    expect(counters.operations_added).to.equal(0)
    expect(counters.operations_updated).to.equal(0)
    expect(counters.operations_deleted).to.equal(0)
    expect(counters.operations_merged).to.equal(0)
    expect(counters.operations_failed).to.equal(0)
    expect(counters.pending_review_count).to.equal(0)
  })

  it('curate-tool-mode: error path — prints curate_run_completed(outcome=error) + task_failed', async () => {
    const {client, trackStub} = buildClient()
    const hook = new AnalyticsHook()
    hook.setAnalyticsClient(client)

    const task = buildToolModeCurateTask({taskId: 'task-curate-tm-err'})
    await hook.onTaskCreate(task)
    await hook.onTaskError(task.taskId, 'writer rejected: path-exists', task)

    dumpEvents('curate-tool-mode — error path', trackStub)
  })

  it('curate-tool-mode: with a successful tool-result op (FU-1 forward-look — what counters WOULD look like)', async () => {
    const {client, trackStub} = buildClient()
    const hook = new AnalyticsHook()
    hook.setAnalyticsClient(client)

    const task = buildToolModeCurateTask({taskId: 'task-curate-tm-fu1'})
    await hook.onTaskCreate(task)

    // Simulate a curate-op as if FU-1 had synthesised one from task.result
    // (today's tool-mode path doesn't fire onToolResult — FU-1 fixes that).
    const simulatedOp: LlmToolResultEvent = {
      callId: 'sim-1',
      result: JSON.stringify({
        applied: [
          {
            filePath: '/Users/dev/example-project/.brv/notes/auth.md',
            needsReview: false,
            path: 'auth',
            status: 'success',
            type: 'ADD',
          },
        ],
      }),
      sessionId: 'sim-session',
      taskId: task.taskId,
      timestamp: NOW,
      toolName: 'curate' as const,
    } as unknown as LlmToolResultEvent
    await hook.onToolResult(task.taskId, simulatedOp)
    await hook.onTaskCompleted(task.taskId, '', task)

    dumpEvents('curate-tool-mode — FU-1 forward-look (single synthetic op)', trackStub)
  })

  it('query-tool-mode: prints every event + payload the daemon emits to analytics', async () => {
    const {client, trackStub} = buildClient()
    const hook = new AnalyticsHook()
    hook.setAnalyticsClient(client)

    const task = buildToolModeQueryTask()
    await hook.onTaskCreate(task)
    await hook.onTaskCompleted(task.taskId, '', task)

    dumpEvents('query-tool-mode — success path (no setQueryResult)', trackStub)

    for (const call of trackStub.getCalls()) {
      const props = call.args[1] as Record<string, unknown>
      expect(props.task_type, `${call.args[0] as string} task_type`).to.equal('query-tool-mode')
    }

    // No setQueryResult call → matched_doc_count + read_doc_count both 0,
    // tier omitted, read_paths_with_metadata omitted. That's the
    // empty-metadata state FU-1's query half closes.
    const queryCompleted = trackStub.getCalls().find((c) => c.args[0] === 'query_completed')
    const props = queryCompleted?.args[1] as Record<string, unknown>
    expect(props.matched_doc_count).to.equal(0)
    expect(props.read_doc_count).to.equal(0)
    expect(props.cache_hit).to.equal(false)
    expect(props.tier).to.equal(undefined)
    expect(props.read_paths_with_metadata).to.equal(undefined)
  })

  it('query-tool-mode: with setQueryResult (forward-look from FU-1) — populated metadata', async () => {
    const {client, trackStub} = buildClient()
    const hook = new AnalyticsHook()
    hook.setAnalyticsClient(client)

    const task = buildToolModeQueryTask({taskId: 'task-query-tm-fu1'})
    await hook.onTaskCreate(task)

    const metadata: QueryResultMetadata = {
      matchedDocs: [],
      searchMetadata: {resultCount: 4, topScore: 0.82, totalFound: 4},
      tier: 2,
      timing: {durationMs: 987},
    } as QueryResultMetadata
    hook.setQueryResult(task.taskId, metadata)

    await hook.onTaskCompleted(task.taskId, '', task)

    dumpEvents('query-tool-mode — FU-1 forward-look (setQueryResult populated)', trackStub)
  })

  it('query (legacy): read_paths_with_metadata carries structured related_paths + relative_path + keywords/tags arrays', async () => {
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
    const hook = new AnalyticsHook({readFile: fakeReadFileForInspection})
    hook.setAnalyticsClient(client)

    const task = buildToolModeQueryTask({
      taskId: 'task-query-paths-1',
      toolCalls: [
        {
          args: {filePath: '/Users/dev/example-project/.brv/notes/auth.md'},
          sessionId: 's1',
          status: 'completed',
          timestamp: NOW,
          toolName: 'read_file',
        },
      ],
      type: 'query',
    } as Partial<TaskInfo>)

    await hook.onTaskCreate(task)
    await hook.onTaskCompleted(task.taskId, '', task)

    dumpEvents('query (legacy) — read_paths_with_metadata + related_paths structure', trackStub)

    const queryCompleted = trackStub.getCalls().find((c) => c.args[0] === 'query_completed')
    const props = queryCompleted?.args[1] as Record<string, unknown>
    const paths = props.read_paths_with_metadata as Array<Record<string, unknown>>
    expect(paths).to.have.lengthOf(1)

    const entry = paths[0]
    expect(entry.relative_path).to.equal('.brv/notes/auth.md')
    expect(entry.keywords).to.deep.equal(['jwt', 'session'])
    expect(entry.tags).to.deep.equal(['security'])
    expect(entry.related_paths).to.deep.equal([
      {keywords: [], relative_path: 'auth/middleware', tags: []},
      {keywords: [], relative_path: 'users', tags: []},
    ])
  })

  it('query-tool-mode: error path', async () => {
    const {client, trackStub} = buildClient()
    const hook = new AnalyticsHook()
    hook.setAnalyticsClient(client)

    const task = buildToolModeQueryTask({taskId: 'task-query-tm-err'})
    await hook.onTaskCreate(task)
    await hook.onTaskError(task.taskId, 'connector unreachable', task)

    dumpEvents('query-tool-mode — error path', trackStub)
  })

  it('HTML topic: read_paths_with_metadata extracts keywords/tags/related from `<bv-topic>` attrs (M16 follow-up)', async () => {
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
    const hook = new AnalyticsHook({readFile: fakeReadFileForInspection})
    hook.setAnalyticsClient(client)

    const task = buildToolModeQueryTask({
      taskId: 'task-query-html-1',
      toolCalls: [
        {
          args: {filePath: '/Users/dev/example-project/.brv/context-tree/analytics/m16.html'},
          sessionId: 's1',
          status: 'completed',
          timestamp: NOW,
          toolName: 'read_file',
        },
      ],
      type: 'query',
    } as Partial<TaskInfo>)

    await hook.onTaskCreate(task)
    await hook.onTaskCompleted(task.taskId, '', task)

    const queryCompleted = trackStub.getCalls().find((c) => c.args[0] === 'query_completed')
    const props = queryCompleted?.args[1] as Record<string, unknown>
    const paths = props.read_paths_with_metadata as Array<Record<string, unknown>>
    expect(paths).to.have.lengthOf(1)
    const entry = paths[0]
    expect(entry.relative_path).to.equal('.brv/context-tree/analytics/m16.html')
    // M16: comma-separated `tags`/`keywords`/`related` HTML attrs become arrays.
    expect(entry.keywords).to.deep.equal(['synthetic', 'broadcast-skip'])
    expect(entry.tags).to.deep.equal(['analytics', 'm16', 'tool-mode'])
    // `related` lifts to the structured `related_paths[]` shape: each entry's
    // own keywords/tags arrays default to empty (only top-level reads enrich).
    expect(entry.related_paths).to.deep.equal([
      {keywords: [], relative_path: '@analytics/related.html', tags: []},
      {keywords: [], relative_path: '@analytics/another.html', tags: []},
    ])
  })
})
