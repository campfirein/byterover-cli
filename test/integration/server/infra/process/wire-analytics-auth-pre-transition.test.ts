import {expect} from 'chai'
import {stub} from 'sinon'

import type {IAnalyticsClient} from '../../../../../src/server/core/interfaces/analytics/i-analytics-client.js'
import type {
  AuthChangedCallback,
  AuthExpiredCallback,
  BeforeAuthChangedCallback,
  IAuthStateStore,
} from '../../../../../src/server/core/interfaces/state/i-auth-state-store.js'

import {AnalyticsBatch} from '../../../../../src/server/core/domain/analytics/batch.js'
import {AuthToken} from '../../../../../src/server/core/domain/entities/auth-token.js'
import {wireAnalyticsAuthPreTransition} from '../../../../../src/server/infra/process/wire-analytics-auth-pre-transition.js'

/**
 * Integration test for the M4.4 auth pre-transition wiring.
 *
 * The pre-hook fires BEFORE `AuthStateStore.cachedToken` mutates, so a
 * `flush()` invoked here ships pending events under the OLD session
 * header. Without this ordering the events would carry old per-event
 * identity but new request-level session, tripping the backend's
 * identity-mismatch path.
 *
 * Same identity-change distinguisher as the M4.1 post-transition wiring
 * (`wire-analytics-auth-transition.ts`):
 *   - login (anon → auth)       → flush
 *   - logout (auth → anon)      → flush
 *   - account switch (A → B)    → flush
 *   - access-token refresh      → SKIP (same userId)
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

function makeFakeAuthStateStore(initial?: AuthToken): IAuthStateStore & {
  fire(oldToken?: AuthToken, newToken?: AuthToken): Promise<void>
  readonly preCallbacks: BeforeAuthChangedCallback[]
} {
  const preCallbacks: BeforeAuthChangedCallback[] = []
  const cached: AuthToken | undefined = initial
  return {
    // Optional params let callers omit either slot for anon-side
    // transitions without triggering `unicorn/no-useless-undefined`
    // autofix to strip the literal `undefined` we'd otherwise pass.
    async fire(oldToken?: AuthToken, newToken?: AuthToken): Promise<void> {
      // Serial execution mirrors AuthStateStore.fireBeforeAuthChange.
      for (const cb of preCallbacks) {
        // eslint-disable-next-line no-await-in-loop
        await cb(oldToken, newToken)
      }
    },
    getToken: () => cached,
    loadToken: async () => cached,
    onAuthChanged(_cb: AuthChangedCallback): void {
      // not exercised here
    },
    onAuthExpired(_cb: AuthExpiredCallback): void {
      // not exercised here
    },
    onBeforeAuthChange(cb: BeforeAuthChangedCallback): void {
      preCallbacks.push(cb)
    },
    preCallbacks,
    startPolling(): void {
      // not exercised here
    },
    stopPolling(): void {
      // not exercised here
    },
  }
}

function makeFakeAnalyticsClient(): IAnalyticsClient & {
  flushSpy: ReturnType<typeof stub>
} {
  const flushSpy = stub().resolves(AnalyticsBatch.create([]))
  return {
    abort() {
      /* M4.4: not exercised in this test */
    },
    flush: flushSpy,
    flushSpy,
    onAuthTransition: stub().resolves(),
    track(): void {
      // intentional no-op
    },
  }
}

describe('M4.4 wireAnalyticsAuthPreTransition (integration)', () => {
  describe('identity change → flush', () => {
    it('fires flush on login (anon → authenticated)', async () => {
      const store = makeFakeAuthStateStore() // initial: undefined
      const client = makeFakeAnalyticsClient()
      wireAnalyticsAuthPreTransition(store, client)

      await store.fire(undefined, makeToken({userId: 'user-A'}))

      expect(client.flushSpy.calledOnce, 'flush must fire on login').to.equal(true)
    })

    it('fires flush on logout (authenticated → anon)', async () => {
      const store = makeFakeAuthStateStore(makeToken({userId: 'user-A'}))
      const client = makeFakeAnalyticsClient()
      wireAnalyticsAuthPreTransition(store, client)

      await store.fire(makeToken({userId: 'user-A'}))

      expect(client.flushSpy.calledOnce, 'flush must fire on logout').to.equal(true)
    })

    it('fires flush on account switch (userA → userB)', async () => {
      const store = makeFakeAuthStateStore(makeToken({userId: 'user-A'}))
      const client = makeFakeAnalyticsClient()
      wireAnalyticsAuthPreTransition(store, client)

      await store.fire(makeToken({userId: 'user-A'}), makeToken({accessToken: 'access-B', userId: 'user-B'}))

      expect(client.flushSpy.calledOnce, 'flush must fire on account switch').to.equal(true)
    })
  })

  describe('token refresh → skip', () => {
    it('does NOT fire flush when accessToken changes but userId is unchanged', async () => {
      const store = makeFakeAuthStateStore(makeToken({accessToken: 'a1', userId: 'user-A'}))
      const client = makeFakeAnalyticsClient()
      wireAnalyticsAuthPreTransition(store, client)

      await store.fire(
        makeToken({accessToken: 'a1', userId: 'user-A'}),
        makeToken({accessToken: 'a2', userId: 'user-A'}),
      )

      expect(client.flushSpy.called, 'token refresh must NOT trigger pre-flush').to.equal(false)
    })

    it('skips a series of refreshes for the same user', async () => {
      const store = makeFakeAuthStateStore(makeToken({userId: 'user-A'}))
      const client = makeFakeAnalyticsClient()
      wireAnalyticsAuthPreTransition(store, client)

      await store.fire(makeToken({accessToken: 'a1', userId: 'user-A'}), makeToken({accessToken: 'a2', userId: 'user-A'}))
      await store.fire(makeToken({accessToken: 'a2', userId: 'user-A'}), makeToken({accessToken: 'a3', userId: 'user-A'}))
      await store.fire(makeToken({accessToken: 'a3', userId: 'user-A'}), makeToken({accessToken: 'a4', userId: 'user-A'}))

      expect(client.flushSpy.callCount).to.equal(0)
    })
  })

  describe('failure resilience', () => {
    it('does NOT propagate flush() rejection (auth transition must not be blocked)', async () => {
      const store = makeFakeAuthStateStore()
      const client = makeFakeAnalyticsClient()
      client.flushSpy.rejects(new Error('flush boom'))
      wireAnalyticsAuthPreTransition(store, client)

      // If the listener propagated the error, this `await store.fire(...)` would reject.
      await store.fire(undefined, makeToken({userId: 'user-A'}))

      expect(client.flushSpy.calledOnce, 'flush still attempted').to.equal(true)
    })
  })
})
