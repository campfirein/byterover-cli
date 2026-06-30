import type {ConnectionResult, ITransportClient} from '@campfirein/brv-transport-client'
import type {Config} from '@oclif/core'

import {ConnectionFailedError, InstanceCrashedError, NoInstanceRunningError} from '@campfirein/brv-transport-client'
import {Config as OclifConfig} from '@oclif/core'
import {expect} from 'chai'
import sinon, {restore, stub} from 'sinon'

import Login, {type LoginOAuthOptions} from '../../src/oclif/commands/login.js'
import {buildCliMetadata} from '../../src/oclif/lib/build-cli-metadata.js'
import {
  AuthEvents,
  type AuthLoginCompletedEvent,
  type AuthLoginWithApiKeyResponse,
  type AuthStartLoginResponse,
} from '../../src/shared/transport/events/auth-events.js'

// ==================== TestableLoginCommand ====================

class TestableLoginCommand extends Login {
  protected browserAvailable = true
  private readonly mockConnector: () => Promise<ConnectionResult>

  constructor(argv: string[], mockConnector: () => Promise<ConnectionResult>, config: Config) {
    super(argv, config)
    this.mockConnector = mockConnector
  }

  protected override canOpenBrowser(): boolean {
    return this.browserAvailable
  }

  protected override async loginWithApiKey(
    apiKey: string,
    cliMetadata: ReturnType<typeof buildCliMetadata>,
  ): Promise<AuthLoginWithApiKeyResponse> {
    return super.loginWithApiKey(apiKey, cliMetadata, {
      maxRetries: 1,
      retryDelayMs: 0,
      transportConnector: this.mockConnector,
    })
  }

  protected override async loginWithOAuth(
    cliMetadata: ReturnType<typeof buildCliMetadata>,
    options?: LoginOAuthOptions,
  ): Promise<AuthLoginCompletedEvent> {
    return super.loginWithOAuth(cliMetadata, {
      ...options,
      maxRetries: 1,
      oauthTimeoutMs: 100,
      retryDelayMs: 0,
      transportConnector: this.mockConnector,
    })
  }

  public setCanOpenBrowser(value: boolean): void {
    this.browserAvailable = value
  }
}

class RealCheckLoginCommand extends Login {
  public checkCanOpenBrowser(): boolean {
    return this.canOpenBrowser()
  }
}

// ==================== Tests ====================

describe('Login Command', () => {
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

  function createCommand(...argv: string[]): TestableLoginCommand {
    const command = new TestableLoginCommand(argv, mockConnector, config)
    stub(command, 'log').callsFake((msg?: string) => {
      if (msg) loggedMessages.push(msg)
    })
    return command
  }

  function createJsonCommand(...argv: string[]): TestableLoginCommand {
    const command = new TestableLoginCommand([...argv, '--format', 'json'], mockConnector, config)
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

  function mockLoginResponse(response: AuthLoginWithApiKeyResponse): void {
    ;(mockClient.requestWithAck as sinon.SinonStub).resolves(response)
  }

  function mockOAuthFlow(startResponse: AuthStartLoginResponse, completion?: AuthLoginCompletedEvent): void {
    const onStub = mockClient.on as sinon.SinonStub
    onStub.callsFake((event: string, cb: (data: AuthLoginCompletedEvent) => void) => {
      if (event === AuthEvents.LOGIN_COMPLETED && completion) {
        setImmediate(() => {
          cb(completion)
        })
      }

      return () => {}
    })
    ;(mockClient.requestWithAck as sinon.SinonStub).callsFake((event: string) => {
      if (event === AuthEvents.START_LOGIN) return Promise.resolve(startResponse)
      return Promise.resolve({})
    })
  }

  // ==================== Successful Login ====================

  describe('successful login', () => {
    it('should display success message with user email', async () => {
      mockLoginResponse({success: true, userEmail: 'user@example.com'})

      await createCommand('--api-key', 'valid-api-key').run()

      expect(loggedMessages.some((m) => m.includes('Logging in...'))).to.be.true
      expect(loggedMessages.some((m) => m.includes('Logged in as user@example.com'))).to.be.true
    })

    it('should send api key + cli_metadata to transport handler', async () => {
      mockLoginResponse({success: true, userEmail: 'user@example.com'})

      await createCommand('--api-key', 'my-secret-key').run()

      expect((mockClient.requestWithAck as sinon.SinonStub).calledOnce).to.be.true
      const [event, data] = (mockClient.requestWithAck as sinon.SinonStub).firstCall.args
      expect(event).to.equal(AuthEvents.LOGIN_WITH_API_KEY)
      // M13.3: payload now carries optional cli_metadata block alongside apiKey.
      expect((data as {apiKey: string}).apiKey).to.equal('my-secret-key')
      expect((data as {cli_metadata: {command_id: string}}).cli_metadata.command_id).to.equal('login')
    })
  })

  // ==================== Failed Login ====================

  describe('failed login', () => {
    it('should display error message from handler', async () => {
      mockLoginResponse({error: 'Invalid API key', success: false})

      await createCommand('--api-key', 'invalid-key').run()

      expect(loggedMessages.some((m) => m.includes('Invalid API key'))).to.be.true
    })

    it('should display generic error when no error message provided', async () => {
      mockLoginResponse({success: false})

      await createCommand('--api-key', 'invalid-key').run()

      expect(loggedMessages.some((m) => m.includes('Authentication failed'))).to.be.true
    })
  })

  // ==================== JSON Format ====================

  describe('json format', () => {
    it('should output JSON on successful login', async () => {
      mockLoginResponse({success: true, userEmail: 'user@example.com'})

      await createJsonCommand('--api-key', 'valid-key').run()

      const json = parseJsonOutput()
      expect(json.command).to.equal('login')
      expect(json.success).to.be.true
      expect(json.data).to.deep.include({userEmail: 'user@example.com'})
    })

    it('should output JSON on failed login', async () => {
      mockLoginResponse({error: 'Invalid API key', success: false})

      await createJsonCommand('--api-key', 'invalid-key').run()

      const json = parseJsonOutput()
      expect(json.command).to.equal('login')
      expect(json.success).to.be.false
      expect(json.data).to.deep.include({error: 'Invalid API key'})
    })

    it('should output JSON with a user-friendly message on connection error', async () => {
      mockConnector.rejects(new NoInstanceRunningError())

      await createJsonCommand('--api-key', 'test-key').run()

      const json = parseJsonOutput()
      expect(json.command).to.equal('login')
      expect(json.success).to.be.false
      expect(String(json.data.error ?? '')).to.include('Daemon failed to start automatically')
    })

    it('should not log "Logging in..." in json mode', async () => {
      mockLoginResponse({success: true, userEmail: 'user@example.com'})

      await createJsonCommand('--api-key', 'valid-key').run()

      expect(loggedMessages.some((m) => m.includes('Logging in...'))).to.be.false
    })
  })

  // ==================== Connection Errors ====================

  describe('connection errors', () => {
    it('should handle NoInstanceRunningError', async () => {
      mockConnector.rejects(new NoInstanceRunningError())

      await createCommand('--api-key', 'test-key').run()

      expect(loggedMessages.some((m) => m.includes('Daemon failed to start automatically'))).to.be.true
    })

    it('should handle InstanceCrashedError', async () => {
      mockConnector.rejects(new InstanceCrashedError())

      await createCommand('--api-key', 'test-key').run()

      expect(loggedMessages.some((m) => m.includes('Daemon crashed unexpectedly'))).to.be.true
    })

    it('should handle ConnectionFailedError', async () => {
      mockConnector.rejects(new ConnectionFailedError(37_847, new Error('Connection refused')))

      await createCommand('--api-key', 'test-key').run()

      expect(loggedMessages.some((m) => m.includes('Failed to connect'))).to.be.true
    })

    it('should handle unexpected errors', async () => {
      mockConnector.rejects(new Error('Something went wrong'))

      await createCommand('--api-key', 'test-key').run()

      expect(loggedMessages.some((m) => m.includes('Something went wrong'))).to.be.true
    })
  })

  // ==================== OAuth Flow (no --api-key) ====================

  describe('oauth flow', () => {
    it('should start OAuth flow and print success on completion', async () => {
      mockOAuthFlow(
        {authUrl: 'https://auth.byterover.dev/oauth?state=abc'},
        {success: true, user: {email: 'oauth@example.com', hasOnboardedCli: true, id: 'u1', name: 'Oauth User'}},
      )

      await createCommand().run()

      const requestWithAckCalls = (mockClient.requestWithAck as sinon.SinonStub).getCalls()
      expect(requestWithAckCalls.some((c) => c.args[0] === AuthEvents.START_LOGIN)).to.be.true
      expect(loggedMessages.some((m) => m.includes('Logged in as oauth@example.com'))).to.be.true
    })

    it('should print the auth URL as a browser fallback', async () => {
      mockOAuthFlow(
        {authUrl: 'https://auth.byterover.dev/oauth?state=abc'},
        {success: true, user: {email: 'oauth@example.com', hasOnboardedCli: true, id: 'u1'}},
      )

      await createCommand().run()

      expect(loggedMessages.some((m) => m.includes('https://auth.byterover.dev/oauth?state=abc'))).to.be.true
    })

    it('should print error message when LOGIN_COMPLETED reports failure', async () => {
      mockOAuthFlow({authUrl: 'https://auth.byterover.dev/oauth'}, {error: 'User denied access', success: false})

      await createCommand().run()

      expect(loggedMessages.some((m) => m.includes('User denied access'))).to.be.true
    })

    it('should time out if LOGIN_COMPLETED never arrives', async () => {
      mockOAuthFlow({authUrl: 'https://auth.byterover.dev/oauth'})

      await createCommand().run()

      expect(loggedMessages.some((m) => m.toLowerCase().includes('timed out'))).to.be.true
    })

    it('should emit JSON on successful OAuth login', async () => {
      mockOAuthFlow(
        {authUrl: 'https://auth.byterover.dev/oauth'},
        {success: true, user: {email: 'oauth@example.com', hasOnboardedCli: true, id: 'u1'}},
      )

      await createJsonCommand().run()

      const json = parseJsonOutput()
      expect(json.command).to.equal('login')
      expect(json.success).to.be.true
      expect(json.data).to.deep.include({userEmail: 'oauth@example.com'})
    })

    it('should emit JSON on OAuth failure', async () => {
      mockOAuthFlow({authUrl: 'https://auth.byterover.dev/oauth'}, {error: 'User denied access', success: false})

      await createJsonCommand().run()

      const json = parseJsonOutput()
      expect(json.command).to.equal('login')
      expect(json.success).to.be.false
      expect(json.data).to.deep.include({error: 'User denied access'})
    })

    it('should display a fallback message when OAuth succeeds but user is absent', async () => {
      mockOAuthFlow({authUrl: 'https://auth.byterover.dev/oauth'}, {success: true, user: undefined})

      await createCommand().run()

      expect(loggedMessages.some((m) => m.includes('Logged in'))).to.be.true
      expect(loggedMessages.some((m) => m.includes('undefined'))).to.be.false
    })

    it('should clear the timeout and surface the error when START_LOGIN rejects', async () => {
      let timerFired = false
      ;(mockClient.on as sinon.SinonStub).returns(() => {
        /* unsubscribe */
      })
      ;(mockClient.requestWithAck as sinon.SinonStub).rejects(new Error('start failed'))

      await createCommand().run()
      // Wait past the 100 ms test timeout. If the timer was not cleared, it would
      // reject an already-discarded promise and surface as an unhandled rejection.
      await new Promise<void>((resolve) => {
        setTimeout(() => {
          timerFired = true
          resolve()
        }, 150)
      })

      expect(timerFired).to.be.true
      expect(loggedMessages.some((m) => m.includes('start failed'))).to.be.true
      expect(loggedMessages.some((m) => m.toLowerCase().includes('timed out'))).to.be.false
    })

    it('should handle connection errors during OAuth flow via formatConnectionError', async () => {
      mockConnector.rejects(new NoInstanceRunningError())

      await createCommand().run()

      expect(loggedMessages.some((m) => m.includes('Daemon failed to start automatically'))).to.be.true
    })
  })

  // ==================== Environments without a browser ====================

  describe('environments without a browser', () => {
    it('should error with a pointer to --api-key when no flag and browser is unavailable', async () => {
      const command = createCommand()
      command.setCanOpenBrowser(false)

      await command.run()

      expect(loggedMessages.some((m) => m.toLowerCase().includes('browser'))).to.be.true
      expect(loggedMessages.some((m) => m.includes('--api-key'))).to.be.true
      expect((mockClient.requestWithAck as sinon.SinonStub).called).to.be.false
    })

    it('should emit JSON error when browser is unavailable and no --api-key', async () => {
      const command = createJsonCommand()
      command.setCanOpenBrowser(false)

      await command.run()

      const json = parseJsonOutput()
      expect(json.command).to.equal('login')
      expect(json.success).to.be.false
      expect(String(json.data.error ?? '').toLowerCase()).to.include('browser')
    })

    it('should still perform api-key login when browser is unavailable and --api-key provided', async () => {
      mockLoginResponse({success: true, userEmail: 'ci@example.com'})

      const command = createCommand('--api-key', 'ci-key')
      command.setCanOpenBrowser(false)

      await command.run()

      expect(loggedMessages.some((m) => m.includes('Logged in as ci@example.com'))).to.be.true
    })
  })

  // ==================== canOpenBrowser() default implementation ====================

  describe('canOpenBrowser default implementation', () => {
    const sshVars = ['SSH_CONNECTION', 'SSH_CLIENT', 'SSH_TTY'] as const
    const savedEnv: Partial<Record<(typeof sshVars)[number], string | undefined>> = {}
    let stdinTtyDesc: PropertyDescriptor | undefined
    let stdoutTtyDesc: PropertyDescriptor | undefined

    beforeEach(() => {
      for (const v of sshVars) {
        savedEnv[v] = process.env[v]
        delete process.env[v]
      }

      stdinTtyDesc = Object.getOwnPropertyDescriptor(process.stdin, 'isTTY')
      stdoutTtyDesc = Object.getOwnPropertyDescriptor(process.stdout, 'isTTY')
      Object.defineProperty(process.stdin, 'isTTY', {configurable: true, value: true, writable: true})
      Object.defineProperty(process.stdout, 'isTTY', {configurable: true, value: true, writable: true})
    })

    afterEach(() => {
      for (const v of sshVars) {
        if (savedEnv[v] === undefined) delete process.env[v]
        else process.env[v] = savedEnv[v]
      }

      if (stdinTtyDesc) Object.defineProperty(process.stdin, 'isTTY', stdinTtyDesc)
      else delete (process.stdin as unknown as Record<string, unknown>).isTTY
      if (stdoutTtyDesc) Object.defineProperty(process.stdout, 'isTTY', stdoutTtyDesc)
      else delete (process.stdout as unknown as Record<string, unknown>).isTTY
    })

    it('returns true with TTY and no SSH env', () => {
      expect(new RealCheckLoginCommand([], config).checkCanOpenBrowser()).to.be.true
    })

    it('returns false without a TTY', () => {
      Object.defineProperty(process.stdout, 'isTTY', {configurable: true, value: false, writable: true})
      expect(new RealCheckLoginCommand([], config).checkCanOpenBrowser()).to.be.false
    })

    it('returns false when SSH_CONNECTION is set', () => {
      process.env.SSH_CONNECTION = '1.2.3.4 55555 5.6.7.8 22'
      expect(new RealCheckLoginCommand([], config).checkCanOpenBrowser()).to.be.false
    })

    it('returns false when SSH_CLIENT is set', () => {
      process.env.SSH_CLIENT = '1.2.3.4 55555 22'
      expect(new RealCheckLoginCommand([], config).checkCanOpenBrowser()).to.be.false
    })

    it('returns false when SSH_TTY is set', () => {
      process.env.SSH_TTY = '/dev/pts/0'
      expect(new RealCheckLoginCommand([], config).checkCanOpenBrowser()).to.be.false
    })
  })
})
