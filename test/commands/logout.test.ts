import type {ConnectionResult, ITransportClient} from '@campfirein/brv-transport-client'
import type {Config} from '@oclif/core'

import {ConnectionFailedError, InstanceCrashedError, NoInstanceRunningError} from '@campfirein/brv-transport-client'
import {Config as OclifConfig} from '@oclif/core'
import {expect} from 'chai'
import sinon, {restore, stub} from 'sinon'

import type {AuthLogoutResponse} from '../../src/shared/transport/events/auth-events.js'

import Logout from '../../src/oclif/commands/logout.js'
import {buildCliMetadata} from '../../src/oclif/lib/build-cli-metadata.js'
import {AuthEvents} from '../../src/shared/transport/events/auth-events.js'

// ==================== TestableLogoutCommand ====================

class TestableLogoutCommand extends Logout {
  private readonly mockConnector: () => Promise<ConnectionResult>

  constructor(argv: string[], mockConnector: () => Promise<ConnectionResult>, config: Config) {
    super(argv, config)
    this.mockConnector = mockConnector
  }

  protected override async performLogout(
    cliMetadata: ReturnType<typeof buildCliMetadata>,
  ): Promise<AuthLogoutResponse> {
    return super.performLogout(cliMetadata, {
      maxRetries: 1,
      retryDelayMs: 0,
      transportConnector: this.mockConnector,
    })
  }
}

// ==================== Tests ====================

type MockTransportClient = {
  [K in keyof ITransportClient]: sinon.SinonStub
}

describe('Logout Command', () => {
  let config: Config
  let loggedMessages: string[]
  let stdoutOutput: string[]
  let mockClient: MockTransportClient
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
      request: stub(),
      requestWithAck: stub().resolves({}),
    }

    mockConnector = stub<[], Promise<ConnectionResult>>().resolves({
      client: mockClient as ITransportClient,
      projectRoot: '/test/project',
    })
  })

  afterEach(() => {
    restore()
  })

  function createCommand(...argv: string[]): TestableLogoutCommand {
    const command = new TestableLogoutCommand(argv, mockConnector, config)
    stub(command, 'log').callsFake((msg?: string) => {
      if (msg) loggedMessages.push(msg)
    })
    return command
  }

  function createJsonCommand(...argv: string[]): TestableLogoutCommand {
    const command = new TestableLogoutCommand(['--format', 'json', ...argv], mockConnector, config)
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

  function mockLogoutResponse(response: AuthLogoutResponse): void {
    mockClient.requestWithAck.resolves(response)
  }

  // ==================== Successful Logout ====================

  describe('successful logout', () => {
    it('should display success message', async () => {
      mockLogoutResponse({success: true})

      await createCommand().run()

      expect(loggedMessages.some((m) => m.includes('Logging out...'))).to.be.true
      expect(loggedMessages.some((m) => m.includes('Logged out successfully'))).to.be.true
    })

    it('should send correct event to transport handler with cli_metadata payload', async () => {
      mockLogoutResponse({success: true})

      await createCommand().run()

      expect(mockClient.requestWithAck.calledOnce).to.be.true
      const [event, payload] = mockClient.requestWithAck.firstCall.args
      expect(event).to.equal(AuthEvents.LOGOUT)
      // M13.3: oclif now attaches cli_metadata to every daemon-bound payload.
      // The cli_metadata block is structurally validated by CliMetadataSchema in the daemon;
      // here we just assert it is present with the expected shape (command_id is the most stable key).
      expect(payload).to.be.an('object')
      expect((payload as {cli_metadata: {command_id: string}}).cli_metadata.command_id).to.equal('logout')
    })
  })

  // ==================== Failed Logout ====================

  describe('failed logout', () => {
    it('should display error message when logout fails', async () => {
      mockLogoutResponse({success: false})

      await createCommand().run()

      expect(loggedMessages.some((m) => m.includes('Logout failed'))).to.be.true
      })
  })

  // ==================== JSON Format ====================

  describe('json format', () => {
    it('should output JSON on successful logout', async () => {
      mockLogoutResponse({success: true})

      await createJsonCommand().run()

      const json = parseJsonOutput()
      expect(json.command).to.equal('logout')
      expect(json.success).to.be.true
      expect(json.data).to.deep.equal({})
    })

    it('should output JSON on failed logout', async () => {
      mockLogoutResponse({success: false})

      await createJsonCommand().run()

      const json = parseJsonOutput()
      expect(json.command).to.equal('logout')
      expect(json.success).to.be.false
      expect(json.data).to.deep.include({error: 'Logout failed'})
      })

    it('should output JSON on connection error', async () => {
      mockConnector.rejects(new NoInstanceRunningError())

      await createJsonCommand().run()

      const json = parseJsonOutput()
      expect(json.command).to.equal('logout')
      expect(json.success).to.be.false
      expect(json.data).to.have.property('error')
      })

    it('should not log "Logging out..." in json mode', async () => {
      mockLogoutResponse({success: true})

      await createJsonCommand().run()

      expect(loggedMessages.some((m) => m.includes('Logging out...'))).to.be.false
    })
  })

  // ==================== Connection Errors ====================

  describe('connection errors', () => {
    it('should handle NoInstanceRunningError', async () => {
      mockConnector.rejects(new NoInstanceRunningError())

      await createCommand().run()

      expect(loggedMessages.some((m) => m.includes('Daemon failed to start automatically'))).to.be.true
      })

    it('should handle InstanceCrashedError', async () => {
      mockConnector.rejects(new InstanceCrashedError())

      await createCommand().run()

      expect(loggedMessages.some((m) => m.includes('Daemon crashed unexpectedly'))).to.be.true
      })

    it('should handle ConnectionFailedError', async () => {
      mockConnector.rejects(new ConnectionFailedError(37_847, new Error('Connection refused')))

      await createCommand().run()

      expect(loggedMessages.some((m) => m.includes('Failed to connect'))).to.be.true
      })

    it('should handle unexpected errors', async () => {
      mockConnector.rejects(new Error('Something went wrong'))

      await createCommand().run()

      expect(loggedMessages.some((m) => m.includes('Something went wrong'))).to.be.true
      })
  })
})
