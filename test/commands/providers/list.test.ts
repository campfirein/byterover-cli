import type {ConnectionResult, ITransportClient} from '@campfirein/brv-transport-client'
import type {Config} from '@oclif/core'

import {Config as OclifConfig} from '@oclif/core'
import {expect} from 'chai'
import sinon, {restore, stub} from 'sinon'

import ProviderList from '../../../src/oclif/commands/providers/list.js'

// ==================== TestableProviderListCommand ====================

class TestableProviderListCommand extends ProviderList {
  private readonly mockConnector: () => Promise<ConnectionResult>

  constructor(argv: string[], mockConnector: () => Promise<ConnectionResult>, config: Config) {
    super(argv, config)
    this.mockConnector = mockConnector
  }

  protected override async fetchAll() {
    return super.fetchAll({
      maxRetries: 1,
      retryDelayMs: 0,
      transportConnector: this.mockConnector,
    })
  }
}

// ==================== Tests ====================

describe('Provider List Command', () => {
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
      requestWithAck: stub().resolves({}),
    } as unknown as sinon.SinonStubbedInstance<ITransportClient>

    mockConnector = stub<[], Promise<ConnectionResult>>().resolves({
      client: mockClient as unknown as ITransportClient,
      projectRoot: '/test/project',
    })
  })

  afterEach(() => {
    restore()
  })

  function createCommand(...argv: string[]): TestableProviderListCommand {
    const command = new TestableProviderListCommand(argv, mockConnector, config)
    stub(command, 'log').callsFake((msg?: string) => {
      if (msg) loggedMessages.push(msg)
    })
    return command
  }

  function createJsonCommand(...argv: string[]): TestableProviderListCommand {
    const command = new TestableProviderListCommand(['--format', 'json', ...argv], mockConnector, config)
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

  function mockListResponse(providers: Record<string, unknown>[]): void {
    ;(mockClient.requestWithAck as sinon.SinonStub).resolves({providers})
  }

  function mockByteRoverContext(
    providers: Record<string, unknown>[],
    teams: Record<string, unknown>[],
    billing: Record<string, unknown>,
  ): void {
    const requestStub = mockClient.requestWithAck as sinon.SinonStub
    requestStub.callsFake(async (event: string) => {
      if (event === 'provider:list') return {providers}
      if (event === 'team:list') return {teams}
      if (event === 'billing:resolve') return {billing}
      return {}
    })
  }

  // ==================== List Providers ====================

  describe('list providers', () => {
    it('should display all providers with their status', async () => {
      mockListResponse([
        {id: 'anthropic', isConnected: true, isCurrent: true, name: 'Anthropic'},
        {id: 'openai', isConnected: true, isCurrent: false, name: 'OpenAI'},
        {id: 'groq', isConnected: false, isCurrent: false, name: 'Groq'},
      ])

      await createCommand().run()

      expect(loggedMessages.some((m) => m.includes('Anthropic') && m.includes('[anthropic]'))).to.be.true
      expect(loggedMessages.some((m) => m.includes('OpenAI') && m.includes('[openai]'))).to.be.true
      expect(loggedMessages.some((m) => m.includes('Groq') && m.includes('[groq]'))).to.be.true
    })

    it('should show "(current)" for the current provider', async () => {
      mockListResponse([
        {id: 'anthropic', isConnected: true, isCurrent: true, name: 'Anthropic'},
      ])

      await createCommand().run()

      expect(loggedMessages.some((m) => m.includes('(current)'))).to.be.true
    })

    it('should show "(connected)" for connected non-active providers', async () => {
      mockListResponse([
        {id: 'openai', isConnected: true, isCurrent: false, name: 'OpenAI'},
      ])

      await createCommand().run()

      expect(loggedMessages.some((m) => m.includes('(connected)'))).to.be.true
    })

    it('should show no status for disconnected providers', async () => {
      mockListResponse([
        {id: 'groq', isConnected: false, isCurrent: false, name: 'Groq'},
      ])

      await createCommand().run()

      expect(loggedMessages.some((m) => m.includes('(current)'))).to.be.false
      expect(loggedMessages.some((m) => m.includes('(connected)'))).to.be.false
      expect(loggedMessages.some((m) => m.includes('Groq') && m.includes('[groq]'))).to.be.true
    })

    it('should print description on a separate indented line', async () => {
      mockListResponse([
        {
          description: 'Claude models by Anthropic',
          id: 'anthropic',
          isConnected: true,
          isCurrent: true,
          name: 'Anthropic',
        },
      ])

      await createCommand().run()

      const headerIndex = loggedMessages.findIndex((m) => m.includes('Anthropic') && m.includes('[anthropic]'))
      expect(headerIndex).to.be.greaterThan(-1)
      const descriptionLine = loggedMessages[headerIndex + 1]
      expect(descriptionLine).to.include('Claude models by Anthropic')
      expect(descriptionLine?.startsWith('    ')).to.be.true
    })

    it('should list teams under a connected ByteRover provider with billing markers', async () => {
      mockByteRoverContext(
        [
          {description: 'ByteRover hosted models', id: 'byterover', isConnected: true, isCurrent: true, name: 'ByteRover'},
          {id: 'openai', isConnected: false, isCurrent: false, name: 'OpenAI'},
        ],
        [
          {avatarUrl: '', displayName: 'Acme Corp', id: 'org-acme', isDefault: false, name: 'acme'},
          {avatarUrl: '', displayName: 'Personal Labs', id: 'org-personal', isDefault: false, name: 'personal'},
          {avatarUrl: '', displayName: 'Contractor Co', id: 'org-contract', isDefault: false, name: 'contract'},
        ],
        {organizationId: 'org-acme', organizationName: 'Acme Corp', remaining: 50_000, source: 'paid', tier: 'PRO', total: 100_000},
      )

      await createCommand().run()

      expect(loggedMessages.some((m) => m.toLowerCase().includes('teams:'))).to.be.true
      const acmeLine = loggedMessages.find((m) => m.includes('Acme Corp'))
      expect(acmeLine, 'expected Acme Corp line').to.exist
      expect(acmeLine!.toLowerCase()).to.include('billing')
      expect(loggedMessages.some((m) => m.includes('Personal Labs'))).to.be.true
      expect(loggedMessages.some((m) => m.includes('Contractor Co'))).to.be.true
    })

    it('should mark the resolved billing team', async () => {
      mockByteRoverContext(
        [{id: 'byterover', isConnected: true, isCurrent: true, name: 'ByteRover'}],
        [
          {avatarUrl: '', displayName: 'Acme Corp', id: 'org-acme', isDefault: false, name: 'acme'},
          {avatarUrl: '', displayName: 'Beta Labs', id: 'org-beta', isDefault: false, name: 'beta'},
        ],
        {organizationId: 'org-acme', organizationName: 'Acme Corp', remaining: 50_000, source: 'paid', tier: 'PRO', total: 100_000},
      )

      await createCommand().run()

      const acmeLine = loggedMessages.find((m) => m.includes('Acme Corp'))
      expect(acmeLine!.toLowerCase()).to.include('billing')
    })

    it('should not list teams when ByteRover is not connected', async () => {
      mockListResponse([{id: 'byterover', isConnected: false, isCurrent: false, name: 'ByteRover'}])

      await createCommand().run()

      expect(loggedMessages.some((m) => m.toLowerCase().includes('teams:'))).to.be.false
    })

    it('should not list teams for non-ByteRover providers', async () => {
      mockListResponse([{id: 'openai', isConnected: true, isCurrent: true, name: 'OpenAI'}])

      await createCommand().run()

      expect(loggedMessages.some((m) => m.toLowerCase().includes('teams:'))).to.be.false
    })

    it('should skip the description line when description is empty', async () => {
      mockListResponse([{description: '', id: 'groq', isConnected: false, isCurrent: false, name: 'Groq'}])

      await createCommand().run()

      const headerIndex = loggedMessages.findIndex((m) => m.includes('Groq'))
      const next = loggedMessages[headerIndex + 1]
      // Next entry must not be an indented empty line
      expect(next === undefined || !next.startsWith('    ')).to.be.true
    })
  })

  // ==================== JSON Output ====================

  describe('json output', () => {
    it('should output JSON with providers list', async () => {
      mockListResponse([
        {id: 'anthropic', isConnected: true, isCurrent: true, name: 'Anthropic'},
      ])

      await createJsonCommand().run()

      const json = parseJsonOutput()
      expect(json.command).to.equal('providers list')
      expect(json.success).to.be.true
      expect(json.data).to.have.property('providers')
    })

    it('should output JSON error on connection failure', async () => {
      mockConnector.rejects(new Error('Connection failed'))

      await createJsonCommand().run()

      const json = parseJsonOutput()
      expect(json.command).to.equal('providers list')
      expect(json.success).to.be.false
      expect(json.data).to.have.property('error')
    })
  })

  // ==================== Connection Errors ====================

  describe('connection errors', () => {
    it('should handle connection errors gracefully', async () => {
      mockConnector.rejects(new Error('Something went wrong'))

      await createCommand().run()

      expect(loggedMessages.some((m) => m.includes('Something went wrong'))).to.be.true
    })
  })
})
