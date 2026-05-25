/* eslint-disable camelcase */
// TOFU + KnownPeer wire fields use snake_case to match the on-disk
// schema (AMENDMENT_TOFU §A3.2). Disabled at file scope.

import {expect} from 'chai'
import {mkdtemp, rm} from 'node:fs/promises'
import {tmpdir} from 'node:os'
import {join} from 'node:path'

import type {KnownPeer} from '../../../../../src/agent/core/trust/tofu-store.js'

import {TofuStore} from '../../../../../src/agent/core/trust/tofu-store.js'
import {loadPinnedPeer, verifyPin, VerifyPinError, type VerifyPinTofuStore} from '../../../../../src/agent/core/trust/verify-pin.js'

// Phase 9 / Slice 9.4g — `brv bridge verify` promotes a pinned peer
// from `auto-tofu` → `user-confirmed` so the `pinned-only` auto-
// provision policy (default per spec §7.3) can accept inbound parley
// queries from that peer.

const buildPeer = (overrides: Partial<KnownPeer> = {}): KnownPeer => ({
  first_seen_at: '2026-05-19T00:00:00.000Z',
  install_cert_fingerprint: 'a'.repeat(64),
  last_seen_at: '2026-05-19T00:00:00.000Z',
  peer_id: '12D3KooWAlice1111111111111111111111111111111',
  pin_state: 'auto-tofu',
  ...overrides,
})

describe('verifyPin (slice 9.4g)', () => {
  let tmp: string
  let storePath: string

  beforeEach(async () => {
    tmp = await mkdtemp(join(tmpdir(), 'verify-pin-test-'))
    storePath = join(tmp, 'known-peers.jsonl')
  })

  afterEach(async () => {
    await rm(tmp, {force: true, recursive: true})
  })

  it('promotes an auto-tofu peer to user-confirmed', async () => {
    const tofu = new TofuStore({storePath})
    const original = buildPeer()
    await tofu.upsert(original)

    const promoted = await verifyPin({peerId: original.peer_id, tofu})

    expect(promoted.pin_state).to.equal('user-confirmed')
    expect(promoted.install_cert_fingerprint).to.equal(original.install_cert_fingerprint)
    expect(promoted.first_seen_at).to.equal(original.first_seen_at)
    // last_seen_at is preserved (verify does NOT touch it; only re-pin updates it).
    expect(promoted.last_seen_at).to.equal(original.last_seen_at)
  })

  it('is idempotent — verifying an already user-confirmed peer is a no-op success', async () => {
    const tofu = new TofuStore({storePath})
    const original = buildPeer({pin_state: 'user-confirmed'})
    await tofu.upsert(original)

    const result = await verifyPin({peerId: original.peer_id, tofu})

    expect(result.pin_state).to.equal('user-confirmed')
    const stored = await tofu.get(original.peer_id)
    expect(stored!.pin_state).to.equal('user-confirmed')
  })

  it('refuses to "downgrade" a ca-bound peer — returns the peer unchanged', async () => {
    const tofu = new TofuStore({storePath})
    const original = buildPeer({
      ca_binding: {
        account_id: 'acct-1',
        ca_cert_fingerprint: 'b'.repeat(64),
        ca_log_entry_index: 42,
        issued_at: '2026-05-19T00:00:00.000Z',
        tree_id: 'tree-1',
      },
      pin_state: 'ca-bound',
    })
    await tofu.upsert(original)

    const result = await verifyPin({peerId: original.peer_id, tofu})

    // ca-bound is strictly stronger than user-confirmed in the policy
    // ordering, so verify is a no-op rather than a downgrade.
    expect(result.pin_state).to.equal('ca-bound')
  })

  it('throws VerifyPinError when the peer is not in the TOFU store', async () => {
    const tofu = new TofuStore({storePath})
    try {
      await verifyPin({peerId: '12D3KooWUnknown', tofu})
      expect.fail('expected VerifyPinError')
    } catch (error) {
      expect(error).to.be.instanceOf(VerifyPinError)
      expect((error as VerifyPinError).code).to.equal('PEER_NOT_PINNED')
    }
  })

  it('propagates an unexpected TofuStore failure unchanged (kimi round-1 LOW-3)', async () => {
    // Simulate a store-level I/O error by injecting a tofu stub
    // whose upsertWithMerge rejects with a generic Error. verifyPin
    // should NOT swallow it; the caller decides how to surface
    // "disk full" / "EACCES" etc. Mock structurally satisfies
    // VerifyPinTofuStore so we don't need an `as` cast (kimi
    // round-2 NIT).
    const stubTofu: VerifyPinTofuStore = {
      async get(): Promise<undefined> { return undefined },
      async upsertWithMerge(): Promise<never> {
        throw new Error('disk full')
      },
    }

    try {
      await verifyPin({peerId: '12D3KooWAlice', tofu: stubTofu})
      expect.fail('expected disk-full error to bubble')
    } catch (error) {
      expect(error).to.be.instanceOf(Error)
      expect((error as Error).message).to.equal('disk full')
      // Definitely not a VerifyPinError — that would mean we masked
      // the underlying failure with a generic code.
      expect(error).to.not.be.instanceOf(VerifyPinError)
    }
  })

  describe('loadPinnedPeer (read-only path for confirmation prompt)', () => {
    it('returns the existing peer when present', async () => {
      const tofu = new TofuStore({storePath})
      const original = buildPeer({display_handle: 'alice'})
      await tofu.upsert(original)

      const loaded = await loadPinnedPeer({peerId: original.peer_id, tofu})
      expect(loaded.peer_id).to.equal(original.peer_id)
      expect(loaded.pin_state).to.equal('auto-tofu')
      expect(loaded.display_handle).to.equal('alice')
    })

    it('throws VerifyPinError(PEER_NOT_PINNED) with the operator-friendly multi-line hint', async () => {
      const tofu = new TofuStore({storePath})
      try {
        await loadPinnedPeer({peerId: '12D3KooWUnknown', tofu})
        expect.fail('expected VerifyPinError')
      } catch (error) {
        expect(error).to.be.instanceOf(VerifyPinError)
        expect((error as VerifyPinError).code).to.equal('PEER_NOT_PINNED')
        const msg = (error as VerifyPinError).message
        expect(msg).to.include('brv bridge pin <multiaddr>')
        expect(msg).to.include('BRV_BRIDGE_AUTO_PROVISION=auto')
      }
    })
  })

  it('preserves auxiliary fields (display_handle, l2_pub_key) when promoting pin_state', async () => {
    const tofu = new TofuStore({storePath})
    const original = buildPeer({
      display_handle: 'alice',
      l2_pub_key: 'AA'.repeat(22),
    })
    await tofu.upsert(original)

    const promoted = await verifyPin({peerId: original.peer_id, tofu})

    expect(promoted.display_handle).to.equal('alice')
    expect(promoted.l2_pub_key).to.equal(original.l2_pub_key)
  })
})
