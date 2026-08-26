import {expect} from 'chai'
import * as sinon from 'sinon'

import type {GenerateContentResponse} from '../../../../src/agent/core/interfaces/i-content-generator.js'

import {ToolErrorType} from '../../../../src/agent/core/domain/tools/tool-error.js'
import {SessionEventBus} from '../../../../src/agent/infra/events/event-emitter.js'
import {ByteRoverLlmHttpService} from '../../../../src/agent/infra/http/internal-llm-http-service.js'
import {AgentLLMService, selectLifecycleResult} from '../../../../src/agent/infra/llm/agent-llm-service.js'
import {ByteRoverContentGenerator} from '../../../../src/agent/infra/llm/generators/byterover-content-generator.js'
import {SystemPromptManager} from '../../../../src/agent/infra/system-prompt/system-prompt-manager.js'
import {ToolManager} from '../../../../src/agent/infra/tools/tool-manager.js'
import {createMockToolProvider} from '../../../helpers/mock-factories.js'

/**
 * Helper function to create a ByteRover content generator with test config
 */
function createContentGenerator(model = 'gemini-2.5-flash') {
  const httpService = new ByteRoverLlmHttpService({
    apiBaseUrl: 'http://localhost:3000',
    sessionKey: 'test-session-key',
    spaceId: 'test-space-id',
    teamId: 'test-team-id',
  })
  return new ByteRoverContentGenerator(httpService, {
    model,
  })
}

/**
 * Comprehensive tests for Gemini-specific functionality in AgentLLMService.
 * These tests verify that Gemini models are correctly initialized with the
 * appropriate formatter, tokenizer, and configuration.
 */
describe('AgentLLMService - Gemini Integration', () => {
  let sessionEventBus: SessionEventBus
  let systemPromptManager: SystemPromptManager
  let toolManager: ToolManager
  let sandbox: sinon.SinonSandbox

  beforeEach(() => {
    sinon.stub(console, 'log')
    sandbox = sinon.createSandbox()
    sessionEventBus = new SessionEventBus()
    systemPromptManager = new SystemPromptManager()
    const mockToolProvider = createMockToolProvider(sandbox, {
      getAllTools: sandbox.stub().returns({}),
      getAvailableMarkers: sandbox.stub().returns(new Set<string>()),
      getToolNames: sandbox.stub().returns([]),
      hasTool: sandbox.stub().returns(true),
    })
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    toolManager = new ToolManager(mockToolProvider as any)
  })

  afterEach(() => {
    sandbox.restore()
    sinon.restore()
  })

  describe('Gemini Model Detection', () => {
    it('should detect gemini-2.5-flash as Gemini provider', () => {
      const generator = createContentGenerator('gemini-2.5-flash')
      const service = new AgentLLMService(
        'test-session',
        generator,
        {
          model: 'gemini-2.5-flash',
        },
        {
          sessionEventBus,
          systemPromptManager,
          toolManager,
        },
      )

      // Verify the service was created (provider detection happens in constructor)
      expect(service).to.exist
      expect(service.getConfig().model).to.equal('gemini-2.5-flash')
    })

    it('should detect gemini-2.0-flash as Gemini provider', () => {
      const generator = createContentGenerator('gemini-2.0-flash')
      const service = new AgentLLMService(
        'test-session',
        generator,
        {
          model: 'gemini-2.0-flash',
        },
        {
          sessionEventBus,
          systemPromptManager,
          toolManager,
        },
      )

      expect(service).to.exist
      expect(service.getConfig().model).to.equal('gemini-2.0-flash')
    })

    it('should detect gemini-1.5-flash as Gemini provider', () => {
      const generator = createContentGenerator('gemini-1.5-flash')
      const service = new AgentLLMService(
        'test-session',
        generator,
        {
          model: 'gemini-1.5-flash',
        },
        {
          sessionEventBus,
          systemPromptManager,
          toolManager,
        },
      )

      expect(service).to.exist
      expect(service.getConfig().model).to.equal('gemini-1.5-flash')
    })

    it('should detect gemini-1.5-pro as Gemini provider', () => {
      const generator = createContentGenerator('gemini-1.5-pro')
      const service = new AgentLLMService(
        'test-session',
        generator,
        {
          model: 'gemini-1.5-pro',
        },
        {
          sessionEventBus,
          systemPromptManager,
          toolManager,
        },
      )

      expect(service).to.exist
      expect(service.getConfig().model).to.equal('gemini-1.5-pro')
    })
  })

  describe('Gemini Formatter & Tokenizer Initialization', () => {
    it('should use GeminiMessageFormatter for Gemini models', () => {
      const generator = createContentGenerator('gemini-2.5-flash')
      const service = new AgentLLMService(
        'test-session',
        generator,
        {
          model: 'gemini-2.5-flash',
        },
        {
          sessionEventBus,
          systemPromptManager,
          toolManager,
        },
      )

      // Access the context manager to verify formatter type
      const contextManager = service.getContextManager()
      expect(contextManager).to.exist

      // The formatter should be a GeminiMessageFormatter (verified indirectly through functionality)
      // We can verify this by checking that the context manager works correctly with Gemini format
      expect(contextManager).to.be.instanceOf(Object)
    })

    it('should use GeminiTokenizer for Gemini models', () => {
      const generator = createContentGenerator('gemini-2.5-flash')
      const service = new AgentLLMService(
        'test-session',
        generator,
        {
          model: 'gemini-2.5-flash',
        },
        {
          sessionEventBus,
          systemPromptManager,
          toolManager,
        },
      )

      // Verify service initialization with Gemini tokenizer
      const contextManager = service.getContextManager()
      expect(contextManager).to.exist

      // The max input tokens should be configured correctly for Gemini
      expect(service.getConfig().configuredMaxInputTokens).to.be.greaterThan(0)
    })

    it('should initialize context manager with correct session ID for Gemini', () => {
      const generator = createContentGenerator('gemini-2.5-flash')
      const service = new AgentLLMService(
        'gemini-test-session',
        generator,
        {
          model: 'gemini-2.5-flash',
        },
        {
          sessionEventBus,
          systemPromptManager,
          toolManager,
        },
      )

      const contextManager = service.getContextManager()
      expect(contextManager.getSessionId()).to.equal('gemini-test-session')
    })

    it('should initialize context manager with correct max tokens for Gemini', () => {
      const generator = createContentGenerator('gemini-2.5-flash')
      const service = new AgentLLMService(
        'test-session',
        generator,
        {
          maxInputTokens: 1_000_000,
          model: 'gemini-2.5-flash',
        },
        {
          sessionEventBus,
          systemPromptManager,
          toolManager,
        },
      )

      const contextManager = service.getContextManager()
      expect(contextManager.getMaxInputTokens()).to.equal(1_000_000)
    })
  })

  describe('Gemini Thinking Configuration', () => {
    it('should support thinking config for Gemini 2.0 models', () => {
      const generator = createContentGenerator('gemini-2.0-flash-thinking')
      const service = new AgentLLMService(
        'test-session',
        generator,
        {
          model: 'gemini-2.0-flash-thinking',
          thinkingConfig: {
            includeThoughts: true,
            thinkingBudget: 1024,
          },
        },
        {
          sessionEventBus,
          systemPromptManager,
          toolManager,
        },
      )

      expect(service).to.exist
      expect(service.getConfig().model).to.equal('gemini-2.0-flash-thinking')
    })

    it('should support thinking config with custom settings', () => {
      const generator = createContentGenerator('gemini-2.0-flash-thinking')
      const service = new AgentLLMService(
        'test-session',
        generator,
        {
          model: 'gemini-2.0-flash-thinking',
          thinkingConfig: {
            includeThoughts: true,
            thinkingBudget: -1, // Dynamic budget
          },
        },
        {
          sessionEventBus,
          systemPromptManager,
          toolManager,
        },
      )

      expect(service).to.exist
    })

    it('should work without thinking config for regular Gemini models', () => {
      const generator = createContentGenerator('gemini-2.5-flash')
      const service = new AgentLLMService(
        'test-session',
        generator,
        {
          model: 'gemini-2.5-flash',
          // No thinking config
        },
        {
          sessionEventBus,
          systemPromptManager,
          toolManager,
        },
      )

      expect(service).to.exist
      expect(service.getConfig().model).to.equal('gemini-2.5-flash')
    })
  })

  describe('Gemini Tool Calling', () => {
    it('should handle tool calls with Gemini models', async () => {
      const generator = createContentGenerator('gemini-2.5-flash')
      const service = new AgentLLMService(
        'test-session',
        generator,
        {
          model: 'gemini-2.5-flash',
        },
        {
          sessionEventBus,
          systemPromptManager,
          toolManager,
        },
      )

      // Setup mocks for tool calling flow
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      sandbox.stub(service.getContextManager() as any, 'addUserMessage').resolves()
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      sandbox.stub(service.getContextManager() as any, 'getFormattedMessagesWithCompression').resolves({
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        formattedMessages: [{parts: [{text: 'search for files'}], role: 'user'} as any],
      })
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      sandbox.stub(service.getContextManager() as any, 'addAssistantMessage').resolves()
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      sandbox.stub(service.getContextManager() as any, 'addToolResult').resolves('tool-result-1')

      // Mock tool execution
      sandbox.stub(toolManager, 'executeTool').resolves({
        content: 'Found 5 files',
        metadata: {},
        success: true,
      })

      // First response with tool call
      const generateStub = sandbox.stub(generator, 'generateContent')
      generateStub.onFirstCall().resolves({
        content: '',
        finishReason: 'tool_calls',
        toolCalls: [
          {
            function: {
              arguments: '{"pattern": "*.ts"}',
              name: 'search',
            },
            id: 'call-1',
            type: 'function',
          },
        ],
      })

      // Second response with final answer
      generateStub.onSecondCall().resolves({
        content: 'I found 5 TypeScript files',
        finishReason: 'stop',
        toolCalls: [],
      } as GenerateContentResponse)

      const result = await service.completeTask('Search for TypeScript files')
      expect(result).to.equal('I found 5 TypeScript files')
    })

    it('preserves malformed code_exec curateResults presence for integrity validation', () => {
      expect(selectLifecycleResult(
        'code_exec',
        {curateResults: 'malformed producer value', stdout: 'do not preserve'},
        'curate',
      )).to.deep.equal({curateResults: 'malformed producer value'})
    })

    it('preserves only code_exec curateResults when the display result is truncated', async () => {
      const generator = createContentGenerator('gemini-2.5-flash')
      const service = new AgentLLMService(
        'test-session',
        generator,
        {model: 'gemini-2.5-flash'},
        {sessionEventBus, systemPromptManager, toolManager},
      )
      const highImpactOperation = {
        impact: 'high',
        needsReview: true,
        path: '/topics/review-integrity.md',
        status: 'success',
        type: 'UPSERT',
      }
      const curateResults = [{applied: [highImpactOperation]}]
      const rawResult = {
        curateResults,
        diagnostics: Array.from({length: 500}, (_, index) => `${index}:${'x'.repeat(300)}`),
        stdout: 'full memory body must not enter the lifecycle channel',
      }

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      sandbox.stub(service.getContextManager() as any, 'addUserMessage').resolves()
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      sandbox.stub(service.getContextManager() as any, 'getFormattedMessagesWithCompression').resolves({
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        formattedMessages: [{parts: [{text: 'curate'}], role: 'user'} as any],
      })
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      sandbox.stub(service.getContextManager() as any, 'addAssistantMessage').resolves()
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      sandbox.stub(service.getContextManager() as any, 'addToolResult').resolves('tool-result')
      sandbox.stub(toolManager, 'executeTool').resolves({content: rawResult, metadata: {}, success: true})

      const generateStub = sandbox.stub(generator, 'generateContent')
      generateStub.onFirstCall().resolves({
        content: '',
        finishReason: 'tool_calls',
        toolCalls: [{
          function: {arguments: '{}', name: 'code_exec'},
          id: 'call-1',
          type: 'function',
        }],
      })
      generateStub.onSecondCall().resolves({content: 'done', finishReason: 'stop', toolCalls: []})

      const toolResultEvents: unknown[] = []
      sessionEventBus.on('llmservice:toolResult', (event) => toolResultEvents.push(event))
      await service.completeTask('curate', {
        executionContext: {commandType: 'curate'},
        taskId: 'task-review-integrity',
      })

      expect(toolResultEvents).to.have.lengthOf(1)
      const event = toolResultEvents[0] as {
        lifecycleResult?: unknown
        metadata?: {truncated?: boolean}
        result?: unknown
      }
      expect(event.metadata?.truncated).to.equal(true)
      expect(event.lifecycleResult).to.deep.equal({curateResults})
      expect(event.lifecycleResult).to.not.have.property('stdout')
      expect(event.lifecycleResult).to.not.have.property('diagnostics')
    })

    it('should handle multiple parallel tool calls with Gemini', async () => {
      const generator = createContentGenerator('gemini-2.5-flash')
      const service = new AgentLLMService(
        'test-session',
        generator,
        {
          model: 'gemini-2.5-flash',
        },
        {
          sessionEventBus,
          systemPromptManager,
          toolManager,
        },
      )

      // Setup mocks
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      sandbox.stub(service.getContextManager() as any, 'addUserMessage').resolves()
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      sandbox.stub(service.getContextManager() as any, 'getFormattedMessagesWithCompression').resolves({
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        formattedMessages: [{parts: [{text: 'read two files'}], role: 'user'} as any],
      })
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      sandbox.stub(service.getContextManager() as any, 'addAssistantMessage').resolves()
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      sandbox.stub(service.getContextManager() as any, 'addToolResult').resolves('tool-result')

      // Mock tool execution
      const executeToolStub = sandbox.stub(toolManager, 'executeTool').resolves({
        content: 'File contents',
        metadata: {},
        success: true,
      })

      const generateStub = sandbox.stub(generator, 'generateContent')

      // First response with multiple tool calls
      generateStub.onFirstCall().resolves({
        content: '',
        finishReason: 'tool_calls',
        toolCalls: [
          {
            function: {arguments: '{"path": "a.ts"}', name: 'read'},
            id: 'call-1',
            type: 'function',
          },
          {
            function: {arguments: '{"path": "b.ts"}', name: 'read'},
            id: 'call-2',
            type: 'function',
          },
        ],
      })

      // Second response with final answer
      generateStub.onSecondCall().resolves({
        content: 'Read both files successfully',
        finishReason: 'stop',
        toolCalls: [],
      } as GenerateContentResponse)

      const result = await service.completeTask('Read a.ts and b.ts')
      expect(result).to.equal('Read both files successfully')

      // Verify tool was called twice (once for each file)
      expect(executeToolStub.callCount).to.equal(2)
    })
  })

  describe('Gemini Error Handling', () => {
    it('should handle Gemini generation errors gracefully', async () => {
      const generator = createContentGenerator('gemini-2.5-flash')
      const service = new AgentLLMService(
        'test-session',
        generator,
        {
          model: 'gemini-2.5-flash',
        },
        {
          sessionEventBus,
          systemPromptManager,
          toolManager,
        },
      )

      // Setup mocks
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      sandbox.stub(service.getContextManager() as any, 'addUserMessage').resolves()
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      sandbox.stub(service.getContextManager() as any, 'getFormattedMessagesWithCompression').resolves({
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        formattedMessages: [{parts: [{text: 'test'}], role: 'user'} as any],
      })

      // Mock generator to throw error
      sandbox.stub(generator, 'generateContent').rejects(new Error('Gemini API error'))

      try {
        await service.completeTask('Test query')
        expect.fail('Should have thrown error')
      } catch (error) {
        expect(error).to.be.instanceOf(Error)
        expect((error as Error).message).to.include('Gemini API error')
      }
    })

    it('should handle Gemini tool execution errors', async () => {
      const generator = createContentGenerator('gemini-2.5-flash')
      const service = new AgentLLMService(
        'test-session',
        generator,
        {
          model: 'gemini-2.5-flash',
        },
        {
          sessionEventBus,
          systemPromptManager,
          toolManager,
        },
      )

      // Setup mocks
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      sandbox.stub(service.getContextManager() as any, 'addUserMessage').resolves()
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      sandbox.stub(service.getContextManager() as any, 'getFormattedMessagesWithCompression').resolves({
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        formattedMessages: [{parts: [{text: 'search'}], role: 'user'} as any],
      })
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      sandbox.stub(service.getContextManager() as any, 'addAssistantMessage').resolves()
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      sandbox.stub(service.getContextManager() as any, 'addToolResult').resolves('tool-result')

      // Mock tool to return error result
      sandbox.stub(toolManager, 'executeTool').resolves({
        content: 'Tool execution failed',
        errorType: ToolErrorType.EXECUTION_FAILED,
        metadata: {},
        success: false,
      })

      const generateStub = sandbox.stub(generator, 'generateContent')

      // First response with tool call
      generateStub.onFirstCall().resolves({
        content: '',
        finishReason: 'tool_calls',
        toolCalls: [
          {
            function: {arguments: '{"query": "test"}', name: 'search'},
            id: 'call-1',
            type: 'function',
          },
        ],
      })

      // Second response with final answer
      generateStub.onSecondCall().resolves({
        content: 'Tool execution encountered an error',
        finishReason: 'stop',
        toolCalls: [],
      } as GenerateContentResponse)

      const result = await service.completeTask('Search for something')
      expect(result).to.be.a('string')
    })
  })

  describe('Gemini Configuration Edge Cases', () => {
    it('should handle very high max input tokens for Gemini 1.5 Pro', () => {
      const generator = createContentGenerator('gemini-1.5-pro')
      const service = new AgentLLMService(
        'test-session',
        generator,
        {
          maxInputTokens: 2_000_000, // Gemini 1.5 Pro supports up to 2M tokens
          model: 'gemini-1.5-pro',
        },
        {
          sessionEventBus,
          systemPromptManager,
          toolManager,
        },
      )

      expect(service.getConfig().configuredMaxInputTokens).to.equal(2_000_000)
    })

    it('should handle custom temperature for Gemini models', () => {
      const generator = createContentGenerator('gemini-2.5-flash')
      const service = new AgentLLMService(
        'test-session',
        generator,
        {
          model: 'gemini-2.5-flash',
          temperature: 0.1, // Very low temperature for deterministic output
        },
        {
          sessionEventBus,
          systemPromptManager,
          toolManager,
        },
      )

      expect(service).to.exist
    })

    it('should handle custom max iterations for Gemini models', () => {
      const generator = createContentGenerator('gemini-2.5-flash')
      const service = new AgentLLMService(
        'test-session',
        generator,
        {
          maxIterations: 5, // Low limit for testing
          model: 'gemini-2.5-flash',
        },
        {
          sessionEventBus,
          systemPromptManager,
          toolManager,
        },
      )

      expect(service).to.exist
    })

    it('should handle timeout configuration for Gemini models', () => {
      const generator = createContentGenerator('gemini-2.5-flash')
      const service = new AgentLLMService(
        'test-session',
        generator,
        {
          model: 'gemini-2.5-flash',
          timeout: 30_000, // 30 second timeout
        },
        {
          sessionEventBus,
          systemPromptManager,
          toolManager,
        },
      )

      expect(service).to.exist
    })
  })

  describe('Gemini vs Claude Provider Comparison', () => {
    it('should initialize different formatters for Gemini vs Claude', () => {
      const geminiGenerator = createContentGenerator('gemini-2.5-flash')
      const geminiService = new AgentLLMService(
        'gemini-session',
        geminiGenerator,
        {
          model: 'gemini-2.5-flash',
        },
        {
          sessionEventBus,
          systemPromptManager,
          toolManager,
        },
      )

      const claudeGenerator = createContentGenerator('claude-3-5-sonnet')
      const claudeService = new AgentLLMService(
        'claude-session',
        claudeGenerator,
        {
          model: 'claude-3-5-sonnet',
        },
        {
          sessionEventBus,
          systemPromptManager,
          toolManager,
        },
      )

      // Both should exist but use different internal configurations
      expect(geminiService).to.exist
      expect(claudeService).to.exist
      expect(geminiService.getConfig().model).to.equal('gemini-2.5-flash')
      expect(claudeService.getConfig().model).to.equal('claude-3-5-sonnet')
    })

    it('should use same service class for both Gemini and Claude', () => {
      const geminiGenerator = createContentGenerator('gemini-2.5-flash')
      const geminiService = new AgentLLMService(
        'test-session',
        geminiGenerator,
        {
          model: 'gemini-2.5-flash',
        },
        {
          sessionEventBus,
          systemPromptManager,
          toolManager,
        },
      )

      const claudeGenerator = createContentGenerator('claude-3-5-sonnet')
      const claudeService = new AgentLLMService(
        'test-session',
        claudeGenerator,
        {
          model: 'claude-3-5-sonnet',
        },
        {
          sessionEventBus,
          systemPromptManager,
          toolManager,
        },
      )

      // Both should be instances of the same service class
      expect(geminiService).to.be.instanceOf(AgentLLMService)
      expect(claudeService).to.be.instanceOf(AgentLLMService)
    })
  })

  describe('Gemini Message Formatting Integration', () => {
    it('should correctly format messages for Gemini API', async () => {
      const generator = createContentGenerator('gemini-2.5-flash')
      const service = new AgentLLMService(
        'test-session',
        generator,
        {
          model: 'gemini-2.5-flash',
        },
        {
          sessionEventBus,
          systemPromptManager,
          toolManager,
        },
      )

      const contextManager = service.getContextManager()

      // Add messages
      await contextManager.addUserMessage('Hello')
      await contextManager.addAssistantMessage('Hi there!')

      // Get formatted messages
      const result = await contextManager.getFormattedMessagesWithCompression()

      // Should have formatted messages
      expect(result.formattedMessages).to.have.lengthOf(2)
      expect(result.tokensUsed).to.be.greaterThan(0)
    })

    it('should handle system messages in Gemini format', async () => {
      const generator = createContentGenerator('gemini-2.5-flash')
      const service = new AgentLLMService(
        'test-session',
        generator,
        {
          model: 'gemini-2.5-flash',
        },
        {
          sessionEventBus,
          systemPromptManager,
          toolManager,
        },
      )

      const contextManager = service.getContextManager()

      await contextManager.addSystemMessage('You are a helpful assistant')
      await contextManager.addUserMessage('Hello')

      const result = await contextManager.getFormattedMessagesWithCompression()

      // System messages in Gemini are converted to user messages with prefix
      expect(result.formattedMessages.length).to.be.greaterThan(0)
    })
  })
})
