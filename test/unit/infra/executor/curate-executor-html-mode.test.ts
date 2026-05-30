/**
 * CurateExecutor HTML-emission tests.
 *
 * The agent's final response is the bv-topic HTML document; the
 * executor routes it through the html-writer (fence-stripping +
 * registry validation + atomic write). These tests stub the agent's
 * response and assert the file is written (or not), the lastStatus is
 * shaped correctly, and validation failures are surfaced cleanly.
 */

import {expect} from 'chai'
import {existsSync, readFileSync} from 'node:fs'
import {mkdir, mkdtemp, rm} from 'node:fs/promises'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import {restore, stub} from 'sinon'

import type {ICipherAgent} from '../../../../src/agent/core/interfaces/i-cipher-agent.js'

import {CurateExecutor} from '../../../../src/server/infra/executor/curate-executor.js'

const VALID_HTML_TOPIC = `<bv-topic path="security/auth" title="JWT auth">
  <bv-reason>Document JWT auth design.</bv-reason>
  <bv-rule severity="must" id="r-1">Always validate signatures.</bv-rule>
</bv-topic>`

function buildAgent(executeOnSessionResult: string): ICipherAgent {
  return {
    cancel: stub().resolves(false),
    createTaskSession: stub().resolves('session-id'),
    deleteSandboxVariable: stub(),
    deleteSandboxVariableOnSession: stub(),
    deleteSession: stub().resolves(true),
    deleteTaskSession: stub().resolves(),
    execute: stub().resolves(''),
    executeOnSession: stub().resolves(executeOnSessionResult),
    generate: stub().resolves({content: '', toolCalls: [], usage: {inputTokens: 0, outputTokens: 0}}),
    getSessionMetadata: stub().resolves(),
    getState: stub().returns({currentIteration: 0, executionHistory: [], executionState: 'idle', toolCallsExecuted: 0}),
    listPersistedSessions: stub().resolves([]),
    reset: stub(),
    setSandboxVariable: stub(),
    setSandboxVariableOnSession: stub(),
    start: stub().resolves(),
    stream: stub().resolves({[Symbol.asyncIterator]: () => ({next: () => Promise.resolve({done: true, value: undefined})})}),
  } as unknown as ICipherAgent
}

describe('CurateExecutor HTML emission', () => {
  let baseDir: string

  beforeEach(async () => {
    baseDir = await mkdtemp(join(tmpdir(), 'curate-executor-html-'))
    // The executor expects `<baseDir>/.brv/context-tree/` to be the
    // write root. Pre-create the directory tree so html-writer's
    // atomic write doesn't have to materialise it through the I/O
    // helper (the helper handles missing intermediate dirs already,
    // but pre-creating keeps the test boundary tight).
    await mkdir(join(baseDir, '.brv', 'context-tree'), {recursive: true})
  })

  afterEach(async () => {
    restore()
    await rm(baseDir, {force: true, recursive: true})
  })

  it('writes a valid HTML topic to <baseDir>/.brv/context-tree/<path>.html', async () => {
    const agent = buildAgent(VALID_HTML_TOPIC)
    const executor = new CurateExecutor()

    const {response} = await executor.runAgentBody(agent, {
      content: 'curate this',
      projectRoot: baseDir,
      taskId: 'task-html-1',
    })

    const expectedPath = join(baseDir, '.brv', 'context-tree', 'security/auth.html')
    expect(existsSync(expectedPath), `expected file at ${expectedPath}`).to.equal(true)
    // The on-disk file is the LLM's HTML plus system-injected
    // `createdat` / `updatedat` attributes on bv-topic. Body content
    // is preserved verbatim; the bv-topic opening tag has the
    // timestamp attributes added.
    const written = readFileSync(expectedPath, 'utf8')
    expect(written).to.include('<bv-reason>Document JWT auth design.</bv-reason>')
    expect(written).to.include('<bv-rule severity="must" id="r-1">Always validate signatures.</bv-rule>')
    expect(written).to.match(/createdat="[^"]+"/)
    expect(written).to.match(/updatedat="[^"]+"/)
    // Response is the raw agent output (returned unchanged — timestamps
    // are injected by the writer at write time, not on the in-memory
    // response).
    expect(response).to.equal(VALID_HTML_TOPIC)
    expect(executor.lastStatus?.status).to.equal('success')
    expect(executor.lastStatus?.summary.added).to.equal(1)
    expect(executor.lastStatus?.summary.failed).to.equal(0)
  })

  it('strips a wrapping ```html fence from the agent response before writing', async () => {
    const wrapped = '```html\n' + VALID_HTML_TOPIC + '\n```'
    const agent = buildAgent(wrapped)
    const executor = new CurateExecutor()

    await executor.runAgentBody(agent, {
      content: 'curate this',
      projectRoot: baseDir,
      taskId: 'task-html-2',
    })

    const expectedPath = join(baseDir, '.brv', 'context-tree', 'security/auth.html')
    expect(existsSync(expectedPath)).to.equal(true)
    const written = readFileSync(expectedPath, 'utf8')
    // Fence is stripped; system timestamps are then injected onto bv-topic.
    expect(written.startsWith('```')).to.equal(false)
    expect(written).to.include('<bv-rule severity="must" id="r-1">Always validate signatures.</bv-rule>')
    expect(written).to.match(/createdat="[^"]+"/)
    expect(written).to.match(/updatedat="[^"]+"/)
    expect(executor.lastStatus?.status).to.equal('success')
  })

  it('records failed status (no file written) when response has no <bv-topic>', async () => {
    const agent = buildAgent('<p>not a topic</p>')
    const executor = new CurateExecutor()

    await executor.runAgentBody(agent, {
      content: 'curate this',
      projectRoot: baseDir,
      taskId: 'task-html-3',
    })

    expect(executor.lastStatus?.status).to.equal('failed')
    expect(executor.lastStatus?.summary.failed).to.equal(1)
    expect(executor.lastStatus?.verification.missing.length).to.be.greaterThan(0)
    // No file was written.
    expect(executor.lastStatus?.summary.added).to.equal(0)
  })

  it('records failed status when response has invalid attribute values', async () => {
    const invalid = `<bv-topic path="x" title="t">
      <bv-rule severity="urgent">x</bv-rule>
    </bv-topic>`
    const agent = buildAgent(invalid)
    const executor = new CurateExecutor()

    await executor.runAgentBody(agent, {
      content: 'curate this',
      projectRoot: baseDir,
      taskId: 'task-html-4',
    })

    expect(executor.lastStatus?.status).to.equal('failed')
    expect(executor.lastStatus?.verification.missing.some((m) => m.includes('attribute-validation'))).to.equal(true)
  })
})
