/**
 * Phase 9 / Slice 9.7 — ByteRover registry client (HTTP handle → record).
 *
 * The fallback discovery path for installs that don't run DHT (mobile,
 * heavily-firewalled, fresh-install). The registry maps a
 * `display_handle` (e.g. `alice@byterover.dev`) to a signed record
 * containing the install's `peer_id` + current multiaddrs. The
 * resolver consults this when DHT returns no records (composite
 * resolver — see `peer-multiaddr-resolver.ts`).
 *
 * Per spec §6.4 D2 the registry is the OPT-IN fallback; the daemon
 * runs without one by default. Operators set `bridge.registry_url`
 * to enable it.
 *
 * **Scope of this slice**: ship the interface + a no-op default +
 * the integration seam in CompositePeerMultiaddrResolver. The
 * actual HTTP client (with auth, retry, response-record signature
 * verification against the ByteRover root cert) lands when the
 * registry endpoint is deployed. This slice does NOT install any
 * HTTP machinery — `NoopRegistryClient` returns `undefined` for
 * every lookup.
 */

export type Multiaddr = string

export type RegistryRecord = {
  readonly displayHandle: string
  readonly multiaddrs: readonly Multiaddr[]
  readonly peerId: string
  /** ISO datetime — when the record was published by the install. */
  readonly publishedAt: string
}

export interface RegistryClient {
  close(): Promise<void>
  lookupByHandle(displayHandle: string): Promise<RegistryRecord | undefined>
  /**
   * Look up the record bound to `peerId`.
   *
   * **Self-consistency requirement (kimi round-1 LOW):**
   * implementations MUST verify that the returned
   * `record.peerId === peerId` before returning, AND that
   * `record.displayHandle` belongs to the same peer_id by the
   * registry's own signature scheme. A buggy or malicious server
   * could otherwise return a record with a different `peerId`
   * field — without this check, downstream resolvers would
   * propagate the wrong multiaddrs as if they belonged to the
   * queried peer, breaking parley's `peer_id ↔ multiaddr`
   * authentication invariant at the libp2p Noise layer.
   */
  lookupByPeerId(peerId: string): Promise<RegistryRecord | undefined>
  /**
   * Push a record for the local install. Throws `REGISTRY_NOT_CONFIGURED`
   * on the no-op default (registry feature off). Real implementation
   * signs the record with the L1 install key and POSTs it to
   * `registry_url`.
   */
  publish(record: RegistryRecord): Promise<void>
}

export class NoopRegistryClient implements RegistryClient {
  public async close(): Promise<void> {}

  public async lookupByHandle(_displayHandle: string): Promise<RegistryRecord | undefined> {
    return undefined
  }

  public async lookupByPeerId(_peerId: string): Promise<RegistryRecord | undefined> {
    return undefined
  }

  public async publish(_record: RegistryRecord): Promise<void> {
    throw new Error(
      'REGISTRY_NOT_CONFIGURED: set `bridge.registry_url` in your bridge config to enable registry publishing',
    )
  }
}
