/**
 * AI SDK Content Generator
 *
 * Universal IContentGenerator adapter wrapping any AI SDK LanguageModel.
 * Replaces per-provider content generators with one unified implementation.
 */

import type {LanguageModel, ModelMessage} from 'ai'

import {generateText, streamText} from 'ai'

import type {
  GenerateContentChunk,
  GenerateContentRequest,
  GenerateContentResponse,
  IContentGenerator,
} from '../../../core/interfaces/i-content-generator.js'
import type {ToolCall} from '../../../core/interfaces/message-types.js'

import {StreamChunkType} from '../../../core/interfaces/i-content-generator.js'
import {createAbortContext, LlmRequestTimeoutError, withRequestTimeout} from './ai-sdk-abort-helper.js'
import {toAiSdkTools, toModelMessages} from './ai-sdk-message-converter.js'

const DEFAULT_CHARS_PER_TOKEN = 4

/**
 * Prepend the system prompt as a system-role message carrying
 * `providerOptions.anthropic.cacheControl: ephemeral`. AI SDK's top-level
 * `system: string` parameter does not propagate providerOptions, so the
 * only way to attach Anthropic cache_control to the system block is to
 * pass it through the messages array. Non-Anthropic providers ignore the
 * `anthropic` namespace.
 */
export function prependCachedSystemMessage(systemPrompt: string | undefined, messages: ModelMessage[]): ModelMessage[] {
  if (!systemPrompt) {
    return messages
  }

  const systemMessage: ModelMessage = {
    content: systemPrompt,
    providerOptions: {anthropic: {cacheControl: {type: 'ephemeral'}}},
    role: 'system',
  }

  return [systemMessage, ...messages]
}

/**
 * Configuration for AiSdkContentGenerator.
 */
export interface AiSdkContentGeneratorConfig {
  /** Characters per token ratio for token estimation */
  charsPerToken?: number
  /**
   * Drop the sampling request parameters (`temperature`, `top_p`, `top_k`)
   * before calling the model. Set when targeting models that reject these
   * (e.g. Claude Opus 4.7 returns 400 on any non-default value).
   */
  excludeSamplingParameters?: boolean
  /** AI SDK LanguageModel instance */
  model: LanguageModel
  /**
   * Per-request wall-clock timeout in milliseconds. When set, every
   * `generateContent` / `generateContentStream` call is bounded by an
   * `AbortSignal` that fires after this duration. A timer-driven abort
   * surfaces as `LlmRequestTimeoutError` (classified as retryable by
   * the retry layer). M3 sources this from the `llm.requestTimeoutMs`
   * setting; absent → no per-request abort.
   */
  requestTimeoutMs?: number
}

/**
 * Universal content generator that wraps any AI SDK LanguageModel.
 *
 * Implements IContentGenerator by delegating to the AI SDK's
 * generateText() and streamText() functions. This single adapter
 * replaces all per-provider content generators (Anthropic, OpenAI,
 * Google, OpenRouter) with one unified implementation.
 */
export class AiSdkContentGenerator implements IContentGenerator {
  private readonly charsPerToken: number
  private readonly excludeSamplingParameters: boolean
  private readonly model: LanguageModel
  private readonly requestTimeoutMs?: number

  constructor(config: AiSdkContentGeneratorConfig) {
    this.model = config.model
    this.charsPerToken = config.charsPerToken ?? DEFAULT_CHARS_PER_TOKEN
    this.excludeSamplingParameters = config.excludeSamplingParameters ?? false
    this.requestTimeoutMs = config.requestTimeoutMs
  }

  public estimateTokensSync(content: string): number {
    return Math.ceil(content.length / this.charsPerToken)
  }

  public async generateContent(request: GenerateContentRequest): Promise<GenerateContentResponse> {
    const messages = prependCachedSystemMessage(request.systemPrompt, toModelMessages(request.contents))
    const tools = toAiSdkTools(request.tools)

    const result = await withRequestTimeout(this.requestTimeoutMs, async (signal) =>
      generateText({
        maxOutputTokens: request.config.maxTokens,
        maxRetries: 0, // RetryableContentGenerator handles retries
        messages,
        model: this.model,
        ...this.buildSamplingParams(request.config),
        ...(tools && {tools}),
        ...(signal && {abortSignal: signal}),
      }),
    )

    // Map AI SDK tool calls to our ToolCall format
    // Preserve thoughtSignature from providerMetadata (required by Gemini 3+ models)
    const toolCalls: ToolCall[] = result.toolCalls.map((tc) => {
      const meta = tc.providerMetadata as Record<string, Record<string, unknown>> | undefined
      const thoughtSig = meta?.google?.thoughtSignature

      return {
        function: {
          arguments: JSON.stringify(tc.input),
          name: tc.toolName,
        },
        id: tc.toolCallId,
        ...(typeof thoughtSig === 'string' && {thoughtSignature: thoughtSig}),
        type: 'function' as const,
      }
    })

    return {
      content: result.text,
      finishReason: mapFinishReason(result.finishReason, toolCalls.length > 0),
      rawResponse: buildRawResponse({
        providerMetadata: result.providerMetadata,
        response: result.response,
        usage: result.usage,
      }),
      ...(result.reasoningText && {reasoning: result.reasoningText}),
      toolCalls: toolCalls.length > 0 ? toolCalls : undefined,
      usage: {
        completionTokens: result.usage.outputTokens ?? 0,
        promptTokens: result.usage.inputTokens ?? 0,
        totalTokens: result.usage.totalTokens ?? 0,
      },
    }
  }

  public async *generateContentStream(request: GenerateContentRequest): AsyncGenerator<GenerateContentChunk> {
    const messages = prependCachedSystemMessage(request.systemPrompt, toModelMessages(request.contents))
    const tools = toAiSdkTools(request.tools)
    const abort = createAbortContext(this.requestTimeoutMs)

    try {
      const result = streamText({
        maxOutputTokens: request.config.maxTokens,
        maxRetries: 0,
        messages,
        model: this.model,
        ...this.buildSamplingParams(request.config),
        ...(tools && {tools}),
        ...(abort.signal && {abortSignal: abort.signal}),
      })

      // Accumulate tool calls during streaming
      const pendingToolCalls: ToolCall[] = []

      for await (const event of result.fullStream) {
        // Every chunk is liveness — switch the abort timer from
        // total-deadline (the default) to idle-deadline so a slow local
        // model that streams steadily across minutes is not killed for
        // exceeding `requestTimeoutMs` while chunks are still arriving.
        abort.recordActivity()

        switch (event.type) {
          case 'error': {
            if (abort.didTimeout() && abort.timeoutMs !== undefined) {
              throw new LlmRequestTimeoutError(abort.timeoutMs)
            }

            // Throw the error so RetryableContentGenerator can catch and retry it.
            // Yielding it as content would swallow the error and prevent retry logic
            // from working (e.g., for 429 rate limit errors).
            throw event.error instanceof Error
              ? event.error
              : new Error(extractStreamErrorMessage(event.error))
          }

          case 'finish-step': {
            yield {
              finishReason: mapFinishReason(event.finishReason, pendingToolCalls.length > 0),
              isComplete: true,
              rawResponse: buildRawResponse({
                providerMetadata: event.providerMetadata,
                response: event.response,
                usage: event.usage,
              }),
              toolCalls: pendingToolCalls.length > 0 ? [...pendingToolCalls] : undefined,
            }

            break
          }

          case 'reasoning-delta': {
            yield {
              isComplete: false,
              reasoning: event.text,
              reasoningId: event.id,
              type: StreamChunkType.THINKING,
            }

            break
          }

          case 'text-delta': {
            yield {
              content: event.text,
              isComplete: false,
              type: StreamChunkType.CONTENT,
            }

            break
          }

          case 'tool-call': {
            // Preserve thoughtSignature from providerMetadata (required by Gemini 3+ models)
            const meta = event.providerMetadata as Record<string, Record<string, unknown>> | undefined
            const thoughtSig = meta?.google?.thoughtSignature
            pendingToolCalls.push({
              function: {
                arguments: JSON.stringify(event.input),
                name: event.toolName,
              },
              id: event.toolCallId,
              ...(typeof thoughtSig === 'string' && {thoughtSignature: thoughtSig}),
              type: 'function',
            })

            break
          }

          default: {
            // Ignore other events (tool-input-start/delta/end, source, file, etc.)
            break
          }
        }
      }
    } catch (error) {
      if (abort.didTimeout() && abort.timeoutMs !== undefined && !(error instanceof LlmRequestTimeoutError)) {
        throw new LlmRequestTimeoutError(abort.timeoutMs)
      }

      throw error
    } finally {
      abort.cleanup()
    }
  }

  /**
   * Build the sampling-parameter slice for an AI SDK request. Returns an
   * empty object when the model-level exclusion is set, so callers can spread
   * the result into the request payload without conditionally emitting fields.
   */
  private buildSamplingParams(config: GenerateContentRequest['config']): Record<string, number> {
    if (this.excludeSamplingParameters) return {}

    return {
      ...(config.temperature !== undefined && {temperature: config.temperature}),
      ...(config.topK !== undefined && {topK: config.topK}),
      ...(config.topP !== undefined && {topP: config.topP}),
    }
  }
}

/**
 * Extract a human-readable message from an AI SDK stream error.
 *
 * The @ai-sdk/openai Responses API provider passes the raw SSE chunk
 * object as the error value (not an Error instance). The actual message
 * is nested at `.error.message`.
 */
export function extractStreamErrorMessage(error: unknown): string {
  if (typeof error === 'string') {
    return error
  }

  if (error && typeof error === 'object') {
    // OpenAI Responses API shape: { type: "error", error: { message: "..." } }
    if ('error' in error) {
      const nested = (error as Record<string, unknown>).error
      if (nested && typeof nested === 'object' && 'message' in nested) {
        const msg = (nested as Record<string, unknown>).message
        if (typeof msg === 'string') {
          return msg
        }
      }
    }

    // Direct message property: { message: "..." }
    if ('message' in error) {
      const msg = (error as Record<string, unknown>).message
      if (typeof msg === 'string') {
        return msg
      }
    }

    try {
      return JSON.stringify(error)
    } catch {
      // circular reference or other stringify failure
    }
  }

  return String(error)
}

/**
 * Map AI SDK finish reason to our finish reason format.
 */
function mapFinishReason(aiReason: string, hasToolCalls: boolean): GenerateContentResponse['finishReason'] {
  if (hasToolCalls) {
    return 'tool_calls'
  }

  switch (aiReason) {
    case 'error': {
      return 'error'
    }

    case 'length': {
      return 'max_tokens'
    }

    case 'stop': {
      return 'stop'
    }

    case 'tool-calls': {
      return 'tool_calls'
    }

    default: {
      return 'stop'
    }
  }
}

/**
 * Build the `rawResponse` payload surfaced to the IContentGenerator decorator chain.
 *
 * AI SDK splits the per-call telemetry across three top-level fields on its `result`:
 * `result.usage` (normalized inputTokens/outputTokens/cachedInputTokens), `result.providerMetadata`
 * (provider-specific extras — Anthropic exposes cache-creation tokens here), and
 * `result.response` (request id, model id, headers). `pickRawUsage()` in the logging
 * decorator only inspects `rawResponse.usage`, so we fold the AI SDK's normalized
 * usage into a synthetic `usage` block on rawResponse and merge Anthropic's cache-creation
 * count into it. Other providers continue to populate only `cachedInputTokens` (cache reads).
 */
function buildRawResponse(parts: {
  providerMetadata: unknown
  response: unknown
  usage: {cachedInputTokens?: number | undefined; inputTokens: number | undefined; outputTokens: number | undefined; totalTokens: number | undefined}
}): Record<string, unknown> {
  const cacheCreation = readAnthropicCacheCreation(parts.providerMetadata)
  const usage: Record<string, unknown> = {
    ...parts.usage,
    ...(cacheCreation !== undefined && {cacheCreationTokens: cacheCreation}),
  }
  const responseObj = typeof parts.response === 'object' && parts.response !== null ? parts.response : {}
  return {
    ...responseObj,
    providerMetadata: parts.providerMetadata,
    usage,
  }
}

/**
 * Read Anthropic's `cacheCreationInputTokens` out of the AI SDK's providerMetadata
 * (typed as `ProviderMetadata = Record<string, Record<string, JSONValue>>` upstream).
 * Returns `undefined` for non-Anthropic calls or when the provider didn't set the field.
 */
function readAnthropicCacheCreation(providerMetadata: unknown): number | undefined {
  if (typeof providerMetadata !== 'object' || providerMetadata === null) return undefined
  const {anthropic} = providerMetadata as {anthropic?: unknown}
  if (typeof anthropic !== 'object' || anthropic === null) return undefined
  const {cacheCreationInputTokens} = anthropic as {cacheCreationInputTokens?: unknown}
  return typeof cacheCreationInputTokens === 'number' && Number.isFinite(cacheCreationInputTokens)
    ? cacheCreationInputTokens
    : undefined
}
