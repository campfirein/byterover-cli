import {expect} from 'chai'

import {
  ChatSession,
  IChatSession,
  ILLMService,
  LLMError,
  LLMResponse,
  MaxIterationsExceededError,
  Message,
  MessageRole,
  SessionCancelledError,
  SessionConfig,
  SessionError,
  SessionManager,
  SessionNotInitializedError,
  ToolCall,
} from '../../../../src/agent/infra/session/index.js'

describe('Session index exports', () => {
  describe('Error exports', () => {
    it('should export LLMError', () => {
      expect(LLMError).to.exist
      expect(LLMError.name).to.equal('LLMError')
    })

    it('should export SessionCancelledError', () => {
      expect(SessionCancelledError).to.exist
      expect(SessionCancelledError.name).to.equal('SessionCancelledError')
    })

    it('should export SessionError', () => {
      expect(SessionError).to.exist
      expect(SessionError.name).to.equal('SessionError')
    })

    it('should export MaxIterationsExceededError', () => {
      expect(MaxIterationsExceededError).to.exist
      expect(MaxIterationsExceededError.name).to.equal('MaxIterationsExceededError')
    })

    it('should export SessionNotInitializedError', () => {
      expect(SessionNotInitializedError).to.exist
      expect(SessionNotInitializedError.name).to.equal('SessionNotInitializedError')
    })
  })

  describe('Type exports', () => {
    it('should export Message type', () => {
      // Type check - if this compiles, the type is exported
      const message: Message = {
        content: 'test',
        role: 'user',
      }
      expect(message).to.exist
    })

    it('should export MessageRole type', () => {
      // Type check
      const role: MessageRole = 'user'
      expect(role).to.equal('user')
    })

    it('should export LLMResponse type', () => {
      // Type check
      const response: LLMResponse = {
        content: 'response',
      }
      expect(response).to.exist
    })

    it('should export SessionConfig type', () => {
      // Type check
      const config: SessionConfig = {
        maxToolIterations: 10,
      }
      expect(config).to.exist
    })

    it('should export ToolCall type', () => {
      // Type check
      const toolCall: ToolCall = {
        arguments: {},
        id: 'call-1',
        name: 'testTool',
      }
      expect(toolCall).to.exist
    })
  })

  describe('Interface exports', () => {
    it('should export IChatSession interface', () => {
      // Type check - if this compiles, the interface is exported
      const session: IChatSession = {
        cancel() {
          return false
        },
        cleanup() {},
        dispose() {},
        getHistory() {
          return []
        },
        getLLMService() {
          return {} as ILLMService
        },
        getMessageCount() {
          return 0
        },
        id: 'test',
        async reset() {},
        async run() {
          return 'response'
        },
        async sendMessage() {
          return 'response'
        },
        async streamRun() {},
      }
      expect(session).to.exist
    })

    it('should export ILLMService interface', () => {
      // Type check
      // Type check - if this compiles, the interface is exported
      const service: ILLMService = {
        async completeTask(_textInput: string, _options?: object) {
          return 'response'
        },
        async getAllTools() {
          return {}
        },
        getConfig: () => ({
          configuredMaxInputTokens: 1000,
          maxInputTokens: 1000,
          maxOutputTokens: 1000,
          model: 'test',
          modelMaxInputTokens: 1000,
          provider: 'test',
          router: 'test',
        }),
        getContextManager: () => ({}) as ReturnType<ILLMService['getContextManager']>,
      }
      expect(service).to.exist
    })
  })

  describe('Class exports', () => {
    it('should export ChatSession class', () => {
      expect(ChatSession).to.exist
      expect(ChatSession).to.be.a('function')
    })

    it('should export SessionManager class', () => {
      expect(SessionManager).to.exist
      expect(SessionManager).to.be.a('function')
    })
  })

  describe('Export completeness', () => {
    it('should export all 5 errors', () => {
      const errors = [
        LLMError,
        SessionCancelledError,
        SessionError,
        MaxIterationsExceededError,
        SessionNotInitializedError,
      ]
      expect(errors).to.have.length(5)
    })

    it('should export all 5 types', () => {
      // Types are checked above via type annotations
      // Cannot test types as values, but compilation ensures they exist
      const message: Message = {content: 'test', role: 'user'}
      const role: MessageRole = 'user'
      const response: LLMResponse = {content: 'test'}
      const config: SessionConfig = {}
      const toolCall: ToolCall = {arguments: {}, id: '1', name: 'test'}
      expect(message).to.exist
      expect(role).to.exist
      expect(response).to.exist
      expect(config).to.exist
      expect(toolCall).to.exist
    })

    it('should export all 2 interfaces', () => {
      // Interfaces are checked above via type annotations
      // Cannot test interfaces as values, but compilation ensures they exist
      const session: IChatSession = {
        cancel() {
          return false
        },
        cleanup() {},
        dispose() {},
        getHistory() {
          return []
        },
        getLLMService() {
          return {} as ILLMService
        },
        getMessageCount() {
          return 0
        },
        id: 'test',
        async reset() {},
        async run() {
          return 'response'
        },
        async sendMessage() {
          return 'response'
        },
        async streamRun() {},
      }
      const service: ILLMService = {
        async completeTask(_textInput: string, _options?: object) {
          return 'response'
        },
        async getAllTools() {
          return {}
        },
        getConfig: () => ({
          configuredMaxInputTokens: 1000,
          maxInputTokens: 1000,
          maxOutputTokens: 1000,
          model: 'test',
          modelMaxInputTokens: 1000,
          provider: 'test',
          router: 'test',
        }),
        getContextManager: () => ({}) as ReturnType<ILLMService['getContextManager']>,
      }
      expect(session).to.exist
      expect(service).to.exist
    })

    it('should export all 2 classes', () => {
      expect(ChatSession).to.exist
      expect(SessionManager).to.exist
    })
  })
})
