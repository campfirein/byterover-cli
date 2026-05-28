/* eslint-disable camelcase */
import {expect} from 'chai'
import {createSandbox, type SinonSandbox, type SinonStub} from 'sinon'

import type {IAnalyticsClient} from '../../../../../src/server/core/interfaces/analytics/i-analytics-client.js'
import type {
  ITransportServer,
  RequestHandler,
} from '../../../../../src/server/core/interfaces/transport/i-transport-server.js'

import {attachCliInvocationMiddleware} from '../../../../../src/server/infra/transport/cli-invocation-middleware.js'
import {AnalyticsEventNames} from '../../../../../src/shared/analytics/event-names.js'

function makeStubTransport(sandbox: SinonSandbox): {
  requestHandlers: Map<string, RequestHandler>
  transport: ITransportServer
} {
  const requestHandlers = new Map<string, RequestHandler>()
  const transport: ITransportServer = {
    addToRoom: sandbox.stub(),
    broadcast: sandbox.stub(),
    broadcastTo: sandbox.stub(),
    getPort: sandbox.stub().returns(3000),
    isRunning: sandbox.stub().returns(true),
    onConnection: sandbox.stub(),
    onDisconnection: sandbox.stub(),
    onRequest: sandbox.stub().callsFake((event: string, handler: RequestHandler) => {
      requestHandlers.set(event, handler)
    }),
    removeFromRoom: sandbox.stub(),
    sendTo: sandbox.stub(),
    start: sandbox.stub().resolves(),
    stop: sandbox.stub().resolves(),
  }
  return {requestHandlers, transport}
}

function validCliMetadata(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    client_sent_at: 1_700_000_000_000,
    command_id: 'status',
    flag_names: ['format'],
    is_ci: false,
    is_tty: true,
    package_manager: 'npm',
    runtime: 'node',
    ...overrides,
  }
}

describe('attachCliInvocationMiddleware (M15.8 §4)', () => {
  let sandbox: SinonSandbox
  let transportHelper: ReturnType<typeof makeStubTransport>
  let trackStub: SinonStub
  let analyticsClient: IAnalyticsClient

  beforeEach(() => {
    sandbox = createSandbox()
    transportHelper = makeStubTransport(sandbox)
    trackStub = sandbox.stub()
    analyticsClient = {
      abort: sandbox.stub(),
      flush: sandbox.stub().resolves({events: []}),
      getRuntimeState: sandbox.stub().resolves({droppedCount: 0, lastSuccessfulFlushAt: undefined, queueDepth: 0}),
      onAuthTransition: sandbox.stub().resolves(),
      track: trackStub,
    } as unknown as IAnalyticsClient
  })

  afterEach(() => sandbox.restore())

  it('fires cli_invocation exactly once per incoming request when cli_metadata is valid', async () => {
    attachCliInvocationMiddleware(transportHelper.transport, {getAnalyticsClient: () => analyticsClient})

    const realHandler = sandbox.stub().resolves('ok')
    transportHelper.transport.onRequest('status:get', realHandler)
    const handler = transportHelper.requestHandlers.get('status:get')!

    await handler({cli_metadata: validCliMetadata(), cwd: '/proj'}, 'client-1')

    expect(trackStub.calledOnce).to.equal(true)
    const trackArgs = trackStub.firstCall.args
    expect(trackArgs[0]).to.equal(AnalyticsEventNames.CLI_INVOCATION)
    const props = trackArgs[1] as Record<string, unknown>
    expect(props.command_id).to.equal('status')
    expect(props.flag_names).to.deep.equal(['format'])
    expect(realHandler.calledOnce).to.equal(true)
  })

  it('does NOT emit when cli_metadata is absent', async () => {
    attachCliInvocationMiddleware(transportHelper.transport, {getAnalyticsClient: () => analyticsClient})

    const realHandler = sandbox.stub().resolves('ok')
    transportHelper.transport.onRequest('daemon:state', realHandler)
    const handler = transportHelper.requestHandlers.get('daemon:state')!

    await handler({cwd: '/proj'}, 'client-1')

    expect(trackStub.called).to.equal(false)
    expect(realHandler.calledOnce).to.equal(true)
  })

  it('does NOT emit when cli_metadata is malformed (safeParse fails) but still forwards', async () => {
    attachCliInvocationMiddleware(transportHelper.transport, {getAnalyticsClient: () => analyticsClient})

    const realHandler = sandbox.stub().resolves('ok')
    transportHelper.transport.onRequest('status:get', realHandler)
    const handler = transportHelper.requestHandlers.get('status:get')!

    // Missing required field (`runtime`)
    await handler({cli_metadata: {command_id: 'partial'}, cwd: '/proj'}, 'client-1')

    expect(trackStub.called).to.equal(false)
    expect(realHandler.calledOnce).to.equal(true)
  })

  it('still emits when the underlying handler rejects ("user typed the command" funnel)', async () => {
    attachCliInvocationMiddleware(transportHelper.transport, {getAnalyticsClient: () => analyticsClient})

    const realHandler = sandbox.stub().rejects(new Error('boom'))
    transportHelper.transport.onRequest('status:get', realHandler)
    const handler = transportHelper.requestHandlers.get('status:get')!

    try {
      await handler({cli_metadata: validCliMetadata()}, 'client-1')
    } catch {
      /* error propagates from handler; expected */
    }

    expect(trackStub.calledOnce).to.equal(true)
  })

  it('is a no-op when no analytics client has been resolved yet (boot-time race)', async () => {
    // eslint-disable-next-line unicorn/no-useless-undefined
    attachCliInvocationMiddleware(transportHelper.transport, {getAnalyticsClient: () => undefined})

    const realHandler = sandbox.stub().resolves('ok')
    transportHelper.transport.onRequest('status:get', realHandler)
    const handler = transportHelper.requestHandlers.get('status:get')!

    await handler({cli_metadata: validCliMetadata()}, 'client-1')

    expect(trackStub.called).to.equal(false)
    expect(realHandler.calledOnce).to.equal(true)
  })

  it('swallows track() errors so analytics can never crash a real handler', async () => {
    trackStub.throws(new Error('analytics down'))
    attachCliInvocationMiddleware(transportHelper.transport, {getAnalyticsClient: () => analyticsClient})

    const realHandler = sandbox.stub().resolves('ok')
    transportHelper.transport.onRequest('status:get', realHandler)
    const handler = transportHelper.requestHandlers.get('status:get')!

    const response = await handler({cli_metadata: validCliMetadata()}, 'client-1')
    expect(response).to.equal('ok')
  })

  it('does NOT double-fire when middleware is applied once and multiple handlers register', async () => {
    attachCliInvocationMiddleware(transportHelper.transport, {getAnalyticsClient: () => analyticsClient})

    transportHelper.transport.onRequest('a:event', sandbox.stub().resolves('a'))
    transportHelper.transport.onRequest('b:event', sandbox.stub().resolves('b'))

    await transportHelper.requestHandlers.get('a:event')!({cli_metadata: validCliMetadata()}, 'c')
    expect(trackStub.callCount).to.equal(1)

    await transportHelper.requestHandlers.get('b:event')!({cli_metadata: validCliMetadata()}, 'c')
    expect(trackStub.callCount).to.equal(2)
  })

  it('idempotent attach: applying the middleware twice does NOT double-fire cli_invocation', async () => {
    attachCliInvocationMiddleware(transportHelper.transport, {getAnalyticsClient: () => analyticsClient})
    // Second attach must be a no-op — without the guard, the wrapped onRequest
    // would wrap itself, double-firing on every incoming request.
    attachCliInvocationMiddleware(transportHelper.transport, {getAnalyticsClient: () => analyticsClient})

    const realHandler = sandbox.stub().resolves('ok')
    transportHelper.transport.onRequest('status:get', realHandler)
    const handler = transportHelper.requestHandlers.get('status:get')!

    await handler({cli_metadata: validCliMetadata()}, 'client-1')

    expect(trackStub.callCount).to.equal(1)
    expect(realHandler.calledOnce).to.equal(true)
  })
})
