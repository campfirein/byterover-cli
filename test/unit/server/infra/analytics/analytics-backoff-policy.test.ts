import {expect} from 'chai'

import {AnalyticsBackoffPolicy} from '../../../../../src/server/infra/analytics/analytics-backoff-policy.js'

/**
 * M4.5 backoff policy: 30s → 60s → 2m → 5m, cap at 5m. First success
 * resets to 30s. Reachability state (healthy / degraded / unreachable)
 * is derived from `consecutiveFailures()` by M4.6, not exposed here.
 */
describe('AnalyticsBackoffPolicy (M4.5)', () => {
  describe('initial state', () => {
    it('starts at 30s with zero consecutive failures', () => {
      const policy = new AnalyticsBackoffPolicy()
      expect(policy.nextDelayMs(), 'base interval is 30s').to.equal(30_000)
      expect(policy.consecutiveFailures()).to.equal(0)
    })

    it('repeated nextDelayMs() calls do NOT advance the policy (read-only)', () => {
      const policy = new AnalyticsBackoffPolicy()
      expect(policy.nextDelayMs()).to.equal(30_000)
      expect(policy.nextDelayMs()).to.equal(30_000)
      expect(policy.consecutiveFailures(), 'reading state must not mutate').to.equal(0)
    })
  })

  describe('exponential backoff schedule', () => {
    it('after 1 failure: 60s', () => {
      const policy = new AnalyticsBackoffPolicy()
      policy.onFailure()
      expect(policy.nextDelayMs()).to.equal(60_000)
      expect(policy.consecutiveFailures()).to.equal(1)
    })

    it('after 2 failures: 2 minutes (120s)', () => {
      const policy = new AnalyticsBackoffPolicy()
      policy.onFailure()
      policy.onFailure()
      expect(policy.nextDelayMs()).to.equal(120_000)
      expect(policy.consecutiveFailures()).to.equal(2)
    })

    it('after 3 failures: 5 minutes (300s)', () => {
      const policy = new AnalyticsBackoffPolicy()
      policy.onFailure()
      policy.onFailure()
      policy.onFailure()
      expect(policy.nextDelayMs()).to.equal(300_000)
      expect(policy.consecutiveFailures()).to.equal(3)
    })

    it('after 4 failures: still 5 minutes (capped)', () => {
      const policy = new AnalyticsBackoffPolicy()
      for (let i = 0; i < 4; i++) policy.onFailure()
      expect(policy.nextDelayMs(), 'cap holds at 5m').to.equal(300_000)
      expect(policy.consecutiveFailures()).to.equal(4)
    })

    it('after many failures: still capped at 5 minutes, counter keeps growing', () => {
      const policy = new AnalyticsBackoffPolicy()
      for (let i = 0; i < 50; i++) policy.onFailure()
      expect(policy.nextDelayMs()).to.equal(300_000)
      expect(policy.consecutiveFailures(), 'counter is unbounded for reachability classification').to.equal(50)
    })
  })

  describe('reset on success', () => {
    it('onSuccess() from clean state stays at 30s with zero failures', () => {
      const policy = new AnalyticsBackoffPolicy()
      policy.onSuccess()
      expect(policy.nextDelayMs()).to.equal(30_000)
      expect(policy.consecutiveFailures()).to.equal(0)
    })

    it('onSuccess() after 1 failure resets to 30s with zero failures', () => {
      const policy = new AnalyticsBackoffPolicy()
      policy.onFailure()
      policy.onSuccess()
      expect(policy.nextDelayMs()).to.equal(30_000)
      expect(policy.consecutiveFailures()).to.equal(0)
    })

    it('onSuccess() after the cap resets to 30s with zero failures', () => {
      const policy = new AnalyticsBackoffPolicy()
      for (let i = 0; i < 10; i++) policy.onFailure()
      expect(policy.nextDelayMs()).to.equal(300_000)
      policy.onSuccess()
      expect(policy.nextDelayMs(), 'cap-then-success must drop straight to 30s').to.equal(30_000)
      expect(policy.consecutiveFailures()).to.equal(0)
    })

    it('failure-success-failure pattern advances from the base, not the prior peak', () => {
      const policy = new AnalyticsBackoffPolicy()
      policy.onFailure()
      policy.onFailure()
      expect(policy.nextDelayMs()).to.equal(120_000)
      policy.onSuccess()
      policy.onFailure()
      expect(policy.nextDelayMs(), 'after success we start the schedule fresh').to.equal(60_000)
    })
  })

  describe('reachability counter (M4.6 will derive labels from this)', () => {
    it('counter starts at 0 → healthy zone', () => {
      const policy = new AnalyticsBackoffPolicy()
      expect(policy.consecutiveFailures()).to.equal(0)
    })

    it('counter at 1-2 → degraded zone (M4.6 mapping)', () => {
      const policy = new AnalyticsBackoffPolicy()
      policy.onFailure()
      expect(policy.consecutiveFailures(), '1 failure').to.equal(1)
      policy.onFailure()
      expect(policy.consecutiveFailures(), '2 failures').to.equal(2)
    })

    it('counter at 3+ → unreachable zone (M4.6 mapping)', () => {
      const policy = new AnalyticsBackoffPolicy()
      for (let i = 0; i < 3; i++) policy.onFailure()
      expect(policy.consecutiveFailures()).to.equal(3)
    })

    it('onSuccess() returns counter to 0 (unreachable → healthy)', () => {
      const policy = new AnalyticsBackoffPolicy()
      for (let i = 0; i < 5; i++) policy.onFailure()
      expect(policy.consecutiveFailures()).to.equal(5)
      policy.onSuccess()
      expect(policy.consecutiveFailures(), 'first success collapses any unreachable count').to.equal(0)
    })
  })
})
