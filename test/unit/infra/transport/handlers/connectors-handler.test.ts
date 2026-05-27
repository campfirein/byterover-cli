 
import {expect} from 'chai'
import {restore, stub} from 'sinon'

import type {IAnalyticsClient} from '../../../../../src/server/core/interfaces/analytics/i-analytics-client.js'

import {ConnectorsHandler} from '../../../../../src/server/infra/transport/handlers/connectors-handler.js'
import {AnalyticsEventNames} from '../../../../../src/shared/analytics/event-names.js'
import {ConnectorEvents} from '../../../../../src/shared/transport/events/connector-events.js'
import {createMockTransportServer, type MockTransportServer} from '../../../../helpers/mock-factories.js'

function makeFakeAnalyticsClient(): IAnalyticsClient & {trackSpy: ReturnType<typeof stub>} {
  const trackSpy = stub()
  return {
    abort: stub(),
    flush: stub().resolves({events: []}),
    getRuntimeState: stub().resolves({droppedCount: 0, lastSuccessfulFlushAt: undefined, queueDepth: 0}),
    onAuthTransition: stub().resolves(),
    track: trackSpy,
    trackSpy,
  } as unknown as IAnalyticsClient & {trackSpy: ReturnType<typeof stub>}
}

describe('ConnectorsHandler — connector_installed analytics', () => {
  let transport: MockTransportServer

  beforeEach(() => {
    transport = createMockTransportServer()
  })

  afterEach(() => {
    restore()
  })

  type SwitchOutcome = 'failure' | 'success' | 'throw'
  function createHandler(opts: {
    analyticsClient?: IAnalyticsClient
    switchOutcome?: SwitchOutcome
  }): {connectorManagerFactory: ReturnType<typeof stub>} {
    const installResult = {configPath: '/cfg', manualInstructions: '', requiresManualSetup: false}
    let switchStub: ReturnType<typeof stub>
    switch (opts.switchOutcome ?? 'success') {
      case 'failure': {
        switchStub = stub().resolves({installResult, message: 'failed', success: false})
        break
      }

      case 'throw': {
        switchStub = stub().rejects(new Error('switch boom'))
        break
      }

      default: {
        switchStub = stub().resolves({installResult, message: 'ok', success: true})
      }
    }

    const connectorManagerFactory = stub().returns({
      getAllInstalledConnectors: stub().resolves(new Map()),
      getConnector: stub(),
      getDefaultConnectorType: stub(),
      getSupportedConnectorTypes: stub().returns([]),
      switchConnector: switchStub,
    })
    new ConnectorsHandler({
      analyticsClient: opts.analyticsClient,
      connectorManagerFactory: connectorManagerFactory as never,
      resolveProjectPath: stub().returns('/proj') as never,
      transport,
    }).setup()
    return {connectorManagerFactory}
  }

  async function callInstall(data: {agentId: string; connectorType: string}): Promise<unknown> {
    const handler = transport._handlers.get(ConnectorEvents.INSTALL)
    expect(handler, 'connectors:install handler should be registered').to.exist
    return handler!(data, 'client-1')
  }

  it('emits connector_installed outcome=success when switchConnector resolves success=true', async () => {
    const analyticsClient = makeFakeAnalyticsClient()
    createHandler({analyticsClient, switchOutcome: 'success'})

    await callInstall({agentId: 'Claude Code', connectorType: 'rules'})

    const calls = analyticsClient.trackSpy
      .getCalls()
      .filter((c: {args: unknown[]}) => c.args[0] === AnalyticsEventNames.CONNECTOR_INSTALLED)
    expect(calls.length).to.equal(1)
    const props = calls[0].args[1] as {agent_target: string; connector_id: string; outcome: string}
    expect(props.outcome).to.equal('success')
    expect(props.agent_target).to.equal('Claude Code')
    expect(props.connector_id).to.equal('rules')
  })

  it('emits connector_installed outcome=failure with failure_kind=install_failed when switchConnector returns success=false', async () => {
    const analyticsClient = makeFakeAnalyticsClient()
    createHandler({analyticsClient, switchOutcome: 'failure'})

    await callInstall({agentId: 'Claude Code', connectorType: 'rules'})

    const calls = analyticsClient.trackSpy
      .getCalls()
      .filter((c: {args: unknown[]}) => c.args[0] === AnalyticsEventNames.CONNECTOR_INSTALLED)
    expect(calls.length).to.equal(1)
    const props = calls[0].args[1] as {failure_kind: string; outcome: string}
    expect(props.outcome).to.equal('failure')
    expect(props.failure_kind).to.equal('install_failed')
  })

  it('emits connector_installed outcome=failure with failure_kind=invalid_agent on bad agentId', async () => {
    const analyticsClient = makeFakeAnalyticsClient()
    createHandler({analyticsClient})

    const result = await callInstall({agentId: 'not-a-real-agent', connectorType: 'rules'})
    expect(result).to.deep.include({success: false})

    const calls = analyticsClient.trackSpy
      .getCalls()
      .filter((c: {args: unknown[]}) => c.args[0] === AnalyticsEventNames.CONNECTOR_INSTALLED)
    expect(calls.length).to.equal(1)
    const props = calls[0].args[1] as {failure_kind: string; outcome: string}
    expect(props.outcome).to.equal('failure')
    expect(props.failure_kind).to.equal('invalid_agent')
  })

  it('emits connector_installed outcome=failure with failure_kind=invalid_connector on bad connectorType', async () => {
    const analyticsClient = makeFakeAnalyticsClient()
    createHandler({analyticsClient})

    const result = await callInstall({agentId: 'Claude Code', connectorType: 'not-a-real-connector'})
    expect(result).to.deep.include({success: false})

    const calls = analyticsClient.trackSpy
      .getCalls()
      .filter((c: {args: unknown[]}) => c.args[0] === AnalyticsEventNames.CONNECTOR_INSTALLED)
    expect(calls.length).to.equal(1)
    const props = calls[0].args[1] as {failure_kind: string; outcome: string}
    expect(props.outcome).to.equal('failure')
    expect(props.failure_kind).to.equal('invalid_connector')
  })

  it('does NOT emit when switchConnector throws (no handler-level catch — error propagates uncaught)', async () => {
    const analyticsClient = makeFakeAnalyticsClient()
    createHandler({analyticsClient, switchOutcome: 'throw'})

    let threw = false
    try {
      await callInstall({agentId: 'Claude Code', connectorType: 'rules'})
    } catch {
      threw = true
    }

    expect(threw, 'thrown errors should propagate to caller').to.equal(true)
    const calls = analyticsClient.trackSpy
      .getCalls()
      .filter((c: {args: unknown[]}) => c.args[0] === AnalyticsEventNames.CONNECTOR_INSTALLED)
    expect(calls.length, 'no emit on thrown failure without an existing catch').to.equal(0)
  })

  it('is a no-op when no analyticsClient is injected (backward-compat)', async () => {
    createHandler({switchOutcome: 'success'})

    const result = await callInstall({agentId: 'Claude Code', connectorType: 'rules'})
    expect(result).to.deep.include({success: true})
  })
})
