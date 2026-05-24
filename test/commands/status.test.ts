import type {ConnectionResult, ITransportClient} from '@campfirein/brv-transport-client'
import type {Config} from '@oclif/core'

import {ConnectionFailedError, InstanceCrashedError, NoInstanceRunningError} from '@campfirein/brv-transport-client'
import {Config as OclifConfig} from '@oclif/core'
import {expect} from 'chai'
import {mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync} from 'node:fs'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import sinon, {restore, stub} from 'sinon'

import type {StatusDTO} from '../../src/shared/transport/types/dto.js'

import Status from '../../src/oclif/commands/status.js'

// ==================== TestableStatusCommand ====================

class TestableStatusCommand extends Status {
  private readonly mockConnector: () => Promise<ConnectionResult>

  constructor(mockConnector: () => Promise<ConnectionResult>, config: Config, argv: string[] = []) {
    super(argv, config)
    this.mockConnector = mockConnector
  }

  protected override async fetchStatus(): Promise<StatusDTO> {
    return super.fetchStatus({
      maxRetries: 1,
      retryDelayMs: 0,
      transportConnector: this.mockConnector,
    })
  }
}

// ==================== Tests ====================

describe('Status Command', () => {
  let config: Config
  let loggedMessages: string[]
  let mockClient: sinon.SinonStubbedInstance<ITransportClient>
  let mockConnector: sinon.SinonStub<[], Promise<ConnectionResult>>
  let originalCwd: string
  let testDir: string

  before(async () => {
    config = await OclifConfig.load(import.meta.url)
  })

  beforeEach(() => {
    loggedMessages = []
    originalCwd = process.cwd()
    testDir = realpathSync(mkdtempSync(join(tmpdir(), 'brv-status-command-')))

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
    process.chdir(originalCwd)
    rmSync(testDir, {force: true, recursive: true})
    restore()
  })

  function createCommand(...argv: string[]): TestableStatusCommand {
    const command = new TestableStatusCommand(mockConnector, config, argv)
    stub(command, 'log').callsFake((msg?: string) => {
      if (msg) loggedMessages.push(msg)
    })
    return command
  }

  function mockStatusResponse(status: StatusDTO): void {
    ;(mockClient.requestWithAck as sinon.SinonStub).resolves({status})
  }

  // ==================== Auth Status ====================

  describe('authentication status', () => {
    it('should display cloud sync not connected when not authenticated', async () => {
      mockStatusResponse({
        authStatus: 'not_logged_in',
        contextTreeStatus: 'not_initialized',
        currentDirectory: '/test',
      })

      await createCommand().run()

      expect(loggedMessages.some((m) => m.startsWith('Account:') && m.includes('Not connected'))).to.be.true
    })

    it('should display "Session expired" when token is expired', async () => {
      mockStatusResponse({
        authStatus: 'expired',
        contextTreeStatus: 'not_initialized',
        currentDirectory: '/test',
      })

      await createCommand().run()

      expect(loggedMessages.some((m) => m.includes('Session expired'))).to.be.true
    })

    it('should display user email when logged in', async () => {
      mockStatusResponse({
        authStatus: 'logged_in',
        contextTreeStatus: 'not_initialized',
        currentDirectory: '/test',
        userEmail: 'user@example.com',
      })

      await createCommand().run()

      expect(loggedMessages.some((m) => m.includes('user@example.com'))).to.be.true
    })

    it('should display unknown auth status gracefully', async () => {
      mockStatusResponse({
        authStatus: 'unknown',
        contextTreeStatus: 'not_initialized',
        currentDirectory: '/test',
      })

      await createCommand().run()

      expect(loggedMessages.some((m) => m.includes('Unable to check'))).to.be.true
    })
  })

  // ==================== Project Status ====================

  describe('project status', () => {
    it('should display "Not initialized" when project is not initialized', async () => {
      mockStatusResponse({
        authStatus: 'logged_in',
        contextTreeStatus: 'not_initialized',
        currentDirectory: '/test',
        userEmail: 'user@example.com',
      })

      await createCommand().run()

      expect(loggedMessages.some((m) => m.includes('Not initialized'))).to.be.true
    })

    it('should display connected team/space when project is initialized', async () => {
      mockStatusResponse({
        authStatus: 'logged_in',
        contextTreeStatus: 'no_changes',
        currentDirectory: '/test',
        spaceName: 'backend-api',
        teamName: 'acme-corp',
        userEmail: 'user@example.com',
      })

      await createCommand().run()

      expect(loggedMessages.some((m) => m.includes('acme-corp/backend-api'))).to.be.true
    })

    it('should display "Not connected" when no team/space', async () => {
      mockStatusResponse({
        authStatus: 'logged_in',
        contextTreeStatus: 'no_changes',
        currentDirectory: '/test',
        userEmail: 'user@example.com',
      })

      await createCommand().run()

      expect(loggedMessages.some((m) => m.startsWith('Space:') && m.includes('Not connected'))).to.be.true
    })

    it('should display linked workspace when worktreeRoot differs from projectRoot', async () => {
      mockStatusResponse({
        authStatus: 'logged_in',
        contextTreeStatus: 'no_changes',
        currentDirectory: '/test',
        projectRoot: '/repos/monorepo',
        userEmail: 'user@example.com',
        worktreeRoot: '/repos/monorepo/packages/api',
      })

      await createCommand().run()

      expect(loggedMessages).to.include('Project: /repos/monorepo')
      expect(loggedMessages).to.include('Worktree: /repos/monorepo/packages/api (linked)')
    })
  })

  // ==================== Context Tree Status ====================

  describe('context tree status', () => {
    it('should display "Not initialized" when context tree does not exist', async () => {
      mockStatusResponse({
        authStatus: 'logged_in',
        contextTreeStatus: 'not_initialized',
        currentDirectory: '/test',
        spaceName: 'backend-api',
        teamName: 'acme-corp',
        userEmail: 'user@example.com',
      })

      await createCommand().run()

      expect(loggedMessages.some((m) => m.includes('Context Tree: Not initialized'))).to.be.true
    })

    it('should display "No changes" when no changes detected', async () => {
      mockStatusResponse({
        authStatus: 'logged_in',
        contextTreeStatus: 'no_changes',
        currentDirectory: '/test',
        spaceName: 'backend-api',
        teamName: 'acme-corp',
        userEmail: 'user@example.com',
      })

      await createCommand().run()

      expect(loggedMessages.some((m) => m.includes('No changes'))).to.be.true
    })

    it('should display added files with context tree relative path', async () => {
      mockStatusResponse({
        authStatus: 'logged_in',
        contextTreeChanges: {
          added: ['design/context.md', 'testing/context.md'],
          deleted: [],
          modified: [],
        },
        contextTreeRelativeDir: '.brv/context-tree',
        contextTreeStatus: 'has_changes',
        currentDirectory: '/test',
        spaceName: 'backend-api',
        teamName: 'acme-corp',
        userEmail: 'user@example.com',
      })

      await createCommand().run()

      expect(loggedMessages.some((m) => m.includes('Context Tree Changes'))).to.be.true
      expect(loggedMessages.some((m) => m.includes('new file:') && m.includes('.brv/context-tree/design/context.md')))
        .to.be.true
      expect(loggedMessages.some((m) => m.includes('new file:') && m.includes('.brv/context-tree/testing/context.md')))
        .to.be.true
    })

    it('should display modified files', async () => {
      mockStatusResponse({
        authStatus: 'logged_in',
        contextTreeChanges: {
          added: [],
          deleted: [],
          modified: ['structure/context.md'],
        },
        contextTreeRelativeDir: '.brv/context-tree',
        contextTreeStatus: 'has_changes',
        currentDirectory: '/test',
        userEmail: 'user@example.com',
      })

      await createCommand().run()

      expect(
        loggedMessages.some((m) => m.includes('modified:') && m.includes('.brv/context-tree/structure/context.md')),
      ).to.be.true
    })

    it('should display deleted files', async () => {
      mockStatusResponse({
        authStatus: 'logged_in',
        contextTreeChanges: {
          added: [],
          deleted: ['old/context.md'],
          modified: [],
        },
        contextTreeRelativeDir: '.brv/context-tree',
        contextTreeStatus: 'has_changes',
        currentDirectory: '/test',
        userEmail: 'user@example.com',
      })

      await createCommand().run()

      expect(loggedMessages.some((m) => m.includes('deleted:') && m.includes('.brv/context-tree/old/context.md'))).to.be
        .true
    })

    it('should display git vc message when context tree is Byterover version control', async () => {
      mockStatusResponse({
        authStatus: 'logged_in',
        contextTreeStatus: 'git_vc',
        currentDirectory: '/test',
        spaceName: 'backend-api',
        teamName: 'acme-corp',
        userEmail: 'user@example.com',
      })

      await createCommand().run()

      expect(
        loggedMessages.some((m) =>
          m.includes('Context Tree: Managed by Byterover version control (use brv vc commands)'),
        ),
      ).to.be.true
    })

    it('should display all change types sorted by path', async () => {
      mockStatusResponse({
        authStatus: 'logged_in',
        contextTreeChanges: {
          added: ['z-new/context.md'],
          deleted: ['a-deleted/context.md'],
          modified: ['m-modified/context.md'],
        },
        contextTreeRelativeDir: '.brv/context-tree',
        contextTreeStatus: 'has_changes',
        currentDirectory: '/test',
        userEmail: 'user@example.com',
      })

      await createCommand().run()

      const changeMessages = loggedMessages.filter(
        (m) => m.includes('new file:') || m.includes('modified:') || m.includes('deleted:'),
      )

      expect(changeMessages.length).to.equal(3)
      expect(changeMessages[0]).to.include('a-deleted')
      expect(changeMessages[1]).to.include('m-modified')
      expect(changeMessages[2]).to.include('z-new')
    })
  })

  // ==================== VC Hint ====================

  describe('vc hint', () => {
    it('should display vc hint after text output', async () => {
      mockStatusResponse({
        authStatus: 'logged_in',
        contextTreeStatus: 'no_changes',
        currentDirectory: '/test',
        userEmail: 'user@example.com',
      })

      await createCommand().run()

      expect(loggedMessages.some((m) => m.includes('Version control is now available'))).to.be.true
      expect(loggedMessages.some((m) => m.includes('https://docs.byterover.dev/git-semantic/overview'))).to.be.true
    })

    it('should display vc hint after error output', async () => {
      mockConnector.rejects(new Error('Connection failed'))

      await createCommand().run()

      expect(loggedMessages.some((m) => m.includes('Version control is now available'))).to.be.true
    })

    it('should not display vc hint for json format', async () => {
      mockStatusResponse({
        authStatus: 'logged_in',
        contextTreeStatus: 'no_changes',
        currentDirectory: '/test',
        userEmail: 'user@example.com',
      })

      let captured = ''
      const writeStub = stub(process.stdout, 'write').callsFake((chunk) => {
        captured += chunk
        return true
      })

      try {
        await new TestableStatusCommand(mockConnector, config, ['--format', 'json']).run()
      } finally {
        writeStub.restore()
      }

      expect(captured).to.not.include('Version control')
    })
  })

  // ==================== JSON Output ====================

  describe('JSON output', () => {
    it('should output success: true with status data', async () => {
      mockStatusResponse({
        authStatus: 'logged_in',
        contextTreeStatus: 'no_changes',
        currentDirectory: '/test',
        userEmail: 'user@example.com',
      })

      let captured = ''
      const writeStub = stub(process.stdout, 'write').callsFake((chunk) => {
        captured += chunk
        return true
      })

      try {
        await new TestableStatusCommand(mockConnector, config, ['--format', 'json']).run()
      } finally {
        writeStub.restore()
      }

      const parsed = JSON.parse(captured) as {success: boolean}
      expect(parsed.success).to.be.true
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

  describe('request payload', () => {
    it('should send cwd explicitly in status request', async () => {
      const projectRoot = join(testDir, 'project')
      mkdirSync(join(projectRoot, '.brv'), {recursive: true})
      writeFileSync(join(projectRoot, '.brv', 'config.json'), JSON.stringify({version: '0.0.1'}))
      process.chdir(projectRoot)
      mockConnector.resolves({
        client: mockClient as unknown as ITransportClient,
        projectRoot,
      })

      mockStatusResponse({
        authStatus: 'logged_in',
        contextTreeStatus: 'no_changes',
        currentDirectory: projectRoot,
        userEmail: 'user@example.com',
      })

      await createCommand().run()

      const [event, payload] = (mockClient.requestWithAck as sinon.SinonStub).firstCall.args
      expect(event).to.equal('status:get')
      expect(payload).to.have.property('cwd', projectRoot)
    })
  })

})
