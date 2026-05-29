import {expect} from 'chai'
import {mkdtempSync, rmSync, writeFileSync} from 'node:fs'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import sinon from 'sinon'

import type {LlmToolResultEvent} from '../../../../../src/server/core/domain/transport/schemas.js'
import type {TaskInfo} from '../../../../../src/server/core/domain/transport/task-info.js'
import type {IAnalyticsClient} from '../../../../../src/server/core/interfaces/analytics/i-analytics-client.js'
import type {QueryResultMetadata} from '../../../../../src/server/infra/process/query-log-handler.js'

import {AnalyticsBatch} from '../../../../../src/server/core/domain/analytics/batch.js'
import {AnalyticsHook} from '../../../../../src/server/infra/process/analytics-hook.js'
import {AnalyticsEventNames} from '../../../../../src/shared/analytics/event-names.js'

const writeMarkdown = (filePath: string, frontmatter: Record<string, unknown>, body = 'body'): void => {
  const yaml = Object.entries(frontmatter)
    .map(([k, v]) => `${k}: ${JSON.stringify(v)}`)
    .join('\n')
  writeFileSync(filePath, `---\n${yaml}\n---\n${body}\n`, 'utf8')
}

const FIXED_NOW = 1_700_000_000_000

type StubBundle = {
  client: IAnalyticsClient
  flushStub: sinon.SinonStub
  trackStub: sinon.SinonStub
}

const buildAnalyticsClient = (): StubBundle => {
  const trackStub = sinon.stub()
  const flushStub = sinon.stub().resolves(AnalyticsBatch.create([]))
  const client: IAnalyticsClient = {
    abort() {
      /* M4.4: not exercised in this test */
    },
    flush: flushStub,
    getRuntimeState: () => Promise.resolve({droppedCount: 0, lastSuccessfulFlushAt: undefined, queueDepth: 0}),
    onAuthTransition: sinon.stub().resolves(),
    track: trackStub,
  }
  return {client, flushStub, trackStub}
}

const buildCurateTask = (overrides: Partial<TaskInfo> = {}): TaskInfo =>
  ({
    clientId: 'client-1',
    completedAt: FIXED_NOW + 5000,
    content: 'curate stuff',
    createdAt: FIXED_NOW,
    projectPath: '/project',
    taskId: 'task-curate-1',
    type: 'curate',
    ...overrides,
  }) as TaskInfo

const buildQueryTask = (overrides: Partial<TaskInfo> = {}): TaskInfo =>
  ({
    clientId: 'client-1',
    completedAt: FIXED_NOW + 1234,
    content: 'query stuff',
    createdAt: FIXED_NOW,
    projectPath: '/project',
    taskId: 'task-query-1',
    toolCalls: [],
    type: 'query',
    ...overrides,
  }) as TaskInfo

type Deferred<T> = {promise: Promise<T>; reject: (e: unknown) => void; resolve: (v: T) => void}
const defer = <T>(): Deferred<T> => {
  let resolve!: (v: T) => void
  let reject!: (e: unknown) => void
  const promise = new Promise<T>((res, rej) => {
    resolve = res
    reject = rej
  })
  return {promise, reject, resolve}
}

const buildFrontmatterDoc = (tag: string): string => `---\ntags: ["${tag}"]\n---\nbody\n`

const findEmit = (stub: sinon.SinonStub, event: string): Record<string, unknown> => {
  const call = stub.getCalls().find((c) => c.args[0] === event)
  if (!call) throw new Error(`expected ${event} emit not found`)
  return call.args[1] as Record<string, unknown>
}

const stubReadFileFromQueue =
  (...queue: Array<Promise<string>>): ((p: string) => Promise<string>) =>
  () => {
    const next = queue.shift()
    if (next === undefined) throw new Error('stubReadFileFromQueue exhausted')
    return next
  }

const stubReadFileAlways =
  (value: Promise<string>): ((p: string) => Promise<string>) =>
  () =>
    value

const buildToolResult = (ops: Array<Record<string, unknown>>): LlmToolResultEvent => ({
  callId: 'call-1',
  result: JSON.stringify({applied: ops}),
  sessionId: 'session-1',
  taskId: 'task-curate-1',
  timestamp: FIXED_NOW,
  toolName: 'curate' as const,
}) as unknown as LlmToolResultEvent

describe('AnalyticsHook', () => {
  let trackStub: sinon.SinonStub
  let hook: AnalyticsHook

  beforeEach(() => {
    const bundle = buildAnalyticsClient()
    trackStub = bundle.trackStub
    hook = new AnalyticsHook()
    hook.setAnalyticsClient(bundle.client)
  })

  // M14.3 added unconditional task_created / task_completed / task_failed
  // emits on every lifecycle callback. Pre-M14.3 tests asserted only the
  // M12 per-flavor curate_*/query_completed emits; filter the stub calls
  // so existing assertions stay focused on M12 behavior. New M14.3
  // coverage lives in `analytics-hook-m14.test.ts`.
  const filterM12 = (stub: sinon.SinonStub): sinon.SinonSpyCall[] =>
    stub.getCalls().filter((c) => {
      const eventName = c.args[0]
      return (
        eventName !== AnalyticsEventNames.TASK_CREATED &&
        eventName !== AnalyticsEventNames.TASK_COMPLETED &&
        eventName !== AnalyticsEventNames.TASK_FAILED
      )
    })
  const m12Calls = (): sinon.SinonSpyCall[] => filterM12(trackStub)

  describe('curate task flow', () => {
    it('emits curate_operation_applied per successful op + bumps matching counter; no event for failed op', async () => {
      const task = buildCurateTask()
      await hook.onTaskCreate(task)

      const payload = buildToolResult([
        {filePath: '/a.md', needsReview: false, path: 'notes/a', status: 'success', type: 'ADD'},
        {filePath: '/b.md', needsReview: true, path: 'notes/b', status: 'success', type: 'UPDATE'},
        {filePath: '/c.md', needsReview: false, path: 'notes/c', status: 'failed', type: 'ADD'},
      ])
      await hook.onToolResult(task.taskId, payload)

      expect(m12Calls()).to.have.lengthOf(2)
      expect(m12Calls()[0].args[0]).to.equal(AnalyticsEventNames.CURATE_OPERATION_APPLIED)
      const firstProps = m12Calls()[0].args[1] as Record<string, unknown>
      // buildCurateTask sets projectPath:'/project'; /a.md escapes the
      // project root → PR #722 outside-project sentinel + basename.
      expect(firstProps.relative_path).to.equal('<outside-project>/a.md')
      expect(firstProps.knowledge_path).to.equal('notes/a')
      expect(firstProps.operation_type).to.equal('ADD')
      expect(firstProps.needs_review).to.equal(false)
      expect(firstProps.tags).to.deep.equal([])
      expect(firstProps.keywords).to.deep.equal([])
      expect(firstProps).to.not.have.property('related')

      const secondProps = m12Calls()[1].args[1] as Record<string, unknown>
      expect(secondProps.needs_review).to.equal(true)
      expect(secondProps.operation_type).to.equal('UPDATE')
    })

    it('emits curate_run_completed at terminal with counter totals + outcome=completed', async () => {
      const task = buildCurateTask()
      await hook.onTaskCreate(task)
      await hook.onToolResult(
        task.taskId,
        buildToolResult([
          {filePath: '/a.md', needsReview: false, path: 'a', status: 'success', type: 'ADD'},
          {filePath: '/b.md', needsReview: false, path: 'b', status: 'success', type: 'UPDATE'},
          {filePath: '/c.md', needsReview: false, path: 'c', status: 'success', type: 'DELETE'},
        ]),
      )
      trackStub.resetHistory()

      await hook.onTaskCompleted(task.taskId, '', task)

      expect(m12Calls()).to.have.lengthOf(1)
      expect(m12Calls()[0].args[0]).to.equal(AnalyticsEventNames.CURATE_RUN_COMPLETED)
      const props = m12Calls()[0].args[1] as Record<string, unknown>
      expect(props.task_id).to.equal(task.taskId)
      expect(props.task_type).to.equal('curate')
      expect(props.outcome).to.equal('completed')
      expect(props.operations_added).to.equal(1)
      expect(props.operations_updated).to.equal(1)
      expect(props.operations_deleted).to.equal(1)
      expect(props.operations_merged).to.equal(0)
      expect(props.operations_failed).to.equal(0)
      expect(props.pending_review_count).to.equal(0)
      expect(props.duration_ms).to.equal(5000)
    })

    it('emits outcome=partial when at least one op failed', async () => {
      const task = buildCurateTask()
      await hook.onTaskCreate(task)
      await hook.onToolResult(
        task.taskId,
        buildToolResult([
          {filePath: '/a.md', needsReview: false, path: 'a', status: 'success', type: 'ADD'},
          {filePath: '/b.md', needsReview: false, path: 'b', status: 'failed', type: 'ADD'},
        ]),
      )
      trackStub.resetHistory()

      await hook.onTaskCompleted(task.taskId, '', task)

      const props = m12Calls()[0].args[1] as Record<string, unknown>
      expect(props.outcome).to.equal('partial')
      expect(props.operations_failed).to.equal(1)
    })

    it('emits outcome=error on onTaskError', async () => {
      const task = buildCurateTask()
      await hook.onTaskCreate(task)
      trackStub.resetHistory()

      await hook.onTaskError(task.taskId, 'boom', task)

      const props = m12Calls()[0].args[1] as Record<string, unknown>
      expect(props.outcome).to.equal('error')
    })

    it('emits outcome=cancelled on onTaskCancelled', async () => {
      const task = buildCurateTask()
      await hook.onTaskCreate(task)
      trackStub.resetHistory()

      await hook.onTaskCancelled(task.taskId, task)

      const props = m12Calls()[0].args[1] as Record<string, unknown>
      expect(props.outcome).to.equal('cancelled')
    })

    it('counts UPSERT with "created new" message as added; otherwise as updated', async () => {
      const task = buildCurateTask()
      await hook.onTaskCreate(task)
      await hook.onToolResult(
        task.taskId,
        buildToolResult([
          {filePath: '/a.md', message: 'created new entry', path: 'a', status: 'success', type: 'UPSERT'},
          {filePath: '/b.md', message: 'updated existing entry', path: 'b', status: 'success', type: 'UPSERT'},
        ]),
      )
      trackStub.resetHistory()

      await hook.onTaskCompleted(task.taskId, '', task)

      const props = m12Calls()[0].args[1] as Record<string, unknown>
      expect(props.operations_added).to.equal(1)
      expect(props.operations_updated).to.equal(1)
    })

    it('counts pending review when needsReview=true on a successful op', async () => {
      const task = buildCurateTask()
      await hook.onTaskCreate(task)
      await hook.onToolResult(
        task.taskId,
        buildToolResult([
          {filePath: '/a.md', needsReview: true, path: 'a', status: 'success', type: 'ADD'},
          {filePath: '/b.md', needsReview: true, path: 'b', status: 'success', type: 'UPDATE'},
        ]),
      )
      trackStub.resetHistory()

      await hook.onTaskCompleted(task.taskId, '', task)

      const props = m12Calls()[0].args[1] as Record<string, unknown>
      expect(props.pending_review_count).to.equal(2)
    })

    it('uses task_type literal from task (curate-folder)', async () => {
      const task = buildCurateTask({type: 'curate-folder'})
      await hook.onTaskCreate(task)
      await hook.onTaskCompleted(task.taskId, '', task)

      const props = m12Calls()[0].args[1] as Record<string, unknown>
      expect(props.task_type).to.equal('curate-folder')
    })

    it('skips emitting op when op.filePath is missing (avoids invalid payload)', async () => {
      const task = buildCurateTask()
      await hook.onTaskCreate(task)
      await hook.onToolResult(
        task.taskId,
        buildToolResult([{needsReview: false, path: 'a', status: 'success', type: 'ADD'}]),
      )

      // No curate_operation_applied for an op missing filePath. (TASK_CREATED
      // still fires from onTaskCreate — filtered out via m12Calls().)
      expect(m12Calls()).to.have.lengthOf(0)
    })
  })

  describe('query task flow', () => {
    it('emits query_completed at terminal with derived counts + paths', async () => {
      const task = buildQueryTask({
        toolCalls: [
          {args: {filePath: '/a.md'}, sessionId: 's', status: 'completed', timestamp: 1, toolName: 'read_file'},
          {args: {filePath: '/b.md'}, sessionId: 's', status: 'completed', timestamp: 2, toolName: 'read_file'},
          {args: {filePath: '/a.md'}, sessionId: 's', status: 'completed', timestamp: 3, toolName: 'read_file'},
          {
            args: {stubPath: '/c.md'},
            sessionId: 's',
            status: 'completed',
            timestamp: 4,
            toolName: 'expand_knowledge',
          },
          {args: {query: 'foo'}, sessionId: 's', status: 'completed', timestamp: 5, toolName: 'search_knowledge'},
        ],
      } as Partial<TaskInfo>)

      await hook.onTaskCreate(task)
      hook.setQueryResult(task.taskId, {
        matchedDocs: [],
        searchMetadata: {resultCount: 7, topScore: 0.9, totalFound: 7},
        tier: 3,
        timing: {durationMs: 1234},
      } as QueryResultMetadata)
      await hook.onTaskCompleted(task.taskId, '', task)

      expect(m12Calls()).to.have.lengthOf(1)
      expect(m12Calls()[0].args[0]).to.equal(AnalyticsEventNames.QUERY_COMPLETED)
      const props = m12Calls()[0].args[1] as Record<string, unknown>
      expect(props.task_id).to.equal(task.taskId)
      expect(props.task_type).to.equal('query')
      expect(props.outcome).to.equal('completed')
      expect(props.duration_ms).to.equal(1234)
      expect(props.read_tool_call_count).to.equal(4) // 3 read_file + 1 expand_knowledge
      expect(props.search_call_count).to.equal(1)
      expect(props.read_doc_count).to.equal(3) // distinct: /a.md, /b.md, /c.md
      expect(props.tier).to.equal(3)
      expect(props.cache_hit).to.equal(false)
      expect(props.matched_doc_count).to.equal(7)
      const paths = props.read_paths_with_metadata as Array<Record<string, unknown>>
      expect(paths).to.have.lengthOf(3)
      // sorted lexicographically; relativized against projectPath:'/project'
      expect(paths.map((p) => p.relative_path)).to.deep.equal([
        '<outside-project>/a.md',
        '<outside-project>/b.md',
        '<outside-project>/c.md',
      ])
      // each entry has empty keywords/tags arrays and an empty related_paths
      // list — no frontmatter source files exist in this in-memory test.
      for (const entry of paths) {
        expect(entry.tags).to.deep.equal([])
        expect(entry.keywords).to.deep.equal([])
        expect(entry.related_paths).to.deep.equal([])
      }
    })

    it('caps read_paths_with_metadata at 10 entries even when more distinct paths exist', async () => {
      const toolCalls = Array.from({length: 15}, (_, i) => ({
        args: {filePath: `/file-${String(i).padStart(2, '0')}.md`},
        sessionId: 's',
        status: 'completed' as const,
        timestamp: i,
        toolName: 'read_file',
      }))
      const task = buildQueryTask({toolCalls} as Partial<TaskInfo>)

      await hook.onTaskCreate(task)
      await hook.onTaskCompleted(task.taskId, '', task)

      const props = m12Calls()[0].args[1] as Record<string, unknown>
      const paths = props.read_paths_with_metadata as Array<Record<string, unknown>>
      expect(paths).to.have.lengthOf(10)
      expect(props.read_doc_count).to.equal(15) // distinct count NOT capped
    })

    for (const tier of [0, 1] as const) {
      it(`cache_hit is true for tier ${tier}`, async () => {
        const localBundle = buildAnalyticsClient()
        const localHook = new AnalyticsHook()
        localHook.setAnalyticsClient(localBundle.client)
        const task = buildQueryTask({taskId: `task-tier-${tier}`})

        await localHook.onTaskCreate(task)
        localHook.setQueryResult(task.taskId, {
          matchedDocs: [],
          tier,
          timing: {durationMs: 5},
        } as QueryResultMetadata)
        await localHook.onTaskCompleted(task.taskId, '', task)

        const props = filterM12(localBundle.trackStub)[0].args[1] as Record<string, unknown>
        expect(props.cache_hit).to.equal(true)
      })
    }

    for (const tier of [2, 3, 4] as const) {
      it(`cache_hit is false for tier ${tier}`, async () => {
        const localBundle = buildAnalyticsClient()
        const localHook = new AnalyticsHook()
        localHook.setAnalyticsClient(localBundle.client)
        const task = buildQueryTask({taskId: `task-tier-${tier}`})

        await localHook.onTaskCreate(task)
        localHook.setQueryResult(task.taskId, {
          matchedDocs: [],
          tier,
          timing: {durationMs: 5},
        } as QueryResultMetadata)
        await localHook.onTaskCompleted(task.taskId, '', task)

        const props = filterM12(localBundle.trackStub)[0].args[1] as Record<string, unknown>
        expect(props.cache_hit).to.equal(false)
      })
    }

    it('emits tier absent + cache_hit=false + matched_doc_count=0 when setQueryResult never ran', async () => {
      const task = buildQueryTask()
      await hook.onTaskCreate(task)
      await hook.onTaskCompleted(task.taskId, '', task)

      const props = m12Calls()[0].args[1] as Record<string, unknown>
      expect(props.tier).to.equal(undefined)
      expect(props.cache_hit).to.equal(false)
      expect(props.matched_doc_count).to.equal(0)
    })

    it('omits read_paths_with_metadata when the command had no read paths (matches optional schema)', async () => {
      const task = buildQueryTask() // empty toolCalls
      await hook.onTaskCreate(task)
      await hook.onTaskCompleted(task.taskId, '', task)

      const props = m12Calls()[0].args[1] as Record<string, unknown>
      expect(props).to.not.have.property('read_paths_with_metadata')
      // Sanity: counts are zero, not omitted.
      expect(props.read_doc_count).to.equal(0)
      expect(props.read_tool_call_count).to.equal(0)
    })

    it('emits outcome=error on onTaskError for query', async () => {
      const task = buildQueryTask()
      await hook.onTaskCreate(task)

      await hook.onTaskError(task.taskId, 'boom', task)

      const props = m12Calls()[0].args[1] as Record<string, unknown>
      expect(props.outcome).to.equal('error')
    })

    it('emits outcome=cancelled on onTaskCancelled for query', async () => {
      const task = buildQueryTask()
      await hook.onTaskCreate(task)

      await hook.onTaskCancelled(task.taskId, task)

      const props = m12Calls()[0].args[1] as Record<string, unknown>
      expect(props.outcome).to.equal('cancelled')
    })
  })

  describe('lifecycle hygiene', () => {
    it('cleanup(taskId) drops state for both flavors', async () => {
      const curate = buildCurateTask()
      const query = buildQueryTask()
      await hook.onTaskCreate(curate)
      await hook.onTaskCreate(query)
      hook.cleanup(curate.taskId)
      hook.cleanup(query.taskId)

      // After cleanup, M12 per-flavor emits must NOT fire (no state to read).
      // M14.3 generic TASK_COMPLETED still fires unconditionally — filtered.
      trackStub.resetHistory()
      await hook.onTaskCompleted(curate.taskId, '', curate)
      await hook.onTaskCompleted(query.taskId, '', query)
      expect(m12Calls()).to.have.lengthOf(0)
    })

    it('ignores unknown task types (no M12 state created; only generic task_* emits fire)', async () => {
      const task = buildCurateTask({taskId: 'task-unknown', type: 'unknown' as TaskInfo['type']})
      await hook.onTaskCreate(task)
      await hook.onTaskCompleted(task.taskId, '', task)
      expect(m12Calls()).to.have.lengthOf(0)
    })

    it('swallows analyticsClient.track throws (does not propagate)', async () => {
      trackStub.throws(new Error('boom'))
      const task = buildCurateTask()
      await hook.onTaskCreate(task)
      await hook.onToolResult(
        task.taskId,
        buildToolResult([{filePath: '/a.md', needsReview: false, path: 'a', status: 'success', type: 'ADD'}]),
      )
      // No throw means swallowed
      expect(trackStub.called).to.equal(true)
    })

    it('emit is a no-op when setAnalyticsClient was never called (originally curate emit)', async () => {
      const bareHook = new AnalyticsHook()
      const task = buildCurateTask()
      await bareHook.onTaskCreate(task)
      // No throws, no client to assert against
      await bareHook.onToolResult(
        task.taskId,
        buildToolResult([{filePath: '/a.md', needsReview: false, path: 'a', status: 'success', type: 'ADD'}]),
      )
      await bareHook.onTaskCompleted(task.taskId, '', task)
    })
  })

  describe('M12.3 frontmatter harvest', () => {
    let tmpDir: string

    beforeEach(() => {
      tmpDir = mkdtempSync(join(tmpdir(), 'analytics-hook-'))
    })

    afterEach(() => {
      rmSync(tmpDir, {force: true, recursive: true})
    })

    describe('curate emit', () => {
      it('attaches tags/keywords/related from post-op frontmatter on ADD ops', async () => {
        const filePath = join(tmpDir, 'a.md')
        writeMarkdown(filePath, {keywords: ['x', 'y'], related: ['z'], tags: ['t1', 't2']})

        const task = buildCurateTask()
        await hook.onTaskCreate(task)
        await hook.onToolResult(
          task.taskId,
          buildToolResult([{filePath, needsReview: false, path: 'a', status: 'success', type: 'ADD'}]),
        )

        const props = m12Calls()[0].args[1] as Record<string, unknown>
        expect(props.tags).to.deep.equal(['t1', 't2'])
        expect(props.keywords).to.deep.equal(['x', 'y'])
        expect(props.related).to.deep.equal(['z'])
      })

      it('keywords/tags default to empty arrays on DELETE ops (file gone post-op); related stays omitted', async () => {
        const filePath = join(tmpDir, 'gone.md')
        const task = buildCurateTask()
        await hook.onTaskCreate(task)
        await hook.onToolResult(
          task.taskId,
          buildToolResult([{filePath, needsReview: false, path: 'gone', status: 'success', type: 'DELETE'}]),
        )

        const props = m12Calls()[0].args[1] as Record<string, unknown>
        expect(props.tags).to.deep.equal([])
        expect(props.keywords).to.deep.equal([])
        expect(props).to.not.have.property('related')
      })

      it('keywords/tags default to empty arrays when filePath cannot be read (ENOENT)', async () => {
        const filePath = join(tmpDir, 'missing.md')
        const task = buildCurateTask()
        await hook.onTaskCreate(task)
        await hook.onToolResult(
          task.taskId,
          buildToolResult([{filePath, needsReview: false, path: 'm', status: 'success', type: 'UPDATE'}]),
        )

        const props = m12Calls()[0].args[1] as Record<string, unknown>
        expect(props.tags).to.deep.equal([])
        expect(props.keywords).to.deep.equal([])
      })

      it('keywords/tags default to empty arrays on malformed YAML (no throw)', async () => {
        const filePath = join(tmpDir, 'bad.md')
        writeFileSync(filePath, '---\nthis is: not [valid YAML\n---\nbody', 'utf8')

        const task = buildCurateTask()
        await hook.onTaskCreate(task)
        await hook.onToolResult(
          task.taskId,
          buildToolResult([{filePath, needsReview: false, path: 'b', status: 'success', type: 'UPDATE'}]),
        )

        const props = m12Calls()[0].args[1] as Record<string, unknown>
        expect(props.tags).to.deep.equal([])
        expect(props.keywords).to.deep.equal([])
      })

      it('caps arrays at 50 entries and strings at 256 chars per entry', async () => {
        const filePath = join(tmpDir, 'huge.md')
        const overlong = 'x'.repeat(300)
        const sixtyTags = Array.from({length: 60}, (_, i) => `tag-${i}`)
        writeMarkdown(filePath, {tags: [overlong, ...sixtyTags]})

        const task = buildCurateTask()
        await hook.onTaskCreate(task)
        await hook.onToolResult(
          task.taskId,
          buildToolResult([{filePath, needsReview: false, path: 'h', status: 'success', type: 'UPDATE'}]),
        )

        const props = m12Calls()[0].args[1] as Record<string, unknown>
        const tags = props.tags as string[]
        expect(tags).to.have.lengthOf(50)
        expect(tags[0]).to.have.lengthOf(256)
      })

      it('skips file reads entirely when isEnabled() returns false; keywords/tags fall back to []', async () => {
        const filePath = join(tmpDir, 'gated.md')
        writeMarkdown(filePath, {tags: ['should-not-appear']})

        const disabledBundle = buildAnalyticsClient()
        const disabledHook = new AnalyticsHook({isEnabled: () => false})
        disabledHook.setAnalyticsClient(disabledBundle.client)
        const task = buildCurateTask({taskId: 'task-gated'})

        await disabledHook.onTaskCreate(task)
        await disabledHook.onToolResult(
          task.taskId,
          buildToolResult([{filePath, needsReview: false, path: 'g', status: 'success', type: 'UPDATE'}]),
        )

        const props = filterM12(disabledBundle.trackStub)[0].args[1] as Record<string, unknown>
        expect(props.tags).to.deep.equal([])
        expect(props.keywords).to.deep.equal([])
      })
    })

    describe('query emit', () => {
      it('attaches per-path frontmatter to read_paths_with_metadata entries', async () => {
        const a = join(tmpDir, 'a.md')
        const b = join(tmpDir, 'b.md')
        writeMarkdown(a, {tags: ['ta']})
        writeMarkdown(b, {keywords: ['kb']})

        // Pin projectPath to tmpDir so relative_path == 'a.md' / 'b.md'.
        const task = buildQueryTask({
          projectPath: tmpDir,
          toolCalls: [
            {args: {filePath: a}, sessionId: 's', status: 'completed', timestamp: 1, toolName: 'read_file'},
            {args: {filePath: b}, sessionId: 's', status: 'completed', timestamp: 2, toolName: 'read_file'},
          ],
        } as Partial<TaskInfo>)

        await hook.onTaskCreate(task)
        await hook.onTaskCompleted(task.taskId, '', task)

        const props = m12Calls()[0].args[1] as Record<string, unknown>
        const paths = props.read_paths_with_metadata as Array<Record<string, unknown>>
        const byPath = Object.fromEntries(paths.map((p) => [p.relative_path, p]))
        expect(byPath['a.md'].tags).to.deep.equal(['ta'])
        expect(byPath['a.md'].keywords).to.deep.equal([])
        expect(byPath['b.md'].keywords).to.deep.equal(['kb'])
        expect(byPath['b.md'].tags).to.deep.equal([])
      })

      it('mixed readable + ENOENT paths: each entry has keywords/tags arrays (populated or empty)', async () => {
        const real = join(tmpDir, 'real.md')
        const missing = join(tmpDir, 'missing.md')
        writeMarkdown(real, {tags: ['ok']})

        const task = buildQueryTask({
          projectPath: tmpDir,
          toolCalls: [
            {args: {filePath: real}, sessionId: 's', status: 'completed', timestamp: 1, toolName: 'read_file'},
            {args: {filePath: missing}, sessionId: 's', status: 'completed', timestamp: 2, toolName: 'read_file'},
          ],
        } as Partial<TaskInfo>)

        await hook.onTaskCreate(task)
        await hook.onTaskCompleted(task.taskId, '', task)

        const props = m12Calls()[0].args[1] as Record<string, unknown>
        const paths = props.read_paths_with_metadata as Array<Record<string, unknown>>
        const byPath = Object.fromEntries(paths.map((p) => [p.relative_path, p]))
        expect(byPath['real.md'].tags).to.deep.equal(['ok'])
        expect(byPath['missing.md'].tags).to.deep.equal([])
        expect(byPath['missing.md'].keywords).to.deep.equal([])
      })

      it('skips per-path file reads when isEnabled() returns false', async () => {
        const filePath = join(tmpDir, 'gated-query.md')
        writeMarkdown(filePath, {tags: ['should-not-appear']})

        const disabledBundle = buildAnalyticsClient()
        const disabledHook = new AnalyticsHook({isEnabled: () => false})
        disabledHook.setAnalyticsClient(disabledBundle.client)

        const task = buildQueryTask({
          taskId: 'task-q-gated',
          toolCalls: [
            {args: {filePath}, sessionId: 's', status: 'completed', timestamp: 1, toolName: 'read_file'},
          ],
        } as Partial<TaskInfo>)

        await disabledHook.onTaskCreate(task)
        await disabledHook.onTaskCompleted(task.taskId, '', task)

        const props = filterM12(disabledBundle.trackStub)[0].args[1] as Record<string, unknown>
        const paths = props.read_paths_with_metadata as Array<Record<string, unknown>>
        expect(paths[0].tags).to.deep.equal([])
        expect(paths[0].keywords).to.deep.equal([])
      })
    })
  })

  describe('async safety (per-task serialization)', () => {
    it('serializes concurrent onToolResult calls for the same task in arrival order', async () => {
      // Without the per-task queue, resolving the 2nd read first would cause op2's emit
      // to land before op1. The queue must enforce arrival order regardless of read
      // completion order.
      const d1 = defer<string>()
      const d2 = defer<string>()
      const stubReadFile = stubReadFileFromQueue(d1.promise, d2.promise)

      const bundle = buildAnalyticsClient()
      const queueHook = new AnalyticsHook({readFile: stubReadFile})
      queueHook.setAnalyticsClient(bundle.client)

      const task = buildCurateTask({taskId: 'task-queue-1'})
      await queueHook.onTaskCreate(task)

      const payload1 = buildToolResult([
        {filePath: '/op1.md', needsReview: false, path: 'notes/op1', status: 'success', type: 'ADD'},
      ])
      const payload2 = buildToolResult([
        {filePath: '/op2.md', needsReview: false, path: 'notes/op2', status: 'success', type: 'ADD'},
      ])

      const p1 = queueHook.onToolResult(task.taskId, payload1)
      const p2 = queueHook.onToolResult(task.taskId, payload2)

      // Resolve in reverse order — the queue must still emit op1 first.
      d2.resolve(buildFrontmatterDoc('tag-op2'))
      d1.resolve(buildFrontmatterDoc('tag-op1'))

      await Promise.all([p1, p2])

      expect(filterM12(bundle.trackStub)).to.have.lengthOf(2)
      const first = filterM12(bundle.trackStub)[0].args[1] as Record<string, unknown>
      const second = filterM12(bundle.trackStub)[1].args[1] as Record<string, unknown>
      // buildCurateTask projectPath:'/project'; absolute paths relativize with '../' prefix
      expect(first.relative_path, 'first emit must be op1').to.equal('<outside-project>/op1.md')
      expect(second.relative_path, 'second emit must be op2').to.equal('<outside-project>/op2.md')
    })

    it('onTaskCompleted waits for in-flight onToolResult work before emitting CURATE_RUN_COMPLETED', async () => {
      // The terminal emit MUST follow every per-op emit on the wire, even if the per-op
      // read is still pending when onTaskCompleted fires.
      const d = defer<string>()
      const stubReadFile = stubReadFileAlways(d.promise)
      const bundle = buildAnalyticsClient()
      const orderHook = new AnalyticsHook({readFile: stubReadFile})
      orderHook.setAnalyticsClient(bundle.client)

      const task = buildCurateTask({taskId: 'task-order-1'})
      await orderHook.onTaskCreate(task)

      const payload = buildToolResult([
        {filePath: '/in-flight.md', needsReview: false, path: 'notes/x', status: 'success', type: 'ADD'},
      ])

      // Kick off the op processing (read pending), then immediately request terminal.
      const opPromise = orderHook.onToolResult(task.taskId, payload)
      const completePromise = orderHook.onTaskCompleted(task.taskId, '', task)

      // Neither M12 emit can have fired yet — read is still pending. (TASK_CREATED
      // from M14.3 already fired during onTaskCreate but doesn't gate on the read.)
      expect(filterM12(bundle.trackStub), 'no M12 emit before read settles').to.have.lengthOf(0)

      d.resolve(buildFrontmatterDoc('tag-x'))
      await Promise.all([opPromise, completePromise])

      expect(filterM12(bundle.trackStub)).to.have.lengthOf(2)
      expect(filterM12(bundle.trackStub)[0].args[0]).to.equal(AnalyticsEventNames.CURATE_OPERATION_APPLIED)
      expect(filterM12(bundle.trackStub)[1].args[0]).to.equal(AnalyticsEventNames.CURATE_RUN_COMPLETED)
    })

    it('readFile rejection is swallowed: emit fires with frontmatter fields omitted; daemon does not crash', async () => {
      const stubReadFile = stubReadFileAlways(Promise.reject(new Error('disk full')))
      const bundle = buildAnalyticsClient()
      const errorHook = new AnalyticsHook({readFile: stubReadFile})
      errorHook.setAnalyticsClient(bundle.client)

      const task = buildCurateTask({taskId: 'task-err-1'})
      await errorHook.onTaskCreate(task)

      const payload = buildToolResult([
        {filePath: '/missing.md', needsReview: false, path: 'notes/missing', status: 'success', type: 'ADD'},
      ])

      await errorHook.onToolResult(task.taskId, payload)

      expect(filterM12(bundle.trackStub)).to.have.lengthOf(1)
      const props = filterM12(bundle.trackStub)[0].args[1] as Record<string, unknown>
      // /missing.md escapes the '/project' root — PR #722 outside-project sentinel.
      expect(props.relative_path).to.equal('<outside-project>/missing.md')
      expect(props.keywords).to.deep.equal([])
      expect(props.tags).to.deep.equal([])
      expect(props).to.not.have.property('related')
    })

    it('cleanup removes per-task pending-queue entry to prevent unbounded growth', async () => {
      const stubReadFile = stubReadFileAlways(Promise.resolve('---\n---\n'))
      const bundle = buildAnalyticsClient()
      const cleanupHook = new AnalyticsHook({readFile: stubReadFile})
      cleanupHook.setAnalyticsClient(bundle.client)

      const task = buildCurateTask({taskId: 'task-cleanup-1'})
      await cleanupHook.onTaskCreate(task)
      await cleanupHook.onToolResult(task.taskId, buildToolResult([
        {filePath: '/x.md', needsReview: false, path: 'notes/x', status: 'success', type: 'ADD'},
      ]))
      await cleanupHook.onTaskCompleted(task.taskId, '', task)
      cleanupHook.cleanup(task.taskId)

      // After cleanup, internal state must be empty. We don't expose pendingByTask
      // directly, but the assertion below catches the leak: a new task with the same
      // id observes a fresh in-memory state.
      await cleanupHook.onTaskCreate(task)
      // M12 emits: 1 curate_operation_applied + 1 curate_run_completed = 2.
      // Re-creating the task after cleanup must NOT replay either; it only
      // adds another TASK_CREATED (filtered out below).
      expect(filterM12(bundle.trackStub), 'no replay after cleanup').to.have.lengthOf(2)
    })
  })

  describe('identity stamping (space_id + team_id)', () => {
    it('stamps both space_id and team_id on curate_run_completed when getIdentity returns them', async () => {
      const bundle = buildAnalyticsClient()
      const spacedHook = new AnalyticsHook({getIdentity: async () => ({spaceId: 'space-abc', teamId: 'team-abc'})})
      spacedHook.setAnalyticsClient(bundle.client)

      const task = buildCurateTask()
      await spacedHook.onTaskCreate(task)
      await spacedHook.onTaskCompleted(task.taskId, '', task)

      const curateProps = findEmit(bundle.trackStub, AnalyticsEventNames.CURATE_RUN_COMPLETED)
      expect(curateProps.space_id).to.equal('space-abc')
      expect(curateProps.team_id).to.equal('team-abc')
    })

    it('stamps both space_id and team_id on query_completed when getIdentity returns them', async () => {
      const bundle = buildAnalyticsClient()
      const spacedHook = new AnalyticsHook({getIdentity: async () => ({spaceId: 'space-xyz', teamId: 'team-xyz'})})
      spacedHook.setAnalyticsClient(bundle.client)

      const task = buildQueryTask()
      await spacedHook.onTaskCreate(task)
      await spacedHook.onTaskCompleted(task.taskId, '', task)

      const queryProps = findEmit(bundle.trackStub, AnalyticsEventNames.QUERY_COMPLETED)
      expect(queryProps.space_id).to.equal('space-xyz')
      expect(queryProps.team_id).to.equal('team-xyz')
    })

    it('stamps team_id alone when spaceId is absent (mid-onboarding state)', async () => {
      const bundle = buildAnalyticsClient()
      const spacedHook = new AnalyticsHook({getIdentity: async () => ({teamId: 'team-only'})})
      spacedHook.setAnalyticsClient(bundle.client)

      const task = buildCurateTask()
      await spacedHook.onTaskCreate(task)
      await spacedHook.onTaskCompleted(task.taskId, '', task)

      const curateProps = findEmit(bundle.trackStub, AnalyticsEventNames.CURATE_RUN_COMPLETED)
      expect(curateProps.team_id).to.equal('team-only')
      expect(curateProps).to.not.have.property('space_id')
    })

    it('stamps space_id alone when teamId is absent', async () => {
      const bundle = buildAnalyticsClient()
      const spacedHook = new AnalyticsHook({getIdentity: async () => ({spaceId: 'space-only'})})
      spacedHook.setAnalyticsClient(bundle.client)

      const task = buildQueryTask()
      await spacedHook.onTaskCreate(task)
      await spacedHook.onTaskCompleted(task.taskId, '', task)

      const queryProps = findEmit(bundle.trackStub, AnalyticsEventNames.QUERY_COMPLETED)
      expect(queryProps.space_id).to.equal('space-only')
      expect(queryProps).to.not.have.property('team_id')
    })

    it('omits both fields when getIdentity returns {} (standalone project)', async () => {
      const bundle = buildAnalyticsClient()
      const spacedHook = new AnalyticsHook({getIdentity: async () => ({})})
      spacedHook.setAnalyticsClient(bundle.client)

      const task = buildCurateTask()
      await spacedHook.onTaskCreate(task)
      await spacedHook.onTaskCompleted(task.taskId, '', task)

      const curateProps = findEmit(bundle.trackStub, AnalyticsEventNames.CURATE_RUN_COMPLETED)
      expect(curateProps).to.not.have.property('space_id')
      expect(curateProps).to.not.have.property('team_id')
    })

    it('normalizes empty strings to omitted fields', async () => {
      const bundle = buildAnalyticsClient()
      const spacedHook = new AnalyticsHook({getIdentity: async () => ({spaceId: '', teamId: ''})})
      spacedHook.setAnalyticsClient(bundle.client)

      const task = buildQueryTask()
      await spacedHook.onTaskCreate(task)
      await spacedHook.onTaskCompleted(task.taskId, '', task)

      const queryProps = findEmit(bundle.trackStub, AnalyticsEventNames.QUERY_COMPLETED)
      expect(queryProps).to.not.have.property('space_id')
      expect(queryProps).to.not.have.property('team_id')
    })

    it('omits both fields and still emits when getIdentity throws', async () => {
      const bundle = buildAnalyticsClient()
      const spacedHook = new AnalyticsHook({
        async getIdentity() {
          throw new Error('config disk unreadable')
        },
      })
      spacedHook.setAnalyticsClient(bundle.client)

      const task = buildCurateTask()
      await spacedHook.onTaskCreate(task)
      await spacedHook.onTaskCompleted(task.taskId, '', task)

      const curateProps = findEmit(bundle.trackStub, AnalyticsEventNames.CURATE_RUN_COMPLETED)
      expect(curateProps).to.not.have.property('space_id')
      expect(curateProps).to.not.have.property('team_id')
      // Funnel emit still lands — getIdentity failure must not block the run-completion emit.
      expect(curateProps.task_type).to.equal('curate')
    })

    it('also stamps both fields on the failure-path emits (onTaskError)', async () => {
      const bundle = buildAnalyticsClient()
      const spacedHook = new AnalyticsHook({getIdentity: async () => ({spaceId: 'space-fail', teamId: 'team-fail'})})
      spacedHook.setAnalyticsClient(bundle.client)

      const task = buildCurateTask()
      await spacedHook.onTaskCreate(task)
      await spacedHook.onTaskError(task.taskId, 'boom', task)

      const curateProps = findEmit(bundle.trackStub, AnalyticsEventNames.CURATE_RUN_COMPLETED)
      expect(curateProps.outcome).to.equal('error')
      expect(curateProps.space_id).to.equal('space-fail')
      expect(curateProps.team_id).to.equal('team-fail')
    })
  })
})
