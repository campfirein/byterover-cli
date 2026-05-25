import {expect} from 'chai'
import {mkdtemp, rm} from 'node:fs/promises'
import {tmpdir} from 'node:os'
import {join} from 'node:path'

import {InstallIdentityService} from '../../../../../../src/agent/core/trust/install-identity-service.js'
import {TofuStore} from '../../../../../../src/agent/core/trust/tofu-store.js'
import {DEFAULT_BRIDGE_CONFIG} from '../../../../../../src/server/infra/channel/bridge/bridge-config.js'
import {fetchAndPin} from '../../../../../../src/server/infra/channel/bridge/identity-client.js'
import {IDENTITY_PROTOCOL, registerIdentityServer} from '../../../../../../src/server/infra/channel/bridge/identity-server.js'
import {Libp2pHost} from '../../../../../../src/server/infra/channel/bridge/libp2p-host.js'

// Phase 9 / Slice 9.2 — identity exchange over libp2p.
//
// `/brv/identity/cert/v1` stream protocol: callee streams its
// InstallCertificate; caller verifies + pins to its TofuStore.
//
// AMENDMENT_TOFU §A3.3 step 1 ("First contact") + Phase 9 §9.2 Exit
// criterion: "brv trust list on A shows B's pin entry with pin_state:
// 'auto-tofu'".

describe('identity exchange (Slice 9.2)', () => {
  let installDirA: string
  let installDirB: string
  let tofuDirA: string

  beforeEach(async () => {
    installDirA = await mkdtemp(join(tmpdir(), 'brv-identity-A-'))
    installDirB = await mkdtemp(join(tmpdir(), 'brv-identity-B-'))
    tofuDirA = await mkdtemp(join(tmpdir(), 'brv-tofu-A-'))
  })

  afterEach(async () => {
    await rm(installDirA, {force: true, recursive: true})
    await rm(installDirB, {force: true, recursive: true})
    await rm(tofuDirA, {force: true, recursive: true})
  })

  describe('protocol constant', () => {
    it('exposes the canonical `/brv/identity/cert/v1` protocol ID', () => {
      expect(IDENTITY_PROTOCOL).to.equal('/brv/identity/cert/v1')
    })
  })

  describe('two-host happy path', () => {
    it('B dials A, fetches A’s install cert, verifies, and pins (auto-tofu)', async () => {
      const idA = new InstallIdentityService({installDir: installDirA})
      const aIdentity = await idA.loadOrGenerate()
      const hostA = new Libp2pHost({config: DEFAULT_BRIDGE_CONFIG, identity: idA})
      await hostA.start()
      await registerIdentityServer({host: hostA, identity: idA})

      const idB = new InstallIdentityService({installDir: installDirB})
      await idB.loadOrGenerate()
      const hostB = new Libp2pHost({config: DEFAULT_BRIDGE_CONFIG, identity: idB})
      await hostB.start()

      const tofu = new TofuStore({storePath: join(tofuDirA, 'known-peers.jsonl')})

      try {
        const addrA = hostA.getMultiaddrs()[0]
        const pinned = await fetchAndPin({
          expectedPeerId: aIdentity.peerId,
          host: hostB,
          multiaddr: addrA,
          tofuStore: tofu,
        })

        // The returned record has the correct peer_id + auto-tofu state.
        expect(pinned.peer_id).to.equal(aIdentity.peerId)
        expect(pinned.pin_state).to.equal('auto-tofu')
        expect(pinned.install_cert_fingerprint).to.match(/^sha256:[\da-f]{64}$/)

        // It's persisted in the TofuStore.
        const stored = await tofu.get(aIdentity.peerId)
        expect(stored).to.exist
        expect(stored?.pin_state).to.equal('auto-tofu')
      } finally {
        await Promise.allSettled([hostA.stop(), hostB.stop()])
      }
    })
  })

  describe('verification failures', () => {
    it('rejects with PEER_ID_MISMATCH when expectedPeerId !== cert.subject_id', async () => {
      const idA = new InstallIdentityService({installDir: installDirA})
      await idA.loadOrGenerate()
      const hostA = new Libp2pHost({config: DEFAULT_BRIDGE_CONFIG, identity: idA})
      await hostA.start()
      await registerIdentityServer({host: hostA, identity: idA})

      const idB = new InstallIdentityService({installDir: installDirB})
      const bIdentity = await idB.loadOrGenerate()
      const hostB = new Libp2pHost({config: DEFAULT_BRIDGE_CONFIG, identity: idB})
      await hostB.start()

      const tofu = new TofuStore({storePath: join(tofuDirA, 'known-peers.jsonl')})

      try {
        const addrA = hostA.getMultiaddrs()[0]
        // Use B's peer_id as the "wrong" expected (valid shape, different
        // from A's cert subject_id).
        try {
          await fetchAndPin({
            expectedPeerId: bIdentity.peerId,
            host: hostB,
            multiaddr: addrA,
            tofuStore: tofu,
          })
          expect.fail('expected PEER_ID_MISMATCH rejection')
        } catch (error) {
          expect((error as Error).message).to.match(/PEER_ID_MISMATCH/i)
        }

        // Nothing pinned.
        expect(await tofu.list()).to.deep.equal([])
      } finally {
        await Promise.allSettled([hostA.stop(), hostB.stop()])
      }
    })
  })

  describe('renewal continuity — fingerprint anchored to pubkey, not cert (kimi round-1 BLOCKING)', () => {
    it('a renewed cert (same key, new expires_at) re-pins WITHOUT TOFU_FINGERPRINT_MISMATCH', async () => {
      const idA = new InstallIdentityService({installDir: installDirA})
      const aIdentity = await idA.loadOrGenerate()
      const hostA = new Libp2pHost({config: DEFAULT_BRIDGE_CONFIG, identity: idA})
      await hostA.start()
      await registerIdentityServer({host: hostA, identity: idA})

      const idB = new InstallIdentityService({installDir: installDirB})
      await idB.loadOrGenerate()
      const hostB = new Libp2pHost({config: DEFAULT_BRIDGE_CONFIG, identity: idB})
      await hostB.start()

      const tofu = new TofuStore({storePath: join(tofuDirA, 'known-peers.jsonl')})

      try {
        const addrA = hostA.getMultiaddrs()[0]
        const first = await fetchAndPin({
          expectedPeerId: aIdentity.peerId,
          host: hostB,
          multiaddr: addrA,
          tofuStore: tofu,
        })

        await idA.renewCert()
        const second = await fetchAndPin({
          expectedPeerId: aIdentity.peerId,
          host: hostB,
          multiaddr: addrA,
          tofuStore: tofu,
        })

        expect(second.peer_id).to.equal(first.peer_id)
        expect(second.install_cert_fingerprint).to.equal(first.install_cert_fingerprint)
        const all = await tofu.list()
        expect(all).to.have.lengthOf(1)
      } finally {
        await Promise.allSettled([hostA.stop(), hostB.stop()])
      }
    })
  })

  describe('handle-collision rejection (AMENDMENT_TOFU §A3.3 step 3, kimi round-1 MEDIUM)', () => {
    it('refuses to auto-pin a second peer that claims the same display_handle as an existing pin', async () => {
      const idA = new InstallIdentityService({installDir: installDirA})
      const aIdentity = await idA.loadOrGenerate({displayHandle: 'alice'})
      const hostA = new Libp2pHost({config: DEFAULT_BRIDGE_CONFIG, identity: idA})
      await hostA.start()
      await registerIdentityServer({host: hostA, identity: idA})

      const idB = new InstallIdentityService({installDir: installDirB})
      const bIdentity = await idB.loadOrGenerate({displayHandle: 'alice'})
      const hostB = new Libp2pHost({config: DEFAULT_BRIDGE_CONFIG, identity: idB})
      await hostB.start()
      await registerIdentityServer({host: hostB, identity: idB})

      // Use a third host as the "verifier" so we can pin both A and B
      // into the same tofu store without confusing self vs other.
      const installDirC = await mkdtemp(join(tmpdir(), 'brv-identity-C-'))
      const idC = new InstallIdentityService({installDir: installDirC})
      await idC.loadOrGenerate()
      const hostC = new Libp2pHost({config: DEFAULT_BRIDGE_CONFIG, identity: idC})
      await hostC.start()

      const tofu = new TofuStore({storePath: join(tofuDirA, 'known-peers.jsonl')})

      try {
        // C pins A first.
        await fetchAndPin({
          expectedPeerId: aIdentity.peerId,
          host: hostC,
          multiaddr: hostA.getMultiaddrs()[0],
          tofuStore: tofu,
        })

        // C tries to pin B (different peer_id, same display_handle).
        try {
          await fetchAndPin({
            expectedPeerId: bIdentity.peerId,
            host: hostC,
            multiaddr: hostB.getMultiaddrs()[0],
            tofuStore: tofu,
          })
          expect.fail('expected HANDLE_COLLISION_REQUIRES_CONFIRMATION rejection')
        } catch (error) {
          expect((error as Error).message).to.match(/HANDLE_COLLISION_REQUIRES_CONFIRMATION/i)
        }

        // A is still pinned; B is NOT pinned.
        const all = await tofu.list()
        expect(all.map((p) => p.peer_id)).to.deep.equal([aIdentity.peerId])
      } finally {
        await Promise.allSettled([hostA.stop(), hostB.stop(), hostC.stop()])
        await rm(installDirC, {force: true, recursive: true})
      }
    })
  })

  describe('idempotency — pinning the same peer twice', () => {
    it('a second fetchAndPin updates last_seen_at without creating a duplicate entry', async () => {
      const idA = new InstallIdentityService({installDir: installDirA})
      const aIdentity = await idA.loadOrGenerate()
      const hostA = new Libp2pHost({config: DEFAULT_BRIDGE_CONFIG, identity: idA})
      await hostA.start()
      await registerIdentityServer({host: hostA, identity: idA})

      const idB = new InstallIdentityService({installDir: installDirB})
      await idB.loadOrGenerate()
      const hostB = new Libp2pHost({config: DEFAULT_BRIDGE_CONFIG, identity: idB})
      await hostB.start()

      const tofu = new TofuStore({storePath: join(tofuDirA, 'known-peers.jsonl')})

      try {
        const addrA = hostA.getMultiaddrs()[0]
        const first = await fetchAndPin({
          expectedPeerId: aIdentity.peerId,
          host: hostB,
          multiaddr: addrA,
          tofuStore: tofu,
        })
        await new Promise<void>((r) => { setTimeout(r, 10) })
        const second = await fetchAndPin({
          expectedPeerId: aIdentity.peerId,
          host: hostB,
          multiaddr: addrA,
          tofuStore: tofu,
        })

        // Same peer, no duplicate entry.
        const all = await tofu.list()
        expect(all).to.have.lengthOf(1)
        // first_seen_at preserved across re-pin (TOFU continuity).
        expect(second.first_seen_at).to.equal(first.first_seen_at)
        // last_seen_at advances.
        expect(Date.parse(second.last_seen_at)).to.be.gte(Date.parse(first.last_seen_at))
      } finally {
        await Promise.allSettled([hostA.stop(), hostB.stop()])
      }
    })
  })
})
