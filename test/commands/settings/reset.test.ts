import type {ConnectionResult, ITransportClient} from '@campfirein/brv-transport-client'
import type {Config} from '@oclif/core'

import {Config as OclifConfig} from '@oclif/core'
import {expect} from 'chai'
import sinon, {restore, stub} from 'sinon'

import SettingsReset from '../../../src/oclif/commands/settings/reset.js'
import {SettingsEvents} from '../../../src/shared/transport/events/settings-events.js'

class TestableSettingsReset extends SettingsReset {
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

  protected override async resetSetting(key: string) {
    return super.resetSetting(key, {
      maxRetries: 1,
      retryDelayMs: 0,
      transportConnector: this.mockConnector,
    })
  }
}

function makeGetResponse(key: string): unknown {
  if (key === 'llm.iterationBudgetMs') {
    return {
      category: 'llm',
      current: 600_000,
      default: 600_000,
      description: 'b',
      key,
      max: 3_600_000,
      min: 60_000,
      ok: true,
      restartRequired: true,
      type: 'integer',
      unit: 'ms',
    }
  }

  return {
    category: 'concurrency',
    current: 10,
    default: 10,
    description: 'c',
    key,
    max: 100,
    min: 1,
    ok: true,
    restartRequired: true,
    type: 'integer',
  }
}

describe('brv settings reset', () => {
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

  function createCommand(...argv: string[]): TestableSettingsReset {
    const command = new TestableSettingsReset(argv, mockConnector, config)
    stub(command, 'log').callsFake((msg?: string) => {
      if (msg !== undefined) loggedMessages.push(msg)
    })
    return command
  }

  function createJsonCommand(...argv: string[]): TestableSettingsReset {
    const command = new TestableSettingsReset(['--format', 'json', ...argv], mockConnector, config)
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

  it('fetches GET then dispatches SettingsEvents.RESET with the requested key', async () => {
    dispatchByEvent((event) => {
      if (event === SettingsEvents.GET) return makeGetResponse('agentPool.maxSize')
      if (event === SettingsEvents.RESET) return {ok: true, restartRequired: true}
      throw new Error('unexpected event')
    })

    await createCommand('agentPool.maxSize').run()

    const requestStub = mockClient.requestWithAck as sinon.SinonStub
    const resetCall = requestStub.getCalls().find((c) => c.args[0] === SettingsEvents.RESET)
    expect(resetCall?.args[1]).to.deep.equal({key: 'agentPool.maxSize'})
  })

  it('echoes the human-formatted default for count keys ("back to default (10)")', async () => {
    dispatchByEvent((event) => {
      if (event === SettingsEvents.GET) return makeGetResponse('agentPool.maxSize')
      if (event === SettingsEvents.RESET) return {ok: true, restartRequired: true}
      throw new Error('unexpected event')
    })

    await createCommand('agentPool.maxSize').run()
    const output = loggedMessages.join('\n')
    expect(output).to.match(/Setting reset: agentPool\.maxSize back to default \(10\)/)
    expect(output).to.include('brv restart')
    expect(process.exitCode ?? 0).to.equal(0)
  })

  it('echoes the human-formatted default for ms keys ("back to default (10m)")', async () => {
    dispatchByEvent((event) => {
      if (event === SettingsEvents.GET) return makeGetResponse('llm.iterationBudgetMs')
      if (event === SettingsEvents.RESET) return {ok: true, restartRequired: true}
      throw new Error('unexpected event')
    })

    await createCommand('llm.iterationBudgetMs').run()
    const output = loggedMessages.join('\n')
    expect(output).to.match(/Setting reset: llm\.iterationBudgetMs back to default \(10m\)/)
  })

  it('prints the daemon error and sets exit code 1 on unknown_key (from GET)', async () => {
    dispatchByEvent((event) => {
      if (event === SettingsEvents.GET) {
        return {
          error: {code: 'unknown_key', key: 'not.a.key', message: "Unknown settings key: 'not.a.key'"},
          ok: false,
        }
      }

      throw new Error('RESET should not be dispatched when GET fails')
    })

    await createCommand('not.a.key').run()

    expect(loggedMessages.some((m) => m.includes('not.a.key'))).to.be.true
    expect(process.exitCode).to.equal(1)
  })

  it('outputs JSON success payload', async () => {
    dispatchByEvent((event) => {
      if (event === SettingsEvents.GET) return makeGetResponse('agentPool.maxSize')
      if (event === SettingsEvents.RESET) return {ok: true, restartRequired: true}
      throw new Error('unexpected event')
    })

    await createJsonCommand('agentPool.maxSize').run()

    const json = parseJsonOutput()
    expect(json.command).to.equal('settings reset')
    expect(json.success).to.be.true
    expect(json.data).to.have.property('restartRequired', true)
  })

  it('outputs JSON error payload and sets exit code 1 on unknown_key', async () => {
    dispatchByEvent((event) => {
      if (event === SettingsEvents.GET) {
        return {error: {code: 'unknown_key', key: 'x', message: 'Unknown settings key'}, ok: false}
      }

      throw new Error('RESET should not be dispatched when GET fails')
    })

    await createJsonCommand('x').run()

    const json = parseJsonOutput()
    expect(json.command).to.equal('settings reset')
    expect(json.success).to.be.false
    expect(json.data).to.have.property('error')
    expect(process.exitCode).to.equal(1)
  })

  it('emits a one-line help mentioning the restart-required behavior', () => {
    expect(SettingsReset.description ?? '').to.match(/restart/i)
  })
})
