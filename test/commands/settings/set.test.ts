import type {ConnectionResult, ITransportClient} from '@campfirein/brv-transport-client'
import type {Config} from '@oclif/core'

import {Config as OclifConfig} from '@oclif/core'
import {expect} from 'chai'
import sinon, {restore, stub} from 'sinon'

import SettingsSet from '../../../src/oclif/commands/settings/set.js'
import {SettingsEvents} from '../../../src/shared/transport/events/settings-events.js'

class TestableSettingsSet extends SettingsSet {
  private readonly mockConnector: () => Promise<ConnectionResult>

  public constructor(argv: string[], mockConnector: () => Promise<ConnectionResult>, config: Config) {
    super(argv, config)
    this.mockConnector = mockConnector
  }

  protected override async fetchDescriptor(key: string) {
    return super.fetchDescriptor(key, {
      maxRetries: 1,
      retryDelayMs: 0,
      transportConnector: this.mockConnector,
    })
  }

  protected override async writeSetting(key: string, value: boolean | number) {
    return super.writeSetting(key, value, {
      maxRetries: 1,
      retryDelayMs: 0,
      transportConnector: this.mockConnector,
    })
  }
}

type DescriptorOverrides = Partial<{
  category: 'concurrency' | 'llm' | 'task-history'
  default: number
  description: string
  max: number
  min: number
  unit: 'count' | 'ms'
}>

function makeBooleanGetResponse(key: string, current: boolean): unknown {
  return {
    category: 'updates',
    current,
    default: true,
    description: 'desc',
    key,
    ok: true,
    restartRequired: false,
    type: 'boolean',
  }
}

function makeGetResponse(key: string, current: number, overrides: DescriptorOverrides = {}): unknown {
  const defaults: Record<string, DescriptorOverrides> = {
    'agentPool.maxSize': {category: 'concurrency', default: 10, max: 100, min: 1},
    'llm.iterationBudgetMs': {category: 'llm', default: 600_000, max: 3_600_000, min: 60_000, unit: 'ms'},
    'taskHistory.maxEntries': {category: 'task-history', default: 1000, max: 10_000, min: 10},
  }
  const merged = {...defaults[key], ...overrides}
  const payload: Record<string, unknown> = {
    current,
    default: merged.default ?? current,
    description: merged.description ?? 'desc',
    key,
    max: merged.max ?? 100,
    min: merged.min ?? 1,
    ok: true,
    restartRequired: true,
    type: 'integer',
  }
  if (merged.category !== undefined) payload.category = merged.category
  if (merged.unit !== undefined) payload.unit = merged.unit
  return payload
}

describe('brv settings set', () => {
  let config: Config
  let loggedMessages: string[]
  let stdoutOutput: string[]
  let mockClient: sinon.SinonStubbedInstance<ITransportClient>
  let mockConnector: sinon.SinonStub<[], Promise<ConnectionResult>>
  let originalExitCode: number | string | undefined

  before(async () => {
    config = await OclifConfig.load(import.meta.url)
  })

  beforeEach(() => {
    loggedMessages = []
    stdoutOutput = []
    originalExitCode = process.exitCode

    mockClient = {
      connect: stub().resolves(),
      disconnect: stub().resolves(),
      getClientId: stub().returns('test-client-id'),
      getDaemonVersion: stub(),
      getState: stub().returns('connected'),
      isConnected: stub().resolves(true),
      joinRoom: stub().resolves(),
      leaveRoom: stub().resolves(),
      on: stub().returns(() => {}),
      once: stub(),
      onStateChange: stub().returns(() => {}),
      request: stub() as unknown as ITransportClient['request'],
      requestWithAck: stub().resolves({ok: true, restartRequired: true}),
    } as unknown as sinon.SinonStubbedInstance<ITransportClient>

    mockConnector = stub<[], Promise<ConnectionResult>>().resolves({
      client: mockClient as unknown as ITransportClient,
      projectRoot: '/test/project',
    })
  })

  afterEach(() => {
    process.exitCode = originalExitCode
    restore()
  })

  function createCommand(...argv: string[]): TestableSettingsSet {
    const command = new TestableSettingsSet(argv, mockConnector, config)
    stub(command, 'log').callsFake((msg?: string) => {
      if (msg !== undefined) loggedMessages.push(msg)
    })
    return command
  }

  function createJsonCommand(...argv: string[]): TestableSettingsSet {
    const command = new TestableSettingsSet(['--format', 'json', ...argv], mockConnector, config)
    stub(command, 'log').callsFake((msg?: string) => {
      if (msg !== undefined) loggedMessages.push(msg)
    })
    stub(process.stdout, 'write').callsFake((chunk: string | Uint8Array) => {
      stdoutOutput.push(String(chunk))
      return true
    })
    return command
  }

  function parseJsonOutput(): {command: string; data: Record<string, unknown>; success: boolean} {
    return JSON.parse(stdoutOutput.join('').trim())
  }

  function dispatchByEvent(handler: (event: string, payload?: unknown) => unknown): void {
    const requestStub = mockClient.requestWithAck as sinon.SinonStub
    requestStub.callsFake(handler as never)
  }

  it('count keys: parses integer arg, fetches GET for descriptor, then dispatches SET (number)', async () => {
    dispatchByEvent((event, payload) => {
      if (event === SettingsEvents.GET) return makeGetResponse('agentPool.maxSize', 10)
      if (event === SettingsEvents.SET) return {ok: true, restartRequired: true}
      throw new Error(`unexpected event ${event}: ${JSON.stringify(payload)}`)
    })

    await createCommand('agentPool.maxSize', '25').run()

    const requestStub = mockClient.requestWithAck as sinon.SinonStub
    const setCall = requestStub.getCalls().find((c) => c.args[0] === SettingsEvents.SET)
    expect(setCall, 'SET dispatch').to.exist
    expect(setCall?.args[1]).to.deep.equal({key: 'agentPool.maxSize', value: 25})
    expect(process.exitCode ?? 0).to.equal(0)
  })

  it('ms keys: parses "30m" via parseDuration and dispatches SET with the integer ms value', async () => {
    dispatchByEvent((event) => {
      if (event === SettingsEvents.GET) return makeGetResponse('llm.iterationBudgetMs', 600_000)
      if (event === SettingsEvents.SET) return {ok: true, restartRequired: true}
      throw new Error('unexpected event')
    })

    await createCommand('llm.iterationBudgetMs', '30m').run()

    const requestStub = mockClient.requestWithAck as sinon.SinonStub
    const setCall = requestStub.getCalls().find((c) => c.args[0] === SettingsEvents.SET)
    expect(setCall?.args[1]).to.deep.equal({key: 'llm.iterationBudgetMs', value: 1_800_000})
    expect(process.exitCode ?? 0).to.equal(0)
  })

  it('ms keys: bare integer input is still accepted as raw ms (back-compat)', async () => {
    dispatchByEvent((event) => {
      if (event === SettingsEvents.GET) return makeGetResponse('llm.iterationBudgetMs', 600_000)
      if (event === SettingsEvents.SET) return {ok: true, restartRequired: true}
      throw new Error('unexpected event')
    })

    await createCommand('llm.iterationBudgetMs', '1800000').run()

    const requestStub = mockClient.requestWithAck as sinon.SinonStub
    const setCall = requestStub.getCalls().find((c) => c.args[0] === SettingsEvents.SET)
    expect(setCall?.args[1]).to.deep.equal({key: 'llm.iterationBudgetMs', value: 1_800_000})
  })

  it('count keys: a duration-shaped argument is rejected locally with a unit-mismatch message', async () => {
    dispatchByEvent((event) => {
      if (event === SettingsEvents.GET) return makeGetResponse('agentPool.maxSize', 10)
      throw new Error('SET should not be dispatched on cross-unit input')
    })

    await createCommand('agentPool.maxSize', '30m').run()

    const requestStub = mockClient.requestWithAck as sinon.SinonStub
    const setCall = requestStub.getCalls().find((c) => c.args[0] === SettingsEvents.SET)
    expect(setCall).to.equal(undefined)
    const stderr = loggedMessages.join('\n')
    expect(stderr).to.match(/expects an integer count/)
    expect(process.exitCode).to.equal(1)
  })

  it('ms keys: an unknown-unit argument is rejected locally with the parser hint', async () => {
    dispatchByEvent((event) => {
      if (event === SettingsEvents.GET) return makeGetResponse('llm.iterationBudgetMs', 600_000)
      throw new Error('SET should not be dispatched on parse error')
    })

    await createCommand('llm.iterationBudgetMs', '10x').run()

    const stderr = loggedMessages.join('\n')
    expect(stderr).to.match(/try 30m, 1h, 1h 30m, or a raw ms integer/)
    expect(process.exitCode).to.equal(1)
  })

  it('echoes the value in human form on success for ms keys', async () => {
    dispatchByEvent((event) => {
      if (event === SettingsEvents.GET) return makeGetResponse('llm.iterationBudgetMs', 600_000)
      if (event === SettingsEvents.SET) return {ok: true, restartRequired: true}
      throw new Error('unexpected event')
    })

    await createCommand('llm.iterationBudgetMs', '30m').run()

    const output = loggedMessages.join('\n')
    expect(output).to.include('Setting saved: llm.iterationBudgetMs = 30m')
    expect(output).to.include('brv restart')
    expect(process.exitCode ?? 0).to.equal(0)
  })

  it('prints the daemon error and sets exit code 1 on validator rejection (post-parse)', async () => {
    dispatchByEvent((event) => {
      if (event === SettingsEvents.GET) return makeGetResponse('agentPool.maxSize', 10)
      if (event === SettingsEvents.SET) {
        return {
          error: {code: 'invalid_value', key: 'agentPool.maxSize', message: 'value 150 is outside allowed range [1, 100]', value: 150},
          ok: false,
        }
      }

      throw new Error('unexpected event')
    })

    await createCommand('agentPool.maxSize', '150').run()

    expect(loggedMessages.some((m) => m.includes('outside allowed range'))).to.be.true
    expect(process.exitCode).to.equal(1)
  })

  it('outputs JSON success payload', async () => {
    dispatchByEvent((event) => {
      if (event === SettingsEvents.GET) return makeGetResponse('agentPool.maxSize', 10)
      if (event === SettingsEvents.SET) return {ok: true, restartRequired: true}
      throw new Error('unexpected event')
    })

    await createJsonCommand('agentPool.maxSize', '25').run()

    const json = parseJsonOutput()
    expect(json.command).to.equal('settings set')
    expect(json.success).to.be.true
    expect(json.data).to.have.property('restartRequired', true)
  })

  it('outputs JSON error payload and sets exit code 1 on validation failure', async () => {
    dispatchByEvent((event) => {
      if (event === SettingsEvents.GET) return makeGetResponse('agentPool.maxSize', 10)
      if (event === SettingsEvents.SET) {
        return {
          error: {code: 'invalid_value', key: 'agentPool.maxSize', message: 'too high', value: 999},
          ok: false,
        }
      }

      throw new Error('unexpected event')
    })

    await createJsonCommand('agentPool.maxSize', '999').run()

    const json = parseJsonOutput()
    expect(json.command).to.equal('settings set')
    expect(json.success).to.be.false
    expect(json.data).to.have.property('error')
    expect(process.exitCode).to.equal(1)
  })

  it('emits a one-line help mentioning the restart-required behavior', () => {
    expect(SettingsSet.description ?? '').to.match(/restart/i)
  })

  describe('boolean keys (T4)', () => {
    const ACCEPTED_TRUE = ['true', 'TRUE', 'True', 'on', 'ON', 'On', '1', 'yes', 'YES', 'Yes']
    const ACCEPTED_FALSE = ['false', 'FALSE', 'False', 'off', 'OFF', 'Off', '0', 'no', 'NO', 'No']

    for (const token of ACCEPTED_TRUE) {
      it(`parses '${token}' as true and dispatches SET with boolean true`, async () => {
        dispatchByEvent((event) => {
          if (event === SettingsEvents.GET) return makeBooleanGetResponse('update.checkForUpdates', false)
          if (event === SettingsEvents.SET) return {ok: true, restartRequired: false}
          throw new Error('unexpected event')
        })

        await createCommand('update.checkForUpdates', token).run()

        const requestStub = mockClient.requestWithAck as sinon.SinonStub
        const setCall = requestStub.getCalls().find((c) => c.args[0] === SettingsEvents.SET)
        expect(setCall?.args[1]).to.deep.equal({key: 'update.checkForUpdates', value: true})
      })
    }

    for (const token of ACCEPTED_FALSE) {
      it(`parses '${token}' as false and dispatches SET with boolean false`, async () => {
        dispatchByEvent((event) => {
          if (event === SettingsEvents.GET) return makeBooleanGetResponse('update.checkForUpdates', true)
          if (event === SettingsEvents.SET) return {ok: true, restartRequired: false}
          throw new Error('unexpected event')
        })

        await createCommand('update.checkForUpdates', token).run()

        const requestStub = mockClient.requestWithAck as sinon.SinonStub
        const setCall = requestStub.getCalls().find((c) => c.args[0] === SettingsEvents.SET)
        expect(setCall?.args[1]).to.deep.equal({key: 'update.checkForUpdates', value: false})
      })
    }

    it('rejects "5" on a boolean key with the documented expected-boolean message', async () => {
      dispatchByEvent((event) => {
        if (event === SettingsEvents.GET) return makeBooleanGetResponse('update.checkForUpdates', true)
        throw new Error('SET should not be dispatched on parse error')
      })

      await createCommand('update.checkForUpdates', '5').run()

      const stderr = loggedMessages.join('\n')
      expect(stderr).to.include('expected boolean (true, false, on, off, 1, 0, yes, no)')
      expect(process.exitCode).to.equal(1)
    })

    it('rejects "maybe" on a boolean key with the same documented message', async () => {
      dispatchByEvent((event) => {
        if (event === SettingsEvents.GET) return makeBooleanGetResponse('update.checkForUpdates', true)
        throw new Error('SET should not be dispatched on parse error')
      })

      await createCommand('update.checkForUpdates', 'maybe').run()

      const stderr = loggedMessages.join('\n')
      expect(stderr).to.include('expected boolean')
      expect(process.exitCode).to.equal(1)
    })

    it('integer key still rejects "true" with the "expects an integer count" message (parser dispatch correct)', async () => {
      dispatchByEvent((event) => {
        if (event === SettingsEvents.GET) return makeGetResponse('agentPool.maxSize', 10)
        throw new Error('SET should not be dispatched on parse error')
      })

      await createCommand('agentPool.maxSize', 'true').run()

      const stderr = loggedMessages.join('\n')
      expect(stderr).to.match(/expects an integer count/)
      expect(process.exitCode).to.equal(1)
    })

    it('omits the "Run `brv restart`" line on success when descriptor does not require restart', async () => {
      dispatchByEvent((event) => {
        if (event === SettingsEvents.GET) return makeBooleanGetResponse('update.checkForUpdates', true)
        if (event === SettingsEvents.SET) return {ok: true, restartRequired: false}
        throw new Error('unexpected event')
      })

      await createCommand('update.checkForUpdates', 'off').run()

      const output = loggedMessages.join('\n')
      expect(output).to.include('Setting saved: update.checkForUpdates = false')
      expect(output, 'must not mention `brv restart` for restartRequired:false keys').to.not.match(/brv restart/i)
    })

    it('keeps the "Run `brv restart`" line on success for restart-required integer keys (regression)', async () => {
      dispatchByEvent((event) => {
        if (event === SettingsEvents.GET) return makeGetResponse('agentPool.maxSize', 10)
        if (event === SettingsEvents.SET) return {ok: true, restartRequired: true}
        throw new Error('unexpected event')
      })

      await createCommand('agentPool.maxSize', '25').run()

      const output = loggedMessages.join('\n')
      expect(output).to.match(/Run `brv restart` to apply/)
    })
  })
})
