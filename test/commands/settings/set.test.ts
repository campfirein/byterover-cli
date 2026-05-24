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

  protected override async writeSetting(key: string, value: unknown) {
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
})
