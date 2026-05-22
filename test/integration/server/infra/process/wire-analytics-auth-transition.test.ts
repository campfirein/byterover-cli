import {expect} from 'chai'
import {spy, stub} from 'sinon'

import type {IAnalyticsClient} from '../../../../../src/server/core/interfaces/analytics/i-analytics-client.js'
import type {
  AuthChangedCallback,
  AuthExpiredCallback,
  IAuthStateStore,
} from '../../../../../src/server/core/interfaces/state/i-auth-state-store.js'

import {AnalyticsBatch} from '../../../../../src/server/core/domain/analytics/batch.js'
import {AuthToken} from '../../../../../src/server/core/domain/entities/auth-token.js'
import {wireAnalyticsAuthTransition} from '../../../../../src/server/infra/process/wire-analytics-auth-transition.js'

/**
 * Integration test for the M4.1 auth-transition wiring at the
 * composition-root level.
 *
 * Three scenarios cover the regressions this wiring exists to prevent:
 *
 *   A. Identity change (login / logout / account switch) MUST trigger
 *      `analyticsClient.onAuthTransition` so the queue is cleared before
 *      the next flush attributes prior-session events to the new user.
 *
 *   B. Token refresh (same userId, new accessToken) MUST NOT trigger
 *      `onAuthTransition` — the userId-guard inside the wiring is the
 *      sole defense against the polling-based refresh path emitting an
 *      `onAuthChanged` for the same user every time the access token
 *      rolls.
 *
 *   C. The wiring uses `IAuthStateStore.onAuthChanged` as a multi-
 *      listener registration. Earlier (pre-fix) it overwrote any
 *      previously-registered callback, which silently broke M4.1 in
 *      production because `AuthHandler.setup()` also subscribes to the
 *      same event. A subsequent subscriber MUST NOT cancel the analytics
 *      callback this wiring installed.
 */

function makeToken(overrides: Partial<{accessToken: string; userId: string}> = {}): AuthToken {
  const accessToken = overrides.accessToken ?? 'access-1'
  const userId = overrides.userId ?? 'user-A'
  return new AuthToken({
    accessToken,
    expiresAt: new Date(Date.now() + 3_600_000),
    refreshToken: 'refresh-1',
    sessionKey: 'session-1',
    userEmail: 'alice@example.com',
    userId,
    userName: 'Alice',
  })
}

/**
 * Stub IAuthStateStore that:
 *   - exposes a settable initial cached token (so `previousUserId` is
 *     seeded correctly when the wiring subscribes),
 *   - appends callbacks (multi-listener) and re-emits via `fire()` so
 *     tests can simulate a poll-detected change without spinning up a
 *     real timer + token store.
 */
function makeFakeAuthStateStore(initial?: AuthToken): IAuthStateStore & {
  readonly callbacks: AuthChangedCallback[]
  fire(token: AuthToken): void
  fireLogout(): void
} {
  const callbacks: AuthChangedCallback[] = []
  let cached: AuthToken | undefined = initial

  return {
    callbacks,
    fire(token: AuthToken): void {
      cached = token
      for (const cb of callbacks) cb(token)
    },
    fireLogout(): void {
      cached = undefined
      for (const cb of callbacks) cb(cached)
    },
    getToken: () => cached,
    loadToken: async () => cached,
    onAuthChanged(cb: AuthChangedCallback): void {
      callbacks.push(cb)
    },
    onAuthExpired(_cb: AuthExpiredCallback): void {
      // not exercised here
    },
    onBeforeAuthChange(): void {
      // M4.4: pre-hook not exercised in this M4.1 test
    },
    startPolling(): void {
      // not exercised here
    },
    stopPolling(): void {
      // not exercised here
    },
  }
}

function makeFakeAnalyticsClient(): IAnalyticsClient & {
  onAuthTransitionSpy: ReturnType<typeof spy>
} {
  const onAuthTransition = stub().resolves()
  return {
    abort() {
      /* M4.4: not exercised in this test */
    },
    flush: stub().resolves(AnalyticsBatch.create([])),
    getRuntimeState: () => Promise.resolve({droppedCount: 0, lastSuccessfulFlushAt: undefined, queueDepth: 0}),
    onAuthTransition,
    onAuthTransitionSpy: onAuthTransition,
    // Hand-rolled noop to preserve the generic `track<E>(event, ...rest)`
    // signature — sinon's `stub()` would erase the generic and fail the
    // structural-typing assignment to `IAnalyticsClient.track`.
    track(): void {
      // intentional no-op
    },
  }
}

async function flushMicrotasks(): Promise<void> {
  await new Promise<void>((resolve) => {
    setImmediate(resolve)
  })
  await new Promise<void>((resolve) => {
    setImmediate(resolve)
  })
}

describe('M4.1 wireAnalyticsAuthTransition (integration)', () => {
  describe('scenario A — identity change fires onAuthTransition', () => {
    it('fires onAuthTransition when an anonymous baseline transitions to authenticated (login)', async () => {
      const store = makeFakeAuthStateStore() // initial: undefined
      const client = makeFakeAnalyticsClient()
      wireAnalyticsAuthTransition(store, client)

      store.fire(makeToken({userId: 'user-A'}))
      await flushMicrotasks()

      expect(client.onAuthTransitionSpy.calledOnce, 'onAuthTransition must fire on login').to.equal(true)
    })

    it('fires onAuthTransition when an authenticated baseline transitions to anonymous (logout)', async () => {
      const store = makeFakeAuthStateStore(makeToken({userId: 'user-A'}))
      const client = makeFakeAnalyticsClient()
      wireAnalyticsAuthTransition(store, client)

      store.fireLogout()
      await flushMicrotasks()

      expect(client.onAuthTransitionSpy.calledOnce, 'onAuthTransition must fire on logout').to.equal(true)
    })

    it('fires onAuthTransition when the userId changes (account switch)', async () => {
      const store = makeFakeAuthStateStore(makeToken({userId: 'user-A'}))
      const client = makeFakeAnalyticsClient()
      wireAnalyticsAuthTransition(store, client)

      store.fire(makeToken({accessToken: 'access-B', userId: 'user-B'}))
      await flushMicrotasks()

      expect(client.onAuthTransitionSpy.calledOnce, 'onAuthTransition must fire on account switch').to.equal(true)
    })
  })

  describe('scenario B — token refresh (same userId) MUST NOT fire onAuthTransition', () => {
    it('does NOT fire onAuthTransition when the same user refreshes the access token', async () => {
      const store = makeFakeAuthStateStore(makeToken({accessToken: 'access-1', userId: 'user-A'}))
      const client = makeFakeAnalyticsClient()
      wireAnalyticsAuthTransition(store, client)

      // Polling detects an accessToken change but same userId — the
      // userId-guard inside the wiring must skip the transition.
      store.fire(makeToken({accessToken: 'access-2', userId: 'user-A'}))
      await flushMicrotasks()

      expect(client.onAuthTransitionSpy.called, 'onAuthTransition must NOT fire on token refresh').to.equal(false)
    })

    it('does NOT fire onAuthTransition when a series of refreshes leaves userId unchanged', async () => {
      const store = makeFakeAuthStateStore(makeToken({accessToken: 'a1', userId: 'user-A'}))
      const client = makeFakeAnalyticsClient()
      wireAnalyticsAuthTransition(store, client)

      store.fire(makeToken({accessToken: 'a2', userId: 'user-A'}))
      store.fire(makeToken({accessToken: 'a3', userId: 'user-A'}))
      store.fire(makeToken({accessToken: 'a4', userId: 'user-A'}))
      await flushMicrotasks()

      expect(client.onAuthTransitionSpy.callCount).to.equal(0)
    })

    it('still fires onAuthTransition when an identity change interleaves with refreshes', async () => {
      const store = makeFakeAuthStateStore(makeToken({accessToken: 'a1', userId: 'user-A'}))
      const client = makeFakeAnalyticsClient()
      wireAnalyticsAuthTransition(store, client)

      // refresh — skip
      store.fire(makeToken({accessToken: 'a2', userId: 'user-A'}))
      // logout — fire
      store.fireLogout()
      // login as different user — fire
      store.fire(makeToken({accessToken: 'b1', userId: 'user-B'}))
      // refresh as user-B — skip
      store.fire(makeToken({accessToken: 'b2', userId: 'user-B'}))
      await flushMicrotasks()

      expect(client.onAuthTransitionSpy.callCount, 'fired twice: logout + login-as-B').to.equal(2)
    })
  })

  describe('scenario C — multi-listener composition (AuthHandler regression)', () => {
    it('preserves the analytics callback when a later subscriber registers', async () => {
      const store = makeFakeAuthStateStore() // anonymous baseline
      const client = makeFakeAnalyticsClient()
      wireAnalyticsAuthTransition(store, client)

      // Simulate `AuthHandler.setup()` registering AFTER the analytics
      // wiring — pre-fix this overwrote the analytics callback.
      const broadcaster = stub()
      store.onAuthChanged(broadcaster)

      store.fire(makeToken({userId: 'user-A'}))
      await flushMicrotasks()

      expect(client.onAuthTransitionSpy.calledOnce, 'analytics callback must still fire').to.equal(true)
      expect(broadcaster.calledOnce, 'broadcaster callback must also fire').to.equal(true)
    })

    it('preserves the analytics callback even when multiple later subscribers register', async () => {
      const store = makeFakeAuthStateStore()
      const client = makeFakeAnalyticsClient()
      wireAnalyticsAuthTransition(store, client)

      const listener2 = stub()
      const listener3 = stub()
      store.onAuthChanged(listener2)
      store.onAuthChanged(listener3)

      store.fire(makeToken({userId: 'user-A'}))
      await flushMicrotasks()

      expect(client.onAuthTransitionSpy.calledOnce).to.equal(true)
      expect(listener2.calledOnce).to.equal(true)
      expect(listener3.calledOnce).to.equal(true)
    })

    it('analytics callback survives even if a later subscriber throws', async () => {
      // The real AuthStateStore impl isolates throws across listeners.
      // This fake mirrors that contract — if it didn't, the analytics
      // callback would also break under sibling failures.
      const callbacks: AuthChangedCallback[] = []
      const noToken: AuthToken | undefined = undefined
      const store: IAuthStateStore & {fire(t: AuthToken): void} = {
        fire(token: AuthToken): void {
          for (const cb of callbacks) {
            try {
              cb(token)
            } catch {
              // isolate, like the real store does
            }
          }
        },
        getToken: () => noToken,
        loadToken: async () => noToken,
        onAuthChanged(cb: AuthChangedCallback): void {
          callbacks.push(cb)
        },
        onAuthExpired(_cb: AuthExpiredCallback): void {},
        onBeforeAuthChange(): void {
          // M4.4: pre-hook not exercised in this M4.1 test
        },
        startPolling(): void {},
        stopPolling(): void {},
      }
      const client = makeFakeAnalyticsClient()
      wireAnalyticsAuthTransition(store, client)

      // A sibling subscriber registered after analytics that throws.
      store.onAuthChanged(() => {
        throw new Error('sibling boom')
      })

      store.fire(makeToken({userId: 'user-A'}))
      await flushMicrotasks()

      expect(client.onAuthTransitionSpy.calledOnce, 'analytics callback must still fire despite sibling throw').to.equal(true)
    })
  })

  describe('seed behavior — previousUserId is read from the cached token at subscribe time', () => {
    it('does NOT fire onAuthTransition when the very first callback matches the cached userId', async () => {
      // Models the production sequence: AuthStateStore.loadToken() fires
      // onAuthChanged AFTER setupFeatureHandlers wired the analytics
      // subscriber. If the user was already authenticated, the first
      // callback delivers the SAME userId the wiring seeded from
      // `getToken()` — that's a no-op, not a transition.
      const initial = makeToken({accessToken: 'a1', userId: 'user-A'})
      const store = makeFakeAuthStateStore(initial)
      const client = makeFakeAnalyticsClient()
      wireAnalyticsAuthTransition(store, client)

      // Same userId, different accessToken (a typical loadToken-after-
      // wiring scenario when the daemon picked up an existing session).
      store.fire(makeToken({accessToken: 'a2', userId: 'user-A'}))
      await flushMicrotasks()

      expect(client.onAuthTransitionSpy.called, 'initial-cached-user must not trigger clear').to.equal(false)
    })
  })
})
