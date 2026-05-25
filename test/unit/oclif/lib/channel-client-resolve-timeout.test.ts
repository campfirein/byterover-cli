import {expect} from 'chai'

import {resolveRequestTimeoutMs} from '../../../../src/oclif/lib/channel-client.js'

// Slice 9.7 (codex D6) — unit-test the timeout resolver extracted from
// `request()`. The Bug 1 regression to catch: a future refactor
// reintroduces a hardcoded 60s that ignores both per-call `options.timeoutMs`
// and the `BRV_CHANNEL_REQUEST_TIMEOUT_MS` env override.
//
// The Slice 8.0.2 integration test catches the "env-default fallback"
// branch end-to-end (real CLI → real daemon → real mock-ACP). This
// suite covers the resolution logic itself across all branches without
// needing a daemon or fake timers.

describe('resolveRequestTimeoutMs (Slice 9.7 — codex D6)', () => {
  describe('per-call options.timeoutMs branch (wins over everything)', () => {
    it('returns the per-call value when defined and positive', () => {
      expect(resolveRequestTimeoutMs({timeoutMs: 30_000}, {})).to.equal(30_000)
    })

    it('per-call value overrides env, even when env is also valid', () => {
      expect(
        resolveRequestTimeoutMs(
          {timeoutMs: 30_000},
          {BRV_CHANNEL_REQUEST_TIMEOUT_MS: '5000'},
        ),
      ).to.equal(30_000)
    })

    it('per-call value > 60s wins over the 60s default (Bug 1 core)', () => {
      // The literal regression: pre-fix the CLI ignored per-call values
      // and capped at 60s. This assertion fires if anyone reintroduces
      // the hardcoded cap.
      expect(resolveRequestTimeoutMs({timeoutMs: 300_000}, {})).to.equal(300_000)
    })

    it('falls through when timeoutMs is undefined', () => {
      expect(resolveRequestTimeoutMs({}, {})).to.equal(60_000)
    })

    it('falls through when timeoutMs is 0 (treats 0 as "no override")', () => {
      expect(resolveRequestTimeoutMs({timeoutMs: 0}, {})).to.equal(60_000)
    })

    it('falls through when timeoutMs is negative (treats negative as invalid)', () => {
      expect(resolveRequestTimeoutMs({timeoutMs: -1}, {})).to.equal(60_000)
    })

    it('handles an undefined options object', () => {
      expect(resolveRequestTimeoutMs(undefined, {})).to.equal(60_000)
    })
  })

  describe('env branch', () => {
    it('returns the parsed env value when no per-call override', () => {
      expect(
        resolveRequestTimeoutMs({}, {BRV_CHANNEL_REQUEST_TIMEOUT_MS: '15000'}),
      ).to.equal(15_000)
    })

    it('handles whitespace around the env value', () => {
      expect(
        resolveRequestTimeoutMs({}, {BRV_CHANNEL_REQUEST_TIMEOUT_MS: '  15000  '}),
      ).to.equal(15_000)
    })

    it('falls back to default on empty env string', () => {
      expect(resolveRequestTimeoutMs({}, {BRV_CHANNEL_REQUEST_TIMEOUT_MS: ''})).to.equal(60_000)
    })

    it('falls back to default on whitespace-only env value', () => {
      expect(resolveRequestTimeoutMs({}, {BRV_CHANNEL_REQUEST_TIMEOUT_MS: '   '})).to.equal(60_000)
    })

    it('falls back to default on unparseable env value', () => {
      expect(resolveRequestTimeoutMs({}, {BRV_CHANNEL_REQUEST_TIMEOUT_MS: 'banana'})).to.equal(
        60_000,
      )
    })

    it('falls back to default on zero env value', () => {
      expect(resolveRequestTimeoutMs({}, {BRV_CHANNEL_REQUEST_TIMEOUT_MS: '0'})).to.equal(60_000)
    })

    it('falls back to default on negative env value', () => {
      expect(resolveRequestTimeoutMs({}, {BRV_CHANNEL_REQUEST_TIMEOUT_MS: '-500'})).to.equal(
        60_000,
      )
    })
  })

  describe('default branch', () => {
    it('returns 60_000ms when neither per-call nor env is set', () => {
      expect(resolveRequestTimeoutMs(undefined, {})).to.equal(60_000)
    })
  })
})
