 

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

describe('ClientManager WebUI session analytics emits', () => {
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

  it('emits webui_session_started with started_at_unix_ms = client.connectedAt on webui register', () => {
    const before = Date.now()
    manager.register('sock-1', 'webui', '/proj/a')
    const after = Date.now()

    const calls = emits(AnalyticsEventNames.WEBUI_SESSION_STARTED)
    expect(calls.length).to.equal(1)
    const props = calls[0].args[1] as {project_path_hash?: string; started_at_unix_ms: number}
    expect(props.started_at_unix_ms).to.be.at.least(before)
    expect(props.started_at_unix_ms).to.be.at.most(after)
    expect(props.project_path_hash).to.match(/^[0-9a-f]{64}$/)
    // client.connectedAt MUST equal the emitted started_at_unix_ms (join key)
    expect(props.started_at_unix_ms).to.equal(manager.getClient('sock-1')!.connectedAt)
  })

  it('emits webui_session_started WITHOUT project_path_hash when no projectPath', () => {
    manager.register('sock-1', 'webui')
    const calls = emits(AnalyticsEventNames.WEBUI_SESSION_STARTED)
    const props = calls[0].args[1] as {project_path_hash?: string; started_at_unix_ms: number}
    expect(props.project_path_hash).to.equal(undefined)
  })

  it('emits webui_session_ended with started_at_unix_ms + session_duration_ms on webui unregister', () => {
    const clock = useFakeTimers(1_000_000_000)
    try {
      manager.register('sock-1', 'webui', '/proj/a')
      const started = manager.getClient('sock-1')!.connectedAt
      clock.tick(7500)
      manager.unregister('sock-1')

      const calls = emits(AnalyticsEventNames.WEBUI_SESSION_ENDED)
      expect(calls.length).to.equal(1)
      const props = calls[0].args[1] as {
        project_path_hash?: string
        session_duration_ms: number
        started_at_unix_ms: number
      }
      expect(props.started_at_unix_ms).to.equal(started)
      expect(props.session_duration_ms).to.equal(7500)
      expect(props.project_path_hash).to.match(/^[0-9a-f]{64}$/)
    } finally {
      clock.restore()
    }
  })

  it('does NOT emit either event for non-webui types (cli/tui/mcp/extension/agent)', () => {
    const types: Array<'agent' | 'cli' | 'extension' | 'mcp' | 'tui'> = ['agent', 'cli', 'extension', 'mcp', 'tui']
    for (const [i, t] of types.entries()) {
      manager.register(`sock-${i}`, t, t === 'mcp' ? undefined : `/proj/${i}`)
      manager.unregister(`sock-${i}`)
    }

    expect(emits(AnalyticsEventNames.WEBUI_SESSION_STARTED).length).to.equal(0)
    expect(emits(AnalyticsEventNames.WEBUI_SESSION_ENDED).length).to.equal(0)
  })

  it('emit fires inside clientKindContext.run({client_kind: webui}) wrap', () => {
    let observed: string | undefined
    analyticsClient.trackSpy.callsFake(() => {
      observed = getClientKindFromContext()
    })
    manager.register('sock-1', 'webui', '/proj/a')
    expect(observed).to.equal('webui')
  })

  it('reconnect: emits ended for OLD client + started for NEW client when same id re-registers as webui', () => {
    const clock = useFakeTimers(1_000_000_000)
    try {
      manager.register('sock-1', 'webui', '/proj/a')
      const firstConnectedAt = manager.getClient('sock-1')!.connectedAt
      clock.tick(2000)

      manager.register('sock-1', 'webui', '/proj/b')

      const endedCalls = emits(AnalyticsEventNames.WEBUI_SESSION_ENDED)
      expect(endedCalls.length).to.equal(1)
      const endedProps = endedCalls[0].args[1] as {session_duration_ms: number; started_at_unix_ms: number}
      expect(endedProps.started_at_unix_ms).to.equal(firstConnectedAt)
      expect(endedProps.session_duration_ms).to.equal(2000)

      const startedCalls = emits(AnalyticsEventNames.WEBUI_SESSION_STARTED)
      expect(startedCalls.length).to.equal(2)
    } finally {
      clock.restore()
    }
  })

  it('is a no-op when analyticsClient is not injected', () => {
    const m = new ClientManager()
    m.register('sock-1', 'webui', '/proj/a')
    m.unregister('sock-1')
    expect(analyticsClient.trackSpy.called).to.equal(false)
  })

  it('analytics track throwing does NOT escape register/unregister', () => {
    analyticsClient.trackSpy.throws(new Error('analytics down'))
    expect(() => manager.register('sock-1', 'webui', '/proj/a')).to.not.throw()
    expect(() => manager.unregister('sock-1')).to.not.throw()
  })

  it('clamps session_duration_ms at 0 when clock skews backward between register and unregister', () => {
    // Simulate NTP correction: register at t=1000, unregister at t=500 (earlier)
    const dateNowStub = sandbox.stub(Date, 'now')
    dateNowStub.onFirstCall().returns(1000)
    dateNowStub.onSecondCall().returns(500)
    manager.register('sock-1', 'webui', '/proj/a')
    manager.unregister('sock-1')

    const calls = emits(AnalyticsEventNames.WEBUI_SESSION_ENDED)
    const props = calls[0].args[1] as {session_duration_ms: number}
    expect(props.session_duration_ms).to.equal(0)
  })

  it('context propagates across async resolver boundary (production path simulation)', async () => {
    // Simulate production flow where track() returns sync but the resolver
    // reads getClientKindFromContext() AFTER an await — matching
    // super-properties-resolver.ts. Verifies AsyncLocalStorage propagation
    // across the microtask queue, not just sync-immediate reads.
    let observed: string | undefined
    const observedPromise = new Promise<void>((resolve) => {
      analyticsClient.trackSpy.callsFake(() => {
        // mimic AnalyticsClient.track → trackAsync → await resolver.resolve()
        Promise.resolve()
          .then(async () => 0)
          .then(() => {
            observed = getClientKindFromContext()
            resolve()
          })
          .catch(() => resolve())
      })
    })
    manager.register('sock-1', 'webui', '/proj/a')
    await observedPromise
    expect(observed).to.equal('webui')
  })

  it('regression: neither emit payload includes any FORBIDDEN_FIELD_NAMES key', () => {
    manager.register('sock-1', 'webui', '/proj/a')
    manager.unregister('sock-1')
    const allEmits = [
      ...emits(AnalyticsEventNames.WEBUI_SESSION_STARTED),
      ...emits(AnalyticsEventNames.WEBUI_SESSION_ENDED),
    ]
    for (const call of allEmits) {
      const props = call.args[1] as Record<string, unknown>
      for (const key of Object.keys(props)) {
        expect(FORBIDDEN_FIELD_NAMES, `field ${key} must not be forbidden`).to.not.include(key)
      }
    }
  })
})
