import {expect} from 'chai'
import {createSandbox, type SinonSandbox, type SinonStub} from 'sinon'

import type {SettingDescriptor} from '../../../../../src/server/core/domain/entities/settings.js'
import type {IAnalyticsClient} from '../../../../../src/server/core/interfaces/analytics/i-analytics-client.js'
import type {ISettingsStore} from '../../../../../src/server/core/interfaces/storage/i-settings-store.js'
import type {ITransportServer, RequestHandler} from '../../../../../src/server/core/interfaces/transport/i-transport-server.js'

import {SETTINGS_KEYS} from '../../../../../src/server/core/domain/entities/settings.js'
import {InvalidSettingValueError, UnknownSettingKeyError} from '../../../../../src/server/infra/storage/settings-validator.js'
import {SettingsHandler} from '../../../../../src/server/infra/transport/handlers/settings-handler.js'
import {AnalyticsEventNames} from '../../../../../src/shared/analytics/event-names.js'
import {SettingsEvents} from '../../../../../src/shared/transport/events/settings-events.js'

type Stubbed<T> = {[K in keyof T]: SinonStub & T[K]}

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

describe('SettingsHandler analytics emits', () => {
  let sandbox: SinonSandbox
  let requestHandlers: Record<string, RequestHandler>
  let transport: Stubbed<ITransportServer>
  let store: Stubbed<ISettingsStore>
  let analyticsClient: IAnalyticsClient & {trackSpy: SinonStub}

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
    store = {
      get: sandbox.stub(),
      list: sandbox.stub().resolves([]),
      readStartupSnapshot: sandbox.stub().resolves({}),
      reset: sandbox.stub().resolves(),
      set: sandbox.stub().resolves(),
    }
    analyticsClient = makeFakeAnalyticsClient()
    new SettingsHandler({analyticsClient, store, transport}).setup()
  })

  afterEach(() => sandbox.restore())

  function emits(name: string): Array<{args: unknown[]}> {
    return analyticsClient.trackSpy.getCalls().filter((c) => c.args[0] === name)
  }

  it('emits setting_changed outcome=success with value_kind + value_changed_from_default', async () => {
    const handler = requestHandlers[SettingsEvents.SET]
    await handler({key: SETTINGS_KEYS.AGENT_POOL_MAX_SIZE, value: 42}, 'c1')
    const calls = emits(AnalyticsEventNames.SETTING_CHANGED)
    expect(calls.length).to.equal(1)
    const props = calls[0].args[1] as {
      outcome: string
      setting_key: string
      value_changed_from_default?: boolean
      value_kind: string
    }
    expect(props.outcome).to.equal('success')
    expect(props.setting_key).to.equal(SETTINGS_KEYS.AGENT_POOL_MAX_SIZE)
    expect(props.value_kind).to.equal('integer')
    expect(props.value_changed_from_default).to.equal(true)
  })

  it('emits setting_changed outcome=failure failure_kind=unknown_key on UnknownSettingKeyError', async () => {
    store.set.rejects(new UnknownSettingKeyError('bogus.key'))
    const handler = requestHandlers[SettingsEvents.SET]
    await handler({key: 'bogus.key', value: 1}, 'c1')
    const calls = emits(AnalyticsEventNames.SETTING_CHANGED)
    expect(calls.length).to.equal(1)
    const props = calls[0].args[1] as {failure_kind?: string; outcome: string; setting_key: string}
    expect(props.outcome).to.equal('failure')
    expect(props.failure_kind).to.equal('unknown_key')
    expect(props.setting_key).to.equal('bogus.key')
  })

  it('emits setting_changed outcome=failure failure_kind=validation on InvalidSettingValueError', async () => {
    store.set.rejects(new InvalidSettingValueError(SETTINGS_KEYS.AGENT_POOL_MAX_SIZE, 9999, 'too big'))
    const handler = requestHandlers[SettingsEvents.SET]
    await handler({key: SETTINGS_KEYS.AGENT_POOL_MAX_SIZE, value: 9999}, 'c1')
    const calls = emits(AnalyticsEventNames.SETTING_CHANGED)
    const props = calls[0].args[1] as {failure_kind?: string; outcome: string}
    expect(props.outcome).to.equal('failure')
    expect(props.failure_kind).to.equal('validation')
  })

  it('emits setting_reset outcome=success', async () => {
    const handler = requestHandlers[SettingsEvents.RESET]
    await handler({key: SETTINGS_KEYS.AGENT_POOL_MAX_SIZE}, 'c1')
    const calls = emits(AnalyticsEventNames.SETTING_RESET)
    expect(calls.length).to.equal(1)
    const props = calls[0].args[1] as {outcome: string; setting_key: string; value_kind: string}
    expect(props.outcome).to.equal('success')
    expect(props.value_kind).to.equal('integer')
  })

  it('emits setting_reset outcome=failure failure_kind=unknown_key on UnknownSettingKeyError', async () => {
    store.reset.rejects(new UnknownSettingKeyError('bogus.key'))
    const handler = requestHandlers[SettingsEvents.RESET]
    await handler({key: 'bogus.key'}, 'c1')
    const calls = emits(AnalyticsEventNames.SETTING_RESET)
    const props = calls[0].args[1] as {failure_kind?: string; outcome: string}
    expect(props.outcome).to.equal('failure')
    expect(props.failure_kind).to.equal('unknown_key')
  })

  it('regression: setting_changed payload never includes raw value or message', async () => {
    const secretValue = 'super-secret-string-leak-check' as unknown as number
    store.set.rejects(new Error('boom: super-secret-string-leak-check'))
    const handler = requestHandlers[SettingsEvents.SET]
    await handler({key: SETTINGS_KEYS.AGENT_POOL_MAX_SIZE, value: secretValue}, 'c1')
    const calls = emits(AnalyticsEventNames.SETTING_CHANGED)
    const props = calls[0].args[1] as Record<string, unknown>
    const json = JSON.stringify(props)
    expect(json).to.not.include('super-secret-string-leak-check')
    expect(json).to.not.include('boom:')
  })

  it('is a no-op when analyticsClient is not injected', async () => {
    const local: Record<string, RequestHandler> = {}
    const transportLocal = {...transport, onRequest: sandbox.stub().callsFake((e: string, h: RequestHandler) => {
      local[e] = h
    })} as never
    new SettingsHandler({store, transport: transportLocal}).setup()
    await local[SettingsEvents.SET]({key: SETTINGS_KEYS.AGENT_POOL_MAX_SIZE, value: 1}, 'c1')
    expect(analyticsClient.trackSpy.called).to.equal(false)
  })

  describe('readonly-info variant (M16.1)', () => {
    const readonlyInfoRegistry: readonly SettingDescriptor[] = [
      {
        category: 'updates',
        description: 'live operational snapshot for tests',
        key: '_test.snapshot',
        restartRequired: false,
        type: 'readonly-info',
      },
    ]

    let isolatedRequestHandlers: Record<string, RequestHandler>
    let isolatedAnalytics: IAnalyticsClient & {trackSpy: SinonStub}

    beforeEach(() => {
      isolatedRequestHandlers = {}
      const isolatedTransport = {
        ...transport,
        onRequest: sandbox.stub().callsFake((event: string, handler: RequestHandler) => {
          isolatedRequestHandlers[event] = handler
        }),
      } as never
      isolatedAnalytics = makeFakeAnalyticsClient()
      new SettingsHandler({
        analyticsClient: isolatedAnalytics,
        registry: readonlyInfoRegistry,
        store,
        transport: isolatedTransport,
      }).setup()
    })

    it('emits setting_changed failure_kind=read_only with value_kind=readonly-info on SET attempt', async () => {
      const handler = isolatedRequestHandlers[SettingsEvents.SET]
      await handler({key: '_test.snapshot', value: 1}, 'c1')
      const calls = isolatedAnalytics.trackSpy.getCalls().filter((c) => c.args[0] === AnalyticsEventNames.SETTING_CHANGED)
      expect(calls.length).to.equal(1)
      const props = calls[0].args[1] as {failure_kind?: string; outcome: string; setting_key: string; value_kind: string}
      expect(props.outcome).to.equal('failure')
      expect(props.failure_kind).to.equal('read_only')
      expect(props.setting_key).to.equal('_test.snapshot')
      expect(props.value_kind).to.equal('readonly-info')
    })

    it('emits setting_reset failure_kind=read_only with value_kind=readonly-info on RESET attempt', async () => {
      const handler = isolatedRequestHandlers[SettingsEvents.RESET]
      await handler({key: '_test.snapshot'}, 'c1')
      const calls = isolatedAnalytics.trackSpy.getCalls().filter((c) => c.args[0] === AnalyticsEventNames.SETTING_RESET)
      expect(calls.length).to.equal(1)
      const props = calls[0].args[1] as {failure_kind?: string; outcome: string; setting_key: string; value_kind: string}
      expect(props.outcome).to.equal('failure')
      expect(props.failure_kind).to.equal('read_only')
      expect(props.value_kind).to.equal('readonly-info')
    })

    it('does NOT call store.set when the SET is gated as read_only', async () => {
      const handler = isolatedRequestHandlers[SettingsEvents.SET]
      await handler({key: '_test.snapshot', value: 1}, 'c1')
      expect(store.set.called).to.equal(false)
    })

    it('does NOT call store.reset when the RESET is gated as read_only', async () => {
      const handler = isolatedRequestHandlers[SettingsEvents.RESET]
      await handler({key: '_test.snapshot'}, 'c1')
      expect(store.reset.called).to.equal(false)
    })
  })
})
