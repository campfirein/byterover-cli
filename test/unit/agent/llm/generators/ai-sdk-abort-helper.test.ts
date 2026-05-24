import {expect} from 'chai'
import {restore, useFakeTimers} from 'sinon'

import {
  createAbortContext,
  LlmRequestTimeoutError,
  withRequestTimeout,
} from '../../../../../src/agent/infra/llm/generators/ai-sdk-abort-helper.js'
import {DEFAULT_RETRY_POLICY, isRetryableError} from '../../../../../src/agent/infra/llm/retry/retry-policy.js'

describe('ai-sdk-abort-helper', () => {
  describe('withRequestTimeout', () => {
    afterEach(() => {
      restore()
    })

    it('returns the body result without a signal when timeoutMs is undefined', async () => {
      let receivedSignal: AbortSignal | undefined
      const result = await withRequestTimeout(undefined, async (signal) => {
        receivedSignal = signal
        return 'ok'
      })

      expect(result).to.equal('ok')
      expect(receivedSignal).to.be.undefined
    })

    it('passes an AbortSignal to the body when timeoutMs is set', async () => {
      let receivedSignal: AbortSignal | undefined
      const result = await withRequestTimeout(10_000, async (signal) => {
        receivedSignal = signal
        return 42
      })

      expect(result).to.equal(42)
      expect(receivedSignal).to.be.instanceOf(AbortSignal)
      expect(receivedSignal?.aborted).to.equal(false)
    })

    it('throws LlmRequestTimeoutError when the body never resolves and the timer fires', async () => {
      const clock = useFakeTimers()
      const promise = withRequestTimeout(50, async (signal) =>
        new Promise<never>((_, reject) => {
          if (signal) signal.addEventListener('abort', () => reject(new Error('aborted')))
        }),
      )
      await clock.tickAsync(50)

      try {
        await promise
        expect.fail('expected throw')
      } catch (error) {
        expect(error).to.be.instanceOf(LlmRequestTimeoutError)
        if (error instanceof LlmRequestTimeoutError) {
          expect(error.timeoutMs).to.equal(50)
          expect(error.message).to.match(/timeout/i)
        }
      }
    })

    it('rethrows non-timeout errors unchanged', async () => {
      const originalError = new Error('different failure')
      try {
        await withRequestTimeout(10_000, async () => {
          throw originalError
        })
        expect.fail('expected throw')
      } catch (error) {
        expect(error).to.equal(originalError)
      }
    })

    it('clears the underlying timer on success so the timeout does not leak', async () => {
      const clock = useFakeTimers()
      const result = await withRequestTimeout(100, async () => 'done')
      expect(result).to.equal('done')

      // If the timer were still active, ticking past the timeout would fire abort,
      // surfacing an unhandled rejection. The clean termination of this test
      // verifies the timer was cleared.
      await clock.tickAsync(200)
    })
  })

  describe('createAbortContext — stream-deadline semantics', () => {
    afterEach(() => {
      restore()
    })

    it('aborts after timeoutMs when the consumer never reports activity (total-deadline default)', async () => {
      // Default behavior: timer is total deadline from construction.
      // A passive consumer that never calls recordActivity gets aborted.
      const clock = useFakeTimers()
      const context = createAbortContext(100)

      for (let i = 0; i < 5; i++) {
        // eslint-disable-next-line no-await-in-loop
        await clock.tickAsync(30)
      }

      expect(context.signal?.aborted).to.equal(true)
      expect(context.didTimeout()).to.equal(true)
      context.cleanup()
    })

    it('does NOT abort when recordActivity() is called within each timeoutMs window (idle-deadline)', async () => {
      // Idle-deadline semantics: every recordActivity() call resets the
      // timer. A slow local 7B model that streams steadily across minutes
      // in 30-ms chunks is no longer killed for exceeding requestTimeoutMs
      // while chunks are still arriving.
      const clock = useFakeTimers()
      const context = createAbortContext(100)

      for (let i = 0; i < 5; i++) {
        // eslint-disable-next-line no-await-in-loop
        await clock.tickAsync(30)
        context.recordActivity()
      }

      expect(context.signal?.aborted).to.equal(false, 'idle-deadline: 30ms gaps are below the 100ms timeout')
      expect(context.didTimeout()).to.equal(false)
      context.cleanup()
    })

    it('aborts after timeoutMs of silence following the last recordActivity()', async () => {
      // The fix must still catch a genuine stall — if chunks stop
      // arriving, the timer fires `timeoutMs` after the last activity.
      const clock = useFakeTimers()
      const context = createAbortContext(100)

      await clock.tickAsync(30)
      context.recordActivity()
      // Now the stream stalls; 110ms of silence > 100ms timeout.
      await clock.tickAsync(110)

      expect(context.signal?.aborted).to.equal(true)
      expect(context.didTimeout()).to.equal(true)
      context.cleanup()
    })

    it('recordActivity() is a no-op after the timer has already fired', async () => {
      // A late recordActivity() must not un-abort an already-aborted
      // context; we cannot resurrect a fired AbortSignal.
      const clock = useFakeTimers()
      const context = createAbortContext(50)

      await clock.tickAsync(60)
      expect(context.signal?.aborted).to.equal(true)

      context.recordActivity()
      expect(context.signal?.aborted).to.equal(true)
      expect(context.didTimeout()).to.equal(true)
      context.cleanup()
    })

    it('recordActivity() is a safe no-op when timeoutMs is undefined', () => {
      // eslint-disable-next-line unicorn/no-useless-undefined
      const context = createAbortContext(undefined)
      // Should not throw.
      context.recordActivity()
      expect(context.signal).to.equal(undefined)
      expect(context.didTimeout()).to.equal(false)
    })

    it('many rapid recordActivity() calls do not leak setTimeout handles', async () => {
      // Section: stress / resource hygiene. The stream loop calls
      // recordActivity on EVERY chunk; a slow model can emit hundreds per
      // second. recordActivity must clearTimeout the old handle before
      // scheduling a new one, otherwise we leak one timer per chunk.
      // sinon's clock.countTimers() exposes the live timer count, so we
      // assert that 500 rapid bumps still leave only ONE timer outstanding.
      const clock = useFakeTimers()
      const baseline = clock.countTimers()
      const context = createAbortContext(1000)

      // Exactly one new timer (the abort timer) after creation.
      expect(clock.countTimers() - baseline).to.equal(1)

      for (let i = 0; i < 500; i++) {
        // eslint-disable-next-line no-await-in-loop
        await clock.tickAsync(1)
        context.recordActivity()
      }

      // Still exactly ONE timer outstanding, not 500.
      expect(clock.countTimers() - baseline).to.equal(
        1,
        `recordActivity leaked timers under storm; live=${clock.countTimers() - baseline}`,
      )
      expect(context.signal?.aborted).to.equal(false)

      context.cleanup()
      expect(clock.countTimers() - baseline).to.equal(0, 'cleanup() must clear the timer')
    })
  })

  describe('LlmRequestTimeoutError', () => {
    it('embeds the timeout in the message so the retry layer classifies it as retryable', () => {
      const error = new LlmRequestTimeoutError(60_000)
      expect(error.message).to.match(/timeout/i)
      expect(isRetryableError(error, DEFAULT_RETRY_POLICY)).to.equal(true)
    })
  })
})
