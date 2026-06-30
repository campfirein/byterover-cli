import {expect} from 'chai'
import {createSandbox, type SinonSandbox, type SinonStub, useFakeTimers} from 'sinon'

import type {IAnalyticsClient} from '../../../../src/server/core/interfaces/analytics/i-analytics-client.js'

import {ClientManager} from '../../../../src/server/infra/client/client-manager.js'
import {getClientKindFromContext} from '../../../../src/server/infra/transport/client-kind-context.js'
import {AnalyticsEventNames} from '../../../../src/shared/analytics/event-names.js'
import {FORBIDDEN_FIELD_NAMES} from '../../../../src/shared/analytics/forbidden-field-names.js'

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

describe('ClientManager MCP session analytics emits (M15.8)', () => {
  let sandbox: SinonSandbox
  let manager: ClientManager
  let analyticsClient: IAnalyticsClient & {trackSpy: SinonStub}

  beforeEach(() => {
    sandbox = createSandbox()
    analyticsClient = makeFakeAnalyticsClient()
    manager = new ClientManager()
    manager.setAnalyticsClient(analyticsClient)
  })

  afterEach(() => sandbox.restore())

  function emits(name: string): Array<{args: unknown[]}> {
    return analyticsClient.trackSpy.getCalls().filter((c) => c.args[0] === name)
  }

  it('does NOT emit mcp_session_start on register (name unknown until handshake)', () => {
    manager.register('sock-1', 'mcp')
    expect(emits(AnalyticsEventNames.MCP_SESSION_START).length).to.equal(0)
  })

  it('emits mcp_session_start when setAgentName lands for an MCP client', () => {
    manager.register('sock-1', 'mcp')
    manager.setAgentName('sock-1', 'Cursor')

    const calls = emits(AnalyticsEventNames.MCP_SESSION_START)
    expect(calls.length).to.equal(1)
    const props = calls[0].args[1] as {client_name: string}
    expect(props.client_name).to.equal('Cursor')
  })

  it('does NOT re-emit mcp_session_start on duplicate setAgentName (idempotent)', () => {
    manager.register('sock-1', 'mcp')
    manager.setAgentName('sock-1', 'Cursor')
    manager.setAgentName('sock-1', 'Cursor')
    expect(emits(AnalyticsEventNames.MCP_SESSION_START).length).to.equal(1)
  })

  it('does NOT emit on setAgentName for non-MCP types (cli/tui/extension/webui/agent)', () => {
    const types: Array<'agent' | 'cli' | 'extension' | 'tui' | 'webui'> = [
      'agent',
      'cli',
      'extension',
      'tui',
      'webui',
    ]
    for (const [i, t] of types.entries()) {
      const id = `sock-${i}`
      manager.register(id, t, t === 'webui' ? '/proj' : undefined)
      manager.setAgentName(id, 'WhateverName')
    }

    expect(emits(AnalyticsEventNames.MCP_SESSION_START).length).to.equal(0)
  })

  it('emits mcp_session_ended on unregister when agentName was set', () => {
    const clock = useFakeTimers(1_700_000_000_000)
    try {
      manager.register('sock-1', 'mcp')
      const started = manager.getClient('sock-1')!.connectedAt
      manager.setAgentName('sock-1', 'Cursor')
      clock.tick(8500)
      manager.unregister('sock-1')

      const calls = emits(AnalyticsEventNames.MCP_SESSION_ENDED)
      expect(calls.length).to.equal(1)
      const props = calls[0].args[1] as {
        client_name: string
        session_duration_ms: number
        started_at_unix_ms: number
      }
      expect(props.client_name).to.equal('Cursor')
      expect(props.started_at_unix_ms).to.equal(started)
      expect(props.session_duration_ms).to.equal(8500)
    } finally {
      clock.restore()
    }
  })

  it('does NOT emit mcp_session_ended on unregister when agentName was never set', () => {
    manager.register('sock-1', 'mcp')
    manager.unregister('sock-1')
    expect(emits(AnalyticsEventNames.MCP_SESSION_ENDED).length).to.equal(0)
  })

  it('reconnect: emits ended for old MCP session + clears state for new register cycle', () => {
    const clock = useFakeTimers(1_700_000_000_000)
    try {
      manager.register('sock-1', 'mcp')
      manager.setAgentName('sock-1', 'Cursor')
      const firstConnectedAt = manager.getClient('sock-1')!.connectedAt
      clock.tick(2000)

      // Reconnect: same id, fresh ClientInfo, fresh handshake.
      manager.register('sock-1', 'mcp')
      manager.setAgentName('sock-1', 'Cursor')

      const endedCalls = emits(AnalyticsEventNames.MCP_SESSION_ENDED)
      expect(endedCalls.length).to.equal(1)
      const endedProps = endedCalls[0].args[1] as {
        client_name: string
        session_duration_ms: number
        started_at_unix_ms: number
      }
      expect(endedProps.client_name).to.equal('Cursor')
      expect(endedProps.started_at_unix_ms).to.equal(firstConnectedAt)
      expect(endedProps.session_duration_ms).to.equal(2000)

      const startedCalls = emits(AnalyticsEventNames.MCP_SESSION_START)
      expect(startedCalls.length).to.equal(2)
    } finally {
      clock.restore()
    }
  })

  it('end-event carries the SAME client_name that start emitted, even if agentName were re-mutated mid-session', () => {
    manager.register('sock-1', 'mcp')
    manager.setAgentName('sock-1', 'Cursor') // emits start with 'Cursor'
    manager.setAgentName('sock-1', 'Claude Code') // wasFirstMcpHandshake=false; mutates _agentName but does NOT re-emit start
    manager.unregister('sock-1')

    const startedCalls = emits(AnalyticsEventNames.MCP_SESSION_START)
    expect(startedCalls.length).to.equal(1)
    expect((startedCalls[0].args[1] as {client_name: string}).client_name).to.equal('Cursor')

    const endedCalls = emits(AnalyticsEventNames.MCP_SESSION_ENDED)
    expect(endedCalls.length).to.equal(1)
    // CRITICAL: the end-event must carry 'Cursor' (the name emitted at start),
    // NOT the post-mutation 'Claude Code' value. Otherwise backend correlation
    // of start↔end via client_name silently breaks.
    expect((endedCalls[0].args[1] as {client_name: string}).client_name).to.equal('Cursor')
  })

  it('clamps session_duration_ms at 0 when clock skews backward between register and unregister', () => {
    const dateNowStub = sandbox.stub(Date, 'now')
    dateNowStub.onFirstCall().returns(1000) // register
    dateNowStub.onSecondCall().returns(500) // unregister
    manager.register('sock-1', 'mcp')
    manager.setAgentName('sock-1', 'Cursor')
    manager.unregister('sock-1')

    const calls = emits(AnalyticsEventNames.MCP_SESSION_ENDED)
    const props = calls[0].args[1] as {session_duration_ms: number}
    expect(props.session_duration_ms).to.equal(0)
  })

  it('emit fires inside clientKindContext.run({client_kind: mcp}) wrap', () => {
    let observed: string | undefined
    analyticsClient.trackSpy.callsFake(() => {
      observed = getClientKindFromContext()
    })
    manager.register('sock-1', 'mcp')
    manager.setAgentName('sock-1', 'Cursor')
    expect(observed).to.equal('mcp')
  })

  it('is a no-op when analyticsClient is not injected', () => {
    const m = new ClientManager()
    m.register('sock-1', 'mcp')
    m.setAgentName('sock-1', 'Cursor')
    m.unregister('sock-1')
    expect(analyticsClient.trackSpy.called).to.equal(false)
  })

  it('analytics track throwing does NOT escape setAgentName/unregister', () => {
    analyticsClient.trackSpy.throws(new Error('analytics down'))
    manager.register('sock-1', 'mcp')
    expect(() => manager.setAgentName('sock-1', 'Cursor')).to.not.throw()
    expect(() => manager.unregister('sock-1')).to.not.throw()
  })

  it('regression: neither emit payload includes any FORBIDDEN_FIELD_NAMES key', () => {
    manager.register('sock-1', 'mcp')
    manager.setAgentName('sock-1', 'Cursor')
    manager.unregister('sock-1')
    const allEmits = [
      ...emits(AnalyticsEventNames.MCP_SESSION_START),
      ...emits(AnalyticsEventNames.MCP_SESSION_ENDED),
    ]
    for (const call of allEmits) {
      const props = call.args[1] as Record<string, unknown>
      for (const key of Object.keys(props)) {
        expect(FORBIDDEN_FIELD_NAMES, `field ${key} must not be forbidden`).to.not.include(key)
      }
    }
  })
})
