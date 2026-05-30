/* eslint-disable camelcase */
import type {ITransportClient} from '@campfirein/brv-transport-client'

import {expect} from 'chai'
import sinon from 'sinon'

import type {CurateLogOperation} from '../../../../../src/server/core/domain/entities/curate-log-entry.js'
import type {
  QueryToolModeMatchedDoc,
  QueryToolModeMetadata,
} from '../../../../../src/server/core/interfaces/executor/i-query-executor.js'

import {LlmEventNames} from '../../../../../src/server/core/domain/transport/schemas.js'
import {
  emitSyntheticCurateToolResult,
  emitSyntheticQueryToolCalls,
} from '../../../../../src/server/infra/process/synthetic-tool-result-emit.js'
import {extractCurateOperations} from '../../../../../src/server/utils/curate-result-parser.js'

const buildTransport = (): {requestStub: sinon.SinonStub; transport: ITransportClient} => {
  const requestStub = sinon.stub().resolves()
  const transport = {request: requestStub} as unknown as ITransportClient
  return {requestStub, transport}
}

const buildMatchedDoc = (overrides: Partial<QueryToolModeMatchedDoc> = {}): QueryToolModeMatchedDoc => ({
  format: 'markdown',
  path: 'topics/intro.md',
  rendered_md: '## stub',
  score: 0.5,
  title: 'Intro',
  ...overrides,
})

const buildMetadata = (overrides: Partial<QueryToolModeMetadata> = {}): QueryToolModeMetadata => ({
  cacheHit: null,
  durationMs: 12,
  skippedSharedCount: 0,
  tier: 2,
  topScore: 0.72,
  totalFound: 1,
  ...overrides,
})

describe('synthetic-tool-result-emit (M17 tool-mode gap fix)', () => {
  describe('emitSyntheticCurateToolResult', () => {
    it('dispatches an llmservice:toolResult that round-trips through extractCurateOperations', () => {
      const {requestStub, transport} = buildTransport()
      const operations: CurateLogOperation[] = [
        {
          confidence: 'high',
          filePath: '/proj/.brv/context-tree/topic.html',
          impact: 'high',
          needsReview: true,
          path: 'analytics/topic',
          status: 'success',
          type: 'ADD',
        },
      ]

      emitSyntheticCurateToolResult({operations, taskId: 'task-1', transport})

      expect(requestStub.calledOnce).to.equal(true)
      const [eventName, payload] = requestStub.firstCall.args as [string, Record<string, unknown>]
      expect(eventName).to.equal(LlmEventNames.TOOL_RESULT)
      expect(payload.toolName).to.equal('curate')
      expect(payload.success).to.equal(true)
      expect(payload.taskId).to.equal('task-1')
      // M17: marker tells TaskRouter to skip the per-client broadcast so
      // synthetic envelopes never surface in CLI / TUI / MCP / webui.
      expect(payload.metadata).to.deep.equal({_synthetic: true})

      // The result must round-trip through the parser AnalyticsHook uses,
      // otherwise the synthetic envelope is dead-on-arrival downstream.
      const parsed = extractCurateOperations({
        result: payload.result as string,
        toolName: 'curate',
      })
      expect(parsed).to.have.length(1)
      expect(parsed[0]).to.deep.include({
        filePath: '/proj/.brv/context-tree/topic.html',
        path: 'analytics/topic',
        status: 'success',
        type: 'ADD',
      })
    })

    it('skips emit when operations array is empty', () => {
      const {requestStub, transport} = buildTransport()
      emitSyntheticCurateToolResult({operations: [], taskId: 'task-1', transport})
      expect(requestStub.called).to.equal(false)
    })

    it('preserves a failed op so curate_run_completed.operations_failed bumps correctly', () => {
      const {requestStub, transport} = buildTransport()
      const operations: CurateLogOperation[] = [
        {path: 'analytics/topic', status: 'failed', type: 'ADD'},
      ]

      emitSyntheticCurateToolResult({operations, taskId: 'task-1', transport})

      expect(requestStub.calledOnce).to.equal(true)
      const parsed = extractCurateOperations({
        result: requestStub.firstCall.args[1].result,
        toolName: 'curate',
      })
      expect(parsed[0].status).to.equal('failed')
    })

    it('swallows synchronous transport throws and logs', () => {
      const requestStub = sinon.stub().throws(new Error('boom'))
      const transport = {request: requestStub} as unknown as ITransportClient
      const logStub = sinon.stub()

      expect(() =>
        emitSyntheticCurateToolResult({
          log: logStub,
          operations: [{path: 'x', status: 'success', type: 'ADD'}],
          taskId: 'task-1',
          transport,
        }),
      ).to.not.throw()
      expect(logStub.calledOnce).to.equal(true)
      expect(logStub.firstCall.args[0]).to.include('synthetic curate toolResult emit failed')
      expect(logStub.firstCall.args[0]).to.include('sync throw')
    })

    it('does not let a throwing log callback escape on the sync-throw path', () => {
      const requestStub = sinon.stub().throws(new Error('boom'))
      const transport = {request: requestStub} as unknown as ITransportClient
      const throwingLog = sinon.stub().throws(new Error('log sink exploded'))

      expect(() =>
        emitSyntheticCurateToolResult({
          log: throwingLog,
          operations: [{path: 'x', status: 'success', type: 'ADD'}],
          taskId: 'task-1',
          transport,
        }),
      ).to.not.throw()
      expect(throwingLog.calledOnce, 'the log sink was invoked (and its throw swallowed)').to.equal(true)
    })

    it('swallows async transport rejections and logs (PR #728 review fix)', async () => {
      const requestStub = sinon.stub().rejects(new Error('socket dead'))
      const transport = {request: requestStub} as unknown as ITransportClient
      const logStub = sinon.stub()

      emitSyntheticCurateToolResult({
        log: logStub,
        operations: [{path: 'x', status: 'success', type: 'ADD'}],
        taskId: 'task-1',
        transport,
      })

      // Async rejection runs on the microtask queue — yield once so the
      // catch handler fires before we assert. Without this, the log
      // assertion races the rejection.
      await new Promise((res) => {
        setImmediate(res)
      })

      expect(logStub.calledOnce).to.equal(true)
      expect(logStub.firstCall.args[0]).to.include('synthetic curate toolResult emit failed')
      expect(logStub.firstCall.args[0]).to.include('async rejection')
    })
  })

  describe('emitSyntheticQueryToolCalls', () => {
    it('fires paired toolCall+toolResult for search_knowledge + one pair per matched doc (PR #728 review fix)', () => {
      const {requestStub, transport} = buildTransport()

      emitSyntheticQueryToolCalls({
        matchedDocs: [
          buildMatchedDoc({path: 'a.md'}),
          buildMatchedDoc({path: 'b.md'}),
        ],
        metadata: buildMetadata({totalFound: 2}),
        projectPath: '/proj',
        taskId: 'task-q',
        transport,
      })

      // 1 search_knowledge toolCall + 1 toolResult, then 2 docs × (call+result) = 6.
      // The pair is what flips the accumulator's `status: 'running'` to
      // `'completed'` in `TaskRouter.accumulateLlmEvent`; without it the
      // synthetic call would be stuck running for the task's lifetime.
      expect(requestStub.callCount).to.equal(6)

      // Every emission carries the synthetic marker so TaskRouter skips the
      // per-client broadcast (M17 — see SYNTHETIC_EVENT_METADATA docblock).
      for (const call of requestStub.getCalls()) {
        expect(call.args[1].metadata).to.deep.equal({_synthetic: true})
      }

      // Call/result pairs share a callId so the accumulator matches them.
      const calls = requestStub.getCalls()
      const search = {call: calls[0], result: calls[1]}
      expect(search.call.args[0]).to.equal(LlmEventNames.TOOL_CALL)
      expect(search.call.args[1].toolName).to.equal('search_knowledge')
      expect(search.result.args[0]).to.equal(LlmEventNames.TOOL_RESULT)
      expect(search.result.args[1].toolName).to.equal('search_knowledge')
      expect(search.result.args[1].callId).to.equal(search.call.args[1].callId)
      expect(search.result.args[1].success).to.equal(true)

      // Per-doc pairs: one call + one result per matched doc, callIds aligned.
      const readPairs = [
        {call: calls[2], result: calls[3]},
        {call: calls[4], result: calls[5]},
      ]
      for (const [i, pair] of readPairs.entries()) {
        expect(pair.call.args[0]).to.equal(LlmEventNames.TOOL_CALL)
        expect(pair.call.args[1].toolName).to.equal('read_file')
        expect(pair.call.args[1].args.filePath).to.equal(
          ['/proj/.brv/context-tree/a.md', '/proj/.brv/context-tree/b.md'][i],
        )
        expect(pair.result.args[0]).to.equal(LlmEventNames.TOOL_RESULT)
        expect(pair.result.args[1].toolName).to.equal('read_file')
        expect(pair.result.args[1].callId).to.equal(pair.call.args[1].callId)
        expect(pair.result.args[1].success).to.equal(true)
      }
    })

    it('emits only the search_knowledge call+result pair when no docs matched', () => {
      const {requestStub, transport} = buildTransport()

      emitSyntheticQueryToolCalls({
        matchedDocs: [],
        metadata: buildMetadata({totalFound: 0}),
        projectPath: '/proj',
        taskId: 'task-q',
        transport,
      })

      expect(requestStub.callCount).to.equal(2)
      expect(requestStub.getCall(0).args[0]).to.equal(LlmEventNames.TOOL_CALL)
      expect(requestStub.getCall(0).args[1].toolName).to.equal('search_knowledge')
      expect(requestStub.getCall(0).args[1].args.matchedCount).to.equal(0)
      expect(requestStub.getCall(1).args[0]).to.equal(LlmEventNames.TOOL_RESULT)
      expect(requestStub.getCall(1).args[1].callId).to.equal(requestStub.getCall(0).args[1].callId)
    })

    it('does NOT leak the raw query string into args (privacy guard)', () => {
      const {requestStub, transport} = buildTransport()

      emitSyntheticQueryToolCalls({
        matchedDocs: [buildMatchedDoc()],
        metadata: buildMetadata(),
        projectPath: '/proj',
        taskId: 'task-q',
        transport,
      })

      for (const call of requestStub.getCalls()) {
        // toolCall envelopes carry `args`; toolResult envelopes carry `result`.
        // Either way, the raw query string MUST NOT appear anywhere in the payload.
        const payload = call.args[1] as Record<string, unknown>
        const args = payload.args as Record<string, unknown> | undefined
        if (args) expect(args).to.not.have.property('query')
        // The result string also MUST NOT carry it.
        if (typeof payload.result === 'string') {
          expect(payload.result.toLowerCase()).to.not.include('query')
        }
      }
    })

    it('swallows synchronous transport throws and logs (per emit site)', () => {
      const requestStub = sinon.stub().throws(new Error('socket dead'))
      const transport = {request: requestStub} as unknown as ITransportClient
      const logStub = sinon.stub()

      expect(() =>
        emitSyntheticQueryToolCalls({
          log: logStub,
          matchedDocs: [],
          metadata: buildMetadata(),
          projectPath: '/proj',
          taskId: 'task-q',
          transport,
        }),
      ).to.not.throw()
      // No-docs case fires 2 emits (search call + search result); both
      // throw → both get logged independently via safeDispatch.
      expect(logStub.callCount).to.equal(2)
      expect(logStub.firstCall.args[0]).to.include('search_knowledge')
      expect(logStub.firstCall.args[0]).to.include('sync throw')
    })
  })
})
