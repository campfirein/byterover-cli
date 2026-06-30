
import {expect} from 'chai'
import {mkdirSync, mkdtempSync, rmSync, writeFileSync} from 'node:fs'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import {createSandbox, type SinonSandbox, type SinonStub} from 'sinon'

import type {IAnalyticsClient} from '../../../../../src/server/core/interfaces/analytics/i-analytics-client.js'
import type {ITransportServer, RequestHandler} from '../../../../../src/server/core/interfaces/transport/i-transport-server.js'

import {SourceHandler} from '../../../../../src/server/infra/transport/handlers/source-handler.js'
import {AnalyticsEventNames} from '../../../../../src/shared/analytics/event-names.js'
import {SourceEvents} from '../../../../../src/shared/transport/events/source-events.js'

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

describe('SourceHandler analytics emits', () => {
  let sandbox: SinonSandbox
  let requestHandlers: Record<string, RequestHandler>
  let transport: Stubbed<ITransportServer>
  let analyticsClient: IAnalyticsClient & {trackSpy: SinonStub}
  let projectDir: string
  let sourceDir: string

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

    projectDir = mkdtempSync(join(tmpdir(), 'brv-src-proj-'))
    mkdirSync(join(projectDir, '.brv'), {recursive: true})
    writeFileSync(join(projectDir, '.brv', 'config.json'), '{}')
    sourceDir = mkdtempSync(join(tmpdir(), 'brv-src-target-'))
    mkdirSync(join(sourceDir, '.brv'), {recursive: true})
    writeFileSync(join(sourceDir, '.brv', 'config.json'), '{}')

    analyticsClient = makeFakeAnalyticsClient()
    new SourceHandler({
      analyticsClient,
      resolveProjectPath: sandbox.stub().returns(projectDir) as never,
      transport,
    }).setup()
  })

  afterEach(() => {
    sandbox.restore()
    rmSync(projectDir, {force: true, recursive: true})
    rmSync(sourceDir, {force: true, recursive: true})
  })

  function emits(name: string): Array<{args: unknown[]}> {
    return analyticsClient.trackSpy.getCalls().filter((c) => c.args[0] === name)
  }

  it('emits source_added outcome=success with source_origin_hash on add success', async () => {
    const handler = requestHandlers[SourceEvents.ADD]
    await handler({targetPath: sourceDir}, 'client-1')
    const calls = emits(AnalyticsEventNames.SOURCE_ADDED)
    expect(calls.length).to.equal(1)
    const props = calls[0].args[1] as {
      outcome: string
      project_path_hash: string
      source_origin_hash?: string
    }
    expect(props.outcome).to.equal('success')
    expect(props.project_path_hash).to.match(sha256HexRegex)
    expect(props.source_origin_hash).to.match(sha256HexRegex)
  })

  it('emits source_added outcome=failure when target is not a BRV project', async () => {
    const handler = requestHandlers[SourceEvents.ADD]
    const notBrvDir = mkdtempSync(join(tmpdir(), 'brv-src-bad-'))
    try {
      await handler({targetPath: notBrvDir}, 'client-1')
      const calls = emits(AnalyticsEventNames.SOURCE_ADDED)
      expect(calls.length).to.equal(1)
      const props = calls[0].args[1] as {failure_kind?: string; outcome: string}
      expect(props.outcome).to.equal('failure')
      expect(props.failure_kind).to.equal('add_failed')
    } finally {
      rmSync(notBrvDir, {force: true, recursive: true})
    }
  })

  it('emits source_removed outcome=failure on non-existent alias', async () => {
    const handler = requestHandlers[SourceEvents.REMOVE]
    await handler({aliasOrPath: 'nonexistent'}, 'client-1')
    const calls = emits(AnalyticsEventNames.SOURCE_REMOVED)
    expect(calls.length).to.equal(1)
    const props = calls[0].args[1] as {failure_kind?: string; outcome: string}
    expect(props.outcome).to.equal('failure')
    expect(props.failure_kind).to.equal('remove_failed')
  })

  it('does NOT emit on list', async () => {
    const handler = requestHandlers[SourceEvents.LIST]
    await handler({}, 'client-1')
    expect(analyticsClient.trackSpy.called).to.equal(false)
  })
})
