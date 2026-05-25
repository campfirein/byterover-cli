import type {ConnectionResult, ITransportClient} from '@campfirein/brv-transport-client'
import type {Config} from '@oclif/core'

import {Config as OclifConfig} from '@oclif/core'
import {expect} from 'chai'
import sinon, {restore, stub} from 'sinon'

import Dream from '../../src/oclif/commands/dream.js'

// ==================== TestableDreamCommand ====================

class TestableDreamCommand extends Dream {
  private readonly mockConnector: () => Promise<ConnectionResult>

  constructor(argv: string[], mockConnector: () => Promise<ConnectionResult>, config: Config) {
    super(argv, config)
    this.mockConnector = mockConnector
  }

  protected override getDaemonClientOptions() {
    return {
      maxRetries: 1,
      retryDelayMs: 0,
      transportConnector: this.mockConnector,
    }
  }
}

// ==================== Tests ====================

describe('Dream Command', () => {
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
      requestWithAck: stub().resolves({activeProvider: 'anthropic'}),
    } as unknown as sinon.SinonStubbedInstance<ITransportClient>

    mockConnector = stub<[], Promise<ConnectionResult>>().resolves({
      client: mockClient as unknown as ITransportClient,
      projectRoot: '/test/project',
    })
  })

  afterEach(() => {
    restore()
  })

  function createCommand(...argv: string[]): TestableDreamCommand {
    const command = new TestableDreamCommand(argv, mockConnector, config)
    stub(command, 'log').callsFake((msg?: string) => {
      if (msg) loggedMessages.push(msg)
    })
    return command
  }

  function createJsonCommand(...argv: string[]): TestableDreamCommand {
    const command = new TestableDreamCommand([...argv, '--format', 'json'], mockConnector, config)
    stub(command, 'log').callsFake((msg?: string) => {
      if (msg) loggedMessages.push(msg)
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

  // ==================== Detach Mode ====================

  describe('detach mode', () => {
    it('should submit task and exit immediately with confirmation', async () => {
      await createCommand('--detach').run()

      const requestStub = mockClient.requestWithAck as sinon.SinonStub
      expect(requestStub.callCount).to.equal(2)
      expect(requestStub.firstCall.args[0]).to.equal('state:getProviderConfig')
      const [event, payload] = requestStub.secondCall.args
      expect(event).to.equal('task:create')
      expect(payload).to.have.property('type', 'dream')
      expect(payload).to.have.property('taskId').that.is.a('string')
      expect(loggedMessages.some((m) => m.includes('Dream queued for processing'))).to.be.true
    })

    it('should include force in task payload when combined with --force', async () => {
      await createCommand('--detach', '--force').run()

      const requestStub = mockClient.requestWithAck as sinon.SinonStub
      const [, payload] = requestStub.secondCall.args
      expect(payload).to.have.property('force', true)
    })

    it('warns once that --timeout is deprecated when the user passes a non-default value', async () => {
      await createCommand('--detach', '--timeout', '600').run()

      const deprecationWarnings = loggedMessages.filter((m) => m.includes('--timeout is deprecated'))
      expect(deprecationWarnings).to.have.lengthOf(1)
      expect(deprecationWarnings[0]).to.include('has no effect')
      expect(deprecationWarnings[0]).to.not.include('llm.iterationBudgetMs')
    })

    it('does not warn about deprecation when --timeout is omitted', async () => {
      await createCommand('--detach').run()

      expect(loggedMessages.some((m) => m.includes('--timeout is deprecated'))).to.be.false
    })

    it('should output JSON on detach', async () => {
      await createJsonCommand('--detach').run()

      const json = parseJsonOutput()
      expect(json.command).to.equal('dream')
      expect(json.success).to.be.true
      expect(json.data).to.have.property('status', 'queued')
      expect(json.data).to.have.property('taskId').that.is.a('string')
      expect(json.data).to.have.property('message', 'Dream queued for processing')
    })

    it('should output JSON on detach with --force', async () => {
      await createJsonCommand('--detach', '--force').run()

      const json = parseJsonOutput()
      expect(json.success).to.be.true
      expect(json.data).to.have.property('status', 'queued')
    })

    it('should disconnect client after detach', async () => {
      await createCommand('--detach').run()

      expect(mockClient.disconnect.calledOnce).to.be.true
    })
  })
})
