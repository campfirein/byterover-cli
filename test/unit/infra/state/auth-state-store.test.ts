/**
 * AuthStateStore Unit Tests
 *
 * Tests global auth state management with polling.
 *
 * Key scenarios:
 * - Token caching (getToken/loadToken)
 * - Polling detects new, changed, removed tokens
 * - Expiry detection (fires once per expiry, not repeated)
 * - isPolling guard prevents overlapping polls
 * - Error resilience (poll error doesn't crash)
 */

import {expect} from 'chai'
import {createSandbox, type SinonFakeTimers, type SinonSandbox, type SinonStub, useFakeTimers} from 'sinon'

import type {ITokenStore} from '../../../../src/server/core/interfaces/auth/i-token-store.js'

import {AuthToken} from '../../../../src/server/core/domain/entities/auth-token.js'
import {AuthStateStore} from '../../../../src/server/infra/state/auth-state-store.js'

function createValidToken(overrides?: Partial<{accessToken: string; expiresAt: Date}>): AuthToken {
  return new AuthToken({
    accessToken: overrides?.accessToken ?? 'access-token-1',
    expiresAt: overrides?.expiresAt ?? new Date(Date.now() + 3_600_000),
    refreshToken: 'refresh-token-1',
    sessionKey: 'session-key-1',
    userEmail: 'user@test.com',
    userId: 'user-1',
  })
}

function createExpiredToken(overrides?: Partial<{accessToken: string}>): AuthToken {
  return new AuthToken({
    accessToken: overrides?.accessToken ?? 'access-token-expired',
    expiresAt: new Date(Date.now() - 1000),
    refreshToken: 'refresh-token-1',
    sessionKey: 'session-key-1',
    userEmail: 'user@test.com',
    userId: 'user-1',
  })
}

describe('AuthStateStore', () => {
  let sandbox: SinonSandbox
  let clock: SinonFakeTimers
  let tokenStore: ITokenStore
  let loadStub: SinonStub
  let store: AuthStateStore

  const POLL_INTERVAL = 100 // Short interval for tests

  beforeEach(() => {
    sandbox = createSandbox()
    clock = useFakeTimers({shouldAdvanceTime: false})

    loadStub = sandbox.stub()
    tokenStore = {
      clear: sandbox.stub().resolves(),
      load: loadStub.resolves(),
      save: sandbox.stub().resolves(),
    }

    store = new AuthStateStore({
      pollIntervalMs: POLL_INTERVAL,
      tokenStore,
    })
  })

  afterEach(() => {
    store.stopPolling()
    clock.restore()
    sandbox.restore()
  })

  describe('getToken()', () => {
    it('should return undefined before any load', () => {
      expect(store.getToken()).to.be.undefined
    })

    it('should return cached token after loadToken()', async () => {
      const token = createValidToken()
      loadStub.resolves(token)

      await store.loadToken()

      expect(store.getToken()).to.equal(token)
    })
  })

  describe('loadToken()', () => {
    it('should load from token store and cache', async () => {
      const token = createValidToken()
      loadStub.resolves(token)

      const result = await store.loadToken()

      expect(result).to.equal(token)
      expect(store.getToken()).to.equal(token)
      expect(loadStub.calledOnce).to.be.true
    })

    it('should return undefined when store has no token', async () => {
      loadStub.resolves()

      const result = await store.loadToken()

      expect(result).to.be.undefined
      expect(store.getToken()).to.be.undefined
    })

    it('should fire onAuthChanged callback when token appears', async () => {
      const callback = sandbox.stub()
      store.onAuthChanged(callback)

      const token = createValidToken()
      loadStub.resolves(token)

      await store.loadToken()

      expect(callback.calledOnce).to.be.true
      expect(callback.calledWith(token)).to.be.true
    })

    it('should not crash on load error', async () => {
      loadStub.rejects(new Error('keychain locked'))

      const result = await store.loadToken()

      // Returns previous cached value (undefined)
      expect(result).to.be.undefined
    })
  })

  describe('polling', () => {
    it('should detect new token and fire onAuthChanged', async () => {
      const callback = sandbox.stub()
      store.onAuthChanged(callback)

      const token = createValidToken()
      loadStub.resolves(token)

      store.startPolling()
      await clock.tickAsync(POLL_INTERVAL)

      expect(callback.calledOnce).to.be.true
      expect(callback.calledWith(token)).to.be.true
    })

    it('should detect changed token (different accessToken) and fire onAuthChanged', async () => {
      const callback = sandbox.stub()
      store.onAuthChanged(callback)

      // Initial token
      const token1 = createValidToken({accessToken: 'token-1'})
      loadStub.resolves(token1)
      await store.loadToken()

      // Changed token
      const token2 = createValidToken({accessToken: 'token-2'})
      loadStub.resolves(token2)

      store.startPolling()
      await clock.tickAsync(POLL_INTERVAL)

      // 2 calls: 1 from loadToken, 1 from poll
      expect(callback.calledTwice).to.be.true
      expect(callback.secondCall.calledWith(token2)).to.be.true
    })

    it('should detect removed token and fire onAuthChanged(undefined)', async () => {
      const callback = sandbox.stub()
      store.onAuthChanged(callback)

      // Initial token
      const token = createValidToken()
      loadStub.resolves(token)
      await store.loadToken()

      // Token removed
      loadStub.resolves()

      store.startPolling()
      await clock.tickAsync(POLL_INTERVAL)

      expect(callback.calledTwice).to.be.true
      expect(callback.secondCall.args[0]).to.be.undefined
    })

    it('should NOT fire onAuthChanged when token is the same', async () => {
      const callback = sandbox.stub()
      store.onAuthChanged(callback)

      const token = createValidToken({accessToken: 'same-token'})
      loadStub.resolves(token)

      // Load initial
      await store.loadToken()
      expect(callback.calledOnce).to.be.true

      // Poll — same token
      store.startPolling()
      await clock.tickAsync(POLL_INTERVAL)

      // Still only called once (from loadToken)
      expect(callback.calledOnce).to.be.true
    })

    it('should detect expired token and fire onAuthExpired', async () => {
      const changedCallback = sandbox.stub()
      const expiredCallback = sandbox.stub()
      store.onAuthChanged(changedCallback)
      store.onAuthExpired(expiredCallback)

      // Load a valid token first
      const validToken = createValidToken({accessToken: 'expiring-token'})
      loadStub.resolves(validToken)
      await store.loadToken()

      // Now return an expired token with the same accessToken
      const expiredToken = createExpiredToken({accessToken: 'expiring-token'})
      loadStub.resolves(expiredToken)

      store.startPolling()
      await clock.tickAsync(POLL_INTERVAL)

      expect(expiredCallback.calledOnce).to.be.true
      expect(expiredCallback.calledWith(expiredToken)).to.be.true
      // onAuthChanged should NOT fire (same accessToken)
      expect(changedCallback.calledOnce).to.be.true // only from initial loadToken
    })

    it('should fire onAuthExpired only once per expiry (not on every poll)', async () => {
      const expiredCallback = sandbox.stub()
      store.onAuthExpired(expiredCallback)

      // Load a valid token
      const validToken = createValidToken({accessToken: 'expiring-token'})
      loadStub.resolves(validToken)
      await store.loadToken()

      // Return expired token with same accessToken
      const expiredToken = createExpiredToken({accessToken: 'expiring-token'})
      loadStub.resolves(expiredToken)

      store.startPolling()
      await clock.tickAsync(POLL_INTERVAL) // 1st poll: fires onAuthExpired
      await clock.tickAsync(POLL_INTERVAL) // 2nd poll: should NOT fire again
      await clock.tickAsync(POLL_INTERVAL) // 3rd poll: should NOT fire again

      expect(expiredCallback.calledOnce).to.be.true
    })

    it('should reset wasExpired when token changes', async () => {
      const expiredCallback = sandbox.stub()
      store.onAuthExpired(expiredCallback)

      // Load valid token -> expire -> new valid token -> expire again
      const token1 = createValidToken({accessToken: 'token-1'})
      loadStub.resolves(token1)
      await store.loadToken()

      // Expire token-1
      const expired1 = createExpiredToken({accessToken: 'token-1'})
      loadStub.resolves(expired1)
      store.startPolling()
      await clock.tickAsync(POLL_INTERVAL)
      expect(expiredCallback.calledOnce).to.be.true

      // New valid token (different accessToken resets wasExpired)
      const token2 = createValidToken({accessToken: 'token-2'})
      loadStub.resolves(token2)
      await clock.tickAsync(POLL_INTERVAL)

      // Expire token-2
      const expired2 = createExpiredToken({accessToken: 'token-2'})
      loadStub.resolves(expired2)
      await clock.tickAsync(POLL_INTERVAL)

      expect(expiredCallback.calledTwice).to.be.true
    })

    it('should not crash on poll error', async () => {
      const callback = sandbox.stub()
      store.onAuthChanged(callback)

      loadStub.rejects(new Error('keychain locked'))

      store.startPolling()
      await clock.tickAsync(POLL_INTERVAL)

      // Should not crash, callback not called
      expect(callback.called).to.be.false
    })

    it('should continue polling after an error', async () => {
      const callback = sandbox.stub()
      store.onAuthChanged(callback)

      // First poll: error
      loadStub.rejects(new Error('keychain locked'))
      store.startPolling()
      await clock.tickAsync(POLL_INTERVAL)

      // Second poll: success
      const token = createValidToken()
      loadStub.resolves(token)
      await clock.tickAsync(POLL_INTERVAL)

      expect(callback.calledOnce).to.be.true
      expect(callback.calledWith(token)).to.be.true
    })
  })

  describe('startPolling() / stopPolling()', () => {
    it('should be idempotent (double-start is safe)', async () => {
      store.startPolling()
      store.startPolling() // Should not create a second interval

      // Verify by checking that only one poll fires per interval
      const callback = sandbox.stub()
      store.onAuthChanged(callback)

      const token = createValidToken()
      loadStub.resolves(token)

      // Wait for exactly one interval
      await clock.tickAsync(POLL_INTERVAL)
    })

    it('should stop polling when stopPolling() is called', async () => {
      const callback = sandbox.stub()
      store.onAuthChanged(callback)

      const token = createValidToken()
      loadStub.resolves(token)

      store.startPolling()
      await clock.tickAsync(POLL_INTERVAL)
      expect(callback.calledOnce).to.be.true

      store.stopPolling()

      // Reset stub to track new calls
      callback.reset()
      loadStub.resolves(createValidToken({accessToken: 'new-token'}))
      await clock.tickAsync(POLL_INTERVAL)

      // No new calls after stopPolling
      expect(callback.called).to.be.false
    })

    it('should be safe to call stopPolling() when not started', () => {
      // Should not throw
      store.stopPolling()
    })
  })

  describe('isPolling guard', () => {
    it('should prevent overlapping polls', async () => {
      // Make load() hang (never resolves during the test)
      let resolveLoad: ((token: AuthToken | undefined) => void) | undefined
      loadStub.callsFake(
        () =>
          new Promise<AuthToken | undefined>((resolve) => {
            resolveLoad = resolve
          }),
      )

      store.startPolling()

      // First poll starts (load is pending)
      await clock.tickAsync(POLL_INTERVAL)
      expect(loadStub.calledOnce).to.be.true

      // Second interval fires, but should be skipped (first still in-flight)
      await clock.tickAsync(POLL_INTERVAL)
      expect(loadStub.calledOnce).to.be.true // Still only called once

      // Resolve the first poll to clean up
      resolveLoad?.(undefined) // eslint-disable-line unicorn/no-useless-undefined
    })
  })

  describe('no callback registered', () => {
    it('should not crash when auth changes without callback', async () => {
      const token = createValidToken()
      loadStub.resolves(token)

      // No callbacks registered — should not throw
      await store.loadToken()
      expect(store.getToken()).to.equal(token)
    })

    it('should not crash when token expires without callback', async () => {
      const validToken = createValidToken({accessToken: 'token'})
      loadStub.resolves(validToken)
      await store.loadToken()

      const expiredToken = createExpiredToken({accessToken: 'token'})
      loadStub.resolves(expiredToken)

      store.startPolling()
      await clock.tickAsync(POLL_INTERVAL)

      // Should not crash
      expect(store.getToken()).to.equal(expiredToken)
    })
  })

  describe('multiple onAuthChanged listeners (M4.1 regression)', () => {
    it('should fire EVERY registered onAuthChanged callback when token appears', async () => {
      const cb1 = sandbox.stub()
      const cb2 = sandbox.stub()
      const cb3 = sandbox.stub()
      store.onAuthChanged(cb1)
      store.onAuthChanged(cb2)
      store.onAuthChanged(cb3)

      const token = createValidToken()
      loadStub.resolves(token)
      await store.loadToken()

      expect(cb1.calledOnce, 'cb1 should fire').to.be.true
      expect(cb2.calledOnce, 'cb2 should fire').to.be.true
      expect(cb3.calledOnce, 'cb3 should fire').to.be.true
      expect(cb1.calledWith(token)).to.be.true
      expect(cb2.calledWith(token)).to.be.true
      expect(cb3.calledWith(token)).to.be.true
    })

    it('should fire listeners in registration order', async () => {
      const order: number[] = []
      store.onAuthChanged(() => order.push(1))
      store.onAuthChanged(() => order.push(2))
      store.onAuthChanged(() => order.push(3))

      loadStub.resolves(createValidToken())
      await store.loadToken()

      expect(order).to.deep.equal([1, 2, 3])
    })

    it('should keep firing later listeners even if an earlier one throws', async () => {
      const cb1 = sandbox.stub().throws(new Error('listener boom'))
      const cb2 = sandbox.stub()
      const cb3 = sandbox.stub()
      store.onAuthChanged(cb1)
      store.onAuthChanged(cb2)
      store.onAuthChanged(cb3)

      loadStub.resolves(createValidToken())

      // The polling loop must not propagate the listener throw — would
      // otherwise crash the daemon's auth poll cycle.
      await store.loadToken()

      expect(cb1.calledOnce).to.be.true
      expect(cb2.calledOnce, 'cb2 must still fire after cb1 threw').to.be.true
      expect(cb3.calledOnce, 'cb3 must still fire after cb1 threw').to.be.true
    })

    it('should fire EVERY onAuthExpired callback', async () => {
      const cb1 = sandbox.stub()
      const cb2 = sandbox.stub()
      store.onAuthExpired(cb1)
      store.onAuthExpired(cb2)

      const validToken = createValidToken({accessToken: 'shared'})
      loadStub.resolves(validToken)
      await store.loadToken()

      const expiredToken = createExpiredToken({accessToken: 'shared'})
      loadStub.resolves(expiredToken)
      store.startPolling()
      await clock.tickAsync(POLL_INTERVAL)

      expect(cb1.calledOnce).to.be.true
      expect(cb2.calledOnce).to.be.true
    })
  })

  describe('onBeforeAuthChange (M4.4 pre-transition hook)', () => {
    // The pre-hook fires BEFORE `cachedToken` is mutated, so listeners
    // (analytics force-flush) can read `getToken()` and observe the
    // OLD token. Without this ordering guarantee, M4.4's flush-then-drop
    // hybrid would ship events with the NEW session header but OLD
    // per-event identity — backend would treat them as anonymous.
    const HANG_GUARD_MS = 50 // shrunk for tests; prod default is 6000

    it('fires the pre-listener BEFORE cachedToken mutates (getToken returns OLD)', async () => {
      const token1 = createValidToken({accessToken: 'old'})
      loadStub.resolves(token1)
      await store.loadToken()

      let observedDuringPre: string | undefined
      store.onBeforeAuthChange(async (_oldToken, _newToken) => {
        // Reading getToken() here MUST return the OLD token — the whole
        // point of the pre-hook is the OLD token is still in place.
        observedDuringPre = store.getToken()?.accessToken
      })

      const token2 = createValidToken({accessToken: 'new'})
      loadStub.resolves(token2)
      await store.loadToken()

      expect(observedDuringPre, 'pre-listener must see OLD token via getToken()').to.equal('old')
      expect(store.getToken()?.accessToken, 'post-transition cached token is NEW').to.equal('new')
    })

    it('awaits the async pre-listener before firing onAuthChanged (post-hook)', async () => {
      const order: string[] = []
      let releasePre!: () => void
      store.onBeforeAuthChange(
        () =>
          new Promise<void>((resolve) => {
            order.push('pre-start')
            releasePre = () => {
              order.push('pre-end')
              resolve()
            }
          }),
      )
      store.onAuthChanged(() => {
        order.push('post')
      })

      loadStub.resolves(createValidToken({accessToken: 'a'}))

      const loadPromise = store.loadToken()
      // Pre-listener registered but not resolved yet → post must NOT fire
      await clock.tickAsync(0)
      expect(order).to.deep.equal(['pre-start'])

      releasePre()
      await loadPromise

      expect(order).to.deep.equal(['pre-start', 'pre-end', 'post'])
    })

    it('skips pre-listeners when accessToken is unchanged (token-refresh shortcut path is unrelated)', async () => {
      // Same accessToken across loads = no change detected, NO pre-listener fire.
      const preCb = sandbox.stub().resolves()
      store.onBeforeAuthChange(preCb)

      const token = createValidToken({accessToken: 'stable'})
      loadStub.resolves(token)
      await store.loadToken() // first load: undefined → token, pre fires
      await store.loadToken() // second load: same accessToken, NO pre

      expect(preCb.calledOnce, 'pre fires only on the actual transition').to.be.true
    })

    it('hang-guard: pre-listener that never resolves does NOT block the transition past beforeAuthChangeTimeoutMs', async () => {
      // Construct a store with a small hang-guard so the test can finish
      // in reasonable time. Prod default is 6s.
      const fastStore = new AuthStateStore({
        beforeAuthChangeTimeoutMs: HANG_GUARD_MS,
        pollIntervalMs: POLL_INTERVAL,
        tokenStore,
      })
      fastStore.onBeforeAuthChange(
        () =>
          new Promise<void>(() => {
            /* never resolves */
          }),
      )
      const postCb = sandbox.stub()
      fastStore.onAuthChanged(postCb)

      loadStub.resolves(createValidToken({accessToken: 'a'}))
      const loadPromise = fastStore.loadToken()

      await clock.tickAsync(HANG_GUARD_MS + 1)
      await loadPromise

      expect(postCb.calledOnce, 'post-hook must still fire after hang-guard expires').to.be.true
      expect(fastStore.getToken()?.accessToken, 'cachedToken must commit even though pre hung').to.equal('a')
    })

    it('clears the hang-guard timer when the pre-listener wins the race (no leaked Node timer)', async () => {
      // Regression for N2 review finding: without clearTimeout, every
      // transition leaks a 6s timer that keeps the event loop alive.
      // We verify by counting pending timers via the fake clock: after
      // a fast callback resolves and the loadToken settles, no setTimeout
      // queued by fireBeforeAuthChange should remain.
      const fastStore = new AuthStateStore({
        beforeAuthChangeTimeoutMs: HANG_GUARD_MS,
        pollIntervalMs: POLL_INTERVAL,
        tokenStore,
      })
      fastStore.onBeforeAuthChange(async () => {
        // resolves on the next microtask — wins the race trivially.
      })

      loadStub.resolves(createValidToken({accessToken: 'a'}))
      // Snapshot the pending-timer count before and after the transition.
      const before = clock.countTimers()
      await fastStore.loadToken()
      const after = clock.countTimers()

      expect(after - before, 'no pending timer leaked by the hang-guard').to.equal(0)
    })

    it('runs multiple pre-listeners in registration order, awaiting each in series', async () => {
      const order: string[] = []
      store.onBeforeAuthChange(async () => {
        await Promise.resolve()
        order.push('pre1')
      })
      store.onBeforeAuthChange(async () => {
        await Promise.resolve()
        order.push('pre2')
      })
      store.onBeforeAuthChange(async () => {
        await Promise.resolve()
        order.push('pre3')
      })

      loadStub.resolves(createValidToken({accessToken: 'a'}))
      await store.loadToken()

      expect(order).to.deep.equal(['pre1', 'pre2', 'pre3'])
    })

    it('continues to subsequent pre-listeners when an earlier one rejects', async () => {
      const cb1 = sandbox.stub().rejects(new Error('pre1 boom'))
      const cb2 = sandbox.stub().resolves()
      const cb3 = sandbox.stub().resolves()
      store.onBeforeAuthChange(cb1)
      store.onBeforeAuthChange(cb2)
      store.onBeforeAuthChange(cb3)
      const postCb = sandbox.stub()
      store.onAuthChanged(postCb)

      loadStub.resolves(createValidToken({accessToken: 'a'}))
      await store.loadToken()

      expect(cb1.calledOnce).to.be.true
      expect(cb2.calledOnce, 'cb2 must run after cb1 rejected').to.be.true
      expect(cb3.calledOnce, 'cb3 must run after cb1 rejected').to.be.true
      expect(postCb.calledOnce, 'post-hook still fires').to.be.true
    })

    it('passes (oldToken, newToken) to the pre-listener', async () => {
      const token1 = createValidToken({accessToken: 'a'})
      loadStub.resolves(token1)
      await store.loadToken()

      const cb = sandbox.stub().resolves()
      store.onBeforeAuthChange(cb)

      const token2 = createValidToken({accessToken: 'b'})
      loadStub.resolves(token2)
      await store.loadToken()

      expect(cb.calledOnce).to.be.true
      expect(cb.firstCall.args[0]?.accessToken, 'arg0 is OLD token').to.equal('a')
      expect(cb.firstCall.args[1]?.accessToken, 'arg1 is NEW token').to.equal('b')
    })
  })
})
