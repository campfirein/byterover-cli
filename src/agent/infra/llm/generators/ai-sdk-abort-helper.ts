/**
 * Per-call AbortSignal helper for AI SDK calls.
 *
 * Builds an AbortController keyed on a configurable timeout, hands the
 * signal to a body callback (which forwards it to `generateText` /
 * `streamText`), and translates a timer-driven abort into a typed
 * `LlmRequestTimeoutError`. The retry layer classifies that error as
 * retryable via the existing `timeout` substring in
 * `DEFAULT_RETRY_POLICY.retryableErrors`.
 *
 * Errors caused by the body throwing for reasons unrelated to the
 * timeout (HTTP 4xx/5xx, AI SDK parsing errors, user cancellation
 * propagated from upstream) are rethrown unchanged.
 */

export class LlmRequestTimeoutError extends Error {
  public readonly timeoutMs: number

  public constructor(timeoutMs: number) {
    super(`LLM request timeout after ${timeoutMs}ms (aborted by client)`)
    this.name = 'LlmRequestTimeoutError'
    this.timeoutMs = timeoutMs
  }
}

export interface AbortContext {
  /** Clears the underlying timer. Idempotent. */
  cleanup(): void
  /** True iff the controller aborted because the timer fired. */
  didTimeout(): boolean
  /**
   * Resets the underlying timer so the deadline is measured from the most
   * recent activity rather than from construction. Streaming consumers call
   * this on every chunk for idle-deadline semantics; a slow stream that
   * keeps delivering chunks faster than `timeoutMs` apart stays alive
   * indefinitely while a stalled stream still aborts after `timeoutMs` of
   * silence. No-op when `timeoutMs` is undefined or the timer already fired.
   */
  recordActivity(): void
  /** Undefined when `timeoutMs` is undefined. */
  signal: AbortSignal | undefined
  /** The configured timeout (echoed for error reporting). */
  timeoutMs: number | undefined
}

/**
 * Builds an `AbortController` keyed on `timeoutMs`. Returns
 * `{signal: undefined}` when `timeoutMs` is undefined so callers can
 * pass the value through unchanged. Reserve for the streaming path
 * which iterates rather than awaiting a single Promise; the
 * `withRequestTimeout` wrapper is preferred for one-shot calls.
 *
 * Default deadline is total (timer fires `timeoutMs` after construction).
 * Streaming consumers can opt into idle-deadline semantics by calling
 * `recordActivity()` on every chunk.
 */
export function createAbortContext(timeoutMs: number | undefined): AbortContext {
  if (timeoutMs === undefined) {
    return {
      cleanup() {},
      didTimeout: () => false,
      recordActivity() {},
      signal: undefined,
      timeoutMs: undefined,
    }
  }

  let timedOut = false
  const controller = new AbortController()
  const fire = (): void => {
    timedOut = true
    controller.abort()
  }

  let timer: NodeJS.Timeout = setTimeout(fire, timeoutMs)

  return {
    cleanup() {
      clearTimeout(timer)
    },
    didTimeout: () => timedOut,
    recordActivity() {
      if (timedOut) return
      clearTimeout(timer)
      timer = setTimeout(fire, timeoutMs)
    },
    signal: controller.signal,
    timeoutMs,
  }
}

/**
 * Runs `body` with an AbortSignal that fires after `timeoutMs`. Returns
 * the body's result on success. Throws `LlmRequestTimeoutError` when
 * the timer fires before the body resolves; rethrows the body's error
 * otherwise. When `timeoutMs` is undefined, no controller is built and
 * `body` is called with `undefined`.
 */
export async function withRequestTimeout<T>(
  timeoutMs: number | undefined,
  body: (signal: AbortSignal | undefined) => Promise<T>,
): Promise<T> {
  const context = createAbortContext(timeoutMs)

  try {
    return await body(context.signal)
  } catch (error) {
    if (context.didTimeout() && context.timeoutMs !== undefined) {
      throw new LlmRequestTimeoutError(context.timeoutMs)
    }

    throw error
  } finally {
    context.cleanup()
  }
}
