/* eslint-disable camelcase */
// KnownPeer field names mirror AMENDMENT_TOFU §A3.3 on-disk JSON shape
// and are intentionally snake_case.

import {randomBytes} from 'node:crypto'
import {existsSync} from 'node:fs'
import {chmod, mkdir, readFile, rename, writeFile} from 'node:fs/promises'
import {dirname} from 'node:path'

import {withProcessLock} from './process-lock.js'

/**
 * Phase 9 / AMENDMENT_TOFU §A3.3 — local "known peers" store.
 *
 * One row per L1 peer this brv install has encountered. Records pin
 * state + CA-binding history. Backing file: `<dir>/known-peers.jsonl`,
 * mode 0600. Cross-process concurrency via flock (process-lock.ts).
 *
 * Reads are "be liberal": a single corrupt line is skipped, the rest
 * load. Writes are "be strict": rebuild the in-memory map, serialise,
 * atomic-rename. No append-only persistence — entries are updated in
 * place by peer_id, and append-only would let a stale value shadow a
 * fresh one on the next read.
 *
 * Integrity invariant (§A3.3 step 2): a peer_id is derived from its
 * pubkey, so two records with the same peer_id MUST have the same
 * install_cert_fingerprint. An upsert that violates this is rejected
 * with `TOFU_FINGERPRINT_MISMATCH`.
 */

// ─── types ──────────────────────────────────────────────────────────────────

export type PinState = 'auto-tofu' | 'ca-bound' | 'user-confirmed'

export interface CaBinding {
  readonly account_id: string
  readonly ca_cert_fingerprint: string
  readonly ca_log_entry_index: number
  readonly issued_at: string
  readonly operator_override?: {
    readonly accepted_at: string
    readonly ca_revoked_fingerprint: string
    readonly l2_fingerprint: string
    readonly operator_acknowledged_ca_revoked: true
  }
  readonly revoked_at?: string
  readonly revoked_reason?: string
  readonly tree_id: string
}

export interface KnownPeer {
  readonly ca_binding?: CaBinding
  readonly display_handle?: string
  readonly first_seen_at: string
  readonly install_cert_fingerprint: string
  /**
   * Phase 9 / Slice 9.4h — ISO datetime captured from the verified
   * L2 cert's `expires_at` field at pin time. Stored alongside
   * `l2_pub_key` so the daemon's L2 fast-path can reject a stale
   * cached pubkey instead of using it for years past its cert
   * expiry. Absent on pre-9.4h entries — `isL2CertExpired` treats
   * absent-but-pubkey-present as stale (force re-fetch).
   */
  readonly l2_expires_at?: string
  /**
   * Phase 9 / Slice 9.4d — base64 of the remote's L2 peer-tree
   * pubkey, captured during `fetchAndPin` when `fetchTreeCert: true`.
   * Used by the channel orchestrator's `inviteRemotePeerMember` to
   * skip the operator-supplied `--l2-pub-key` flag when the peer is
   * already pinned with full identity. Absent on legacy entries
   * (slice 9.2/9.3) that pinned via the install-cert-only path.
   */
  readonly l2_pub_key?: string
  readonly last_seen_at: string
  readonly peer_id: string
  readonly pin_state: PinState
}

export interface TofuStoreDeps {
  readonly storePath: string
}

// ─── store ──────────────────────────────────────────────────────────────────

const LOCK_SUFFIX = '.lock'

/**
 * Module-level in-process lock map, keyed by absolute store path. Two
 * TofuStore instances on the same file MUST share an in-process queue,
 * else they'd both try to acquire the cross-process flock concurrently
 * and either deadlock (same PID == still-held) or interleave their
 * read-modify-write cycles. This Map is the in-process serialiser; the
 * flock from process-lock.ts is the cross-process serialiser.
 */
const inProcessLocks = new Map<string, Promise<void>>()

const NOOP = (): void => {}

export class TofuStore {
  private readonly lockPath: string
  private readonly storePath: string

  public constructor(deps: TofuStoreDeps) {
    this.storePath = deps.storePath
    this.lockPath = `${deps.storePath}${LOCK_SUFFIX}`
  }

  /** Return one peer by peer_id, or `undefined` if not present. */
  public async get(peer_id: string): Promise<KnownPeer | undefined> {
    const peers = await this.list()
    return peers.find((p) => p.peer_id === peer_id)
  }

  /** Return all known peers. Skips corrupt lines. */
  public async list(): Promise<KnownPeer[]> {
    if (!existsSync(this.storePath)) return []
    const raw = await readFile(this.storePath, 'utf8')
    const peers: KnownPeer[] = []
    for (const line of raw.split('\n')) {
      const trimmed = line.trim()
      if (trimmed === '') continue
      try {
        const parsed = JSON.parse(trimmed) as KnownPeer
        // Minimum shape check — anything missing the required fields
        // is treated as corrupt and skipped.
        if (typeof parsed.peer_id !== 'string') continue
        if (typeof parsed.install_cert_fingerprint !== 'string') continue
        if (typeof parsed.pin_state !== 'string') continue
        peers.push(parsed)
      } catch {
        // Corrupt JSON — skip.
      }
    }

    return peers
  }

  /**
   * Insert or update a peer. Within ONE process, concurrent upserts
   * serialise via an internal promise chain. Across processes, flock
   * via process-lock.ts ensures atomic read-modify-write.
   *
   * Throws `TOFU_FINGERPRINT_MISMATCH` if the peer already exists
   * with a different install_cert_fingerprint (an attacker, a forge,
   * or an L1 regeneration the user hasn't acknowledged).
   */
  public async upsert(peer: KnownPeer): Promise<KnownPeer> {
    return this.runExclusive(async () => {
      const existing = await this.list()
      const idx = existing.findIndex((p) => p.peer_id === peer.peer_id)
      if (idx === -1) {
        existing.push(peer)
      } else {
        const prior = existing[idx]
        if (prior.install_cert_fingerprint !== peer.install_cert_fingerprint) {
          throw new Error(
            `TOFU_FINGERPRINT_MISMATCH: peer ${peer.peer_id} already pinned with a different install_cert_fingerprint ` +
            `(stored: ${prior.install_cert_fingerprint}, presented: ${peer.install_cert_fingerprint}); ` +
            `this is a structural integrity violation — investigate before re-pinning`,
          )
        }

        existing[idx] = peer
      }

      await this.writeAtomic(existing)
      return peer
    })
  }

  /**
   * Read-modify-write with merger running INSIDE the lock. Use this
   * when the new record depends on the prior record (e.g. preserving
   * `first_seen_at` or `pin_state` across a re-pin). The merger gets
   * the post-flock snapshot of the existing entry, so concurrent
   * pin-state upgrades from another upsert won't be silently
   * overwritten (kimi round-1 MEDIUM — TOCTOU race fix).
   *
   * The returned record is fingerprint-checked against any prior
   * record exactly like `upsert(peer)`, so `TOFU_FINGERPRINT_MISMATCH`
   * semantics are identical.
   */
  public async upsertWithMerge(
    peer_id: string,
    merge: (existing: KnownPeer | undefined) => KnownPeer,
  ): Promise<KnownPeer> {
    return this.runExclusive(async () => {
      const existing = await this.list()
      const idx = existing.findIndex((p) => p.peer_id === peer_id)
      const prior = idx === -1 ? undefined : existing[idx]
      const merged = merge(prior)
      if (merged.peer_id !== peer_id) {
        throw new Error(
          `TOFU_MERGE_MISMATCH: merger returned peer_id ${merged.peer_id} but operation was scoped to ${peer_id}`,
        )
      }

      if (prior && prior.install_cert_fingerprint !== merged.install_cert_fingerprint) {
        throw new Error(
          `TOFU_FINGERPRINT_MISMATCH: peer ${peer_id} already pinned with a different install_cert_fingerprint ` +
          `(stored: ${prior.install_cert_fingerprint}, presented: ${merged.install_cert_fingerprint}); ` +
          `this is a structural integrity violation — investigate before re-pinning`,
        )
      }

      if (idx === -1) existing.push(merged)
      else existing[idx] = merged
      await this.writeAtomic(existing)
      return merged
    })
  }

  /**
   * Serialise the body against (a) the module-level in-process queue
   * keyed by storePath, AND (b) the cross-process flock. The two
   * layers together guarantee atomic read-modify-write regardless of
   * whether contention is in-process or cross-process.
   */
  private async runExclusive<T>(body: () => Promise<T>): Promise<T> {
    const previous = inProcessLocks.get(this.storePath) ?? Promise.resolve()
    let resolveSelf: () => void = NOOP
    const current = new Promise<void>((r) => { resolveSelf = r })
    inProcessLocks.set(this.storePath, current)
    try {
      await previous
      await mkdir(dirname(this.storePath), {mode: 0o700, recursive: true})
      return await withProcessLock(this.lockPath, body)
    } finally {
      resolveSelf()
      // Clean up the map entry if no further operations are pending
      // (the entry we just set IS the tail).
      if (inProcessLocks.get(this.storePath) === current) {
        inProcessLocks.delete(this.storePath)
      }
    }
  }

  private async writeAtomic(peers: KnownPeer[]): Promise<void> {
    const body = peers.map((p) => JSON.stringify(p)).join('\n') + (peers.length > 0 ? '\n' : '')
    const tmp = `${this.storePath}.tmp.${process.pid}.${randomBytes(4).toString('hex')}`
    await writeFile(tmp, body, {encoding: 'utf8', mode: 0o600})
    await rename(tmp, this.storePath)
    if (process.platform !== 'win32') {
      await chmod(this.storePath, 0o600)
    }
  }
}
