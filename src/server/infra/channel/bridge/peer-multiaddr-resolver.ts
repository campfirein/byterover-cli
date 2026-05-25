/**
 * Phase 9 / Slice 9.6 — peer multiaddr resolver abstraction.
 *
 * The bridge needs to convert a libp2p `peer_id` into a current set
 * of dialable multiaddrs. Today the daemon only knows the
 * `ChannelMemberRemotePeer.multiaddr` field that was pinned at
 * invite time — if Bob's IP rotates, Alice's stored multiaddr goes
 * stale and mentions fail.
 *
 * The spec (§6.4 D2) locks **DHT as primary** + **ByteRover registry
 * as fallback** for resolution. Real DHT integration requires the
 * `@libp2p/kad-dht` package wired into the libp2p host, plus signed
 * peer-record publishing on an `announce_interval_hours` cadence.
 * That integration is operator-side opt-in (it changes the host's
 * network footprint), so 9.6 ships the INTERFACE only; a future
 * commit adds the kad-dht implementation behind the same seam.
 *
 * Until a real resolver is wired, the daemon uses
 * `NoopPeerMultiaddrResolver` which returns no addresses for any
 * peer_id. Callers must treat `resolve()` returning an empty array
 * as "no fresh multiaddrs available — fall back to the cached
 * member.multiaddr or surface a clear error to the operator."
 */

import type {RegistryClient} from './registry-client.js'

/**
 * String alias for the libp2p multiaddr wire form. Kept as a
 * string (not the `@multiformats/multiaddr` Multiaddr class) so the
 * abstraction layer doesn't force a libp2p dep on every caller.
 *
 * **Implementations MUST validate format before use** — typical
 * shape is `/ip4/<ip>/tcp/<port>/p2p/<peer-id>` per libp2p
 * conventions. A KadDhtPeerMultiaddrResolver should reject malformed
 * results from the DHT before returning them; a HttpRegistryClient
 * should reject malformed records from the registry endpoint.
 * Callers (parley dialers) treat the returned array as best-effort
 * and surface a dial failure if every entry is malformed.
 */
export type Multiaddr = string

/**
 * Per-backend `publish()` result emitted by
 * `CompositePeerMultiaddrResolver.publishWithResults()`. Lets the
 * daemon's background announce loop log per-backend failure
 * (broken `registry_url`, DHT node not bootstrapped, etc.) instead
 * of seeing a silent void (kimi round-1 MED).
 */
export type PublishResult = {
  readonly backend: string
  readonly error?: unknown
  readonly ok: boolean
}

export interface IPeerMultiaddrResolver {
  /**
   * Drop any in-memory caches and release any libp2p subscriptions.
   * Safe to call multiple times.
   */
  close(): Promise<void>
  /**
   * Publish (announce) the local install's current set of dialable
   * multiaddrs to the discovery layer. The real implementation will
   * sign a libp2p peer-record with the L1 install key. Called by
   * the daemon on a background timer per
   * `bridge.announce_interval_hours`.
   */
  publish(addrs: readonly Multiaddr[]): Promise<void>
  /**
   * Look up the current dialable multiaddrs for a peer_id. Returns
   * an empty array when:
   *   - the resolver has no knowledge of the peer (DHT query
   *     returned no records, registry returned 404, etc.)
   *   - the resolver is the no-op default
   *
   * Callers should not retry on empty — that's the resolver's job.
   */
  resolve(peerId: string): Promise<readonly Multiaddr[]>
}

export class NoopPeerMultiaddrResolver implements IPeerMultiaddrResolver {
  public async close(): Promise<void> {}

  public async publish(_addrs: readonly Multiaddr[]): Promise<void> {}

  public async resolve(_peerId: string): Promise<readonly Multiaddr[]> {
    return []
  }
}

/**
 * Phase 9 / Slice 9.6 + 9.7 — composite resolver that tries each
 * configured backend in priority order. Used to layer "DHT primary,
 * registry fallback" (spec §6.4 D2) without baking the policy into
 * either backend.
 *
 * Resolution: walks resolvers in order; returns the FIRST non-empty
 * result. Per-backend throws are caught and treated as empty so a
 * misconfigured backend doesn't block the chain. **However**, if
 * EVERY backend throws, the composite re-throws the first error
 * instead of returning a silent empty — operators need to see the
 * primary misconfiguration when no fallback can succeed (kimi
 * round-1 MED).
 *
 * Publish: fan-out to every backend; individual failures are caught
 * and swallowed in `publish()` (best-effort fan-out semantics). For
 * callers that need per-backend visibility (the daemon's background
 * announce loop), `publishWithResults()` returns structured per-
 * backend success/error so failures can be logged or alerted
 * (kimi round-1 MED).
 */
export class CompositePeerMultiaddrResolver implements IPeerMultiaddrResolver {
  private readonly resolvers: readonly IPeerMultiaddrResolver[]

  public constructor(resolvers: readonly IPeerMultiaddrResolver[]) {
    this.resolvers = resolvers
  }

  public async close(): Promise<void> {
    // Per-backend close failures are swallowed so a misbehaving
    // backend can't block daemon shutdown.
    await Promise.allSettled(this.resolvers.map((r) => r.close()))
  }

  public async publish(addrs: readonly Multiaddr[]): Promise<void> {
    await this.publishWithResults(addrs)
  }

  /**
   * Variant of `publish` that returns per-backend success/error so
   * the caller can log or alert on partial failure. Used by the
   * daemon's background announce loop.
   */
  public async publishWithResults(addrs: readonly Multiaddr[]): Promise<readonly PublishResult[]> {
    const results = await Promise.allSettled(this.resolvers.map((r) => r.publish(addrs)))
    return results.map((r, i) => {
      const backend = this.resolvers[i].constructor.name
      if (r.status === 'fulfilled') return {backend, ok: true}
      return {backend, error: r.reason, ok: false}
    })
  }

  public async resolve(peerId: string): Promise<readonly Multiaddr[]> {
    // kimi round-1 MED — track the first error so we can re-throw
    // it if every backend fails (no silent empty).
    let firstError: unknown
    let allThrew = true
    for (const r of this.resolvers) {
      let result: readonly Multiaddr[] = []
      try {
        // eslint-disable-next-line no-await-in-loop
        result = await r.resolve(peerId)
        allThrew = false
      } catch (error) {
        if (firstError === undefined) firstError = error
        continue
      }

      if (result.length > 0) return result
    }

    if (allThrew && this.resolvers.length > 0 && firstError !== undefined) {
      throw firstError
    }

    return []
  }
}

/**
 * Phase 9 / Slice 9.7 — adapter that wraps a `RegistryClient` to
 * satisfy the resolver interface.
 *
 * **Publish semantics (kimi round-1 NIT):** `publish()` is a
 * deliberate no-op on the registry side because registration is
 * operator-initiated via a future `brv bridge register` CLI verb
 * (not auto-fired on every announce tick). The `CompositePeerMultiaddrResolver`
 * still calls into this no-op as part of its publish fan-out, which
 * is harmless — the registry record is published separately by the
 * operator after they've explicitly chosen to register.
 *
 * **Self-consistency requirement (kimi round-1 LOW):**
 * implementations of `RegistryClient.lookupByPeerId(peerId)` MUST
 * verify that the returned `record.peerId === queriedPeerId`
 * before returning. A buggy or malicious server could otherwise
 * return a record bound to a different peer_id, and this adapter
 * would propagate the wrong multiaddrs as if they belonged to the
 * queried peer.
 */
export class RegistryPeerMultiaddrResolver implements IPeerMultiaddrResolver {
  private readonly client: RegistryClient

  public constructor(client: RegistryClient) {
    this.client = client
  }

  public async close(): Promise<void> {
    await this.client.close()
  }

  public async publish(_addrs: readonly Multiaddr[]): Promise<void> {
    // Intentional no-op — see class docstring.
  }

  public async resolve(peerId: string): Promise<readonly Multiaddr[]> {
    const record = await this.client.lookupByPeerId(peerId)
    return record === undefined ? [] : record.multiaddrs
  }
}
