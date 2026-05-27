
import {expect} from 'chai'
import {mkdirSync, mkdtempSync, rmSync, writeFileSync} from 'node:fs'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import {createSandbox, type SinonSandbox, type SinonStub} from 'sinon'

import type {IAnalyticsClient} from '../../../../../src/server/core/interfaces/analytics/i-analytics-client.js'
import type {ITransportServer, RequestHandler} from '../../../../../src/server/core/interfaces/transport/i-transport-server.js'

import {WorktreeHandler} from '../../../../../src/server/infra/transport/handlers/worktree-handler.js'
import {AnalyticsEventNames} from '../../../../../src/shared/analytics/event-names.js'
import {WorktreeEvents} from '../../../../../src/shared/transport/events/worktree-events.js'

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

describe('WorktreeHandler analytics emits', () => {
  let sandbox: SinonSandbox
  let requestHandlers: Record<string, RequestHandler>
  let transport: Stubbed<ITransportServer>
  let analyticsClient: IAnalyticsClient & {trackSpy: SinonStub}
  let projectDir: string
  let worktreeDir: string

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

    // Create a real project dir with .brv/config.json so addWorktree sees it as a BRV project
    projectDir = mkdtempSync(join(tmpdir(), 'brv-wt-proj-'))
    mkdirSync(join(projectDir, '.brv'), {recursive: true})
    writeFileSync(join(projectDir, '.brv', 'config.json'), '{}')
    worktreeDir = mkdtempSync(join(tmpdir(), 'brv-wt-target-'))

    analyticsClient = makeFakeAnalyticsClient()
    const resolveProjectPath = sandbox.stub().returns(projectDir)
    new WorktreeHandler({
      analyticsClient,
      resolveProjectPath: resolveProjectPath as never,
      transport,
    }).setup()
  })

  afterEach(() => {
    sandbox.restore()
    rmSync(projectDir, {force: true, recursive: true})
    rmSync(worktreeDir, {force: true, recursive: true})
  })

  function emits(name: string): Array<{args: unknown[]}> {
    return analyticsClient.trackSpy.getCalls().filter((c) => c.args[0] === name)
  }

  it('emits worktree_added outcome=success on add success', async () => {
    const handler = requestHandlers[WorktreeEvents.ADD]
    await handler({worktreePath: worktreeDir}, 'client-1')
    const calls = emits(AnalyticsEventNames.WORKTREE_ADDED)
    expect(calls.length).to.equal(1)
    const props = calls[0].args[1] as {outcome: string; project_path_hash: string}
    expect(props.outcome).to.equal('success')
    expect(props.project_path_hash).to.match(sha256HexRegex)
  })

  it('emits worktree_removed outcome=failure when target does not exist', async () => {
    const handler = requestHandlers[WorktreeEvents.REMOVE]
    const nonexistent = join(tmpdir(), `brv-wt-noexist-${Date.now()}`)
    await handler({worktreePath: nonexistent}, 'client-1')
    const calls = emits(AnalyticsEventNames.WORKTREE_REMOVED)
    expect(calls.length).to.equal(1)
    const props = calls[0].args[1] as {failure_kind?: string; outcome: string; project_path_hash: string}
    expect(props.outcome).to.equal('failure')
    expect(props.failure_kind).to.equal('remove_failed')
    expect(props.project_path_hash).to.match(sha256HexRegex)
  })

  it('does NOT emit on list', async () => {
    const handler = requestHandlers[WorktreeEvents.LIST]
    await handler({}, 'client-1')
    expect(analyticsClient.trackSpy.called).to.equal(false)
  })

  it('is a no-op when analyticsClient is not injected', async () => {
    const requestHandlersLocal: Record<string, RequestHandler> = {}
    const transportLocal: Stubbed<ITransportServer> = {
      addToRoom: sandbox.stub(),
      broadcast: sandbox.stub(),
      broadcastTo: sandbox.stub(),
      getPort: sandbox.stub(),
      isRunning: sandbox.stub(),
      onConnection: sandbox.stub(),
      onDisconnection: sandbox.stub(),
      onRequest: sandbox.stub().callsFake((event: string, handler: RequestHandler) => {
        requestHandlersLocal[event] = handler
      }),
      removeFromRoom: sandbox.stub(),
      sendTo: sandbox.stub(),
      start: sandbox.stub().resolves(),
      stop: sandbox.stub().resolves(),
    }
    new WorktreeHandler({
      resolveProjectPath: sandbox.stub().returns(projectDir) as never,
      transport: transportLocal,
    }).setup()
    const handler = requestHandlersLocal[WorktreeEvents.ADD]
    await handler({worktreePath: worktreeDir}, 'client-1')
    // No throw, no spy invocations on the injected client either
    expect(analyticsClient.trackSpy.called).to.equal(false)
  })
})
