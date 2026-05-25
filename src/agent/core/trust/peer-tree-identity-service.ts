 
// PeerTreeCertificate fields mirror AMENDMENT_TOFU §A3.2 on-disk JSON
// shape and are intentionally snake_case.

import {
  createCipheriv,
  createDecipheriv,
  createHash,
  createPrivateKey,
  createPublicKey,
  generateKeyPairSync,
  KeyObject,
  randomBytes,
} from 'node:crypto'
import {existsSync} from 'node:fs'
import {chmod, mkdir, readFile, rename, unlink, writeFile} from 'node:fs/promises'
import {join} from 'node:path'

import {InstallIdentityService} from './install-identity-service.js'
import {issuePeerTreeCertificate, type PeerTreeCertificate} from './peer-tree-signer.js'
import {generateTreeId} from './tree-id.js'

/**
 * Phase 9 / Slice 9.4b — disk-backed L2 peer-tree identity service.
 *
 * Persists a single L2 Ed25519 keypair + an L1-signed
 * `PeerTreeCertificate` to disk so the same L2 pubkey is reused across
 * daemon restarts. Without persistence, Alice's pinned
 * `--l2-pub-key <base64>` would stop matching Bob's regenerated key
 * after a restart and every response-frame signature would fail.
 *
 * Files written under `<installDir>/`:
 *   - tree.master.key — random 32-byte AES key (rotated by `regenerate()`)
 *   - tree.key.enc    — AES-256-GCM-encrypted L2 Ed25519 private key (PKCS8 DER)
 *   - tree.cert.json  — plaintext PeerTreeCertificate (cert can be public)
 *
 * All files: mode 0600. Parent directory: mode 0700. Same pattern as
 * `InstallIdentityService` for L1.
 *
 * Slice 9.4c will refactor to per-context-tree L2 identities (one L2
 * key per `tree_id`) when project trees are wired in. 9.4b stores a
 * SINGLE shared L2 identity per install (one daemon → one L2 key).
 */

const FIVE_YEARS_MS = 5 * 365 * 24 * 60 * 60 * 1000

// Slice 9.4c will add per-tree L2 keys (`tree-<treeId>.*`). The
// `-default` suffix reserves the namespace without forcing a migration
// when that lands (kimi round-1 MEDIUM).
const MASTER_KEY_FILE = 'tree-default.master.key'
const ENCRYPTED_KEY_FILE = 'tree-default.key.enc'
const CERT_FILE = 'tree-default.cert.json'
const ALGORITHM = 'aes-256-gcm'
const MASTER_KEY_LENGTH = 32
const IV_LENGTH = 12
const AUTH_TAG_LENGTH = 16

export interface PeerTreeIdentity {
  readonly cert: PeerTreeCertificate
  readonly privateKey: KeyObject
  readonly publicKey: KeyObject
  readonly treeId: string
}

export interface PeerTreeIdentityServiceDeps {
  readonly clock?: () => Date
  readonly install: InstallIdentityService
}

export class PeerTreeIdentityService {
  private cache: PeerTreeIdentity | undefined
  private readonly clock: () => Date
  private readonly install: InstallIdentityService
  private readonly installDir: string
  // In-process serialiser so concurrent `loadOrGenerate()` callers
  // don't race the stale-purge path (kimi round-2 LOW). Without this,
  // T2's `identityExists()` could pass before T1 unlinks the files,
  // T2 then hits `loadFromDisk` and throws ENOENT instead of falling
  // through to regenerate.
  private loadPromise: Promise<PeerTreeIdentity> | undefined

  public constructor(deps: PeerTreeIdentityServiceDeps) {
    this.install = deps.install
    this.clock = deps.clock ?? (() => new Date())
    // Reuse the L1 install dir as the L2 storage location — they
    // belong together (one L2 cert per install, bound to that L1).
    this.installDir = deps.install.getInstallDir()
  }

  public async loadOrGenerate(): Promise<PeerTreeIdentity> {
    if (this.cache) return this.cache
    if (this.loadPromise) return this.loadPromise

    this.loadPromise = this.doLoadOrGenerate().finally(() => {
      this.loadPromise = undefined
    })
    return this.loadPromise
  }

  private async doLoadOrGenerate(): Promise<PeerTreeIdentity> {
    if (this.identityExists()) {
      // Wrap loadFromDisk in try/catch so a concurrent purge or any
      // other I/O race falls through to regenerate instead of throwing
      // an opaque ENOENT (kimi round-2 LOW).
      let loaded: PeerTreeIdentity | undefined
      try {
        loaded = await this.loadFromDisk()
      } catch {
        loaded = undefined
      }

      if (loaded !== undefined) {
        // Verify the L2 cert's `parent_install.install_pubkey_fingerprint`
        // against the CURRENT L1 pubkey (kimi round-1 HIGH). If the
        // operator ran `brv install regenerate` (rotating L1), the
        // persisted L2 binds to the OLD L1 key and any remote verifier
        // would reject with `INVALID_PARENT_BINDING`. Drop + regenerate
        // so the daemon recovers automatically.
        const l1PubRaw = await this.install.getRawPublicKey()
        const expectedFingerprint = createHash('sha256').update(l1PubRaw).digest('hex')
        if (loaded.cert.parent_install.install_pubkey_fingerprint === expectedFingerprint) {
          this.cache = loaded
          return loaded
        }

        await this.purgeStaleArtifacts()
        // fall through to regenerate against the current L1
      }
    }

    return this.regenerate()
  }

  private identityExists(): boolean {
    return (
      existsSync(join(this.installDir, MASTER_KEY_FILE)) &&
      existsSync(join(this.installDir, ENCRYPTED_KEY_FILE)) &&
      existsSync(join(this.installDir, CERT_FILE))
    )
  }

  private async loadFromDisk(): Promise<PeerTreeIdentity> {
    const masterKey = await readFile(join(this.installDir, MASTER_KEY_FILE))
    if (masterKey.length !== MASTER_KEY_LENGTH) {
      throw new Error(`${MASTER_KEY_FILE} has unexpected length ${masterKey.length}; expected ${MASTER_KEY_LENGTH}`)
    }

    const encrypted = await readFile(join(this.installDir, ENCRYPTED_KEY_FILE))
    if (encrypted.length < IV_LENGTH + AUTH_TAG_LENGTH) {
      throw new Error(`${ENCRYPTED_KEY_FILE} is too short to be a valid AES-256-GCM ciphertext`)
    }

    const iv = encrypted.subarray(0, IV_LENGTH)
    const authTag = encrypted.subarray(encrypted.length - AUTH_TAG_LENGTH)
    const ciphertext = encrypted.subarray(IV_LENGTH, encrypted.length - AUTH_TAG_LENGTH)
    const decipher = createDecipheriv(ALGORITHM, masterKey, iv)
    decipher.setAuthTag(authTag)
    const plaintext = Buffer.concat([decipher.update(ciphertext), decipher.final()])

    const privateKey = createPrivateKey({format: 'der', key: plaintext, type: 'pkcs8'})
    const publicKey = createPublicKey(privateKey)

    const certJson = await readFile(join(this.installDir, CERT_FILE), 'utf8')
    const cert = JSON.parse(certJson) as PeerTreeCertificate
    return {cert, privateKey, publicKey, treeId: cert.subject_id}
  }

  private async persist(args: {cert: PeerTreeCertificate; privateKey: KeyObject}): Promise<void> {
    const masterKey = randomBytes(MASTER_KEY_LENGTH)
    const iv = randomBytes(IV_LENGTH)
    const cipher = createCipheriv(ALGORITHM, masterKey, iv)
    const pkcs8 = args.privateKey.export({format: 'der', type: 'pkcs8'})
    const ciphertext = Buffer.concat([cipher.update(pkcs8 as Buffer), cipher.final()])
    const authTag = cipher.getAuthTag()

    await this.writeAtomic(MASTER_KEY_FILE, masterKey)
    await this.writeAtomic(ENCRYPTED_KEY_FILE, Buffer.concat([iv, ciphertext, authTag]))
    await this.writeAtomic(CERT_FILE, Buffer.from(`${JSON.stringify(args.cert, null, 2)}\n`, 'utf8'))
  }

  private async purgeStaleArtifacts(): Promise<void> {
    for (const name of [MASTER_KEY_FILE, ENCRYPTED_KEY_FILE, CERT_FILE]) {
      // eslint-disable-next-line no-await-in-loop
      await unlink(join(this.installDir, name)).catch(() => {})
    }
  }

  private async regenerate(): Promise<PeerTreeIdentity> {
    await mkdir(this.installDir, {mode: 0o700, recursive: true})

    const {privateKey, publicKey} = generateKeyPairSync('ed25519')
    const pubJwk = publicKey.export({format: 'jwk'}) as {x?: string}
    if (typeof pubJwk.x !== 'string') {
      throw new TypeError('L2 Ed25519 KeyObject JWK is missing the `x` field')
    }

    const l2PubKey = Buffer.from(pubJwk.x, 'base64url').toString('base64')
    const treeId = generateTreeId()

    const installIdentity = await this.install.loadOrGenerate()
    const l1PubRaw = await this.install.getRawPublicKey()
    const l1PrivateKey = await this.install.getL1PrivateKey()

    const now = this.clock()
    const cert = issuePeerTreeCertificate({
      expiresAt: new Date(now.getTime() + FIVE_YEARS_MS),
      issuedAt: now,
      l1PeerId: installIdentity.peerId,
      l1PrivateKey,
      l1PubRaw,
      l2PubKey,
      treeId,
    })

    await this.persist({cert, privateKey})

    const identity: PeerTreeIdentity = {cert, privateKey, publicKey, treeId}
    this.cache = identity
    return identity
  }

  private async writeAtomic(name: string, body: Buffer): Promise<void> {
    // Belt-and-suspenders mkdir BEFORE the temp write, in case
    // writeAtomic is ever called outside of regenerate() (kimi round-1
    // LOW — the late mkdir-after-write was happen-to-work because
    // regenerate() pre-created the dir).
    await mkdir(this.installDir, {mode: 0o700, recursive: true})
    const target = join(this.installDir, name)
    const tmp = `${target}.tmp.${process.pid}.${randomBytes(4).toString('hex')}`
    await writeFile(tmp, body, {mode: 0o600})
    await rename(tmp, target)
    if (process.platform !== 'win32') {
      await chmod(target, 0o600)
    }
  }
}
