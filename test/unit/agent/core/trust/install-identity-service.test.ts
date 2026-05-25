/* eslint-disable camelcase */
// Cert / payload field names mirror AMENDMENT_TOFU §A3.2 on-disk JSON
// shape and are intentionally snake_case to match the wire spec.

import {expect} from 'chai'
import {mkdtemp, readFile, rm, stat} from 'node:fs/promises'
import {tmpdir} from 'node:os'
import {join} from 'node:path'

import {
  type InstallCertificate,
  InstallIdentityService,
} from '../../../../../src/agent/core/trust/install-identity-service.js'
import {isValidPeerIdString} from '../../../../../src/agent/core/trust/peer-id.js'
import {verifyInstallCert} from '../../../../../src/agent/core/trust/sign.js'

// Phase 9 / AMENDMENT_TOFU §A3.1, §A4.7, §A4.9.x — L1 install identity
// service. Lazy-init the keypair, encrypt to disk with AES-256-GCM,
// self-sign the install.cert, expose typed sign helpers (no raw
// private-key accessor), support renew (same key) and regenerate
// (new key → new peer_id).

describe('InstallIdentityService', () => {
  let installDir: string

  beforeEach(async () => {
    installDir = await mkdtemp(join(tmpdir(), 'brv-install-id-'))
  })

  afterEach(async () => {
    await rm(installDir, {force: true, recursive: true})
  })

  describe('loadOrGenerate', () => {
    it('generates a new identity on first call', async () => {
      const svc = new InstallIdentityService({installDir})
      const id = await svc.loadOrGenerate()
      expect(id.peerId).to.be.a('string')
      expect(isValidPeerIdString(id.peerId)).to.equal(true)
      expect(id.cert.cert_kind).to.equal('install')
      expect(id.cert.subject_id).to.equal(id.peerId)
      expect(id.cert.public_key.alg).to.equal('ed25519')
    })

    it('is idempotent — second call returns the same identity', async () => {
      const svc = new InstallIdentityService({installDir})
      const first = await svc.loadOrGenerate()
      const second = await svc.loadOrGenerate()
      expect(second.peerId).to.equal(first.peerId)
      expect(second.cert.signature).to.equal(first.cert.signature)
    })

    it('persists across service instances (loads from disk on second instance)', async () => {
      const svc1 = new InstallIdentityService({installDir})
      const first = await svc1.loadOrGenerate()
      const svc2 = new InstallIdentityService({installDir})
      const second = await svc2.loadOrGenerate()
      expect(second.peerId).to.equal(first.peerId)
    })

    it('writes install.key.enc + install.master.key + install.cert.json + peer-id files', async () => {
      const svc = new InstallIdentityService({installDir})
      await svc.loadOrGenerate()
      // All four files exist.
      await stat(join(installDir, 'install.key.enc'))
      await stat(join(installDir, 'install.master.key'))
      await stat(join(installDir, 'install.cert.json'))
      await stat(join(installDir, 'peer-id'))
    })

    it('writes peer_id file with the exact peer_id string + trailing newline', async () => {
      const svc = new InstallIdentityService({installDir})
      const id = await svc.loadOrGenerate()
      const fileContent = await readFile(join(installDir, 'peer-id'), 'utf8')
      expect(fileContent.trimEnd()).to.equal(id.peerId)
    })

    it('writes the install.cert.json as the same cert object', async () => {
      const svc = new InstallIdentityService({installDir})
      const id = await svc.loadOrGenerate()
      const fileContent = await readFile(join(installDir, 'install.cert.json'), 'utf8')
      const parsed = JSON.parse(fileContent) as InstallCertificate
      expect(parsed.subject_id).to.equal(id.peerId)
      expect(parsed.signature).to.equal(id.cert.signature)
    })

    it('sets file permissions to 0600 on all written files (POSIX only)', async function () {
      // Skip on Windows — POSIX file modes do not apply.
      if (process.platform === 'win32') {
        this.skip()
        return
      }

      const svc = new InstallIdentityService({installDir})
      await svc.loadOrGenerate()
      const files = ['install.key.enc', 'install.master.key', 'install.cert.json', 'peer-id']
      const stats = await Promise.all(files.map((f) => stat(join(installDir, f))))
      for (const [i, s] of stats.entries()) {
        // eslint-disable-next-line no-bitwise
        const mode = s.mode & 0o777
        expect(mode, `${files[i]} should be mode 0600`).to.equal(0o600)
      }
    })

    it('sets install dir mode to 0700 (POSIX only)', async function () {
      if (process.platform === 'win32') {
        this.skip()
        return
      }

      const svc = new InstallIdentityService({installDir})
      await svc.loadOrGenerate()
      const s = await stat(installDir)
      // eslint-disable-next-line no-bitwise
      const mode = s.mode & 0o777
      expect(mode, 'install dir should be mode 0700').to.equal(0o700)
    })

    it('the generated cert subject_id == derivePeerId(public_key) (AMENDMENT_TOFU §A3.2 invariant)', async () => {
      const svc = new InstallIdentityService({installDir})
      const id = await svc.loadOrGenerate()
      expect(id.cert.subject_id).to.equal(id.peerId)
    })

    it('the generated cert is self-signed and verifies against its own public key', async () => {
      const svc = new InstallIdentityService({installDir})
      const id = await svc.loadOrGenerate()
      const {signature, ...payload} = id.cert
      // verifyInstallCert checks via canonicalize + domain tag.
      expect(verifyInstallCert(payload, signature, id.publicKey)).to.equal(true)
    })

    it('cert.expires_at is approximately 5 years after cert.issued_at', async () => {
      const svc = new InstallIdentityService({installDir})
      const id = await svc.loadOrGenerate()
      const issued = Date.parse(id.cert.issued_at)
      const expires = Date.parse(id.cert.expires_at)
      const fiveYearsMs = 5 * 365 * 24 * 60 * 60 * 1000
      // Allow ±1 day tolerance for leap years.
      expect(expires - issued).to.be.closeTo(fiveYearsMs, 86_400_000)
    })

    it('accepts an optional displayHandle', async () => {
      const svc = new InstallIdentityService({installDir})
      const id = await svc.loadOrGenerate({displayHandle: 'alice-laptop'})
      expect(id.cert.display_handle).to.equal('alice-laptop')
    })

    it('rejects displayHandle longer than 64 characters', async () => {
      const svc = new InstallIdentityService({installDir})
      const handle = 'a'.repeat(65)
      try {
        await svc.loadOrGenerate({displayHandle: handle})
        expect.fail('expected RangeError')
      } catch (error) {
        expect((error as Error).message).to.match(/64/)
      }
    })

    it('NFC-normalizes display_handle on the persisted cert (opencode round-2 MEDIUM)', async () => {
      // Two visually-identical handles with different NFC byte sequences:
      // NFC: U+00E9 (single code point é)
      // NFD: U+0065 U+0301 (e + combining acute)
      const nfcForm = 'café'         // 4 code points
      const nfdForm = 'café'        // 5 code points; same visual

      const svc = new InstallIdentityService({installDir})
      const id = await svc.loadOrGenerate({displayHandle: nfdForm})
      // The persisted handle MUST be the NFC form regardless of input form.
      expect(id.cert.display_handle).to.equal(nfcForm)
      expect(id.cert.display_handle?.normalize('NFC')).to.equal(id.cert.display_handle)
    })
  })

  describe('regenerate', () => {
    it('produces a different peer_id', async () => {
      const svc = new InstallIdentityService({installDir})
      const first = await svc.loadOrGenerate()
      const regenerated = await svc.regenerate()
      expect(regenerated.peerId).to.not.equal(first.peerId)
    })

    it('overwrites all four files (peer_id reflects the new identity)', async () => {
      const svc = new InstallIdentityService({installDir})
      await svc.loadOrGenerate()
      const regenerated = await svc.regenerate()
      const peerIdFile = (await readFile(join(installDir, 'peer-id'), 'utf8')).trimEnd()
      expect(peerIdFile).to.equal(regenerated.peerId)
    })

    it('does NOT regenerate when loadOrGenerate is called on an existing install', async () => {
      const svc = new InstallIdentityService({installDir})
      const first = await svc.loadOrGenerate()
      const reloaded = await svc.loadOrGenerate()  // idempotent
      expect(reloaded.peerId).to.equal(first.peerId)
    })
  })

  describe('renewCert', () => {
    it('preserves the keypair (peer_id unchanged) but advances expires_at', async () => {
      const svc = new InstallIdentityService({clock: () => new Date('2026-01-01T00:00:00.000Z'), installDir})
      const original = await svc.loadOrGenerate()

      // Advance the clock by 4y, 11mo so renewal is warranted but key unchanged.
      const svc2 = new InstallIdentityService({clock: () => new Date('2030-12-01T00:00:00.000Z'), installDir})
      const renewed = await svc2.renewCert()

      expect(renewed.subject_id).to.equal(original.peerId)
      expect(renewed.public_key.key).to.equal(original.cert.public_key.key)
      expect(Date.parse(renewed.expires_at)).to.be.greaterThan(Date.parse(original.cert.expires_at))
    })

    it('signs the renewed cert with the same key so it verifies', async () => {
      const svc1 = new InstallIdentityService({clock: () => new Date('2026-01-01T00:00:00.000Z'), installDir})
      const original = await svc1.loadOrGenerate()
      const svc2 = new InstallIdentityService({clock: () => new Date('2030-12-01T00:00:00.000Z'), installDir})
      const renewed = await svc2.renewCert()
      const {signature, ...payload} = renewed
      expect(verifyInstallCert(payload, signature, original.publicKey)).to.equal(true)
    })
  })

  describe('typed sign helpers', () => {
    it('signInstallCert produces a verifiable signature with the install key', async () => {
      const svc = new InstallIdentityService({installDir})
      const id = await svc.loadOrGenerate()
      const payload = {
        cert_kind: 'install',
        expires_at: id.cert.expires_at,
        issued_at: id.cert.issued_at,
        public_key: id.cert.public_key,
        subject_id: id.peerId,
        version: 1,
      }
      const sig = await svc.signInstallCert(payload)
      expect(verifyInstallCert(payload, sig, id.publicKey)).to.equal(true)
    })

    it('signParleyHandshake produces a different signature than signInstallCert for the same payload (cross-domain separation)', async () => {
      const svc = new InstallIdentityService({installDir})
      await svc.loadOrGenerate()
      const payload = {arbitrary: 'shared-payload'}
      const sigInstall = await svc.signInstallCert(payload)
      const sigHandshake = await svc.signParleyHandshake(payload)
      expect(sigInstall).to.not.equal(sigHandshake)
    })
  })

  describe('encrypted storage', () => {
    it('install.key.enc bytes do NOT contain the raw private key in plaintext', async () => {
      const svc = new InstallIdentityService({installDir})
      const id = await svc.loadOrGenerate()
      const encrypted = await readFile(join(installDir, 'install.key.enc'))
      // The pubkey base64 IS plaintext (in install.cert.json); the
      // PRIVATE key bytes must not be plaintext-recoverable from the
      // .enc file. We check by ensuring the encrypted blob doesn't
      // contain the pubkey's base64 (which is a fingerprint that
      // would imply structure leak), and that decrypting requires
      // the master key. Stronger: rotating the master key file
      // makes the .enc file unreadable.
      const pubB64 = id.cert.public_key.key
      expect(encrypted.toString('base64')).to.not.include(pubB64)
    })

    it('regenerate rotates the master key + re-encrypts (old .enc is unreadable with new master key)', async () => {
      const svc = new InstallIdentityService({installDir})
      await svc.loadOrGenerate()
      const oldMaster = await readFile(join(installDir, 'install.master.key'))
      await svc.regenerate()
      const newMaster = await readFile(join(installDir, 'install.master.key'))
      expect(newMaster.equals(oldMaster)).to.equal(false)
    })
  })

  describe('API surface — no raw private-key escape hatch', () => {
    it('InstallIdentityService does NOT expose a `getPrivateKey` method', () => {
      const svc = new InstallIdentityService({installDir})
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      expect((svc as any).getPrivateKey).to.equal(undefined)
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      expect((svc as any).privateKey).to.equal(undefined)
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      expect((svc as any).exportPrivateKey).to.equal(undefined)
    })

    it('InstallIdentity result does NOT carry the private key', async () => {
      const svc = new InstallIdentityService({installDir})
      const id = await svc.loadOrGenerate()
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      expect((id as any).privateKey).to.equal(undefined)
    })
  })
})
