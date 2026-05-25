/**
 * Phase 9 / IMPLEMENTATION_PHASE_9 §5.1 — compute-DoS rate limit for
 * the parley handshake verifier.
 *
 * Keyed on the libp2p-Noise-authenticated `transportPeerId` (which an
 * attacker cannot spoof without the L1 private key), so frame-spoofing
 * under another peer's identity cannot lock out the legitimate peer.
 *
 * The wrapper is invoked PER reject path (steps 1–10 + any structured-
 * failure passthrough) per codex round-3 MEDIUM-1 + round-4 MEDIUM-1 —
 * malformed envelopes and timestamp-window rejects count too, so an
 * attacker can't drive cheap rejects without consequence.
 *
 * Defaults (configurable via `bridge.bad_sig_*`):
 *   - BAD_SIG_BURST = 20 failures within window → block
 *   - BAD_SIG_WINDOW_MS = 60_000 (1 min) — failure counter resets
 *     after this window of no further failures
 *   - BAD_SIG_COOLDOWN_MS = 300_000 (5 min) — block duration
 *
 * Test seam: `now()` is injectable so tests can advance the clock
 * without sleeping; `onBlock(transportPeerId)` is a callback the
 * server wires up to `libp2p.peerStore.tagPeer + hangUp`.
 */

export interface RateLimitConfig {
  readonly badSigBurst: number
  readonly badSigCooldownMs: number
  readonly badSigWindowMs: number
}

export const DEFAULT_RATE_LIMIT_CONFIG: RateLimitConfig = {
  badSigBurst: 20,
  badSigCooldownMs: 300 * 1000,
  badSigWindowMs: 60 * 1000,
}

export interface RateLimiterDeps {
  readonly config?: Partial<RateLimitConfig>
  readonly now?: () => number
  readonly onBlock?: (transportPeerId: string, cooldownMs: number) => void
}

interface Counter {
  blockedUntil: number
  failures: number
  windowStart: number
}

export class HandshakeRateLimiter {
  private readonly config: RateLimitConfig
  private readonly counters = new Map<string, Counter>()
  private readonly now: () => number
  private readonly onBlock?: (transportPeerId: string, cooldownMs: number) => void

  public constructor(deps: RateLimiterDeps = {}) {
    this.config = {...DEFAULT_RATE_LIMIT_CONFIG, ...deps.config}
    this.now = deps.now ?? (() => Date.now())
    this.onBlock = deps.onBlock
  }

  /** Test-only — drop all state. */
  public clear(): void {
    this.counters.clear()
  }

  /**
   * `true` if the peer is currently rate-limited and the verifier
   * should refuse to run on its envelopes (caller hangs up the
   * libp2p connection).
   */
  public isBlocked(transportPeerId: string): boolean {
    const counter = this.counters.get(transportPeerId)
    return counter !== undefined && this.now() < counter.blockedUntil
  }

  /**
   * Record a verifier failure for this peer. Returns `true` if the
   * peer just got blocked (caller should hang up); `false` otherwise.
   * Failures outside the rolling window reset the counter.
   */
  public recordFailure(transportPeerId: string): boolean {
    const t = this.now()
    let counter = this.counters.get(transportPeerId)
    if (!counter) {
      counter = {blockedUntil: 0, failures: 0, windowStart: t}
      this.counters.set(transportPeerId, counter)
    }

    if (t - counter.windowStart > this.config.badSigWindowMs) {
      counter.windowStart = t
      counter.failures = 0
    }

    counter.failures += 1
    if (counter.failures >= this.config.badSigBurst) {
      counter.blockedUntil = t + this.config.badSigCooldownMs
      this.onBlock?.(transportPeerId, this.config.badSigCooldownMs)
      return true
    }

    return false
  }
}
