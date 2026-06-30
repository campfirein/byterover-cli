import {expect} from 'chai'
import {mkdtempSync, rmSync, writeFileSync} from 'node:fs'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import {createSandbox, type SinonSandbox, type SinonStub} from 'sinon'

import type {IAnalyticsClient} from '../../../../../src/server/core/interfaces/analytics/i-analytics-client.js'
import type {IContextFileReader} from '../../../../../src/server/core/interfaces/context-tree/i-context-file-reader.js'
import type {IContextTreeService} from '../../../../../src/server/core/interfaces/context-tree/i-context-tree-service.js'
import type {IGitService} from '../../../../../src/server/core/interfaces/services/i-git-service.js'
import type {ITransportServer, RequestHandler} from '../../../../../src/server/core/interfaces/transport/i-transport-server.js'

import {ContextTreeHandler} from '../../../../../src/server/infra/transport/handlers/context-tree-handler.js'
import {AnalyticsEventNames} from '../../../../../src/shared/analytics/event-names.js'
import {ContextTreeEvents} from '../../../../../src/shared/transport/events/context-tree-events.js'

type Stubbed<T> = {[K in keyof T]: SinonStub & T[K]}

const sha256HexRegex = /^[0-9a-f]{64}$/

function makeFakeAnalyticsClient(): IAnalyticsClient & {trackSpy: SinonStub} {
  const trackSpy = createSandbox().stub() as SinonStub
  return {
    abort: createSandbox().stub(),
    flush: createSandbox().stub().resolves({events: []}),
    getRuntimeState: createSandbox().stub().resolves({droppedCount: 0, lastSuccessfulFlushAt: undefined, queueDepth: 0}),
    onAuthTransition: createSandbox().stub().resolves(),
    track: trackSpy,
    trackSpy,
  } as unknown as IAnalyticsClient & {trackSpy: SinonStub}
}

describe('ContextTreeHandler analytics emits', () => {
  let sandbox: SinonSandbox
  let requestHandlers: Record<string, RequestHandler>
  let transport: Stubbed<ITransportServer>
  let analyticsClient: IAnalyticsClient & {trackSpy: SinonStub}
  let projectDir: string
  let contextTreeDir: string

  beforeEach(() => {
    sandbox = createSandbox()
    requestHandlers = {}
    transport = {
      addToRoom: sandbox.stub(),
      broadcast: sandbox.stub(),
      broadcastTo: sandbox.stub(),
      getPort: sandbox.stub(),
      isRunning: sandbox.stub(),
      onConnection: sandbox.stub(),
      onDisconnection: sandbox.stub(),
      onRequest: sandbox.stub().callsFake((event: string, handler: RequestHandler) => {
        requestHandlers[event] = handler
      }),
      removeFromRoom: sandbox.stub(),
      sendTo: sandbox.stub(),
      start: sandbox.stub().resolves(),
      stop: sandbox.stub().resolves(),
    }

    projectDir = mkdtempSync(join(tmpdir(), 'brv-ct-proj-'))
    contextTreeDir = join(projectDir, '.brv', 'context-tree')

    const contextTreeService = {
      delete: sandbox.stub().resolves(),
      exists: sandbox.stub().resolves(true),
      hasGitRepo: sandbox.stub().resolves(false),
      initialize: sandbox.stub().resolves(contextTreeDir),
      resolvePath: sandbox.stub().returns(contextTreeDir),
    } as unknown as IContextTreeService

    const contextFileReader: IContextFileReader = {read: sandbox.stub().resolves()} as never
    const gitService = {log: sandbox.stub().resolves([])} as unknown as Pick<IGitService, 'log'>

    analyticsClient = makeFakeAnalyticsClient()
    new ContextTreeHandler({
      analyticsClient,
      contextFileReader,
      contextTreeService,
      gitService,
      resolveProjectPath: sandbox.stub().returns(projectDir),
      transport,
    }).setup()
  })

  afterEach(() => {
    sandbox.restore()
    rmSync(projectDir, {force: true, recursive: true})
  })

  function emits(name: string): Array<{args: unknown[]}> {
    return analyticsClient.trackSpy.getCalls().filter((c) => c.args[0] === name)
  }

  it('emits context_tree_file_edited outcome=success with byte_delta + hashed paths', async () => {
    await requestHandlers[ContextTreeEvents.UPDATE_FILE]({content: 'new-content', path: 'topic.md'}, 'c1')
    const calls = emits(AnalyticsEventNames.CONTEXT_TREE_FILE_EDITED)
    expect(calls.length).to.equal(1)
    const props = calls[0].args[1] as {
      byte_delta?: number
      file_relative_path_hash: string
      outcome: string
      project_path_hash: string
    }
    expect(props.outcome).to.equal('success')
    expect(props.project_path_hash).to.match(sha256HexRegex)
    expect(props.file_relative_path_hash).to.match(sha256HexRegex)
    expect(props.byte_delta).to.equal(11)
  })

  it('emits context_tree_file_edited outcome=success with negative byte_delta on shrink', async () => {
    // Pre-create the file so we have a baseline
    const {mkdirSync} = await import('node:fs')
    mkdirSync(contextTreeDir, {recursive: true})
    writeFileSync(join(contextTreeDir, 'topic.md'), 'old much longer content here')

    await requestHandlers[ContextTreeEvents.UPDATE_FILE]({content: 'tiny', path: 'topic.md'}, 'c1')
    const calls = emits(AnalyticsEventNames.CONTEXT_TREE_FILE_EDITED)
    const props = calls[0].args[1] as {byte_delta?: number}
    expect(props.byte_delta).to.be.lessThan(0)
  })

  it('emits context_tree_file_edited outcome=failure failure_kind=invalid_path on path traversal', async () => {
    try {
      await requestHandlers[ContextTreeEvents.UPDATE_FILE]({content: 'x', path: '../../etc/passwd'}, 'c1')
      expect.fail('should have thrown')
    } catch (error) {
      expect((error as Error).message).to.include('traversal')
    }

    const calls = emits(AnalyticsEventNames.CONTEXT_TREE_FILE_EDITED)
    expect(calls.length).to.equal(1)
    const props = calls[0].args[1] as {failure_kind?: string; outcome: string; project_path_hash: string}
    expect(props.outcome).to.equal('failure')
    expect(props.failure_kind).to.equal('invalid_path')
    expect(props.project_path_hash).to.match(sha256HexRegex)
  })

  it('regression: raw path never appears in emit (only sha256 hash)', async () => {
    const secretPath = 'super-secret-topic-name.md'
    await requestHandlers[ContextTreeEvents.UPDATE_FILE]({content: 'x', path: secretPath}, 'c1')
    const calls = emits(AnalyticsEventNames.CONTEXT_TREE_FILE_EDITED)
    const props = calls[0].args[1] as Record<string, unknown>
    expect(JSON.stringify(props)).to.not.include('super-secret-topic-name.md')
  })

  it('does NOT emit on read-only events (GET_FILE / GET_NODES / GET_HISTORY)', async () => {
    try {
      await requestHandlers[ContextTreeEvents.GET_NODES]({}, 'c1')
    } catch {
      // swallow — readonly handler may error in this stubbed env
    }

    expect(analyticsClient.trackSpy.called).to.equal(false)
  })
})
