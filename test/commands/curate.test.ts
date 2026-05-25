import type {ConnectionResult, ITransportClient} from '@campfirein/brv-transport-client'
import type {Config} from '@oclif/core'

import {ConnectionFailedError, InstanceCrashedError, NoInstanceRunningError} from '@campfirein/brv-transport-client'
import {Config as OclifConfig} from '@oclif/core'
import {expect} from 'chai'
import {mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync} from 'node:fs'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import sinon, {restore, stub} from 'sinon'

import Curate from '../../src/oclif/commands/curate/index.js'

// ==================== TestableCurateCommand ====================

class TestableCurateCommand extends Curate {
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

describe('Curate Command', () => {
  let config: Config
  let loggedMessages: string[]
  let originalCwd: string
  let stdoutOutput: string[]
  let mockClient: sinon.SinonStubbedInstance<ITransportClient>
  let mockConnector: sinon.SinonStub<[], Promise<ConnectionResult>>
  let testDir: string

  before(async () => {
    config = await OclifConfig.load(import.meta.url)
  })

  beforeEach(() => {
    loggedMessages = []
    originalCwd = process.cwd()
    stdoutOutput = []
    testDir = realpathSync(mkdtempSync(join(tmpdir(), 'brv-curate-command-')))

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
    process.chdir(originalCwd)
    rmSync(testDir, {force: true, recursive: true})
    restore()
  })

  function createLinkedWorkspace(): {clientCwd: string; projectRoot: string; worktreeRoot: string} {
    const projectRoot = join(testDir, 'monorepo')
    const worktreeRoot = join(projectRoot, 'packages', 'api')
    const clientCwd = join(worktreeRoot, 'src')
    mkdirSync(join(projectRoot, '.brv'), {recursive: true})
    mkdirSync(clientCwd, {recursive: true})
    writeFileSync(join(projectRoot, '.brv', 'config.json'), JSON.stringify({version: '0.0.1'}))
    writeFileSync(join(worktreeRoot, '.brv'), JSON.stringify({projectRoot}, null, 2) + '\n')
    return {clientCwd, projectRoot, worktreeRoot}
  }

  function createCommand(...argv: string[]): TestableCurateCommand {
    const command = new TestableCurateCommand(argv, mockConnector, config)
    stub(command, 'log').callsFake((msg?: string) => {
      if (msg) loggedMessages.push(msg)
    })
    return command
  }

  function createJsonCommand(...argv: string[]): TestableCurateCommand {
    const command = new TestableCurateCommand([...argv, '--format', 'json'], mockConnector, config)
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

  /** Parses the last JSON line emitted — used for non-detach mode which emits multiple events. */
  function parseLastJsonLine(): {command: string; data: Record<string, unknown>; success: boolean} {
    const lines = stdoutOutput.join('').trim().split('\n').filter(Boolean)
    return JSON.parse(lines.at(-1)!)
  }

  // ==================== Input Validation ====================

  describe('input validation', () => {
    it('should show usage message when neither context nor files are provided', async () => {
      await createCommand().run()

      expect(loggedMessages).to.include('Either a context argument, file reference, or folder reference is required.')
    })

    it('should treat whitespace-only context as no context', async () => {
      await createCommand('   ').run()

      expect(loggedMessages).to.include('Either a context argument, file reference, or folder reference is required.')
    })

    it('should output JSON error when no input provided in json mode', async () => {
      await createJsonCommand().run()

      const json = parseJsonOutput()
      expect(json.success).to.be.false
      expect(json.data).to.have.property('message').that.includes('Either a context argument')
    })
  })

  // ==================== Provider Validation ====================

  describe('provider validation', () => {
    it('should error when no provider is connected', async () => {
      ;(mockClient.requestWithAck as sinon.SinonStub).resolves({activeProvider: ''})

      await createCommand('test context', '--detach').run()

      expect(loggedMessages.some((m) => m.includes('No provider connected'))).to.be.true
      expect(loggedMessages.some((m) => m.includes('brv providers connect'))).to.be.true
    })

    it('should output JSON error when no provider is connected', async () => {
      ;(mockClient.requestWithAck as sinon.SinonStub).resolves({activeProvider: ''})

      await createJsonCommand('test context', '--detach').run()

      const json = parseJsonOutput()
      expect(json.success).to.be.false
      expect(json.data).to.have.property('error').that.includes('No provider connected')
    })
  })

  // ==================== Detach Mode ====================

  describe('detach mode', () => {
    it('should send task:create with context and taskId', async () => {
      await createCommand('test context', '--detach').run()

      const requestStub = mockClient.requestWithAck as sinon.SinonStub
      const taskCreateCall = requestStub.getCalls().find((c) => c.args[0] === 'task:create')
      expect(taskCreateCall, 'expected task:create call').to.exist
      expect(requestStub.getCalls().some((c) => c.args[0] === 'state:getProviderConfig')).to.be.true
      const payload = taskCreateCall!.args[1]
      expect(payload).to.have.property('content', 'test context')
      expect(payload).to.have.property('type', 'curate')
      expect(payload).to.have.property('taskId').that.is.a('string')
      expect(loggedMessages.some((m) => m.startsWith('✓ Context queued for processing.'))).to.be.true
    })

    it('should send task:create with empty content when only files provided', async () => {
      await createCommand('--detach', '-f', 'src/auth.ts', '-f', 'src/utils.ts').run()

      const requestStub = mockClient.requestWithAck as sinon.SinonStub
      const taskCreateCall = requestStub.getCalls().find((c) => c.args[0] === 'task:create')
      expect(taskCreateCall, 'expected task:create call').to.exist
      expect(requestStub.getCalls().some((c) => c.args[0] === 'state:getProviderConfig')).to.be.true
      const payload = taskCreateCall!.args[1]
      expect(payload).to.have.property('content', '')
      expect(payload).to.have.property('files').that.deep.equals(['src/auth.ts', 'src/utils.ts'])
      expect(payload).to.have.property('type', 'curate')
    })

    it('should send task:create with context and files', async () => {
      await createCommand('test context', '--detach', '-f', 'file1.ts', '-f', 'file2.ts').run()

      const requestStub = mockClient.requestWithAck as sinon.SinonStub
      const taskCreateCall = requestStub.getCalls().find((c) => c.args[0] === 'task:create')
      expect(taskCreateCall, 'expected task:create call').to.exist
      const payload = taskCreateCall!.args[1]
      expect(payload).to.have.property('content', 'test context')
      expect(payload).to.have.property('files').that.deep.equals(['file1.ts', 'file2.ts'])
    })

    it('should send projectPath, worktreeRoot, and clientCwd from a linked workspace', async () => {
      const {clientCwd, projectRoot, worktreeRoot} = createLinkedWorkspace()
      process.chdir(clientCwd)
      mockConnector.resolves({
        client: mockClient as unknown as ITransportClient,
        projectRoot,
      })

      await createCommand('test context', '--detach', '-f', './auth.ts').run()

      const requestStub = mockClient.requestWithAck as sinon.SinonStub
      const taskCreateCall = requestStub.getCalls().find((c) => c.args[0] === 'task:create')
      expect(taskCreateCall, 'expected task:create call').to.exist
      const payload = taskCreateCall!.args[1]
      expect(payload).to.include({
        clientCwd,
        projectPath: projectRoot,
        worktreeRoot,
      })
      expect(payload).to.have.property('files').that.deep.equals(['./auth.ts'])
    })

    it('should send worktreeRoot even when curate has no explicit file paths', async () => {
      const {clientCwd, projectRoot, worktreeRoot} = createLinkedWorkspace()
      process.chdir(clientCwd)
      mockConnector.resolves({
        client: mockClient as unknown as ITransportClient,
        projectRoot,
      })

      await createCommand('workspace-scoped curate', '--detach').run()

      const requestStub = mockClient.requestWithAck as sinon.SinonStub
      const taskCreateCall = requestStub.getCalls().find((c) => c.args[0] === 'task:create')
      expect(taskCreateCall, 'expected task:create call').to.exist
      const payload = taskCreateCall!.args[1]
      expect(payload).to.include({
        clientCwd,
        projectPath: projectRoot,
        worktreeRoot,
      })
      expect(payload).to.not.have.property('files')
    })

    it('should disconnect client after successful request', async () => {
      await createCommand('test context', '--detach').run()

      expect(mockClient.disconnect.calledOnce).to.be.true
    })

    it('should output JSON on detach', async () => {
      await createJsonCommand('test context', '--detach').run()

      const json = parseJsonOutput()
      expect(json.command).to.equal('curate')
      expect(json.success).to.be.true
      expect(json.data).to.have.property('status', 'queued')
      expect(json.data).to.have.property('taskId').that.is.a('string')
    })
  })

  // ==================== Connection Errors ====================

  describe('connection errors', () => {
    it('should handle NoInstanceRunningError', async () => {
      mockConnector.rejects(new NoInstanceRunningError())

      await createCommand('test context', '--detach').run()

      expect(loggedMessages.some((m) => m.includes('Daemon failed to start automatically'))).to.be.true
    })

    it('should handle InstanceCrashedError', async () => {
      mockConnector.rejects(new InstanceCrashedError())

      await createCommand('test context', '--detach').run()

      expect(loggedMessages.some((m) => m.includes('Daemon crashed unexpectedly'))).to.be.true
    })

    it('should handle ConnectionFailedError', async () => {
      mockConnector.rejects(new ConnectionFailedError(37_847, new Error('Connection refused')))

      await createCommand('test context', '--detach').run()

      expect(loggedMessages.some((m) => m.includes('Failed to connect'))).to.be.true
    })

    it('should handle unexpected errors', async () => {
      mockConnector.rejects(new Error('Something went wrong'))

      await createCommand('test context', '--detach').run()

      expect(loggedMessages.some((m) => m.includes('Something went wrong'))).to.be.true
    })

    it('should disconnect client even when request fails', async () => {
      ;(mockClient.requestWithAck as sinon.SinonStub).rejects(new Error('Request failed'))

      await createCommand('test context', '--detach').run()

      expect(mockClient.disconnect.calledOnce).to.be.true
    })

    it('should output JSON on connection error', async () => {
      mockConnector.rejects(new NoInstanceRunningError())

      await createJsonCommand('test context', '--detach').run()

      const json = parseJsonOutput()
      expect(json.command).to.equal('curate')
      expect(json.success).to.be.false
      expect(json.data).to.have.property('error')
    })
  })

  // ==================== Pending Review Output ====================

  /**
   * Configures mock client to simulate task completion with the given tool results.
   * Fires LLM events (toolCall, toolResult), optionally review:notify, and task:completed
   * on the next tick after task:create is acknowledged, matching the real daemon event sequence.
   *
   * @param toolResults - Curate tool outputs to emit as llmservice:toolResult events.
   * @param pendingCount - When provided, fires review:notify before task:completed.
   *   The server broadcasts this event when curate completes with operations requiring review.
   */
  function simulateTaskCompletion(toolResults: unknown[], pendingCount?: number): void {
    const eventHandlers = new Map<string, (data: unknown) => void>()

    ;(mockClient.on as sinon.SinonStub).callsFake((event: string, handler: (data: unknown) => void) => {
      eventHandlers.set(event, handler)
      return () => {}
    })

    ;(mockClient.requestWithAck as sinon.SinonStub).callsFake(async (event: string, data: unknown) => {
      if (event === 'state:getProviderConfig') return {activeProvider: 'anthropic'}

      // task:create — capture taskId, fire events on next tick
      const {taskId} = data as {taskId: string}
      setImmediate(() => {
        for (const [i, toolResult] of toolResults.entries()) {
          const callId = `call-${i}`
          // Use 'curate' toolName — extractCurateOperations handles {applied:[...]} directly
          eventHandlers.get('llmservice:toolCall')?.({args: {}, callId, taskId, toolName: 'curate'})
          eventHandlers.get('llmservice:toolResult')?.({
            callId,
            result: JSON.stringify(toolResult),
            success: true,
            taskId,
            toolName: 'curate',
          })
        }

        // Server fires review:notify before task:completed when pending reviews exist
        if (pendingCount !== undefined && pendingCount > 0) {
          eventHandlers.get('review:notify')?.({
            pendingCount,
            reviewUrl: 'http://localhost:3000/review',
            taskId,
          })
        }

        const completedPayload: Record<string, unknown> = {logId: 'log-1', taskId}
        if (pendingCount !== undefined && pendingCount > 0) {
          completedPayload.pendingReviewCount = pendingCount
        }

        eventHandlers.get('task:completed')?.(completedPayload)
      })

      return {logId: 'log-1'}
    })
  }

  describe('pending review output', () => {

    it('should print review summary for high-impact pending ops', async () => {
      simulateTaskCompletion(
        [
          {
            applied: [
              {
                confidence: 'high',
                filePath: '/project/.brv/context-tree/auth/jwt.md',
                impact: 'high',
                needsReview: true,
                path: 'auth/jwt.md',
                previousSummary: 'Basic JWT validation',
                reason: 'Core auth strategy change',
                status: 'success',
                summary: 'JWT with refresh tokens',
                type: 'UPDATE',
              },
            ],
          },
        ],
        1,
      )

      await createCommand('test context').run()

      expect(loggedMessages.some((m) => m.includes('require'))).to.be.true
      expect(loggedMessages.some((m) => m.includes('auth/jwt.md'))).to.be.true
      expect(loggedMessages.some((m) => m.includes('Core auth strategy change'))).to.be.true
      expect(loggedMessages.some((m) => m.includes('Basic JWT validation'))).to.be.true
      expect(loggedMessages.some((m) => m.includes('JWT with refresh tokens'))).to.be.true
      expect(loggedMessages.some((m) => m.includes('brv review approve'))).to.be.true
      expect(loggedMessages.some((m) => m.includes('brv review reject'))).to.be.true
    })

    it('should print review summary for delete pending ops', async () => {
      simulateTaskCompletion(
        [
          {
            applied: [
              {
                filePath: '/project/.brv/context-tree/old/guide.md',
                impact: 'low',
                needsReview: true,
                path: 'old/guide.md',
                previousSummary: 'Old guide content',
                reason: 'Duplicate removed',
                status: 'success',
                type: 'DELETE',
              },
            ],
          },
        ],
        1,
      )

      await createCommand('test context').run()

      expect(loggedMessages.some((m) => m.includes('old/guide.md'))).to.be.true
      expect(loggedMessages.some((m) => m.includes('Duplicate removed'))).to.be.true
      expect(loggedMessages.some((m) => m.includes('brv review approve'))).to.be.true
    })

    it('should not print review summary when no ops need review', async () => {
      simulateTaskCompletion([
        {
          applied: [
            {
              filePath: '/project/.brv/context-tree/auth/jwt.md',
              impact: 'low',
              needsReview: false,
              path: 'auth/jwt.md',
              status: 'success',
              type: 'ADD',
            },
          ],
        },
      ])

      await createCommand('test context').run()

      expect(loggedMessages.some((m) => m.includes('require'))).to.be.false
      expect(loggedMessages.some((m) => m.includes('brv review'))).to.be.false
    })

    it('should include pendingReview in JSON output when ops need review', async () => {
      simulateTaskCompletion(
        [
          {
            applied: [
              {
                impact: 'high',
                needsReview: true,
                path: 'auth/jwt.md',
                reason: 'Core auth strategy change',
                status: 'success',
                summary: 'JWT with refresh tokens',
                type: 'UPDATE',
              },
            ],
          },
        ],
        1,
      )

      await createJsonCommand('test context').run()

      // Non-detach mode emits multiple events (toolCall, toolResult, completed) — read the last line
      const json = parseLastJsonLine()
      expect(json.success).to.be.true
      expect(json.data).to.have.property('pendingReview')
      const pr = json.data.pendingReview as Record<string, unknown>
      expect(pr).to.have.property('count', 1)
      expect(pr).to.have.property('taskId').that.is.a('string')
      expect(pr).to.have.property('files').that.is.an('array').with.lengthOf(1)
      const file = (pr.files as Record<string, unknown>[])[0]
      expect(file).to.have.property('path', 'auth/jwt.md')
      expect(file).to.have.property('reason', 'Core auth strategy change')
    })

    it('should not include pendingReview in JSON output when no review needed', async () => {
      simulateTaskCompletion([
        {
          applied: [
            {
              needsReview: false,
              path: 'auth/jwt.md',
              status: 'success',
              type: 'ADD',
            },
          ],
        },
      ])

      await createJsonCommand('test context').run()

      const json = parseLastJsonLine()
      expect(json.success).to.be.true
      expect(json.data).to.not.have.property('pendingReview')
    })
  })

  // ==================== Timeout Flag ====================

  describe('timeout flag', () => {
    it('should accept --timeout flag without error', async () => {
      await createCommand('test context', '--detach', '--timeout', '600').run()

      expect(loggedMessages.some((m) => m.startsWith('✓ Context queued for processing.'))).to.be.true
    })

    it('warns once that --timeout is deprecated when the user passes a non-default value', async () => {
      await createCommand('test context', '--detach', '--timeout', '600').run()

      const deprecationWarnings = loggedMessages.filter((m) => m.includes('--timeout is deprecated'))
      expect(deprecationWarnings).to.have.lengthOf(1)
      expect(deprecationWarnings[0]).to.include('has no effect')
      expect(deprecationWarnings[0]).to.not.include('llm.iterationBudgetMs')
    })

    it('does not warn about deprecation when --timeout is omitted', async () => {
      await createCommand('test context', '--detach').run()

      expect(loggedMessages.some((m) => m.includes('--timeout is deprecated'))).to.be.false
    })

    it('should accept --timeout flag in JSON mode', async () => {
      await createJsonCommand('test context', '--detach', '--timeout', '600').run()

      const json = parseJsonOutput()
      expect(json.success).to.be.true
      expect(json.data).to.have.property('status', 'queued')
    })

    it('should work with default timeout when flag is not provided', async () => {
      simulateTaskCompletion([
        {
          applied: [
            {
              needsReview: false,
              path: 'auth/jwt.md',
              status: 'success',
              type: 'ADD',
            },
          ],
        },
      ])

      await createCommand('test context').run()

      expect(loggedMessages.some((m) => m.includes('✓ Context curated successfully'))).to.be.true
    })
  })

  // ==================== --cancel flag (T2.2) ====================

  describe('--cancel flag', () => {
    // eslint-disable-next-line unicorn/consistent-function-scoping -- captures mockClient from outer beforeEach
    function stubCancelResponse(response: {error?: string; success: boolean}): void {
      ;(mockClient.requestWithAck as sinon.SinonStub).callsFake(async (event: string) => {
        if (event === 'task:cancel') return response
        // Provider config still answers if the command ever asks — but the cancel
        // branch should never get here. Returning a config keeps the stub honest
        // so the assertion below catches a missed short-circuit.
        return {activeProvider: 'anthropic'}
      })
    }

    it('short-circuits the create flow: emits task:cancel, never asks provider config or task:create', async () => {
      stubCancelResponse({success: true})

      await createCommand('--cancel', 'task-A').run()

      const requestStub = mockClient.requestWithAck as sinon.SinonStub
      const eventNames = requestStub.getCalls().map((c) => c.args[0])
      expect(eventNames).to.deep.equal(['task:cancel'])
      expect(requestStub.firstCall.args[1]).to.deep.equal({taskId: 'task-A'})
    })

    it('prints "Cancelled <id>" on success (text format)', async () => {
      stubCancelResponse({success: true})

      await createCommand('--cancel', 'task-B').run()

      expect(loggedMessages).to.include('Cancelled task-B')
    })

    it('prints a failure line including the daemon-provided reason (text format) and exits non-zero', async () => {
      stubCancelResponse({error: 'Task not found', success: false})

      let exitError: unknown
      try {
        await createCommand('--cancel', 'task-X').run()
      } catch (error) {
        exitError = error
      }

      expect(loggedMessages.some((m) => m.includes('Failed to cancel task-X') && m.includes('Task not found'))).to.be.true
      // oclif throws ExitError when this.exit(1) runs
      expect(exitError).to.not.equal(undefined)
    })

    it('emits the project JSON envelope when --format json is given (success)', async () => {
      stubCancelResponse({success: true})

      await createJsonCommand('--cancel', 'task-J').run()

      const json = parseJsonOutput()
      expect(json.command).to.equal('curate')
      expect(json.success).to.equal(true)
      expect(json.data).to.deep.include({status: 'cancelled', taskId: 'task-J'})
    })

    it('emits the project JSON envelope when --format json is given (failure)', async () => {
      stubCancelResponse({error: 'Task not found', success: false})

      try {
        await createJsonCommand('--cancel', 'task-K').run()
      } catch {
        // ExitError on non-zero exit
      }

      const json = parseJsonOutput()
      expect(json.command).to.equal('curate')
      expect(json.success).to.equal(false)
      expect(json.data).to.deep.include({error: 'Task not found', status: 'error', taskId: 'task-K'})
    })

    it('does NOT call validateInput (no context required when --cancel is used)', async () => {
      stubCancelResponse({success: true})

      await createCommand('--cancel', 'task-C').run()

      // Without --cancel, missing context would log this hint.
      expect(loggedMessages.some((m) => m.includes('Either a context argument'))).to.equal(false)
    })

    it('rejects --cancel together with --files (mutually exclusive)', async () => {
      stubCancelResponse({success: true})

      let parseError: unknown
      try {
        await createCommand('--cancel', 'task-Z', '--files', 'foo.ts').run()
      } catch (error) {
        parseError = error
      }

      // oclif throws CLIError when exclusive flags are combined; no transport calls are made.
      expect(parseError).to.not.equal(undefined)
      expect((mockClient.requestWithAck as sinon.SinonStub).called).to.equal(false)
    })

    it('rejects --cancel together with --folder (mutually exclusive)', async () => {
      stubCancelResponse({success: true})

      let parseError: unknown
      try {
        await createCommand('--cancel', 'task-Z', '--folder', 'src/').run()
      } catch (error) {
        parseError = error
      }

      expect(parseError).to.not.equal(undefined)
      expect((mockClient.requestWithAck as sinon.SinonStub).called).to.equal(false)
    })

    it('rejects --cancel together with --detach (mutually exclusive)', async () => {
      stubCancelResponse({success: true})

      let parseError: unknown
      try {
        await createCommand('--cancel', 'task-Z', '--detach').run()
      } catch (error) {
        parseError = error
      }

      expect(parseError).to.not.equal(undefined)
      expect((mockClient.requestWithAck as sinon.SinonStub).called).to.equal(false)
    })

    it('allows --cancel alongside --timeout (timeout has no effect on the cancel branch)', async () => {
      stubCancelResponse({success: true})

      let parseError: unknown
      try {
        await createCommand('--cancel', 'task-T', '--timeout', '60').run()
      } catch (error) {
        parseError = error
      }

      expect(parseError).to.equal(undefined)
      const requestStub = mockClient.requestWithAck as sinon.SinonStub
      const eventNames = requestStub.getCalls().map((c) => c.args[0])
      expect(eventNames).to.deep.equal(['task:cancel'])
    })
  })

  // ==================== Remote cancel during foreground wait (N-2) ====================

  describe('remote cancel during foreground wait', () => {
    // eslint-disable-next-line unicorn/consistent-function-scoping -- captures mockClient from outer beforeEach
    function simulateRemoteCancel(): void {
      const eventHandlers = new Map<string, (data: unknown) => void>()
      ;(mockClient.on as sinon.SinonStub).callsFake((event: string, handler: (data: unknown) => void) => {
        eventHandlers.set(event, handler)
        return () => {}
      })
      ;(mockClient.requestWithAck as sinon.SinonStub).callsFake(async (event: string, data: unknown) => {
        if (event === 'state:getProviderConfig') return {activeProvider: 'anthropic'}
        const {taskId} = data as {taskId: string}
        setImmediate(() => {
          eventHandlers.get('task:cancelled')?.({taskId})
        })
        return {logId: 'log-1'}
      })
    }

    it('prints the cancelled line and exits non-zero (text)', async () => {
      simulateRemoteCancel()

      let exitError: unknown
      try {
        await createCommand('test context').run()
      } catch (error) {
        exitError = error
      }

      expect(loggedMessages.some((m) => m.includes('Curate cancelled'))).to.be.true
      expect(exitError).to.not.equal(undefined)
    })

    it('emits a cancelled JSON envelope and exits non-zero (json)', async () => {
      simulateRemoteCancel()

      try {
        await createJsonCommand('test context').run()
      } catch {
        // ExitError on this.exit(130)
      }

      const json = parseLastJsonLine()
      expect(json.command).to.equal('curate')
      // success: false tracks the non-zero exit code; cancellation semantics live in data.status.
      expect(json.success).to.equal(false)
      expect(json.data).to.deep.include({event: 'cancelled', status: 'cancelled'})
    })
  })
})
