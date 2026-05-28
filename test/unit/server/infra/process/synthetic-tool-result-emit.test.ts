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

describe('synthetic-tool-result-emit (M16 tool-mode gap fix)', () => {
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
      // M16: marker tells TaskRouter to skip the per-client broadcast so
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

    it('swallows transport errors and logs', () => {
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
    })
  })

  describe('emitSyntheticQueryToolCalls', () => {
    it('fires one search_knowledge toolCall plus one read_file toolCall per matched doc', () => {
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

      expect(requestStub.callCount).to.equal(3)
      const [first, ...reads] = requestStub.getCalls()

      // Every call carries the synthetic marker so TaskRouter skips the
      // per-client broadcast (M16 — see SYNTHETIC_EVENT_METADATA docblock).
      for (const call of requestStub.getCalls()) {
        expect(call.args[1].metadata).to.deep.equal({_synthetic: true})
      }

      // First call: the search_knowledge envelope with retrieval metadata.
      expect(first.args[0]).to.equal(LlmEventNames.TOOL_CALL)
      expect(first.args[1].toolName).to.equal('search_knowledge')
      expect(first.args[1].args).to.deep.include({
        cacheHit: null,
        matchedCount: 2,
        tier: 2,
        topScore: 0.72,
        totalFound: 2,
      })

      // Subsequent calls: one read_file per doc, with absolute path under
      // the project's context tree.
      expect(reads.map((c) => c.args[1].toolName)).to.deep.equal(['read_file', 'read_file'])
      const filePaths = reads.map((c) => c.args[1].args.filePath as string)
      expect(filePaths).to.deep.equal([
        '/proj/.brv/context-tree/a.md',
        '/proj/.brv/context-tree/b.md',
      ])
    })

    it('emits only the search_knowledge call when no docs matched', () => {
      const {requestStub, transport} = buildTransport()

      emitSyntheticQueryToolCalls({
        matchedDocs: [],
        metadata: buildMetadata({totalFound: 0}),
        projectPath: '/proj',
        taskId: 'task-q',
        transport,
      })

      expect(requestStub.callCount).to.equal(1)
      expect(requestStub.firstCall.args[1].toolName).to.equal('search_knowledge')
      expect(requestStub.firstCall.args[1].args.matchedCount).to.equal(0)
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
        const args = call.args[1].args as Record<string, unknown>
        // No `query` field anywhere — only structured metadata + filePath.
        expect(args).to.not.have.property('query')
      }
    })

    it('swallows transport errors and logs', () => {
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
      expect(logStub.calledOnce).to.equal(true)
      expect(logStub.firstCall.args[0]).to.include('synthetic query toolCall emit failed')
    })
  })
})
