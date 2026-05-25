 
import {expect} from 'chai'
import {mkdtemp, readFile, rm} from 'node:fs/promises'
import {tmpdir} from 'node:os'
import {join} from 'node:path'

import {InstallIdentityService} from '../../../../../src/agent/core/trust/install-identity-service.js'
import {PeerTreeIdentityService} from '../../../../../src/agent/core/trust/peer-tree-identity-service.js'
import {verifyPeerTreeCertChain} from '../../../../../src/agent/core/trust/peer-tree-signer.js'

// Phase 9 / Slice 9.3b — `PeerTreeIdentityService` holds an in-memory
// L2 peer-tree identity (keypair + cert). For 9.3 mock-echo testing
// the L2 identity does NOT need to persist across daemon restarts;
// persistence comes in a later slice when real per-tree identities are
// wired into the project store.

describe('PeerTreeIdentityService', () => {
  let installDir: string
  let install: InstallIdentityService

  beforeEach(async () => {
    installDir = await mkdtemp(join(tmpdir(), 'brv-l2-test-'))
    install = new InstallIdentityService({installDir})
    await install.loadOrGenerate()
  })

  afterEach(async () => {
    await rm(installDir, {force: true, recursive: true})
  })

  describe('loadOrGenerate()', () => {
    it('returns a fresh L2 identity bound to the supplied L1 install', async () => {
      const l2 = new PeerTreeIdentityService({install})
      const identity = await l2.loadOrGenerate()
      expect(identity.cert.cert_kind).to.equal('peer-tree')
      expect(identity.cert.subject_id).to.match(/^[\da-f]{8}-[\da-f]{4}-7[\da-f]{3}-[89ab][\da-f]{3}-[\da-f]{12}$/)
    })

    it('returns the SAME identity on a second call (in-memory cache)', async () => {
      const l2 = new PeerTreeIdentityService({install})
      const a = await l2.loadOrGenerate()
      const b = await l2.loadOrGenerate()
      expect(a.cert.subject_id).to.equal(b.cert.subject_id)
      expect(a.cert.signature).to.equal(b.cert.signature)
    })

    it('produces a cert whose chain verifies against the L1 install', async () => {
      const l2 = new PeerTreeIdentityService({install})
      const identity = await l2.loadOrGenerate()
      const r = verifyPeerTreeCertChain({
        cert: identity.cert,
        l1PubRaw: await install.getRawPublicKey(),
        now: new Date(),
      })
      expect(r.ok, JSON.stringify(r)).to.equal(true)
    })

    it('two independent services on the SAME install share the SAME persisted L2 identity (slice 9.4b)', async () => {
      const a = new PeerTreeIdentityService({install})
      const b = new PeerTreeIdentityService({install})
      const aIdentity = await a.loadOrGenerate()
      const bIdentity = await b.loadOrGenerate()
      expect(aIdentity.cert.subject_id).to.equal(bIdentity.cert.subject_id)
      expect(aIdentity.cert.signature).to.equal(bIdentity.cert.signature)
    })

    it('exposes the L2 private key for signing response frames', async () => {
      const l2 = new PeerTreeIdentityService({install})
      const identity = await l2.loadOrGenerate()
      expect(identity.privateKey.asymmetricKeyType).to.equal('ed25519')
    })

    it('persists L2 identity to disk so daemon restarts reuse the same pubkey (slice 9.4b)', async () => {
      const first = new PeerTreeIdentityService({install})
      const firstIdentity = await first.loadOrGenerate()

      // tree-default.* artifacts must be on disk under the install dir.
      const certRaw = await readFile(join(installDir, 'tree-default.cert.json'), 'utf8')
      const cert = JSON.parse(certRaw)
      expect(cert.cert_kind).to.equal('peer-tree')
      expect(cert.subject_id).to.equal(firstIdentity.cert.subject_id)

      // A fresh service constructed on the same install dir loads the
      // SAME identity (same tree_id + same signature).
      const second = new PeerTreeIdentityService({install})
      const secondIdentity = await second.loadOrGenerate()
      expect(secondIdentity.cert.subject_id).to.equal(firstIdentity.cert.subject_id)
      expect(secondIdentity.cert.signature).to.equal(firstIdentity.cert.signature)
    })

    it('regenerates L2 when persisted cert binds to a stale L1 pubkey (kimi round-1 HIGH)', async () => {
      // First service persists an L2 cert bound to the current L1.
      const first = new PeerTreeIdentityService({install})
      const firstIdentity = await first.loadOrGenerate()

      // Simulate `brv install regenerate` by rotating L1 key on disk.
      await install.regenerate()

      // Fresh service detects the parent_install fingerprint mismatch
      // and regenerates L2 against the NEW L1. The on-disk artifacts
      // are replaced.
      const second = new PeerTreeIdentityService({install})
      const secondIdentity = await second.loadOrGenerate()
      expect(secondIdentity.cert.subject_id).not.to.equal(firstIdentity.cert.subject_id)
      expect(secondIdentity.cert.parent_install.peer_id).to.equal((await install.loadOrGenerate()).peerId)
    })
  })
})
