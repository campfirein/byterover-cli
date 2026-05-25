import type {ConnectionResult, ITransportClient} from '@campfirein/brv-transport-client'
import type {Config} from '@oclif/core'

import {ConnectionFailedError, InstanceCrashedError, NoInstanceRunningError} from '@campfirein/brv-transport-client'
import {Config as OclifConfig} from '@oclif/core'
import {expect} from 'chai'
import {mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync} from 'node:fs'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import sinon, {restore, stub} from 'sinon'

import Query from '../../src/oclif/commands/query.js'

// ==================== TestableQueryCommand ====================

class TestableQueryCommand extends Query {
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

describe('Query Command', () => {
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
    testDir = realpathSync(mkdtempSync(join(tmpdir(), 'brv-query-command-')))

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

  function createLinkedWorkspace(): {projectRoot: string; worktreeRoot: string} {
    const projectRoot = join(testDir, 'monorepo')
    const worktreeRoot = join(projectRoot, 'packages', 'api')
    mkdirSync(join(projectRoot, '.brv'), {recursive: true})
    mkdirSync(worktreeRoot, {recursive: true})
    writeFileSync(join(projectRoot, '.brv', 'config.json'), JSON.stringify({version: '0.0.1'}))
    writeFileSync(join(worktreeRoot, '.brv'), JSON.stringify({projectRoot}, null, 2) + '\n')
    return {projectRoot, worktreeRoot}
  }

  function createCommand(...argv: string[]): TestableQueryCommand {
    const command = new TestableQueryCommand(argv, mockConnector, config)
    stub(command, 'log').callsFake((msg?: string) => {
      if (msg) loggedMessages.push(msg)
    })
    return command
  }

  function createJsonCommand(...argv: string[]): TestableQueryCommand {
    const command = new TestableQueryCommand([...argv, '--format', 'json'], mockConnector, config)
    stub(command, 'log').callsFake((msg?: string) => {
      if (msg) loggedMessages.push(msg)
    })
    stub(process.stdout, 'write').callsFake((chunk: string | Uint8Array) => {
      stdoutOutput.push(String(chunk))
      return true
    })
    return command
  }

  function parseJsonOutput(): Array<{command: string; data: Record<string, unknown>; success: boolean}> {
    const output = stdoutOutput.join('')
    return output
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line))
  }

  // ==================== Input Validation ====================

  describe('input validation', () => {
    it('should show usage message when query is empty', async () => {
      await createCommand('').run()

      expect(loggedMessages).to.include('Query argument is required.')
      expect(loggedMessages).to.include('Usage: brv query "your question here"')
    })

    it('should show usage message when query is whitespace only', async () => {
      await createCommand('   ').run()

      expect(loggedMessages).to.include('Query argument is required.')
    })

    it('should output JSON error when query is empty in json mode', async () => {
      await createJsonCommand('').run()

      const [json] = parseJsonOutput()
      expect(json.success).to.be.false
      expect(json.data).to.have.property('message', 'Query argument is required.')
    })
  })

  // ==================== Provider Validation ====================

  describe('provider validation', () => {
    it('should error when no provider is connected', async () => {
      ;(mockClient.requestWithAck as sinon.SinonStub).resolves({activeProvider: ''})

      await createCommand('test query').run()

      expect(loggedMessages.some((m) => m.includes('No provider connected'))).to.be.true
      expect(loggedMessages.some((m) => m.includes('brv providers connect'))).to.be.true
    })

    it('should output JSON error when no provider is connected', async () => {
      ;(mockClient.requestWithAck as sinon.SinonStub).resolves({activeProvider: ''})

      await createJsonCommand('test query').run()

      const [json] = parseJsonOutput()
      expect(json.success).to.be.false
      expect(json.data).to.have.property('error').that.includes('No provider connected')
    })
  })

  // ==================== Task Submission ====================

  describe('task submission', () => {
    it('should send task:create request with query and taskId', async () => {
      // Simulate task:completed via event handler
      const eventHandlers: Map<string, Array<(data: unknown) => void>> = new Map()
      ;(mockClient.on as sinon.SinonStub).callsFake((event: string, handler: (data: unknown) => void) => {
        if (!eventHandlers.has(event)) eventHandlers.set(event, [])
        eventHandlers.get(event)!.push(handler)
        return () => {}
      })
      ;(mockClient.requestWithAck as sinon.SinonStub).callsFake(async (event: string, payload: {taskId: string}) => {
        if (event === 'state:getProviderConfig') return {activeProvider: 'anthropic'}
        if (event === 'billing:resolve') return {}
        if (event === 'config:getEnvironment') return {}
        setTimeout(() => {
          const handlers = eventHandlers.get('task:completed')
          if (handlers) {
            for (const handler of handlers) handler({result: 'Mock response', taskId: payload.taskId})
          }
        }, 10)
        return {taskId: payload.taskId}
      })

      await createCommand('What is the architecture?').run()

      const requestStub = mockClient.requestWithAck as sinon.SinonStub
      const taskCreateCall = requestStub.getCalls().find((c) => c.args[0] === 'task:create')
      expect(taskCreateCall, 'expected task:create to be called').to.exist
      const payload = taskCreateCall!.args[1]
      expect(payload).to.have.property('content', 'What is the architecture?')
      expect(payload).to.have.property('type', 'query')
      expect(payload).to.have.property('taskId').that.is.a('string')
      expect(payload).to.have.property('projectPath', '/test/project')
    })

    it('should send projectPath, worktreeRoot, and clientCwd from a linked workspace', async () => {
      const {projectRoot, worktreeRoot} = createLinkedWorkspace()
      process.chdir(worktreeRoot)
      mockConnector.resolves({
        client: mockClient as unknown as ITransportClient,
        projectRoot,
      })

      const eventHandlers: Map<string, Array<(data: unknown) => void>> = new Map()
      ;(mockClient.on as sinon.SinonStub).callsFake((event: string, handler: (data: unknown) => void) => {
        if (!eventHandlers.has(event)) eventHandlers.set(event, [])
        eventHandlers.get(event)!.push(handler)
        return () => {}
      })
      ;(mockClient.requestWithAck as sinon.SinonStub).callsFake(async (event: string, payload: {taskId: string}) => {
        if (event === 'state:getProviderConfig') return {activeProvider: 'anthropic'}
        if (event === 'billing:resolve') return {}
        if (event === 'config:getEnvironment') return {}
        setTimeout(() => {
          const handlers = eventHandlers.get('task:completed')
          if (handlers) {
            for (const handler of handlers) handler({result: 'Scoped response', taskId: payload.taskId})
          }
        }, 10)
        return {taskId: payload.taskId}
      })

      await createCommand('What is scoped here?').run()

      const taskCreateCall = (mockClient.requestWithAck as sinon.SinonStub)
        .getCalls()
        .find((c) => c.args[0] === 'task:create')
      expect(taskCreateCall, 'expected task:create to be called').to.exist
      expect(taskCreateCall!.args[1]).to.include({
        clientCwd: worktreeRoot,
        projectPath: projectRoot,
        worktreeRoot,
      })
    })

    it('should display result from task:completed fallback', async () => {
      const eventHandlers: Map<string, Array<(data: unknown) => void>> = new Map()
      ;(mockClient.on as sinon.SinonStub).callsFake((event: string, handler: (data: unknown) => void) => {
        if (!eventHandlers.has(event)) eventHandlers.set(event, [])
        eventHandlers.get(event)!.push(handler)
        return () => {}
      })
      ;(mockClient.requestWithAck as sinon.SinonStub).callsFake(async (event: string, payload: {taskId: string}) => {
        if (event === 'state:getProviderConfig') return {activeProvider: 'anthropic'}
        if (event === 'billing:resolve') return {}
        if (event === 'config:getEnvironment') return {}
        setTimeout(() => {
          const handlers = eventHandlers.get('task:completed')
          if (handlers) {
            for (const handler of handlers) handler({result: 'Direct search result', taskId: payload.taskId})
          }
        }, 10)
        return {taskId: payload.taskId}
      })

      await createCommand('test query').run()

      expect(loggedMessages.some((m) => m.includes('Direct search result'))).to.be.true
    })

    it('should display result from llmservice:response', async () => {
      const eventHandlers: Map<string, Array<(data: unknown) => void>> = new Map()
      ;(mockClient.on as sinon.SinonStub).callsFake((event: string, handler: (data: unknown) => void) => {
        if (!eventHandlers.has(event)) eventHandlers.set(event, [])
        eventHandlers.get(event)!.push(handler)
        return () => {}
      })
      ;(mockClient.requestWithAck as sinon.SinonStub).callsFake(async (event: string, payload: {taskId: string}) => {
        if (event === 'state:getProviderConfig') return {activeProvider: 'anthropic'}
        if (event === 'billing:resolve') return {}
        if (event === 'config:getEnvironment') return {}
        setTimeout(() => {
          // Fire llmservice:response first, then task:completed
          const responseHandlers = eventHandlers.get('llmservice:response')
          if (responseHandlers) {
            for (const handler of responseHandlers) {
              handler({content: 'LLM final answer', sessionId: 'sess-1', taskId: payload.taskId})
            }
          }

          const completedHandlers = eventHandlers.get('task:completed')
          if (completedHandlers) {
            for (const handler of completedHandlers) handler({taskId: payload.taskId})
          }
        }, 10)
        return {taskId: payload.taskId}
      })

      await createCommand('test query').run()

      expect(loggedMessages.some((m) => m.includes('LLM final answer'))).to.be.true
    })

    it('should surface attribution footer from completed payload when streaming (text)', async () => {
      const eventHandlers: Map<string, Array<(data: unknown) => void>> = new Map()
      ;(mockClient.on as sinon.SinonStub).callsFake((event: string, handler: (data: unknown) => void) => {
        if (!eventHandlers.has(event)) eventHandlers.set(event, [])
        eventHandlers.get(event)!.push(handler)
        return () => {}
      })
      ;(mockClient.requestWithAck as sinon.SinonStub).callsFake(async (event: string, payload: {taskId: string}) => {
        if (event === 'state:getProviderConfig') return {activeProvider: 'anthropic'}
        if (event === 'billing:resolve') return {}
        if (event === 'config:getEnvironment') return {}
        setTimeout(() => {
          // llmservice:response fires first WITHOUT the attribution footer
          const responseHandlers = eventHandlers.get('llmservice:response')
          if (responseHandlers) {
            for (const handler of responseHandlers) {
              handler({content: 'The answer is 42.', sessionId: 'sess-1', taskId: payload.taskId})
            }
          }

          // task:completed fires with the result that NOW includes the attribution footer
          const completedHandlers = eventHandlers.get('task:completed')
          if (completedHandlers) {
            for (const handler of completedHandlers) {
              handler({
                result: 'The answer is 42.\n\nSource: ByteRover Knowledge Base',
                taskId: payload.taskId,
              })
            }
          }
        }, 10)
        return {taskId: payload.taskId}
      })

      await createCommand('test query').run()

      expect(loggedMessages.some((m) => m.includes('The answer is 42.'))).to.be.true
      expect(loggedMessages.some((m) => m.includes('Source: ByteRover Knowledge Base'))).to.be.true
    })

    it('should surface attribution footer from completed payload when streaming (json)', async () => {
      const eventHandlers: Map<string, Array<(data: unknown) => void>> = new Map()
      ;(mockClient.on as sinon.SinonStub).callsFake((event: string, handler: (data: unknown) => void) => {
        if (!eventHandlers.has(event)) eventHandlers.set(event, [])
        eventHandlers.get(event)!.push(handler)
        return () => {}
      })
      ;(mockClient.requestWithAck as sinon.SinonStub).callsFake(async (event: string, payload: {taskId: string}) => {
        if (event === 'state:getProviderConfig') return {activeProvider: 'anthropic'}
        if (event === 'billing:resolve') return {}
        if (event === 'config:getEnvironment') return {}
        setTimeout(() => {
          const responseHandlers = eventHandlers.get('llmservice:response')
          if (responseHandlers) {
            for (const handler of responseHandlers) {
              handler({content: 'The answer is 42.', sessionId: 'sess-1', taskId: payload.taskId})
            }
          }

          const completedHandlers = eventHandlers.get('task:completed')
          if (completedHandlers) {
            for (const handler of completedHandlers) {
              handler({
                result: 'The answer is 42.\n\nSource: ByteRover Knowledge Base',
                taskId: payload.taskId,
              })
            }
          }
        }, 10)
        return {taskId: payload.taskId}
      })

      await createJsonCommand('test query').run()

      const lines = parseJsonOutput()
      const completedEvent = lines.find((l) => (l.data as Record<string, unknown>).event === 'completed')
      expect(completedEvent).to.exist
      expect(completedEvent!.data).to.have.property('result', 'The answer is 42.\n\nSource: ByteRover Knowledge Base')
    })

    it('should disconnect client after successful request', async () => {
      const eventHandlers: Map<string, Array<(data: unknown) => void>> = new Map()
      ;(mockClient.on as sinon.SinonStub).callsFake((event: string, handler: (data: unknown) => void) => {
        if (!eventHandlers.has(event)) eventHandlers.set(event, [])
        eventHandlers.get(event)!.push(handler)
        return () => {}
      })
      ;(mockClient.requestWithAck as sinon.SinonStub).callsFake(async (event: string, payload: {taskId: string}) => {
        if (event === 'state:getProviderConfig') return {activeProvider: 'anthropic'}
        if (event === 'billing:resolve') return {}
        if (event === 'config:getEnvironment') return {}
        setTimeout(() => {
          const handlers = eventHandlers.get('task:completed')
          if (handlers) {
            for (const handler of handlers) handler({result: 'done', taskId: payload.taskId})
          }
        }, 10)
        return {taskId: payload.taskId}
      })

      await createCommand('test query').run()

      expect(mockClient.disconnect.calledOnce).to.be.true
    })
  })

  // ==================== JSON Output ====================

  describe('json output', () => {
    it('should stream response event and completed event as separate JSON lines', async () => {
      const eventHandlers: Map<string, Array<(data: unknown) => void>> = new Map()
      ;(mockClient.on as sinon.SinonStub).callsFake((event: string, handler: (data: unknown) => void) => {
        if (!eventHandlers.has(event)) eventHandlers.set(event, [])
        eventHandlers.get(event)!.push(handler)
        return () => {}
      })
      ;(mockClient.requestWithAck as sinon.SinonStub).callsFake(async (event: string, payload: {taskId: string}) => {
        if (event === 'state:getProviderConfig') return {activeProvider: 'anthropic'}
        if (event === 'billing:resolve') return {}
        if (event === 'config:getEnvironment') return {}
        setTimeout(() => {
          const responseHandlers = eventHandlers.get('llmservice:response')
          if (responseHandlers) {
            for (const handler of responseHandlers) {
              handler({content: 'JSON answer', sessionId: 'sess-1', taskId: payload.taskId})
            }
          }

          const completedHandlers = eventHandlers.get('task:completed')
          if (completedHandlers) {
            for (const handler of completedHandlers) handler({taskId: payload.taskId})
          }
        }, 10)
        return {taskId: payload.taskId}
      })

      await createJsonCommand('test query').run()

      const lines = parseJsonOutput()
      expect(lines.length).to.be.at.least(2)

      const responseEvent = lines.find((l) => (l.data as Record<string, unknown>).event === 'response')
      expect(responseEvent).to.exist
      expect(responseEvent!.data).to.have.property('content', 'JSON answer')

      const completedEvent = lines.find((l) => (l.data as Record<string, unknown>).event === 'completed')
      expect(completedEvent).to.exist
      expect(completedEvent!.data).to.have.property('result', 'JSON answer')
    })

    it('should surface matchedDocs, tier, durationMs, and topScore in completed event when present', async () => {
      const eventHandlers: Map<string, Array<(data: unknown) => void>> = new Map()
      ;(mockClient.on as sinon.SinonStub).callsFake((event: string, handler: (data: unknown) => void) => {
        if (!eventHandlers.has(event)) eventHandlers.set(event, [])
        eventHandlers.get(event)!.push(handler)
        return () => {}
      })
      ;(mockClient.requestWithAck as sinon.SinonStub).callsFake(async (event: string, payload: {taskId: string}) => {
        if (event === 'state:getProviderConfig') return {activeProvider: 'anthropic'}
        if (event === 'billing:resolve') return {}
        setTimeout(() => {
          const completedHandlers = eventHandlers.get('task:completed')
          if (completedHandlers) {
            for (const handler of completedHandlers) {
              handler({
                durationMs: 184,
                matchedDocs: [
                  {path: 'auth/jwt-tokens.md', score: 0.92, title: 'JWT tokens'},
                  {path: 'billing/stripe-webhooks.md', score: 0.78, title: 'Stripe webhooks'},
                ],
                result: 'cached answer',
                taskId: payload.taskId,
                tier: 2,
                topScore: 0.92,
              })
            }
          }
        }, 10)
        return {taskId: payload.taskId}
      })

      await createJsonCommand('test query').run()

      const lines = parseJsonOutput()
      const completedEvent = lines.find((l) => (l.data as Record<string, unknown>).event === 'completed')
      expect(completedEvent, 'completed event should exist').to.exist
      const data = completedEvent!.data as Record<string, unknown>
      expect(data).to.have.property('result', 'cached answer')
      expect(data).to.have.property('tier', 2)
      expect(data).to.have.property('durationMs', 184)
      expect(data).to.have.property('topScore', 0.92)
      expect(data).to.have.deep.property('matchedDocs', [
        {path: 'auth/jwt-tokens.md', score: 0.92, title: 'JWT tokens'},
        {path: 'billing/stripe-webhooks.md', score: 0.78, title: 'Stripe webhooks'},
      ])
    })

    it('should omit matchedDocs/tier/durationMs/topScore from completed event when absent (graceful)', async () => {
      const eventHandlers: Map<string, Array<(data: unknown) => void>> = new Map()
      ;(mockClient.on as sinon.SinonStub).callsFake((event: string, handler: (data: unknown) => void) => {
        if (!eventHandlers.has(event)) eventHandlers.set(event, [])
        eventHandlers.get(event)!.push(handler)
        return () => {}
      })
      ;(mockClient.requestWithAck as sinon.SinonStub).callsFake(async (event: string, payload: {taskId: string}) => {
        if (event === 'state:getProviderConfig') return {activeProvider: 'anthropic'}
        if (event === 'billing:resolve') return {}
        setTimeout(() => {
          const completedHandlers = eventHandlers.get('task:completed')
          if (completedHandlers) {
            for (const handler of completedHandlers) handler({result: 'plain answer', taskId: payload.taskId})
          }
        }, 10)
        return {taskId: payload.taskId}
      })

      await createJsonCommand('test query').run()

      const lines = parseJsonOutput()
      const completedEvent = lines.find((l) => (l.data as Record<string, unknown>).event === 'completed')
      expect(completedEvent).to.exist
      const data = completedEvent!.data as Record<string, unknown>
      expect(data).to.have.property('result', 'plain answer')
      expect(data).to.not.have.property('matchedDocs')
      expect(data).to.not.have.property('tier')
      expect(data).to.not.have.property('durationMs')
      expect(data).to.not.have.property('topScore')
    })
  })

  // ==================== Connection Errors ====================

  describe('connection errors', () => {
    it('should handle NoInstanceRunningError', async () => {
      mockConnector.rejects(new NoInstanceRunningError())

      await createCommand('test query').run()

      expect(loggedMessages.some((m) => m.includes('Daemon failed to start automatically'))).to.be.true
    })

    it('should handle InstanceCrashedError', async () => {
      mockConnector.rejects(new InstanceCrashedError())

      await createCommand('test query').run()

      expect(loggedMessages.some((m) => m.includes('Daemon crashed unexpectedly'))).to.be.true
    })

    it('should handle ConnectionFailedError', async () => {
      mockConnector.rejects(new ConnectionFailedError(37_847, new Error('Connection refused')))

      await createCommand('test query').run()

      expect(loggedMessages.some((m) => m.includes('Failed to connect'))).to.be.true
    })

    it('should handle unexpected errors', async () => {
      mockConnector.rejects(new Error('Something went wrong'))

      await createCommand('test query').run()

      expect(loggedMessages.some((m) => m.includes('Something went wrong'))).to.be.true
    })

    it('should output JSON on connection error', async () => {
      mockConnector.rejects(new NoInstanceRunningError())

      await createJsonCommand('test query').run()

      const [json] = parseJsonOutput()
      expect(json.command).to.equal('query')
      expect(json.success).to.be.false
      expect(json.data).to.have.property('error')
    })
  })

  // ==================== Timeout Flag ====================

  describe('timeout flag', () => {
    it('should accept --timeout flag without error', async () => {
      const eventHandlers: Map<string, Array<(data: unknown) => void>> = new Map()
      ;(mockClient.on as sinon.SinonStub).callsFake((event: string, handler: (data: unknown) => void) => {
        if (!eventHandlers.has(event)) eventHandlers.set(event, [])
        eventHandlers.get(event)!.push(handler)
        return () => {}
      })
      ;(mockClient.requestWithAck as sinon.SinonStub).callsFake(async (event: string, payload: {taskId: string}) => {
        if (event === 'state:getProviderConfig') return {activeProvider: 'anthropic'}
        if (event === 'billing:resolve') return {}
        if (event === 'config:getEnvironment') return {}
        setTimeout(() => {
          const handlers = eventHandlers.get('task:completed')
          if (handlers) {
            for (const handler of handlers) handler({result: 'done', taskId: payload.taskId})
          }
        }, 10)
        return {taskId: payload.taskId}
      })

      await createCommand('test query', '--timeout', '600').run()

      expect(loggedMessages.some((m) => m.includes('done'))).to.be.true
      const deprecationWarnings = loggedMessages.filter((m) => m.includes('--timeout is deprecated'))
      expect(deprecationWarnings).to.have.lengthOf(1)
      expect(deprecationWarnings[0]).to.include('has no effect')
      expect(deprecationWarnings[0]).to.not.include('llm.iterationBudgetMs')
    })

    it('should accept --timeout flag in JSON mode', async () => {
      const eventHandlers: Map<string, Array<(data: unknown) => void>> = new Map()
      ;(mockClient.on as sinon.SinonStub).callsFake((event: string, handler: (data: unknown) => void) => {
        if (!eventHandlers.has(event)) eventHandlers.set(event, [])
        eventHandlers.get(event)!.push(handler)
        return () => {}
      })
      ;(mockClient.requestWithAck as sinon.SinonStub).callsFake(async (event: string, payload: {taskId: string}) => {
        if (event === 'state:getProviderConfig') return {activeProvider: 'anthropic'}
        if (event === 'billing:resolve') return {}
        if (event === 'config:getEnvironment') return {}
        setTimeout(() => {
          const handlers = eventHandlers.get('task:completed')
          if (handlers) {
            for (const handler of handlers) handler({result: 'done', taskId: payload.taskId})
          }
        }, 10)
        return {taskId: payload.taskId}
      })

      await createJsonCommand('test query', '--timeout', '600').run()

      const lines = parseJsonOutput()
      const completedEvent = lines.find((l) => (l.data as Record<string, unknown>).event === 'completed')
      expect(completedEvent).to.exist
      expect(completedEvent!.success).to.be.true
    })

    it('should work with default timeout when flag is not provided', async () => {
      const eventHandlers: Map<string, Array<(data: unknown) => void>> = new Map()
      ;(mockClient.on as sinon.SinonStub).callsFake((event: string, handler: (data: unknown) => void) => {
        if (!eventHandlers.has(event)) eventHandlers.set(event, [])
        eventHandlers.get(event)!.push(handler)
        return () => {}
      })
      ;(mockClient.requestWithAck as sinon.SinonStub).callsFake(async (event: string, payload: {taskId: string}) => {
        if (event === 'state:getProviderConfig') return {activeProvider: 'anthropic'}
        if (event === 'billing:resolve') return {}
        if (event === 'config:getEnvironment') return {}
        setTimeout(() => {
          const handlers = eventHandlers.get('task:completed')
          if (handlers) {
            for (const handler of handlers) handler({result: 'done', taskId: payload.taskId})
          }
        }, 10)
        return {taskId: payload.taskId}
      })

      await createCommand('test query').run()

      expect(loggedMessages.some((m) => m.includes('done'))).to.be.true
    })
  })

  // ==================== --cancel flag (T2.3) ====================

  describe('--cancel flag', () => {
    // eslint-disable-next-line unicorn/consistent-function-scoping -- captures mockClient from outer beforeEach
    function stubCancelResponse(response: {error?: string; success: boolean}): void {
      ;(mockClient.requestWithAck as sinon.SinonStub).callsFake(async (event: string) => {
        if (event === 'task:cancel') return response
        return {activeProvider: 'anthropic'}
      })
    }

    it('short-circuits the create flow: emits task:cancel only', async () => {
      stubCancelResponse({success: true})

      await createCommand('--cancel', 'task-A').run()

      const requestStub = mockClient.requestWithAck as sinon.SinonStub
      const eventNames = requestStub.getCalls().map((c) => c.args[0])
      expect(eventNames).to.deep.equal(['task:cancel'])
      expect(requestStub.firstCall.args[1]).to.deep.equal({taskId: 'task-A'})
    })

    it('does not require the positional query argument when --cancel is set', async () => {
      stubCancelResponse({success: true})

      // No positional arg, no error
      let parseError: unknown
      try {
        await createCommand('--cancel', 'task-B').run()
      } catch (error) {
        parseError = error
      }

      expect(parseError).to.equal(undefined)
      expect(loggedMessages).to.include('Cancelled task-B')
    })

    it('prints failure line with daemon-reported reason and exits non-zero (text)', async () => {
      stubCancelResponse({error: 'Task not found', success: false})

      let exitError: unknown
      try {
        await createCommand('--cancel', 'task-X').run()
      } catch (error) {
        exitError = error
      }

      expect(loggedMessages.some((m) => m.includes('Failed to cancel task-X') && m.includes('Task not found'))).to.be.true
      expect(exitError).to.not.equal(undefined)
    })

    it('emits the project JSON envelope (success)', async () => {
      stubCancelResponse({success: true})

      await createJsonCommand('--cancel', 'task-J').run()

      const [json] = parseJsonOutput()
      expect(json.command).to.equal('query')
      expect(json.success).to.equal(true)
      expect(json.data).to.deep.include({status: 'cancelled', taskId: 'task-J'})
    })

    it('emits the project JSON envelope (failure)', async () => {
      stubCancelResponse({error: 'Task not found', success: false})

      try {
        await createJsonCommand('--cancel', 'task-K').run()
      } catch {
        // ExitError on non-zero exit
      }

      const [json] = parseJsonOutput()
      expect(json.command).to.equal('query')
      expect(json.success).to.equal(false)
      expect(json.data).to.deep.include({error: 'Task not found', status: 'error', taskId: 'task-K'})
    })

    it('rejects positional query string together with --cancel (mutex)', async () => {
      stubCancelResponse({success: true})

      let exitError: unknown
      try {
        await createCommand('what is X', '--cancel', 'task-Z').run()
      } catch (error) {
        exitError = error
      }

      // Either a clear logged error + non-zero exit, or just a thrown error.
      const loggedErr = loggedMessages.some((m) => m.toLowerCase().includes('cancel') && m.toLowerCase().includes('query'))
      expect(loggedErr || exitError !== undefined).to.equal(true)
      // No transport call must be made when the combination is rejected.
      expect((mockClient.requestWithAck as sinon.SinonStub).called).to.equal(false)
    })

    it('rejects missing both positional query and --cancel with the existing missing-query error', async () => {
      let exitError: unknown
      try {
        await createCommand().run()
      } catch (error) {
        exitError = error
      }

      // Missing-query message OR a thrown error from oclif arg validation.
      const loggedMissing = loggedMessages.some((m) => m.includes('Query argument is required'))
      expect(loggedMissing || exitError !== undefined).to.equal(true)
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
        return {taskId}
      })
    }

    it('prints the cancelled line and exits non-zero (text)', async () => {
      simulateRemoteCancel()

      let exitError: unknown
      try {
        await createCommand('test query').run()
      } catch (error) {
        exitError = error
      }

      expect(loggedMessages.some((m) => m.includes('Query cancelled'))).to.be.true
      expect(exitError).to.not.equal(undefined)
    })

    it('emits a cancelled JSON envelope and exits non-zero (json)', async () => {
      simulateRemoteCancel()

      try {
        await createJsonCommand('test query').run()
      } catch {
        // ExitError on this.exit(130)
      }

      const lines = parseJsonOutput()
      const cancelled = lines.find((line) => line.data.status === 'cancelled')
      expect(cancelled).to.not.equal(undefined)
      expect(cancelled!.command).to.equal('query')
      // success: false tracks the non-zero exit code; cancellation semantics live in data.status.
      expect(cancelled!.success).to.equal(false)
    })
  })
})
