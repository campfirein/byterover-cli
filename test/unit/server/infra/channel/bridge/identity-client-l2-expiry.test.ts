/* eslint-disable camelcase */
// Wire fields use snake_case (AMENDMENT_TOFU §A3.2).

import {expect} from 'chai'

import type {KnownPeer} from '../../../../../../src/agent/core/trust/tofu-store.js'

import {isL2CertExpired, mergeL2Fields} from '../../../../../../src/server/infra/channel/bridge/identity-client.js'

// Phase 9 / Slice 9.4h — cached L2 cert expiry check.
//
// Background: 9.4d's TOFU fast-path returns `KnownPeer.l2_pub_key`
// without consulting any expires_at, so a stale (expired) L2 cert is
// happily reused for years. 9.4h adds `KnownPeer.l2_expires_at` and
// an `isL2CertExpired` helper used by the daemon's
// `resolveRemotePeerL2PubKey` to fall through to a fresh `fetchAndPin`
// when the cached cert has expired.

const buildPeer = (overrides: Partial<KnownPeer> = {}): KnownPeer => ({
  first_seen_at: '2026-05-19T00:00:00.000Z',
  install_cert_fingerprint: 'a'.repeat(64),
  last_seen_at: '2026-05-19T00:00:00.000Z',
  peer_id: '12D3KooWAlice',
  pin_state: 'user-confirmed',
  ...overrides,
})

describe('isL2CertExpired (slice 9.4h)', () => {
  const now = new Date('2026-05-19T00:00:00.000Z')

  it('returns false when the cached cert is still valid', () => {
    const peer = buildPeer({
      l2_expires_at: '2027-05-19T00:00:00.000Z',
      l2_pub_key: 'AA'.repeat(22),
    })
    expect(isL2CertExpired(peer, now)).to.equal(false)
  })

  it('returns true when the cached cert has expired', () => {
    const peer = buildPeer({
      l2_expires_at: '2026-05-18T00:00:00.000Z',
      l2_pub_key: 'AA'.repeat(22),
    })
    expect(isL2CertExpired(peer, now)).to.equal(true)
  })

  it('returns true at the exact expiry boundary (expires_at <= now)', () => {
    const peer = buildPeer({
      l2_expires_at: '2026-05-19T00:00:00.000Z',
      l2_pub_key: 'AA'.repeat(22),
    })
    expect(isL2CertExpired(peer, now)).to.equal(true)
  })

  it('returns true (treat as expired) when l2_pub_key is set but l2_expires_at is missing — pre-9.4h legacy entries are stale-unknown', () => {
    // Forces a re-fetch on next use so the operator gets fresh
    // cert validation. Worst case is one extra dial; best case is
    // we catch a peer whose L2 cert silently expired.
    const peer = buildPeer({
      l2_pub_key: 'AA'.repeat(22),
    })
    expect(isL2CertExpired(peer, now)).to.equal(true)
  })

  it('returns false when there is no cached l2_pub_key — nothing to mark stale', () => {
    const peer = buildPeer()
    expect(isL2CertExpired(peer, now)).to.equal(false)
  })

  it('returns true when l2_expires_at is unparseable', () => {
    const peer = buildPeer({
      l2_expires_at: 'not-a-date',
      l2_pub_key: 'AA'.repeat(22),
    })
    expect(isL2CertExpired(peer, now)).to.equal(true)
  })

  describe('mergeL2Fields (kimi round-1 LOW direct coverage)', () => {
    it('fresh material overwrites both fields', () => {
      const result = mergeL2Fields(
        {l2ExpiresAt: '2027-05-19T00:00:00.000Z', l2PubKey: 'NEW'.repeat(22)},
        {l2_expires_at: '2025-01-01T00:00:00.000Z', l2_pub_key: 'OLD'.repeat(22)},
      )
      expect(result.l2_pub_key).to.equal('NEW'.repeat(22))
      expect(result.l2_expires_at).to.equal('2027-05-19T00:00:00.000Z')
    })

    it('fresh material overwrites even when existing is undefined (first pin)', () => {
      // eslint-disable-next-line unicorn/no-useless-undefined
      const result = mergeL2Fields({l2ExpiresAt: '2027-05-19T00:00:00.000Z', l2PubKey: 'NEW'.repeat(22)}, undefined)
      expect(result.l2_pub_key).to.equal('NEW'.repeat(22))
      expect(result.l2_expires_at).to.equal('2027-05-19T00:00:00.000Z')
    })

    it('no fresh material + no existing pubkey → empty pair (drops both fields)', () => {
      const result = mergeL2Fields(undefined, {})
      expect(result.l2_pub_key).to.be.undefined
      expect(result.l2_expires_at).to.be.undefined
    })

    it('no fresh material + no existing record → empty pair', () => {
      // eslint-disable-next-line unicorn/no-useless-undefined
      const result = mergeL2Fields(undefined, undefined)
      expect(result.l2_pub_key).to.be.undefined
      expect(result.l2_expires_at).to.be.undefined
    })

    it('preserves existing pair when no fresh material', () => {
      const result = mergeL2Fields(undefined, {
        l2_expires_at: '2027-05-19T00:00:00.000Z',
        l2_pub_key: 'OLD'.repeat(22),
      })
      expect(result.l2_pub_key).to.equal('OLD'.repeat(22))
      expect(result.l2_expires_at).to.equal('2027-05-19T00:00:00.000Z')
    })

    it('preserves legacy pubkey-without-expiry as-is (pre-9.4h pin)', () => {
      // The result MUST keep the legacy pubkey AND omit the expiry
      // (rather than invent one). isL2CertExpired later treats this
      // shape as stale, forcing a re-fetch on next use.
      const result = mergeL2Fields(undefined, {l2_pub_key: 'LEGACY'.repeat(11)})
      expect(result.l2_pub_key).to.equal('LEGACY'.repeat(11))
      expect(result.l2_expires_at).to.be.undefined
    })
  })
})
