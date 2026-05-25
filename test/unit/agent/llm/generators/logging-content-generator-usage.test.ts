/* eslint-disable camelcase */
// Test fixtures intentionally use the snake_case wire format from
// Anthropic / OpenAI responses (see CLAUDE.md "Snake_case APIs").

import {expect} from 'chai'

import type {
  GenerateContentChunk,
  GenerateContentRequest,
  GenerateContentResponse,
  IContentGenerator,
} from '../../../../../src/agent/core/interfaces/i-content-generator.js'

import {SessionEventBus} from '../../../../../src/agent/infra/events/event-emitter.js'
import {LoggingContentGenerator} from '../../../../../src/agent/infra/llm/generators/logging-content-generator.js'

class FakeInnerGenerator implements IContentGenerator {
  constructor(private readonly response: GenerateContentResponse) {}

  estimateTokensSync(content: string): number {
    return content.length
  }

  async generateContent(_request: GenerateContentRequest): Promise<GenerateContentResponse> {
    return this.response
  }

  async *generateContentStream(_request: GenerateContentRequest): AsyncGenerator<GenerateContentChunk> {
    yield {isComplete: true}
  }
}

function makeRequest(overrides: Partial<GenerateContentRequest> = {}): GenerateContentRequest {
  return {
    config: {},
    contents: [],
    model: 'claude-3-5-sonnet-20241022',
    taskId: 'task-test',
    ...overrides,
  }
}

describe('LoggingContentGenerator — llmservice:usage emission (ENG-2741)', () => {
  it('emits llmservice:usage with canonical M1 fields on Anthropic raw response', async () => {
    const inner = new FakeInnerGenerator({
      content: 'response',
      finishReason: 'stop',
      rawResponse: {
        usage: {
          cache_creation_input_tokens: 50,
          cache_read_input_tokens: 200,
          input_tokens: 1000,
          output_tokens: 250,
        },
      },
    })
    const eventBus = new SessionEventBus()
    const captured: unknown[] = []
    eventBus.on('llmservice:usage', (payload) => {
      captured.push(payload)
    })

    const generator = new LoggingContentGenerator(inner, eventBus)
    await generator.generateContent(makeRequest())

    expect(captured).to.have.lengthOf(1)
    const payload = captured[0] as {
      cacheCreationTokens?: number
      cachedInputTokens?: number
      durationMs: number
      inputTokens: number
      model: string
      outputTokens: number
      taskId?: string
    }
    expect(payload.inputTokens).to.equal(1000)
    expect(payload.outputTokens).to.equal(250)
    expect(payload.cachedInputTokens).to.equal(200)
    expect(payload.cacheCreationTokens).to.equal(50)
    expect(payload.model).to.equal('claude-3-5-sonnet-20241022')
    expect(payload.taskId).to.equal('task-test')
    expect(payload.durationMs).to.be.a('number')
    expect(payload.durationMs).to.be.at.least(0)
  })

  it('emits llmservice:usage with canonical M1 fields on OpenAI raw response', async () => {
    const inner = new FakeInnerGenerator({
      content: 'response',
      finishReason: 'stop',
      rawResponse: {
        usage: {
          completion_tokens: 250,
          prompt_tokens: 1000,
          prompt_tokens_details: {cached_tokens: 200},
        },
      },
    })
    const eventBus = new SessionEventBus()
    const captured: unknown[] = []
    eventBus.on('llmservice:usage', (payload) => {
      captured.push(payload)
    })

    const generator = new LoggingContentGenerator(inner, eventBus)
    await generator.generateContent(makeRequest({model: 'gpt-4o'}))

    expect(captured).to.have.lengthOf(1)
    const payload = captured[0] as {cachedInputTokens?: number; inputTokens: number; outputTokens: number}
    expect(payload.inputTokens).to.equal(1000)
    expect(payload.outputTokens).to.equal(250)
    expect(payload.cachedInputTokens).to.equal(200)
  })

  it('emits llmservice:usage on Gemini usageMetadata', async () => {
    const inner = new FakeInnerGenerator({
      content: 'response',
      finishReason: 'stop',
      rawResponse: {
        usageMetadata: {
          cachedContentTokenCount: 200,
          candidatesTokenCount: 250,
          promptTokenCount: 1000,
        },
      },
    })
    const eventBus = new SessionEventBus()
    const captured: unknown[] = []
    eventBus.on('llmservice:usage', (payload) => {
      captured.push(payload)
    })

    const generator = new LoggingContentGenerator(inner, eventBus)
    await generator.generateContent(makeRequest({model: 'gemini-2.5-flash'}))

    expect(captured).to.have.lengthOf(1)
    const payload = captured[0] as {cachedInputTokens?: number; inputTokens: number; outputTokens: number}
    expect(payload.inputTokens).to.equal(1000)
    expect(payload.outputTokens).to.equal(250)
    expect(payload.cachedInputTokens).to.equal(200)
  })

  it('does not emit when rawResponse is missing or malformed', async () => {
    const inner = new FakeInnerGenerator({
      content: 'response',
      finishReason: 'stop',
    })
    const eventBus = new SessionEventBus()
    const captured: unknown[] = []
    eventBus.on('llmservice:usage', (payload) => {
      captured.push(payload)
    })

    const generator = new LoggingContentGenerator(inner, eventBus)
    await generator.generateContent(makeRequest())

    expect(captured).to.have.lengthOf(0)
  })

  it('does not emit when no eventBus is provided', async () => {
    const inner = new FakeInnerGenerator({
      content: 'response',
      finishReason: 'stop',
      rawResponse: {usage: {input_tokens: 1, output_tokens: 1}},
    })

    const generator = new LoggingContentGenerator(inner)
    // Should not throw — eventBus is optional
    await generator.generateContent(makeRequest())
  })

  describe('streaming path', () => {
    class StreamingFakeGenerator implements IContentGenerator {
      constructor(private readonly chunks: GenerateContentChunk[]) {}

      estimateTokensSync(content: string): number {
        return content.length
      }

      async generateContent(): Promise<GenerateContentResponse> {
        return {content: '', finishReason: 'stop'}
      }

      async *generateContentStream(): AsyncGenerator<GenerateContentChunk> {
        for (const chunk of this.chunks) {
          yield chunk
        }
      }
    }

    it('emits llmservice:usage when terminating stream chunk carries rawResponse', async () => {
      const inner = new StreamingFakeGenerator([
        {content: 'partial', isComplete: false},
        {
          finishReason: 'stop',
          isComplete: true,
          rawResponse: {
            usage: {
              cacheCreationTokens: 50,
              cachedInputTokens: 200,
              inputTokens: 1000,
              outputTokens: 250,
            },
          },
        },
      ])
      const eventBus = new SessionEventBus()
      const captured: unknown[] = []
      eventBus.on('llmservice:usage', (payload) => captured.push(payload))

      const generator = new LoggingContentGenerator(inner, eventBus)
      // Drain the stream — emission happens after the loop exits.
      // Drain the stream — emission happens after the loop exits.
      // eslint-disable-next-line @typescript-eslint/no-unused-vars, no-empty
      for await (const _chunk of generator.generateContentStream(makeRequest())) {}

      expect(captured).to.have.lengthOf(1)
      const payload = captured[0] as {
        cacheCreationTokens?: number
        cachedInputTokens?: number
        inputTokens: number
        outputTokens: number
        taskId?: string
      }
      expect(payload.inputTokens).to.equal(1000)
      expect(payload.outputTokens).to.equal(250)
      expect(payload.cachedInputTokens).to.equal(200)
      expect(payload.cacheCreationTokens).to.equal(50)
      expect(payload.taskId).to.equal('task-test')
    })

    it('does not emit when streaming chunks never carry rawResponse', async () => {
      const inner = new StreamingFakeGenerator([
        {content: 'partial', isComplete: false},
        {finishReason: 'stop', isComplete: true},
      ])
      const eventBus = new SessionEventBus()
      const captured: unknown[] = []
      eventBus.on('llmservice:usage', (payload) => captured.push(payload))

      const generator = new LoggingContentGenerator(inner, eventBus)
      // Drain the stream — emission happens after the loop exits.
      // eslint-disable-next-line @typescript-eslint/no-unused-vars, no-empty
      for await (const _chunk of generator.generateContentStream(makeRequest())) {}

      expect(captured).to.have.lengthOf(0)
    })
  })
})
