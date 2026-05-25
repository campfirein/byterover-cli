/**
 * Phase 9 / IMPLEMENTATION_PHASE_9 §5.1 step 6 — per-sender handshake
 * nonce replay-protection LRU.
 *
 * Keyed on `(transportPeerId, nonceBase64)`. An attacker who tries to
 * replay an old handshake (same install_cert / handshake.signature /
 * nonce) hits a `HANDSHAKE_REPLAY` reject. The LRU is bounded so an
 * attacker spamming distinct nonces cannot grow it without bound; the
 * oldest entries are evicted by sender once the per-sender cap is hit.
 *
 * Per-sender capacity is deliberately small (default 256 entries) so a
 * single hostile peer cannot exhaust memory; cross-sender attacks are
 * blocked by the rate-limit wrapper that hangs up the peer after
 * `BAD_SIG_BURST` failures.
 *
 * The LRU is process-scoped and ephemeral. Daemon restart clears it,
 * which is fine: an attacker who captured a nonce will still hit the
 * handshake's `ts` window check (5-min default) before the LRU even
 * matters, and the `ts` window survives restart because it's clock-
 * driven.
 */

export interface NonceLruDeps {
  readonly perSenderCapacity?: number
}

const DEFAULT_PER_SENDER_CAPACITY = 256

export class NonceLru {
  private readonly perSenderCapacity: number
  private readonly senders = new Map<string, Map<string, true>>()

  public constructor(deps: NonceLruDeps = {}) {
    this.perSenderCapacity = deps.perSenderCapacity ?? DEFAULT_PER_SENDER_CAPACITY
  }

  /** Test-only — drop all state. */
  public clear(): void {
    this.senders.clear()
  }

  /** True if `(transportPeerId, nonce)` has been seen before. Does NOT insert. */
  public has(transportPeerId: string, nonce: string): boolean {
    const inner = this.senders.get(transportPeerId)
    return inner !== undefined && inner.has(nonce)
  }

  /**
   * Record a nonce as seen. Evicts the oldest entry for this sender
   * once `perSenderCapacity` is reached (JS Map preserves insertion
   * order, so deleting the first key drops the oldest).
   */
  public insert(transportPeerId: string, nonce: string): void {
    let inner = this.senders.get(transportPeerId)
    if (!inner) {
      inner = new Map()
      this.senders.set(transportPeerId, inner)
    }

    if (inner.size >= this.perSenderCapacity) {
      const oldest = inner.keys().next().value
      if (oldest !== undefined) inner.delete(oldest)
    }

    inner.set(nonce, true)
  }
}
