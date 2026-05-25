/* eslint-disable camelcase */
import {expect} from 'chai'
import {createPublicKey, generateKeyPairSync} from 'node:crypto'
import {mkdtemp, rm} from 'node:fs/promises'
import {tmpdir} from 'node:os'
import {join} from 'node:path'

import {InstallIdentityService} from '../../../../../../src/agent/core/trust/install-identity-service.js'
import {PeerTreeIdentityService} from '../../../../../../src/agent/core/trust/peer-tree-identity-service.js'
import {TofuStore} from '../../../../../../src/agent/core/trust/tofu-store.js'
import {DEFAULT_BRIDGE_CONFIG} from '../../../../../../src/server/infra/channel/bridge/bridge-config.js'
import {Libp2pHost} from '../../../../../../src/server/infra/channel/bridge/libp2p-host.js'
import {sendParleyQuery} from '../../../../../../src/server/infra/channel/bridge/parley-client.js'
import {registerParleyServer} from '../../../../../../src/server/infra/channel/bridge/parley-server.js'

// Phase 9 / Slice 9.3e + 9.3f — two-host end-to-end tests for the
// /brv/parley/query/v1 wire layer.

interface Rig {
  alice: {
    host: Libp2pHost
    install: InstallIdentityService
    installDir: string
    l2: PeerTreeIdentityService
  }
  bob: {
    host: Libp2pHost
    install: InstallIdentityService
    installDir: string
    l2: PeerTreeIdentityService
    tofu: TofuStore
    tofuDir: string
  }
}

async function bringUpRig(opts: {
  acceptModes?: ('ca-issued-tree' | 'peer-tree')[]
  tofuPolicy?: 'auto' | 'deny'
} = {}): Promise<Rig> {
  const aDir = await mkdtemp(join(tmpdir(), 'brv-pe2e-A-'))
  const bDir = await mkdtemp(join(tmpdir(), 'brv-pe2e-B-'))
  const bTofu = await mkdtemp(join(tmpdir(), 'brv-pe2e-Btofu-'))
  const idA = new InstallIdentityService({installDir: aDir})
  await idA.loadOrGenerate()
  const idB = new InstallIdentityService({installDir: bDir})
  await idB.loadOrGenerate()
  const l2A = new PeerTreeIdentityService({install: idA})
  const l2B = new PeerTreeIdentityService({install: idB})
  await l2A.loadOrGenerate()
  await l2B.loadOrGenerate()
  const hostA = new Libp2pHost({config: DEFAULT_BRIDGE_CONFIG, identity: idA})
  const hostB = new Libp2pHost({config: DEFAULT_BRIDGE_CONFIG, identity: idB})
  await hostA.start()
  await hostB.start()
  const tofuB = new TofuStore({storePath: join(bTofu, 'known-peers.jsonl')})
  await registerParleyServer({
    acceptModes: opts.acceptModes ?? ['peer-tree'],
    host: hostB,
    l2Identity: l2B,
    tofuPolicy: opts.tofuPolicy ?? 'auto',
    tofuStore: tofuB,
  })

  return {
    alice: {host: hostA, install: idA, installDir: aDir, l2: l2A},
    bob: {host: hostB, install: idB, installDir: bDir, l2: l2B, tofu: tofuB, tofuDir: bTofu},
  }
}

async function disposeRig(rig: Rig): Promise<void> {
  await Promise.allSettled([rig.alice.host.stop(), rig.bob.host.stop()])
  await rm(rig.alice.installDir, {force: true, recursive: true})
  await rm(rig.bob.installDir, {force: true, recursive: true})
  await rm(rig.bob.tofuDir, {force: true, recursive: true})
}

async function bobL2PubKey(rig: Rig) {
  const l2 = await rig.bob.l2.loadOrGenerate()
  return createPublicKey({
    format: 'jwk',
    key: {crv: 'Ed25519', kty: 'OKP', x: Buffer.from(l2.cert.public_key.key, 'base64').toString('base64url')},
  })
}

describe('Parley two-host (Slice 9.3e + 9.3f)', () => {
  describe('happy path', () => {
    let rig: Rig

    beforeEach(async () => {
      rig = await bringUpRig()
    })

    afterEach(async () => {
      await disposeRig(rig)
    })

    it('A sends query, B verifies + echoes, A verifies seal signature', async () => {
      const addrB = rig.bob.host.getMultiaddrs()[0]
      const result = await sendParleyQuery({
        channel_id: 'review-2026',
        delivery_id: 'd-e2e-001',
        host: rig.alice.host,
        install: rig.alice.install,
        l2Identity: rig.alice.l2,
        multiaddr: addrB,
        prompt: [{text: 'echo this end-to-end', type: 'text'}],
        remoteL2PubKey: await bobL2PubKey(rig),
        turn_id: 't-e2e-001',
      })
      expect(result.ok, JSON.stringify(result)).to.equal(true)
      if (result.ok) {
        expect(result.endedState).to.equal('completed')
        expect(result.content).to.equal('echo this end-to-end')
      }
    })

    it('pins Alice in Bob\'s TOFU store with auto-tofu after first contact', async () => {
      const addrB = rig.bob.host.getMultiaddrs()[0]
      await sendParleyQuery({
        channel_id: 'review-2026',
        delivery_id: 'd-e2e-002',
        host: rig.alice.host,
        install: rig.alice.install,
        l2Identity: rig.alice.l2,
        multiaddr: addrB,
        prompt: [{text: 'first contact', type: 'text'}],
        remoteL2PubKey: await bobL2PubKey(rig),
        turn_id: 't-e2e-002',
      })
      const aIdentity = await rig.alice.install.loadOrGenerate()
      const pinned = await rig.bob.tofu.get(aIdentity.peerId)
      expect(pinned?.pin_state).to.equal('auto-tofu')
    })
  })

  describe('negative — accept_modes rejects peer-tree', () => {
    it('returns CERT_KIND_REJECTED_BY_POLICY when Bob only accepts ca-issued-tree', async () => {
      const rig = await bringUpRig({acceptModes: ['ca-issued-tree']})
      try {
        const result = await sendParleyQuery({
          channel_id: 'review-2026',
          delivery_id: 'd-deny-001',
          host: rig.alice.host,
          install: rig.alice.install,
          l2Identity: rig.alice.l2,
          multiaddr: rig.bob.host.getMultiaddrs()[0],
          prompt: [{text: 'denied', type: 'text'}],
          remoteL2PubKey: await bobL2PubKey(rig),
          turn_id: 't-deny-001',
        })
        expect(result.ok).to.equal(false)
        if (!result.ok) expect(result.code).to.equal('CERT_KIND_REJECTED_BY_POLICY')
      } finally {
        await disposeRig(rig)
      }
    })
  })

  describe('negative — tofu_policy: "deny" rejects unpinned caller', () => {
    it('returns PEER_UNPINNED on first contact when policy is "deny"', async () => {
      const rig = await bringUpRig({tofuPolicy: 'deny'})
      try {
        const result = await sendParleyQuery({
          channel_id: 'review-2026',
          delivery_id: 'd-unpinned-001',
          host: rig.alice.host,
          install: rig.alice.install,
          l2Identity: rig.alice.l2,
          multiaddr: rig.bob.host.getMultiaddrs()[0],
          prompt: [{text: 'unpinned', type: 'text'}],
          remoteL2PubKey: await bobL2PubKey(rig),
          turn_id: 't-unpinned-001',
        })
        expect(result.ok).to.equal(false)
        if (!result.ok) expect(result.code).to.equal('PEER_UNPINNED')
      } finally {
        await disposeRig(rig)
      }
    })
  })

  describe('negative — replay protection', () => {
    it('returns HANDSHAKE_REPLAY when the same nonce is reused for two queries from the same peer', async () => {
      const rig = await bringUpRig()
      try {
        const fixedNonce = new Uint8Array(16).fill(0x77)
        const addrB = rig.bob.host.getMultiaddrs()[0]
        const args = {
          channel_id: 'review-2026',
          host: rig.alice.host,
          install: rig.alice.install,
          l2Identity: rig.alice.l2,
          multiaddr: addrB,
          nonce: fixedNonce,
          remoteL2PubKey: await bobL2PubKey(rig),
        }

        const first = await sendParleyQuery({
          ...args,
          delivery_id: 'd-replay-1',
          prompt: [{text: 'first', type: 'text'}],
          turn_id: 't-replay-1',
        })
        expect(first.ok, JSON.stringify(first)).to.equal(true)

        const second = await sendParleyQuery({
          ...args,
          delivery_id: 'd-replay-2',
          prompt: [{text: 'second', type: 'text'}],
          turn_id: 't-replay-2',
        })
        expect(second.ok).to.equal(false)
        if (!second.ok) expect(second.code).to.equal('HANDSHAKE_REPLAY')
      } finally {
        await disposeRig(rig)
      }
    })
  })

  describe('negative — error-terminal authenticity (kimi round-1 BLOCKING fix)', () => {
    it('the dialer\'s seal/error verify uses the REAL request context bound by the server', async () => {
      // tofu_policy:'deny' produces a verifier reject AFTER step 1
      // (envelope parse succeeded), so the server now binds the error
      // terminal to Alice's real channel_id/turn_id/delivery_id +
      // request_envelope_hash. The dialer's verify against the EXPECTED
      // context succeeds → ok:false with PEER_UNPINNED is authenticated.
      const rig = await bringUpRig({tofuPolicy: 'deny'})
      try {
        const result = await sendParleyQuery({
          channel_id: 'review-2026',
          delivery_id: 'd-bound-001',
          host: rig.alice.host,
          install: rig.alice.install,
          l2Identity: rig.alice.l2,
          multiaddr: rig.bob.host.getMultiaddrs()[0],
          prompt: [{text: 'bound', type: 'text'}],
          remoteL2PubKey: await bobL2PubKey(rig),
          turn_id: 't-bound-001',
        })
        expect(result.ok).to.equal(false)
        if (!result.ok) {
          // The authenticated reject path returns PEER_UNPINNED, NOT
          // the synthetic ERROR_TERMINAL_UNAUTHENTICATED sentinel.
          expect(result.code).to.equal('PEER_UNPINNED')
        }
      } finally {
        await disposeRig(rig)
      }
    })
  })

  describe('negative — bad L2 public key on the dialer side', () => {
    it('a dialer who verifies against the WRONG L2 pubkey detects the mismatch on the transcript_seal', async () => {
      const rig = await bringUpRig()
      try {
        // Construct a stranger Ed25519 key — using it to verify the
        // seal MUST fail with TRANSCRIPT_SEAL_SIG_INVALID.
        const stranger = generateKeyPairSync('ed25519')
        let caught: Error | undefined
        try {
          await sendParleyQuery({
            channel_id: 'review-2026',
            delivery_id: 'd-wrongkey-001',
            host: rig.alice.host,
            install: rig.alice.install,
            l2Identity: rig.alice.l2,
            multiaddr: rig.bob.host.getMultiaddrs()[0],
            prompt: [{text: 'wrong key', type: 'text'}],
            remoteL2PubKey: stranger.publicKey,
            turn_id: 't-wrongkey-001',
          })
        } catch (error) {
          caught = error as Error
        }

        expect(caught).to.exist
        expect(caught?.message).to.match(/STREAM_END_SIG_INVALID|TRANSCRIPT_SEAL_SIG_INVALID/)
      } finally {
        await disposeRig(rig)
      }
    })
  })
})
