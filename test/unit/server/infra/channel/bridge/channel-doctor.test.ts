/* eslint-disable camelcase */
// Wire fields use snake_case (AMENDMENT_TOFU §A3.3).

import {expect} from 'chai'
import {mkdtemp, rm} from 'node:fs/promises'
import {tmpdir} from 'node:os'
import {join} from 'node:path'

import type {KnownPeer} from '../../../../../../src/agent/core/trust/tofu-store.js'
import type {ChannelMemberRemotePeer} from '../../../../../../src/shared/types/channel.js'

import {TofuStore} from '../../../../../../src/agent/core/trust/tofu-store.js'
import {diagnoseRemotePeer} from '../../../../../../src/server/infra/channel/bridge/channel-doctor.js'

// Phase 9 / Slice 9.11 — pure diagnostic for `brv channel doctor`.
// Covers the LOCAL self-consistency checks (TOFU pin state, L2 cert
// expiry, mirror-only members, member-record vs TOFU pubkey drift).
// Network probes are out of scope.

const NOW = new Date('2026-05-19T00:00:00.000Z')

const buildPeer = (overrides: Partial<KnownPeer> = {}): KnownPeer => ({
  first_seen_at: '2026-05-19T00:00:00.000Z',
  install_cert_fingerprint: 'a'.repeat(64),
  last_seen_at: '2026-05-19T00:00:00.000Z',
  peer_id: '12D3KooWAlice',
  pin_state: 'user-confirmed',
  ...overrides,
})

const buildMember = (overrides: Partial<ChannelMemberRemotePeer> = {}): ChannelMemberRemotePeer => ({
  handle: '@alice',
  joinedAt: '2026-05-19T00:00:00.000Z',
  memberKind: 'remote-peer',
  multiaddr: '/ip4/127.0.0.1/tcp/4001/p2p/12D3KooWAlice',
  peerId: '12D3KooWAlice',
  remoteL2PubKey: 'AA'.repeat(22),
  status: 'idle',
  ...overrides,
})

describe('diagnoseRemotePeer (slice 9.11)', () => {
  let storePath: string
  let tmp: string

  beforeEach(async () => {
    tmp = await mkdtemp(join(tmpdir(), 'channel-doctor-test-'))
    storePath = join(tmp, 'known-peers.jsonl')
  })

  afterEach(async () => {
    await rm(tmp, {force: true, recursive: true})
  })

  it('reports info-level "all good" when peer is pinned + user-confirmed + L2 valid', async () => {
    const tofu = new TofuStore({storePath})
    await tofu.upsert(buildPeer({
      l2_expires_at: '2027-05-19T00:00:00.000Z',
      l2_pub_key: 'AA'.repeat(22),
      pin_state: 'user-confirmed',
    }))

    const report = await diagnoseRemotePeer({member: buildMember(), now: NOW, tofu})

    expect(report.pinned).to.equal(true)
    expect(report.cachedPinState).to.equal('user-confirmed')
    expect(report.overallLevel).to.equal('info')
    expect(report.findings).to.have.length(0)
  })

  it('reports error when peer is not in the local TOFU store', async () => {
    const tofu = new TofuStore({storePath})
    // No upsert — peer is unknown.

    const report = await diagnoseRemotePeer({member: buildMember(), now: NOW, tofu})

    expect(report.pinned).to.equal(false)
    expect(report.overallLevel).to.equal('error')
    expect(report.findings.some((f) => f.code === 'PEER_UNPINNED' && f.level === 'error')).to.equal(true)
  })

  it('reports warn when peer is in auto-tofu pin state (default pinned-only policy will reject)', async () => {
    const tofu = new TofuStore({storePath})
    await tofu.upsert(buildPeer({
      l2_expires_at: '2027-05-19T00:00:00.000Z',
      l2_pub_key: 'AA'.repeat(22),
      pin_state: 'auto-tofu',
    }))

    const report = await diagnoseRemotePeer({member: buildMember(), now: NOW, tofu})
    expect(report.overallLevel).to.equal('warn')
    expect(report.findings.some((f) => f.code === 'AUTO_TOFU_PIN_STATE')).to.equal(true)
  })

  it('reports warn when cached L2 cert has expired', async () => {
    const tofu = new TofuStore({storePath})
    await tofu.upsert(buildPeer({
      l2_expires_at: '2026-05-18T00:00:00.000Z',  // expired before NOW
      l2_pub_key: 'AA'.repeat(22),
    }))

    const report = await diagnoseRemotePeer({member: buildMember(), now: NOW, tofu})
    expect(report.findings.some((f) => f.code === 'L2_CERT_STALE')).to.equal(true)
  })

  it('reports warn when cached L2 entry is legacy (pubkey without expiry)', async () => {
    const tofu = new TofuStore({storePath})
    await tofu.upsert(buildPeer({l2_pub_key: 'AA'.repeat(22)}))

    const report = await diagnoseRemotePeer({member: buildMember(), now: NOW, tofu})
    expect(report.findings.some((f) => f.code === 'L2_CERT_LEGACY')).to.equal(true)
  })

  it('reports warn when peer is pinned but has no L2 pubkey cached', async () => {
    const tofu = new TofuStore({storePath})
    await tofu.upsert(buildPeer())  // no l2_pub_key

    const report = await diagnoseRemotePeer({member: buildMember(), now: NOW, tofu})
    expect(report.findings.some((f) => f.code === 'L2_CERT_MISSING')).to.equal(true)
  })

  it('flags mirror-only members (Bob auto-provisioned, no multiaddr / no L2 pubkey)', async () => {
    const tofu = new TofuStore({storePath})

    const mirror = buildMember({multiaddr: undefined, remoteL2PubKey: undefined})
    const report = await diagnoseRemotePeer({member: mirror, now: NOW, tofu})
    expect(report.mirrorOnly).to.equal(true)
    expect(report.findings.some((f) => f.code === 'MIRROR_ONLY')).to.equal(true)
  })

  it('flags drift when member.remoteL2PubKey differs from the TOFU-cached pubkey', async () => {
    const tofu = new TofuStore({storePath})
    await tofu.upsert(buildPeer({
      l2_expires_at: '2027-05-19T00:00:00.000Z',
      l2_pub_key: 'BB'.repeat(22),  // different from the member's stored 'AA'.repeat(22)
    }))

    const report = await diagnoseRemotePeer({member: buildMember(), now: NOW, tofu})
    expect(report.findings.some((f) => f.code === 'L2_CERT_DRIFT')).to.equal(true)
  })

  it('skips auto-tofu warning when peer is ca-bound (CA log corroborates identity)', async () => {
    const tofu = new TofuStore({storePath})
    await tofu.upsert(buildPeer({
      ca_binding: {
        account_id: 'acct-1',
        ca_cert_fingerprint: 'b'.repeat(64),
        ca_log_entry_index: 42,
        issued_at: '2026-05-19T00:00:00.000Z',
        tree_id: 'tree-1',
      },
      l2_expires_at: '2027-05-19T00:00:00.000Z',
      l2_pub_key: 'AA'.repeat(22),
      pin_state: 'ca-bound',
    }))

    const report = await diagnoseRemotePeer({member: buildMember(), now: NOW, tofu})
    expect(report.findings.some((f) => f.code === 'AUTO_TOFU_PIN_STATE')).to.equal(false)
    expect(report.overallLevel).to.equal('info')
    expect(report.cachedPinState).to.equal('ca-bound')
  })

  it('returns highest-severity overallLevel across multiple findings', async () => {
    const tofu = new TofuStore({storePath})
    // No upsert → PEER_UNPINNED (error level). The mirror flag would add an info.
    const mirror = buildMember({multiaddr: undefined, remoteL2PubKey: undefined})

    const report = await diagnoseRemotePeer({member: mirror, now: NOW, tofu})
    expect(report.overallLevel).to.equal('error')
  })
})
