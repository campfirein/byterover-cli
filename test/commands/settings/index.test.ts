import type {ConnectionResult, ITransportClient} from '@campfirein/brv-transport-client'
import type {Config} from '@oclif/core'

import {Config as OclifConfig} from '@oclif/core'
import {expect} from 'chai'
import sinon, {restore, stub} from 'sinon'

import Settings from '../../../src/oclif/commands/settings/index.js'
import {SettingsEvents} from '../../../src/shared/transport/events/settings-events.js'

class TestableSettings extends Settings {
  private readonly mockConnector: () => Promise<ConnectionResult>

  public constructor(argv: string[], mockConnector: () => Promise<ConnectionResult>, config: Config) {
    super(argv, config)
    this.mockConnector = mockConnector
  }

  protected override async fetchSettings() {
    return super.fetchSettings({
      maxRetries: 1,
      retryDelayMs: 0,
      transportConnector: this.mockConnector,
    })
  }
}

describe('brv settings (index)', () => {
  let config: Config
  let loggedMessages: string[]
  let stdoutOutput: string[]
  let mockClient: sinon.SinonStubbedInstance<ITransportClient>
  let mockConnector: sinon.SinonStub<[], Promise<ConnectionResult>>

  before(async () => {
    config = await OclifConfig.load(import.meta.url)
  })

  beforeEach(() => {
    loggedMessages = []
    stdoutOutput = []

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
      requestWithAck: stub().resolves({items: []}),
    } as unknown as sinon.SinonStubbedInstance<ITransportClient>

    mockConnector = stub<[], Promise<ConnectionResult>>().resolves({
      client: mockClient as unknown as ITransportClient,
      projectRoot: '/test/project',
    })
  })

  afterEach(() => {
    restore()
  })

  function createCommand(...argv: string[]): TestableSettings {
    const command = new TestableSettings(argv, mockConnector, config)
    stub(command, 'log').callsFake((msg?: string) => {
      if (msg !== undefined) loggedMessages.push(msg)
    })
    return command
  }

  function createJsonCommand(...argv: string[]): TestableSettings {
    const command = new TestableSettings(['--format', 'json', ...argv], mockConnector, config)
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
    const output = stdoutOutput.join('')
    return JSON.parse(output.trim())
  }

  it('dispatches SettingsEvents.LIST through the transport client', async () => {
    const requestStub = mockClient.requestWithAck as sinon.SinonStub
    requestStub.resolves({items: []})

    await createCommand().run()

    expect(requestStub.calledOnceWith(SettingsEvents.LIST)).to.be.true
  })

  it('renders the M7 grouped layout: scope header + section headers + no RESTART column', async () => {
    const requestStub = mockClient.requestWithAck as sinon.SinonStub
    requestStub.resolves({
      items: [
        {
          category: 'concurrency',
          current: 25,
          default: 10,
          description: 'Max concurrent active projects.',
          key: 'agentPool.maxSize',
          max: 100,
          min: 1,
          restartRequired: true,
          type: 'integer',
        },
        {
          category: 'llm',
          current: 600_000,
          default: 600_000,
          description: 'Loop budget.',
          key: 'llm.iterationBudgetMs',
          max: 3_600_000,
          min: 60_000,
          restartRequired: true,
          type: 'integer',
          unit: 'ms',
        },
        {
          category: 'task-history',
          current: 1000,
          default: 1000,
          description: 'History size.',
          key: 'taskHistory.maxEntries',
          max: 10_000,
          min: 10,
          restartRequired: true,
          type: 'integer',
        },
      ],
    })

    await createCommand().run()
    const output = loggedMessages.join('\n')

    // Scope header line + restart reminder.
    expect(output).to.match(/scope:\s*global/)
    expect(output).to.include('brv restart')

    // Group section headers, uppercased from category enum.
    expect(output).to.include('CONCURRENCY')
    expect(output).to.include('LLM')
    expect(output).to.include('TASK HISTORY')

    // Rows in human form.
    const llmRow = loggedMessages.find((m) => m.includes('llm.iterationBudgetMs'))
    expect(llmRow, 'row for llm.iterationBudgetMs').to.exist
    expect(llmRow).to.include('10m')
    expect(llmRow).to.match(/default\s*10m/)

    const historyRow = loggedMessages.find((m) => m.includes('taskHistory.maxEntries'))
    expect(historyRow).to.include('1,000')

    // Dead RESTART column is gone.
    const headerLineWithRestart = loggedMessages.find((m) => /\bRESTART\?/.test(m))
    expect(headerLineWithRestart).to.equal(undefined)
    const yesNoRow = loggedMessages.find((m) => /\byes\b/.test(m) && m.includes('agentPool.maxSize'))
    expect(yesNoRow).to.equal(undefined)

    // Footer surfaces the set/reset entry points.
    expect(output).to.match(/brv settings set/)
    expect(output).to.match(/brv settings reset/)
  })

  it('groups items by category even when the daemon returns them in a different order', async () => {
    const requestStub = mockClient.requestWithAck as sinon.SinonStub
    requestStub.resolves({
      items: [
        {
          category: 'task-history',
          current: 1000,
          default: 1000,
          description: 'h',
          key: 'taskHistory.maxEntries',
          max: 10_000,
          min: 10,
          restartRequired: true,
          type: 'integer',
        },
        {
          category: 'llm',
          current: 600_000,
          default: 600_000,
          description: 'b',
          key: 'llm.iterationBudgetMs',
          max: 3_600_000,
          min: 60_000,
          restartRequired: true,
          type: 'integer',
          unit: 'ms',
        },
        {
          category: 'concurrency',
          current: 10,
          default: 10,
          description: 'c',
          key: 'agentPool.maxSize',
          max: 100,
          min: 1,
          restartRequired: true,
          type: 'integer',
        },
      ],
    })

    await createCommand().run()
    const concurrencyIdx = loggedMessages.findIndex((m) => m.includes('CONCURRENCY'))
    const llmIdx = loggedMessages.findIndex((m) => m.includes('LLM'))
    const historyIdx = loggedMessages.findIndex((m) => m.includes('TASK HISTORY'))
    expect(concurrencyIdx).to.be.lessThan(llmIdx)
    expect(llmIdx).to.be.lessThan(historyIdx)
  })

  it('adds the coupling hint inline on llm.requestTimeoutMs only', async () => {
    const requestStub = mockClient.requestWithAck as sinon.SinonStub
    requestStub.resolves({
      items: [
        {
          category: 'llm',
          current: 120_000,
          default: 120_000,
          description: 'b',
          key: 'llm.requestTimeoutMs',
          max: 3_600_000,
          min: 10_000,
          restartRequired: true,
          type: 'integer',
          unit: 'ms',
        },
        {
          category: 'llm',
          current: 600_000,
          default: 600_000,
          description: 'a',
          key: 'llm.iterationBudgetMs',
          max: 3_600_000,
          min: 60_000,
          restartRequired: true,
          type: 'integer',
          unit: 'ms',
        },
      ],
    })

    await createCommand().run()
    const timeoutRow = loggedMessages.find((m) => m.includes('llm.requestTimeoutMs'))
    expect(timeoutRow, 'timeout row').to.exist
    expect(timeoutRow).to.include('max loop budget')

    const budgetRow = loggedMessages.find((m) => m.includes('llm.iterationBudgetMs'))
    expect(budgetRow).to.not.include('max loop budget')
  })

  it('emits a one-line help mentioning the restart-required behavior', () => {
    const description = Settings.description ?? ''
    expect(description).to.match(/restart/i)
  })

  it('outputs the raw items array under --format json', async () => {
    const requestStub = mockClient.requestWithAck as sinon.SinonStub
    requestStub.resolves({
      items: [
        {
          current: 25,
          default: 10,
          description: 'Maximum number of concurrent active projects.',
          key: 'agentPool.maxSize',
          max: 100,
          min: 1,
          restartRequired: true,
          type: 'integer',
        },
      ],
    })

    await createJsonCommand().run()

    const json = parseJsonOutput()
    expect(json.command).to.equal('settings')
    expect(json.success).to.be.true
    expect(json.data).to.have.property('items').that.is.an('array').with.lengthOf(1)
  })

  it('outputs JSON error on connection failure', async () => {
    mockConnector.rejects(new Error('Connection failed'))

    await createJsonCommand().run()

    const json = parseJsonOutput()
    expect(json.command).to.equal('settings')
    expect(json.success).to.be.false
    expect(json.data).to.have.property('error')
  })

  it('logs a connection error message in text mode', async () => {
    mockConnector.rejects(new Error('Connection failed'))

    await createCommand().run()

    expect(loggedMessages.some((m) => m.includes('Connection failed'))).to.be.true
  })
})
