import type {ConnectionResult, ITransportClient} from '@campfirein/brv-transport-client'
import type {Config} from '@oclif/core'

import {Config as OclifConfig} from '@oclif/core'
import {expect} from 'chai'
import sinon, {restore, stub} from 'sinon'

import SettingsGet from '../../../src/oclif/commands/settings/get.js'
import {SettingsEvents} from '../../../src/shared/transport/events/settings-events.js'

class TestableSettingsGet extends SettingsGet {
  private readonly mockConnector: () => Promise<ConnectionResult>

  public constructor(argv: string[], mockConnector: () => Promise<ConnectionResult>, config: Config) {
    super(argv, config)
    this.mockConnector = mockConnector
  }

  protected override async fetchSetting(key: string) {
    return super.fetchSetting(key, {
      maxRetries: 1,
      retryDelayMs: 0,
      transportConnector: this.mockConnector,
    })
  }
}

describe('brv settings get', () => {
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
      requestWithAck: stub().resolves({error: {code: 'unknown_key', key: 'x', message: 'no'}, ok: false}),
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

  function createCommand(...argv: string[]): TestableSettingsGet {
    const command = new TestableSettingsGet(argv, mockConnector, config)
    stub(command, 'log').callsFake((msg?: string) => {
      if (msg !== undefined) loggedMessages.push(msg)
    })
    return command
  }

  function createJsonCommand(...argv: string[]): TestableSettingsGet {
    const command = new TestableSettingsGet(['--format', 'json', ...argv], mockConnector, config)
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

  it('dispatches SettingsEvents.GET with the requested key', async () => {
    const requestStub = mockClient.requestWithAck as sinon.SinonStub
    requestStub.resolves({
      current: 25,
      default: 10,
      description: 'desc',
      key: 'agentPool.maxSize',
      max: 100,
      min: 1,
      ok: true,
      restartRequired: true,
      type: 'integer',
    })

    await createCommand('agentPool.maxSize').run()

    expect(requestStub.calledOnceWith(SettingsEvents.GET, {key: 'agentPool.maxSize'})).to.be.true
  })

  it('prints the M7 multi-line block for a count key (key / current / default / range / scope)', async () => {
    const requestStub = mockClient.requestWithAck as sinon.SinonStub
    requestStub.resolves({
      category: 'concurrency',
      current: 25,
      default: 10,
      description: 'desc',
      key: 'agentPool.maxSize',
      max: 100,
      min: 1,
      ok: true,
      restartRequired: true,
      type: 'integer',
    })

    await createCommand('agentPool.maxSize').run()
    const output = loggedMessages.join('\n')

    expect(output).to.include('agentPool.maxSize')
    expect(output).to.match(/current:\s*25/)
    expect(output).to.match(/default:\s*10/)
    expect(output).to.match(/range:\s*1-100/)
    expect(output).to.match(/scope:\s*global/)
    expect(process.exitCode ?? 0).to.equal(0)
  })

  it('renders current/default in human duration form for ms-unit keys', async () => {
    const requestStub = mockClient.requestWithAck as sinon.SinonStub
    requestStub.resolves({
      category: 'llm',
      current: 600_000,
      default: 600_000,
      description: 'b',
      key: 'llm.iterationBudgetMs',
      max: 3_600_000,
      min: 60_000,
      ok: true,
      restartRequired: true,
      type: 'integer',
      unit: 'ms',
    })

    await createCommand('llm.iterationBudgetMs').run()
    const output = loggedMessages.join('\n')

    expect(output).to.match(/current:\s*10m\b/)
    expect(output).to.match(/default:\s*10m\b/)
    expect(output).to.match(/range:\s*1m-1h/)
  })

  it('prints the daemon error message and sets exit code 1 for an unknown_key error', async () => {
    const requestStub = mockClient.requestWithAck as sinon.SinonStub
    requestStub.resolves({
      error: {code: 'unknown_key', key: 'not.a.key', message: "Unknown settings key: 'not.a.key'"},
      ok: false,
    })

    await createCommand('not.a.key').run()

    expect(loggedMessages.some((m) => m.includes('not.a.key'))).to.be.true
    expect(process.exitCode).to.equal(1)
  })

  it('outputs JSON success payload for a known key', async () => {
    const requestStub = mockClient.requestWithAck as sinon.SinonStub
    requestStub.resolves({
      current: 25,
      default: 10,
      description: 'desc',
      key: 'agentPool.maxSize',
      max: 100,
      min: 1,
      ok: true,
      restartRequired: true,
      type: 'integer',
    })

    await createJsonCommand('agentPool.maxSize').run()

    const json = parseJsonOutput()
    expect(json.command).to.equal('settings get')
    expect(json.success).to.be.true
    expect(json.data).to.have.property('current', 25)
    expect(json.data).to.have.property('default', 10)
  })

  it('outputs JSON error payload for unknown_key and sets exit code 1', async () => {
    const requestStub = mockClient.requestWithAck as sinon.SinonStub
    requestStub.resolves({
      error: {code: 'unknown_key', key: 'x', message: 'Unknown settings key'},
      ok: false,
    })

    await createJsonCommand('x').run()

    const json = parseJsonOutput()
    expect(json.command).to.equal('settings get')
    expect(json.success).to.be.false
    expect(json.data).to.have.property('error')
    expect(process.exitCode).to.equal(1)
  })

  it('emits a one-line help mentioning the restart-required behavior', () => {
    const description = SettingsGet.description ?? ''
    expect(description).to.match(/restart/i)
  })
})
