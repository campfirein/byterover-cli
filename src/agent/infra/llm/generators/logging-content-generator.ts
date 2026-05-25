/**
 * Logging Content Generator Decorator.
 *
 * Wraps any IContentGenerator to add debug logging capabilities.
 * Logs request/response metadata, timing, and errors. Emits
 * `llmservice:usage` after every successful call with canonical M1
 * token usage extracted from the response .
 */

import type {
  GenerateContentChunk,
  GenerateContentRequest,
  GenerateContentResponse,
  IContentGenerator,
} from '../../../core/interfaces/i-content-generator.js'
import type {SessionEventBus} from '../../events/event-emitter.js'

import {extractUsage, type ProviderType} from '../usage-extractor.js'

/**
 * Order matters only for tie-breaking; raw shapes don't overlap across providers.
 * Mirrors the {@link ProviderType} union in `usage-extractor.ts` — keep in sync if
 * a new provider is added to the discriminator there.
 *
 * In production all live LLM traffic flows through `AiSdkContentGenerator`,
 * which folds `result.usage` (+ Anthropic's `providerMetadata.cacheCreationInputTokens`)
 * into the rawResponse shape that the `'aiSdk'` discriminator matches. The
 * `'anthropic' / 'openai' / 'google'` branches are defensive shims for any
 * future direct-provider adapter that bypasses the AI SDK and emits a native
 * SDK shape on rawResponse — don't infer from the iteration order that live
 * traffic flows through them first.
 */
const PROVIDER_TYPES: readonly ProviderType[] = ['anthropic', 'openai', 'google', 'aiSdk']

/**
 * Logging options for the decorator.
 */
export interface LoggingOptions {
  /** Log individual streaming chunks */
  logChunks?: boolean
  /** Log request details */
  logRequests?: boolean
  /** Log response details */
  logResponses?: boolean
  /** Enable verbose logging (all options) */
  verbose?: boolean
}

/**
 * Logging Content Generator.
 *
 * Decorator that wraps any IContentGenerator to add logging capabilities.
 * Useful for debugging, monitoring, and performance analysis.
 *
 * Features:
 * - Request/response logging with configurable verbosity
 * - Timing information for all operations
 * - Error logging with context
 * - Event emission via SessionEventBus
 */
export class LoggingContentGenerator implements IContentGenerator {
  private readonly eventBus?: SessionEventBus
  private readonly inner: IContentGenerator
  private readonly options: LoggingOptions

  /**
   * Create a new Logging Content Generator.
   *
   * @param inner - The wrapped content generator
   * @param eventBus - Optional event bus for emitting events
   * @param options - Logging options
   */
  constructor(
    inner: IContentGenerator,
    eventBus?: SessionEventBus,
    options: LoggingOptions = {},
  ) {
    this.inner = inner
    this.eventBus = eventBus
    this.options = options
  }

  /**
   * Estimate tokens (delegates to inner generator).
   *
   * @param content - Text to estimate tokens for
   * @returns Estimated token count
   */
  public estimateTokensSync(content: string): number {
    return this.inner.estimateTokensSync(content)
  }

  /**
   * Generate content with logging.
   *
   * @param request - Generation request
   * @returns Generated content response
   */
  public async generateContent(request: GenerateContentRequest): Promise<GenerateContentResponse> {
    const startTime = Date.now()
    const requestId = this.generateRequestId()

    this.logRequest(requestId, request)
    this.eventBus?.emit('llmservice:thinking')

    try {
      const response = await this.inner.generateContent(request)
      // Telemetry must never break the response. A throw inside emitUsage
      // (e.g., a misbehaving event listener) would otherwise be caught by
      // the outer catch and reported as an LLM error.
      try {
        this.emitUsage(request, response.rawResponse, Date.now() - startTime)
      } catch {
        // Best-effort — swallow any telemetry-side failure.
      }

      return response
    } catch (error) {
      this.logError(requestId, error, Date.now() - startTime)
      throw error
    }
  }

  /**
   * Generate content with streaming and logging.
   *
   * @param request - Generation request
   * @yields Content chunks as they are generated
   * @returns Async generator yielding content chunks
   */
  public async *generateContentStream(
    request: GenerateContentRequest,
  ): AsyncGenerator<GenerateContentChunk> {
    const startTime = Date.now()
    const requestId = this.generateRequestId()

    this.logRequest(requestId, request)
    this.eventBus?.emit('llmservice:thinking')

    try {
      let chunkCount = 0
      // Streaming providers (e.g. AiSdkContentGenerator) attach the per-call
      // usage block to the terminating chunk's `rawResponse`. Capture the
      // last non-undefined occurrence and emit telemetry once the stream drains.
      let lastRawResponse: unknown

      for await (const chunk of this.inner.generateContentStream(request)) {
        chunkCount++

        if (this.shouldLogChunks()) {
          this.logChunk(requestId, chunk, chunkCount)
        }

        if (chunk.rawResponse !== undefined) {
          lastRawResponse = chunk.rawResponse
        }

        yield chunk
      }

      try {
        this.emitUsage(request, lastRawResponse, Date.now() - startTime)
      } catch {
        // Best-effort — swallow any telemetry-side failure.
      }
    } catch (error) {
      this.logError(requestId, error, Date.now() - startTime)
      throw error
    }
  }

  /**
   * Auto-detect provider type from raw response shape and emit
   * `llmservice:usage` with canonical fields. Best-effort: emits nothing
   * when no recognizable usage shape is present.
   *
   * Accepts an explicit `rawResponse` so the streaming path can pass the
   * value captured off the terminating chunk; non-streaming callers pass
   * `response.rawResponse` directly.
   */
  private emitUsage(
    request: GenerateContentRequest,
    rawResponse: unknown,
    durationMs: number,
  ): void {
    if (!this.eventBus) return

    const rawUsage = pickRawUsage(rawResponse)
    if (rawUsage === undefined) return

    for (const providerType of PROVIDER_TYPES) {
      const usage = extractUsage(rawUsage, providerType)
      if (!usage) continue
      this.eventBus.emit('llmservice:usage', {
        ...(usage.cacheCreationTokens !== undefined && {cacheCreationTokens: usage.cacheCreationTokens}),
        ...(usage.cachedInputTokens !== undefined && {cachedInputTokens: usage.cachedInputTokens}),
        durationMs,
        inputTokens: usage.inputTokens,
        model: request.model,
        outputTokens: usage.outputTokens,
        ...(request.taskId && {taskId: request.taskId}),
      })
      return
    }
  }

  /**
   * Generate a unique request ID for tracking.
   */
  private generateRequestId(): string {
    return Math.random().toString(36).slice(2, 8)
  }

  /**
   * Log a streaming chunk (no-op: verbose-only, routed through event bus).
   */
  private logChunk(_requestId: string, _chunk: GenerateContentChunk, _index: number): void {
    // Removed: console.debug output disrupts Ink TUI layout.
    // Chunk-level telemetry is available via event bus if needed.
  }

  /**
   * Log an error that occurred during generation.
   */
  private logError(_requestId: string, error: unknown, _durationMs: number): void {
    const errorMessage = error instanceof Error ? error.message : String(error)

    this.eventBus?.emit('llmservice:error', {
      error: errorMessage,
    })
  }

  /**
   * Log a generation request (no-op: verbose-only, routed through event bus).
   */
  private logRequest(_requestId: string, _request: GenerateContentRequest): void {
    // Removed: console.debug output disrupts Ink TUI layout.
    // Request metadata is available via event bus if needed.
  }

  /**
   * Check if chunks should be logged.
   */
  private shouldLogChunks(): boolean {
    return this.options.logChunks === true || this.options.verbose === true
  }
}

function isObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object'
}

/**
 * Pull the provider's raw `usage` block out of `rawResponse`. Anthropic and
 * OpenAI nest it under `usage`; Gemini under `usageMetadata`. Returns the
 * first match or `undefined`.
 */
function pickRawUsage(rawResponse: unknown): unknown {
  if (!isObject(rawResponse)) return undefined
  return rawResponse.usage ?? rawResponse.usageMetadata
}
