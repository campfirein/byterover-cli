import type {ITransportClient} from '@campfirein/brv-transport-client'

import {expect} from 'chai'
import {restore, stub} from 'sinon'

import type {IContentGenerator} from '../../../src/agent/core/interfaces/i-content-generator.js'
import type {AgentConfig} from '../../../src/agent/infra/agent/index.js'
import type {GeneratorFactoryConfig} from '../../../src/agent/infra/llm/providers/types.js'

import {CipherAgent} from '../../../src/agent/infra/agent/index.js'
import {byteroverProvider} from '../../../src/agent/infra/llm/providers/byterover.js'
import {_resetNestingRegistryForTests, getNestingRecord} from '../../../src/agent/infra/map/agentic-map-service.js'
import {SessionCompressor} from '../../../src/agent/infra/session/session-compressor.js'
import {BRV_CONFIG_VERSION} from '../../../src/server/constants.js'
import {BrvConfig} from '../../../src/server/core/domain/entities/brv-config.js'

function createStubGenerator(): IContentGenerator {
  return {
    estimateTokensSync: () => 0,
    generateContent: async () => ({content: '', finishReason: 'stop'}),
    async *generateContentStream() {
      yield {isComplete: true}
    },
  }
}

describe('CipherAgent', () => {
  let agentConfig: AgentConfig

  beforeEach(() => {
    agentConfig = {
      apiBaseUrl: 'http://localhost:3333',
      blobStorage: {
        maxBlobSize: 100 * 1024 * 1024,
        maxTotalSize: 1024 * 1024 * 1024,
        storageDir: '/tmp/brv-test-blobs',
      },
      llm: {
        maxIterations: 10,
        maxTokens: 1000,
        temperature: 0.5,
      },
      model: 'gemini-2.5-flash',
      projectId: 'byterover',
      sessionKey: 'test-session-key',
      storagePath: '/tmp/brv-test-storage',
    }
    stub(console, 'log')
  })

  afterEach(() => {
    restore()
  })

  describe('stream', () => {
    it('keeps lifecycleResult on the internal event bus but not the public stream', async () => {
      const agent = new CipherAgent(agentConfig)
      const abortController = new AbortController()

      try {
        await agent.start()
        const internalEvents: unknown[] = []
        agent.agentEventBus!.on('llmservice:toolResult', (payload) => internalEvents.push(payload))
        const iterator = await agent.stream('inspect stream privacy', {signal: abortController.signal})
        const lifecycleResult = {
          applied: [{
            confidence: 'high',
            impact: 'high',
            needsReview: true,
            path: '/private-operation.md',
            reason: 'Internal lifecycle metadata',
            status: 'success',
            type: 'UPSERT',
          }],
        }

        agent.agentEventBus!.emit('llmservice:toolResult', {
          lifecycleResult,
          result: 'public display result',
          sessionId: agent.sessionId!,
          success: true,
          toolName: 'curate',
        } as never)

        const readPublicToolResult = async (attemptsRemaining: number): Promise<Record<string, unknown> | undefined> => {
          if (attemptsRemaining === 0) return undefined
          const next = await iterator.next()
          if (next.done) return undefined
          if (next.value.name === 'llmservice:toolResult') {
            return next.value as unknown as Record<string, unknown>
          }

          return readPublicToolResult(attemptsRemaining - 1)
        }

        const publicToolResult = await readPublicToolResult(10)

        expect(internalEvents[0]).to.deep.include({lifecycleResult})
        expect(publicToolResult).to.include({result: 'public display result'})
        expect(publicToolResult).to.not.have.property('lifecycleResult')
      } finally {
        abortController.abort()
        await agent.stop()
      }
    })
  })

  describe('constructor', () => {
    it('should create instance with valid agent config', () => {
      const agent = new CipherAgent(agentConfig)

      expect(agent).to.be.instanceOf(CipherAgent)
    })

    it('should create instance with agent config and BRV config', () => {
      const brvConfig = new BrvConfig({
        chatLogPath: 'chat.log',
        cipherAgentSystemPrompt: 'Custom system prompt',
        createdAt: new Date().toISOString(),
        cwd: '/test/cwd',
        ide: 'Claude Code',
        spaceId: 'space-id',
        spaceName: 'Space Name',
        teamId: 'team-id',
        teamName: 'Team Name',
        version: BRV_CONFIG_VERSION,
      })

      const agent = new CipherAgent(agentConfig, brvConfig)

      expect(agent).to.be.instanceOf(CipherAgent)
    })

    it('should initialize with zero iterations', () => {
      const agent = new CipherAgent(agentConfig)

      const state = agent.getState()
      expect(state.currentIteration).to.equal(0)
      expect(state.executionHistory).to.deep.equal([])
    })
  })

  describe('getState', () => {
    it('should return initial state before start', () => {
      const agent = new CipherAgent(agentConfig)

      const state = agent.getState()

      expect(state).to.have.property('currentIteration')
      expect(state).to.have.property('executionHistory')
      expect(state.currentIteration).to.equal(0)
      expect(state.executionHistory).to.be.an('array').that.is.empty
    })

    it('should return independent state copies', () => {
      const agent = new CipherAgent(agentConfig)

      const state1 = agent.getState()
      const state2 = agent.getState()

      expect(state1).to.not.equal(state2)
      expect(state1.executionHistory).to.not.equal(state2.executionHistory)
    })
  })

  describe('reset', () => {
    it('should reset state to initial values after start', async () => {
      const agent = new CipherAgent(agentConfig)
      await agent.start()

      // Reset should clear state
      agent.reset()

      const state = agent.getState()
      expect(state.currentIteration).to.equal(0)
      expect(state.executionHistory).to.deep.equal([])
    })

    it('should allow reset before start (no event emission)', () => {
      const agent = new CipherAgent(agentConfig)

      // Reset is safe to call before start() - it just won't emit events
      // This is safer than the old implementation which would throw TypeError
      agent.reset()

      const state = agent.getState()
      expect(state.currentIteration).to.equal(0)
      expect(state.executionHistory).to.deep.equal([])
    })
  })

  describe('execute - error handling', () => {
    it('should throw error when execute is called before start', async () => {
      const agent = new CipherAgent(agentConfig)

      try {
        // Agent now uses its default session (created during start())
        await agent.execute('test input')
        expect.fail('Should have thrown error')
      } catch (error) {
        expect(error).to.be.instanceOf(Error)
        expect((error as Error).message).to.include('must be started')
      }
    })
  })

  describe('getSystemPrompt - error handling', () => {
    it('should throw error when getSystemPrompt is called before start', async () => {
      const agent = new CipherAgent(agentConfig)

      try {
        await agent.getSystemPrompt()
        expect.fail('Should have thrown error')
      } catch (error) {
        expect(error).to.be.instanceOf(Error)
        expect((error as Error).message).to.include('must be started')
      }
    })
  })

  describe('start', () => {
    it('should throw error when start is called twice', async () => {
      const agent = new CipherAgent(agentConfig)

      await agent.start()

      try {
        await agent.start()
        expect.fail('Should have thrown error')
      } catch (error) {
        expect(error).to.be.instanceOf(Error)
        expect((error as Error).message).to.include('already started')
      }
    })
  })

  describe('two-phase initialization pattern', () => {
    it('should require start() before execute()', async () => {
      const agent = new CipherAgent(agentConfig)

      // Phase 1: Constructor completes synchronously
      expect(agent).to.be.instanceOf(CipherAgent)
      expect(agent.getState().currentIteration).to.equal(0)

      // Phase 2: Must call start() before execute()
      // Agent now uses its default session (created during start())
      try {
        await agent.execute('test')
        expect.fail('Should require start() first')
      } catch (error) {
        expect((error as Error).message).to.include('must be started')
      }
    })

    it('should allow reset() before start() (safe behavior)', () => {
      const agent = new CipherAgent(agentConfig)

      // After refactoring to remove non-null assertions, reset() is now safe
      // to call before start() - it just won't emit events
      agent.reset()

      const state = agent.getState()
      expect(state.currentIteration).to.equal(0)
      expect(state.executionHistory).to.deep.equal([])
    })

    it('should allow getState() before start()', () => {
      const agent = new CipherAgent(agentConfig)

      // getState should work without start()
      const state = agent.getState()

      expect(state).to.have.property('currentIteration')
      expect(state).to.have.property('executionHistory')
    })
  })

  describe('switchDefaultSession', () => {
    it('should throw error when called before start', () => {
      const agent = new CipherAgent(agentConfig)

      try {
        agent.switchDefaultSession('some-session-id')
        expect.fail('Should have thrown error')
      } catch (error) {
        expect(error).to.be.instanceOf(Error)
        expect((error as Error).message).to.include('must be started')
      }
    })

    it('should throw error when session does not exist', async () => {
      const agent = new CipherAgent(agentConfig)
      await agent.start()

      try {
        agent.switchDefaultSession('non-existent-session-id')
        expect.fail('Should have thrown error')
      } catch (error) {
        expect(error).to.be.instanceOf(Error)
        expect((error as Error).message).to.include('does not exist')
        expect((error as Error).message).to.include('non-existent-session-id')
      }
    })

    it('should switch to existing session successfully', async () => {
      const agent = new CipherAgent(agentConfig)
      await agent.start()

      // Get the initial default session ID
      const initialSessionId = agent.sessionId
      expect(initialSessionId).to.be.a('string')

      // Create a new session
      const newSession = await agent.createSession('new-test-session')
      expect(newSession.id).to.equal('new-test-session')

      // Switch to the new session
      agent.switchDefaultSession('new-test-session')

      // Verify the default session ID has changed
      expect(agent.sessionId).to.equal('new-test-session')
      expect(agent.sessionId).to.not.equal(initialSessionId)
    })

    it('should allow switching back to original session', async () => {
      const agent = new CipherAgent(agentConfig)
      await agent.start()

      const originalSessionId = agent.sessionId!

      // Create and switch to a new session
      await agent.createSession('temp-session')
      agent.switchDefaultSession('temp-session')
      expect(agent.sessionId).to.equal('temp-session')

      // Switch back to original
      agent.switchDefaultSession(originalSessionId)
      expect(agent.sessionId).to.equal(originalSessionId)
    })
  })

  describe('interface compliance', () => {
    it('should implement all ICipherAgent methods', () => {
      const agent = new CipherAgent(agentConfig)

      // Check that all required methods exist
      expect(agent).to.have.property('start').that.is.a('function')
      expect(agent).to.have.property('execute').that.is.a('function')
      expect(agent).to.have.property('getState').that.is.a('function')
      expect(agent).to.have.property('reset').that.is.a('function')
      expect(agent).to.have.property('switchDefaultSession').that.is.a('function')
    })

    it('should expose agentEventBus after start', async () => {
      const agent = new CipherAgent(agentConfig)

      await agent.start()

      expect(agent).to.have.property('agentEventBus')
      expect(agent.agentEventBus).to.have.property('on')
      expect(agent.agentEventBus).to.have.property('emit')
    })
  })

  describe('refreshProviderConfig', () => {
    it('should throw error when called before start', () => {
      const agent = new CipherAgent(agentConfig)

      try {
        agent.refreshProviderConfig({model: 'gpt-4'})
        expect.fail('Should have thrown error')
      } catch (error) {
        expect(error).to.be.instanceOf(Error)
        expect((error as Error).message).to.include('must be started')
      }
    })

    it('should succeed after start and replace SessionManager', async () => {
      const agent = new CipherAgent(agentConfig)
      await agent.start()

      // Create a session on the old SessionManager
      const oldSessionId = agent.sessionId
      expect(oldSessionId).to.be.a('string')

      // refreshProviderConfig should not throw
      agent.refreshProviderConfig({
        model: 'gpt-4o',
        provider: 'openrouter',
        providerApiKey: 'sk-test-key',
      })

      // Old sessions are gone (SessionManager replaced), so old sessionId is no longer valid
      // Agent should still be functional - can create new sessions
      const newSession = await agent.createSession('post-refresh-session')
      expect(newSession.id).to.equal('post-refresh-session')
    })

    it('should replace SessionManager when only credentials change (token refresh / auth method switch)', async () => {
      const agent = new CipherAgent(agentConfig)
      await agent.start()

      // Create a session on the old SessionManager
      const oldSession = await agent.createSession('pre-refresh')
      expect(oldSession.id).to.equal('pre-refresh')
      expect(agent.listSessions()).to.include('pre-refresh')

      // Simulate credential-only change: same model, new API key + headers (e.g., OAuth token refresh)
      agent.refreshProviderConfig({
        model: agentConfig.model,
        providerApiKey: 'refreshed-oauth-token',
        providerHeaders: {'ChatGPT-Account-Id': 'org-123'},
      })

      // Old sessions are gone (SessionManager was replaced)
      expect(agent.getSession('pre-refresh')).to.be.undefined
      expect(agent.listSessions()).to.not.include('pre-refresh')

      // New SessionManager is functional
      const newSession = await agent.createSession('post-credential-refresh')
      expect(newSession.id).to.equal('post-credential-refresh')
      expect(agent.listSessions()).to.include('post-credential-refresh')
    })
  })

  describe('deleteTaskSession', () => {
    it('waits for the abstract queue to stay idle before returning', async () => {
      const agent = new CipherAgent(agentConfig)

      try {
        await agent.start()

        const drainStub = stub().resolves()
        const getStatusStub = stub()
        getStatusStub.callsFake(() => (
          getStatusStub.callCount === 0
            ? {failed: 0, pending: 1, processed: 0, processing: true}
            : {failed: 0, pending: 0, processed: 1, processing: false}
        ))
        ;(
          agent as unknown as {
            services?: {abstractQueue?: {drain: () => Promise<void>; getStatus: () => {failed: number; pending: number; processed: number; processing: boolean}}}
          }
        ).services!.abstractQueue = {drain: drainStub, getStatus: getStatusStub}

        await agent.drainBackgroundWork()

        expect(drainStub.callCount).to.be.greaterThan(1)
        expect(getStatusStub.callCount).to.be.greaterThan(1)
      } finally {
        await agent.stop()
      }
    })

    it('compresses user-facing task sessions with a lower minMessages threshold', async () => {
      const compressStub = stub(SessionCompressor.prototype, 'compress').resolves({created: 0, merged: 0, skipped: 0})

      const agent = new CipherAgent(agentConfig)

      try {
        await agent.start()

        const taskSessionId = await agent.createTaskSession('task-compress-threshold', 'curate', {userFacing: true})
        await agent.deleteTaskSession(taskSessionId)

        expect(compressStub.calledOnce).to.be.true
        expect(compressStub.firstCall.args[2]).to.deep.equal({minMessages: 2})
      } finally {
        await agent.stop()
      }
    })

    it('passes http config and ranking metadata when refreshing a byterover generator', async () => {
      const capturedConfigs: GeneratorFactoryConfig[] = []
      stub(byteroverProvider, 'createGenerator').callsFake((config) => {
        capturedConfigs.push(config)
        return createStubGenerator()
      })
      stub(SessionCompressor.prototype, 'compress').resolves({created: 0, merged: 0, skipped: 0})

      const transportClient = {
        request: stub(),
        requestWithAck: stub().resolves({
          activeModel: 'fresh-model',
          activeProvider: 'byterover',
          providerApiKey: 'fresh-token',
          providerKeyMissing: false,
        }),
      } as unknown as ITransportClient

      const agent = new CipherAgent({
        ...agentConfig,
        httpReferer: 'https://app.byterover.dev',
        siteName: 'ByteRover CLI',
      }, undefined, {transportClient})

      try {
        await agent.start()

        const taskSessionId = await agent.createTaskSession('task-refresh', 'curate', {userFacing: true})
        await agent.deleteTaskSession(taskSessionId)

        const refreshConfig = capturedConfigs.find((config) => config.model === 'fresh-model')
        expect(refreshConfig).to.not.be.undefined
        expect(refreshConfig!.httpConfig).to.deep.include({
          apiBaseUrl: agentConfig.apiBaseUrl,
          projectId: agentConfig.projectId,
          sessionKey: agentConfig.sessionKey,
          spaceId: '',
          teamId: '',
        })
        expect(refreshConfig!.httpReferer).to.equal('https://app.byterover.dev')
        expect(refreshConfig!.siteName).to.equal('ByteRover CLI')
      } finally {
        await agent.stop()
      }
    })

    it('falls back to the current runtime model when transport omits activeModel', async () => {
      const capturedConfigs: GeneratorFactoryConfig[] = []
      stub(byteroverProvider, 'createGenerator').callsFake((config) => {
        capturedConfigs.push(config)
        return createStubGenerator()
      })
      stub(SessionCompressor.prototype, 'compress').resolves({created: 0, merged: 0, skipped: 0})

      const transportClient = {
        request: stub(),
        requestWithAck: stub().resolves({
          activeProvider: 'byterover',
          providerApiKey: 'fresh-token',
          providerKeyMissing: false,
        }),
      } as unknown as ITransportClient

      const agent = new CipherAgent(agentConfig, undefined, {transportClient})

      try {
        await agent.start()
        agent.refreshProviderConfig({
          model: 'runtime-model',
          providerApiKey: 'runtime-token',
        })

        capturedConfigs.length = 0

        const taskSessionId = await agent.createTaskSession('task-runtime-model', 'curate', {userFacing: true})
        await agent.deleteTaskSession(taskSessionId)

        expect(capturedConfigs.some((config) => config.model === 'runtime-model')).to.equal(true)
        expect(capturedConfigs.some((config) => config.model === 'default')).to.equal(false)
      } finally {
        await agent.stop()
      }
    })
  })

  describe('agentic_map registry integration', () => {
    beforeEach(() => {
      _resetNestingRegistryForTests()
    })

    afterEach(() => {
      _resetNestingRegistryForTests()
    })

    it('createTaskSession with mapRootEligible registers root-eligible record', async () => {
      const agent = new CipherAgent(agentConfig)
      await agent.start()

      const taskSessionId = await agent.createTaskSession('task-1', 'curate', {mapRootEligible: true})
      const record = getNestingRecord(taskSessionId)
      expect(record).to.not.be.undefined
      expect(record!.isRootCaller).to.be.true
      expect(record!.nestingDepth).to.equal(0)

      await agent.deleteTaskSession(taskSessionId)
      expect(getNestingRecord(taskSessionId)).to.be.undefined
      await agent.stop()
    })

    it('createTaskSession without mapRootEligible does NOT register (default)', async () => {
      const agent = new CipherAgent(agentConfig)
      await agent.start()

      const taskSessionId = await agent.createTaskSession('task-2', 'query')
      const record = getNestingRecord(taskSessionId)
      expect(record).to.be.undefined

      await agent.deleteTaskSession(taskSessionId)
      await agent.stop()
    })
  })
})
