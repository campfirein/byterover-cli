import type {ConnectionResult, ITransportClient} from '@campfirein/brv-transport-client'
import type {Config} from '@oclif/core'

import {Config as OclifConfig} from '@oclif/core'
import {expect} from 'chai'
import sinon, {restore, stub} from 'sinon'

import ProviderConnect from '../../../src/oclif/commands/providers/connect.js'
import {BillingEvents} from '../../../src/shared/transport/events/billing-events.js'
import {TeamEvents} from '../../../src/shared/transport/events/team-events.js'
import {STUB_BYTEROVER_AUTH_ERROR} from '../../helpers/provider-fixtures.js'

// ==================== TestableProviderConnectCommand ====================

class TestableProviderConnectCommand extends ProviderConnect {
  private readonly mockConnector: () => Promise<ConnectionResult>

  constructor(argv: string[], mockConnector: () => Promise<ConnectionResult>, config: Config) {
    super(argv, config)
    this.mockConnector = mockConnector
  }

  protected override async applyTeamPin(team: string) {
    return super.applyTeamPin(team, {
      maxRetries: 1,
      retryDelayMs: 0,
      transportConnector: this.mockConnector,
    })
  }

  protected override async connectProvider(params: {
    apiKey?: string
    baseUrl?: string
    model?: string
    providerId: string
  }) {
    return super.connectProvider(params, {
      maxRetries: 1,
      retryDelayMs: 0,
      transportConnector: this.mockConnector,
    })
  }

  protected override async connectProviderOAuth(
    params: {code?: string; providerId: string},
    _options?: unknown,
    onProgress?: (msg: string) => void,
  ) {
    return super.connectProviderOAuth(
      params,
      {
        maxRetries: 1,
        retryDelayMs: 0,
        transportConnector: this.mockConnector,
      },
      onProgress,
    )
  }
}

function stubByteRoverConnect(mockClient: sinon.SinonStubbedInstance<ITransportClient>): void {
  const requestStub = mockClient.requestWithAck as sinon.SinonStub
  requestStub
    .withArgs('provider:list')
    .resolves({providers: [{id: 'byterover', isConnected: false, name: 'ByteRover', requiresApiKey: false}]})
  requestStub.withArgs('provider:connect').resolves({success: true})
}

// ==================== Tests ====================

describe('Provider Connect Command', () => {
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

  function createCommand(...argv: string[]): TestableProviderConnectCommand {
    const command = new TestableProviderConnectCommand(argv, mockConnector, config)
    stub(command, 'log').callsFake((msg?: string) => {
      if (msg) loggedMessages.push(msg)
    })
    return command
  }

  function createJsonCommand(...argv: string[]): TestableProviderConnectCommand {
    const command = new TestableProviderConnectCommand(['--format', 'json', ...argv], mockConnector, config)
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

  // ==================== Successful Connect ====================

  describe('successful connect', () => {
    it('should connect provider without API key', async () => {
      const requestStub = mockClient.requestWithAck as sinon.SinonStub
      requestStub.onFirstCall().resolves({
        providers: [{id: 'byterover', isConnected: false, name: 'ByteRover', requiresApiKey: false}],
      })
      requestStub.onSecondCall().resolves({success: true})

      await createCommand('byterover').run()

      expect(loggedMessages.some((m) => m.includes('Connected to ByteRover (byterover)'))).to.be.true
    })

    it('should connect provider with valid API key', async () => {
      const requestStub = mockClient.requestWithAck as sinon.SinonStub
      requestStub.onFirstCall().resolves({
        providers: [{id: 'anthropic', isConnected: false, name: 'Anthropic', requiresApiKey: true}],
      })
      requestStub.onSecondCall().resolves({isValid: true})
      requestStub.onThirdCall().resolves({success: true})

      await createCommand('anthropic', '--api-key', 'sk-valid').run()

      expect(loggedMessages.some((m) => m.includes('Connected to Anthropic (anthropic)'))).to.be.true
    })

    it('should connect and set model when --model is provided', async () => {
      const requestStub = mockClient.requestWithAck as sinon.SinonStub
      requestStub.onFirstCall().resolves({
        providers: [{id: 'anthropic', isConnected: false, name: 'Anthropic', requiresApiKey: true}],
      })
      requestStub.onSecondCall().resolves({isValid: true})
      requestStub.onThirdCall().resolves({success: true})
      requestStub.resolves({success: true})

      await createCommand('anthropic', '--api-key', 'sk-valid', '--model', 'claude-sonnet-4-5').run()

      expect(loggedMessages.some((m) => m.includes('Connected to Anthropic'))).to.be.true
      expect(loggedMessages.some((m) => m.includes('Model set to: claude-sonnet-4-5'))).to.be.true
    })

    it('should switch active provider using SET_ACTIVE when already connected without API key', async () => {
      const requestStub = mockClient.requestWithAck as sinon.SinonStub
      requestStub.onFirstCall().resolves({
        providers: [{id: 'anthropic', isConnected: true, name: 'Anthropic', requiresApiKey: true}],
      })
      requestStub.onSecondCall().resolves({success: true})

      await createCommand('anthropic').run()

      expect(loggedMessages.some((m) => m.includes('Connected to Anthropic (anthropic)'))).to.be.true
      expect(requestStub.secondCall.args[0]).to.equal('provider:setActive')
    })

    it('should re-connect with CONNECT when already connected and API key is provided', async () => {
      const requestStub = mockClient.requestWithAck as sinon.SinonStub
      requestStub.onFirstCall().resolves({
        providers: [{id: 'anthropic', isConnected: true, name: 'Anthropic', requiresApiKey: true}],
      })
      requestStub.onSecondCall().resolves({isValid: true})
      requestStub.onThirdCall().resolves({success: true})

      await createCommand('anthropic', '--api-key', 'sk-new-key').run()

      expect(loggedMessages.some((m) => m.includes('Connected to Anthropic (anthropic)'))).to.be.true
      expect(requestStub.thirdCall.args[0]).to.equal('provider:connect')
    })
  })

  // ==================== OpenAI Compatible ====================

  describe('openai-compatible provider', () => {
    it('should connect with --base-url and no API key', async () => {
      const requestStub = mockClient.requestWithAck as sinon.SinonStub
      requestStub.onFirstCall().resolves({
        providers: [{id: 'openai-compatible', isConnected: false, name: 'OpenAI Compatible', requiresApiKey: false}],
      })
      requestStub.onSecondCall().resolves({success: true})

      await createCommand('openai-compatible', '--base-url', 'http://localhost:11434/v1').run()

      expect(loggedMessages.some((m) => m.includes('Connected to OpenAI Compatible'))).to.be.true
      expect(requestStub.secondCall.args[0]).to.equal('provider:connect')
      expect(requestStub.secondCall.args[1]).to.deep.include({baseUrl: 'http://localhost:11434/v1'})
    })

    it('should connect with --base-url and --api-key', async () => {
      const requestStub = mockClient.requestWithAck as sinon.SinonStub
      requestStub.onFirstCall().resolves({
        providers: [{id: 'openai-compatible', isConnected: false, name: 'OpenAI Compatible', requiresApiKey: false}],
      })
      requestStub.onSecondCall().resolves({success: true})

      await createCommand('openai-compatible', '--base-url', 'http://localhost:11434/v1', '--api-key', 'sk-test').run()

      expect(loggedMessages.some((m) => m.includes('Connected to OpenAI Compatible'))).to.be.true
      expect(requestStub.secondCall.args[1]).to.deep.include({
        apiKey: 'sk-test',
        baseUrl: 'http://localhost:11434/v1',
      })
    })

    it('should connect with --base-url, --api-key, and --model', async () => {
      const requestStub = mockClient.requestWithAck as sinon.SinonStub
      requestStub.onFirstCall().resolves({
        providers: [{id: 'openai-compatible', isConnected: false, name: 'OpenAI Compatible', requiresApiKey: false}],
      })
      requestStub.onSecondCall().resolves({success: true})
      requestStub.onThirdCall().resolves({success: true})

      await createCommand('openai-compatible', '--base-url', 'http://localhost:11434/v1', '--model', 'llama3').run()

      expect(loggedMessages.some((m) => m.includes('Connected to OpenAI Compatible'))).to.be.true
      expect(loggedMessages.some((m) => m.includes('Model set to: llama3'))).to.be.true
    })

    it('should error when --base-url is missing and not already connected', async () => {
      ;(mockClient.requestWithAck as sinon.SinonStub).resolves({
        providers: [{id: 'openai-compatible', isConnected: false, name: 'OpenAI Compatible', requiresApiKey: false}],
      })

      await createCommand('openai-compatible').run()

      expect(loggedMessages.some((m) => m.includes('requires a base URL'))).to.be.true
      expect(loggedMessages.some((m) => m.includes('--base-url'))).to.be.true
    })

    it('should switch active using SET_ACTIVE when already connected without --base-url', async () => {
      const requestStub = mockClient.requestWithAck as sinon.SinonStub
      requestStub.onFirstCall().resolves({
        providers: [{id: 'openai-compatible', isConnected: true, name: 'OpenAI Compatible', requiresApiKey: false}],
      })
      requestStub.onSecondCall().resolves({success: true})

      await createCommand('openai-compatible').run()

      expect(loggedMessages.some((m) => m.includes('Connected to OpenAI Compatible'))).to.be.true
      expect(requestStub.secondCall.args[0]).to.equal('provider:setActive')
    })

    it('should re-connect with CONNECT when already connected and --base-url is provided', async () => {
      const requestStub = mockClient.requestWithAck as sinon.SinonStub
      requestStub.onFirstCall().resolves({
        providers: [{id: 'openai-compatible', isConnected: true, name: 'OpenAI Compatible', requiresApiKey: false}],
      })
      requestStub.onSecondCall().resolves({success: true})

      await createCommand('openai-compatible', '--base-url', 'http://localhost:8080/v1').run()

      expect(requestStub.secondCall.args[0]).to.equal('provider:connect')
      expect(requestStub.secondCall.args[1]).to.deep.include({baseUrl: 'http://localhost:8080/v1'})
    })

    it('should error for invalid base URL format', async () => {
      ;(mockClient.requestWithAck as sinon.SinonStub).resolves({
        providers: [{id: 'openai-compatible', isConnected: false, name: 'OpenAI Compatible', requiresApiKey: false}],
      })

      await createCommand('openai-compatible', '--base-url', 'not-a-url').run()

      expect(loggedMessages.some((m) => m.includes('Invalid base URL format'))).to.be.true
    })

    it('should error for non-http URL', async () => {
      ;(mockClient.requestWithAck as sinon.SinonStub).resolves({
        providers: [{id: 'openai-compatible', isConnected: false, name: 'OpenAI Compatible', requiresApiKey: false}],
      })

      await createCommand('openai-compatible', '--base-url', 'ftp://localhost:11434/v1').run()

      expect(loggedMessages.some((m) => m.includes('http://'))).to.be.true
    })
  })

  // ==================== Error Cases ====================

  describe('error cases', () => {
    it('should error for unknown provider', async () => {
      ;(mockClient.requestWithAck as sinon.SinonStub).resolves({providers: []})

      await createCommand('unknown-provider').run()

      expect(loggedMessages.some((m) => m.includes('Unknown provider'))).to.be.true
      expect(loggedMessages.some((m) => m.includes('brv providers list'))).to.be.true
    })

    it('should error when API key is required but not provided', async () => {
      ;(mockClient.requestWithAck as sinon.SinonStub).resolves({
        providers: [{id: 'openai', isConnected: false, name: 'OpenAI', requiresApiKey: true}],
      })

      await createCommand('openai').run()

      expect(loggedMessages.some((m) => m.includes('requires an API key'))).to.be.true
      expect(loggedMessages.some((m) => m.includes('--api-key'))).to.be.true
    })

    it('should include API key URL in error when available', async () => {
      ;(mockClient.requestWithAck as sinon.SinonStub).resolves({
        providers: [
          {
            apiKeyUrl: 'https://platform.openai.com/api-keys',
            id: 'openai',
            isConnected: false,
            name: 'OpenAI',
            requiresApiKey: true,
          },
        ],
      })

      await createCommand('openai').run()

      expect(loggedMessages.some((m) => m.includes('https://platform.openai.com/api-keys'))).to.be.true
    })

    it('should error when API key validation fails with message', async () => {
      const requestStub = mockClient.requestWithAck as sinon.SinonStub
      requestStub.onFirstCall().resolves({
        providers: [{id: 'anthropic', isConnected: false, name: 'Anthropic', requiresApiKey: true}],
      })
      requestStub.onSecondCall().resolves({error: 'Key expired', isValid: false})

      await createCommand('anthropic', '--api-key', 'sk-invalid').run()

      expect(loggedMessages.some((m) => m.includes('Key expired'))).to.be.true
    })

    it('should show fallback message when API key validation fails without message', async () => {
      const requestStub = mockClient.requestWithAck as sinon.SinonStub
      requestStub.onFirstCall().resolves({
        providers: [{id: 'anthropic', isConnected: false, name: 'Anthropic', requiresApiKey: true}],
      })
      requestStub.onSecondCall().resolves({isValid: false})

      await createCommand('anthropic', '--api-key', 'sk-invalid').run()

      expect(loggedMessages.some((m) => m.includes('API key provided is invalid'))).to.be.true
    })

    it('should show auth error when server resolves CONNECT with success:false', async () => {
      const requestStub = mockClient.requestWithAck as sinon.SinonStub
      requestStub.onFirstCall().resolves({
        providers: [{id: 'byterover', isConnected: false, name: 'ByteRover', requiresApiKey: false}],
      })
      requestStub.onSecondCall().resolves({
        error: STUB_BYTEROVER_AUTH_ERROR,
        success: false,
      })

      await createCommand('byterover').run()

      expect(loggedMessages.some((m) => m.includes('ByteRover account'))).to.be.true
      expect(loggedMessages.some((m) => m.includes('brv login --api-key'))).to.be.true
    })

    it('should show auth error when server resolves SET_ACTIVE with success:false', async () => {
      const requestStub = mockClient.requestWithAck as sinon.SinonStub
      requestStub.onFirstCall().resolves({
        providers: [{id: 'byterover', isConnected: true, name: 'ByteRover', requiresApiKey: false}],
      })
      requestStub.onSecondCall().resolves({
        error: STUB_BYTEROVER_AUTH_ERROR,
        success: false,
      })

      await createCommand('byterover').run()

      expect(loggedMessages.some((m) => m.includes('ByteRover account'))).to.be.true
      expect(loggedMessages.some((m) => m.includes('brv login --api-key'))).to.be.true
    })

    it('should show fallback error when CONNECT resolves with success:false and no error message', async () => {
      const requestStub = mockClient.requestWithAck as sinon.SinonStub
      requestStub.onFirstCall().resolves({
        providers: [{id: 'byterover', isConnected: false, name: 'ByteRover', requiresApiKey: false}],
      })
      requestStub.onSecondCall().resolves({success: false})

      await createCommand('byterover').run()

      expect(loggedMessages.some((m) => m.includes('Failed to connect provider'))).to.be.true
    })
  })

  // ==================== JSON Output ====================

  describe('json output', () => {
    it('should output JSON on successful connect', async () => {
      const requestStub = mockClient.requestWithAck as sinon.SinonStub
      requestStub.onFirstCall().resolves({
        providers: [{id: 'byterover', isConnected: false, name: 'ByteRover', requiresApiKey: false}],
      })
      requestStub.onSecondCall().resolves({success: true})

      await createJsonCommand('byterover').run()

      const json = parseJsonOutput()
      expect(json.command).to.equal('providers connect')
      expect(json.success).to.be.true
      expect(json.data).to.deep.include({providerId: 'byterover'})
    })

    it('should output JSON on error', async () => {
      ;(mockClient.requestWithAck as sinon.SinonStub).resolves({providers: []})

      await createJsonCommand('unknown').run()

      const json = parseJsonOutput()
      expect(json.command).to.equal('providers connect')
      expect(json.success).to.be.false
      expect(json.data).to.have.property('error')
    })

    it('should output JSON error when CONNECT resolves with success:false', async () => {
      const requestStub = mockClient.requestWithAck as sinon.SinonStub
      requestStub.onFirstCall().resolves({
        providers: [{id: 'byterover', isConnected: false, name: 'ByteRover', requiresApiKey: false}],
      })
      requestStub.onSecondCall().resolves({
        error: STUB_BYTEROVER_AUTH_ERROR,
        success: false,
      })

      await createJsonCommand('byterover').run()

      const json = parseJsonOutput()
      expect(json.success).to.be.false
      expect(json.data.error).to.equal(STUB_BYTEROVER_AUTH_ERROR)
    })
  })

  // ==================== Connection Errors ====================

  describe('connection errors', () => {
    it('should handle connection errors gracefully', async () => {
      mockConnector.rejects(new Error('Something went wrong'))

      await createCommand('anthropic').run()

      expect(loggedMessages.some((m) => m.includes('Something went wrong'))).to.be.true
    })
  })

  // ==================== OAuth Flow ====================

  describe('oauth flow', () => {
    const openaiOAuthProvider = {
      id: 'openai',
      isConnected: false,
      name: 'OpenAI',
      oauthCallbackMode: 'auto',
      requiresApiKey: true,
      supportsOAuth: true,
    }

    const codePasteOAuthProvider = {
      id: 'anthropic',
      isConnected: false,
      name: 'Anthropic',
      oauthCallbackMode: 'code-paste',
      requiresApiKey: true,
      supportsOAuth: true,
    }

    it('should start OAuth flow and print auth URL for auto callback mode', async () => {
      const requestStub = mockClient.requestWithAck as sinon.SinonStub
      requestStub.onFirstCall().resolves({providers: [openaiOAuthProvider]})
      requestStub.onSecondCall().resolves({
        authUrl: 'https://auth.openai.com/oauth/authorize?client_id=test',
        callbackMode: 'auto',
        success: true,
      })
      requestStub.onThirdCall().resolves({success: true})

      await createCommand('openai', '--oauth').run()

      expect(loggedMessages.some((m) => m.includes('https://auth.openai.com/oauth/authorize'))).to.be.true
      expect(loggedMessages.some((m) => m.includes('Connected to OpenAI via OAuth'))).to.be.true
    })

    it('should send LIST then START_OAUTH events', async () => {
      const requestStub = mockClient.requestWithAck as sinon.SinonStub
      requestStub.onFirstCall().resolves({providers: [openaiOAuthProvider]})
      requestStub.onSecondCall().resolves({
        authUrl: 'https://auth.openai.com/oauth/authorize',
        callbackMode: 'auto',
        success: true,
      })
      requestStub.onThirdCall().resolves({success: true})

      await createCommand('openai', '--oauth').run()

      expect(requestStub.firstCall.args[0]).to.equal('provider:list')
      expect(requestStub.secondCall.args[0]).to.equal('provider:startOAuth')
      expect(requestStub.secondCall.args[1]).to.deep.include({providerId: 'openai'})
    })

    it('should send AWAIT_OAUTH_CALLBACK with 5-minute timeout for auto mode', async () => {
      const requestStub = mockClient.requestWithAck as sinon.SinonStub
      requestStub.onFirstCall().resolves({providers: [openaiOAuthProvider]})
      requestStub.onSecondCall().resolves({
        authUrl: 'https://auth.openai.com/oauth/authorize',
        callbackMode: 'auto',
        success: true,
      })
      requestStub.onThirdCall().resolves({success: true})

      await createCommand('openai', '--oauth').run()

      expect(requestStub.thirdCall.args[0]).to.equal('provider:awaitOAuthCallback')
      expect(requestStub.thirdCall.args[2]).to.deep.equal({timeout: 300_000})
    })

    it('should handle code-paste mode by printing instructions', async () => {
      const codePasteProvider = {
        id: 'some-provider',
        isConnected: false,
        name: 'Some Provider',
        requiresApiKey: true,
        supportsOAuth: true,
      }
      const requestStub = mockClient.requestWithAck as sinon.SinonStub
      requestStub.onFirstCall().resolves({providers: [codePasteProvider]})
      requestStub.onSecondCall().resolves({
        authUrl: 'https://auth.example.com/authorize',
        callbackMode: 'code-paste',
        success: true,
      })

      await createCommand('some-provider', '--oauth').run()

      expect(loggedMessages.some((m) => m.includes('Copy the authorization code'))).to.be.true
      expect(loggedMessages.some((m) => m.includes('--oauth --code'))).to.be.true
    })

    it('should submit code when --oauth --code is provided for code-paste provider', async () => {
      const requestStub = mockClient.requestWithAck as sinon.SinonStub
      requestStub.onFirstCall().resolves({providers: [codePasteOAuthProvider]})
      requestStub.onSecondCall().resolves({success: true})

      await createCommand('anthropic', '--oauth', '--code', 'my-auth-code').run()

      expect(requestStub.secondCall.args[0]).to.equal('provider:submitOAuthCode')
      expect(requestStub.secondCall.args[1]).to.deep.include({code: 'my-auth-code', providerId: 'anthropic'})
    })

    it('should error when --code is used with a browser-callback (auto) provider', async () => {
      ;(mockClient.requestWithAck as sinon.SinonStub).resolves({providers: [openaiOAuthProvider]})

      await createCommand('openai', '--oauth', '--code', 'my-auth-code').run()

      expect(loggedMessages.some((m) => m.includes('does not accept --code'))).to.be.true
      expect(loggedMessages.some((m) => m.includes('brv providers connect openai --oauth'))).to.be.true
    })

    it('should error when provider does not support OAuth', async () => {
      const noOAuthProvider = {
        id: 'anthropic',
        isConnected: false,
        name: 'Anthropic',
        requiresApiKey: true,
        supportsOAuth: false,
      }
      ;(mockClient.requestWithAck as sinon.SinonStub).resolves({providers: [noOAuthProvider]})

      await createCommand('anthropic', '--oauth').run()

      expect(loggedMessages.some((m) => m.includes('does not support OAuth'))).to.be.true
    })

    it('should error for unknown provider with --oauth', async () => {
      ;(mockClient.requestWithAck as sinon.SinonStub).resolves({providers: []})

      await createCommand('unknown-provider', '--oauth').run()

      expect(loggedMessages.some((m) => m.includes('Unknown provider'))).to.be.true
    })

    it('should handle START_OAUTH failure', async () => {
      const requestStub = mockClient.requestWithAck as sinon.SinonStub
      requestStub.onFirstCall().resolves({providers: [openaiOAuthProvider]})
      requestStub.onSecondCall().resolves({
        authUrl: '',
        callbackMode: 'auto',
        error: 'Failed to start OAuth',
        success: false,
      })

      await createCommand('openai', '--oauth').run()

      expect(loggedMessages.some((m) => m.includes('Failed to start OAuth'))).to.be.true
    })

    it('should handle AWAIT_OAUTH_CALLBACK failure', async () => {
      const requestStub = mockClient.requestWithAck as sinon.SinonStub
      requestStub.onFirstCall().resolves({providers: [openaiOAuthProvider]})
      requestStub.onSecondCall().resolves({
        authUrl: 'https://auth.openai.com/oauth/authorize',
        callbackMode: 'auto',
        success: true,
      })
      requestStub.onThirdCall().resolves({error: 'OAuth callback timed out', success: false})

      await createCommand('openai', '--oauth').run()

      expect(loggedMessages.some((m) => m.includes('OAuth callback timed out'))).to.be.true
    })

    it('should error when --oauth and --api-key are both provided', async () => {
      await createCommand('openai', '--oauth', '--api-key', 'sk-test').run()

      expect(loggedMessages.some((m) => m.includes('Cannot use --oauth and --api-key together'))).to.be.true
    })

    it('should error when --code is provided without --oauth', async () => {
      await createCommand('openai', '--code', 'my-code').run()

      expect(loggedMessages.some((m) => m.includes('--code requires the --oauth flag'))).to.be.true
    })

    it('should output JSON on successful OAuth connect', async () => {
      const requestStub = mockClient.requestWithAck as sinon.SinonStub
      requestStub.onFirstCall().resolves({providers: [openaiOAuthProvider]})
      requestStub.onSecondCall().resolves({
        authUrl: 'https://auth.openai.com/oauth/authorize',
        callbackMode: 'auto',
        success: true,
      })
      requestStub.onThirdCall().resolves({success: true})

      await createJsonCommand('openai', '--oauth').run()

      expect(loggedMessages).to.be.empty
      const json = parseJsonOutput()
      expect(json.command).to.equal('providers connect')
      expect(json.success).to.be.true
      expect(json.data).to.deep.include({providerId: 'openai'})
    })

    it('should output JSON without progress logs for code-paste OAuth', async () => {
      const requestStub = mockClient.requestWithAck as sinon.SinonStub
      requestStub.onFirstCall().resolves({providers: [openaiOAuthProvider]})
      requestStub.onSecondCall().resolves({
        authUrl: 'https://auth.openai.com/oauth/authorize',
        callbackMode: 'code-paste',
        success: true,
      })

      await createJsonCommand('openai', '--oauth').run()

      expect(loggedMessages).to.be.empty
      const json = parseJsonOutput()
      expect(json.command).to.equal('providers connect')
      expect(json.success).to.be.true
      expect(json.data).to.deep.include({providerId: 'openai'})
    })

    it('should output JSON error when --oauth and --api-key conflict', async () => {
      await createJsonCommand('openai', '--oauth', '--api-key', 'sk-test').run()

      const json = parseJsonOutput()
      expect(json.success).to.be.false
      expect(json.data).to.have.property('error')
    })
  })

  describe('--team flag', () => {
    it('connects byterover and pins the matching team by display name', async () => {
      stubByteRoverConnect(mockClient)
      const requestStub = mockClient.requestWithAck as sinon.SinonStub
      requestStub.withArgs(TeamEvents.LIST).resolves({
        teams: [
          {avatarUrl: '', displayName: 'Acme Corp', id: 'org-acme', isDefault: false, name: 'acme'},
        ],
      })
      requestStub.withArgs(BillingEvents.SET_PINNED_TEAM).resolves({success: true})

      await createCommand('byterover', '--team', 'acme corp').run()

      const setCall = requestStub.getCalls().find((c) => c.args[0] === BillingEvents.SET_PINNED_TEAM)
      expect(setCall, 'expected SET_PINNED_TEAM call').to.exist
      expect(setCall!.args[1]).to.deep.equal({projectPath: '/test/project', teamId: 'org-acme'})
      expect(loggedMessages.some((m) => m.includes('Connected to ByteRover'))).to.be.true
      expect(
        loggedMessages.some((m) => m.includes('ByteRover usage on this project will be billed to Acme Corp')),
      ).to.be.true
    })

    it('errors before connecting when --team is used with a non-byterover provider', async () => {
      await createCommand('openai', '--team', 'acme').run()

      expect(mockClient.requestWithAck.called).to.be.false
      expect(loggedMessages.some((m) => m.toLowerCase().includes('byterover'))).to.be.true
    })

    it('reports a no-match error after a successful connect', async () => {
      stubByteRoverConnect(mockClient)
      const requestStub = mockClient.requestWithAck as sinon.SinonStub
      requestStub.withArgs(TeamEvents.LIST).resolves({teams: []})

      await createCommand('byterover', '--team', 'unknown').run()

      const setCall = requestStub.getCalls().find((c) => c.args[0] === BillingEvents.SET_PINNED_TEAM)
      expect(setCall, 'expected no SET_PINNED_TEAM call').to.not.exist
      expect(loggedMessages.some((m) => m.toLowerCase().includes('no team matched'))).to.be.true
    })

    it('emits a JSON success payload that includes the team field', async () => {
      stubByteRoverConnect(mockClient)
      const requestStub = mockClient.requestWithAck as sinon.SinonStub
      requestStub.withArgs(TeamEvents.LIST).resolves({
        teams: [{avatarUrl: '', displayName: 'Acme Corp', id: 'org-acme', isDefault: false, name: 'acme'}],
      })
      requestStub.withArgs(BillingEvents.SET_PINNED_TEAM).resolves({success: true})

      await createJsonCommand('byterover', '--team', 'acme').run()

      const json = parseJsonOutput()
      expect(json.success).to.be.true
      expect(json.data).to.have.property('team').that.deep.includes({
        cleared: false,
        displayName: 'Acme Corp',
        organizationId: 'org-acme',
      })
    })
  })
})
