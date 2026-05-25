/* eslint-disable camelcase */
// Cert / payload field names mirror AMENDMENT_TOFU §A3.2 on-disk JSON
// shape and are intentionally snake_case to match the wire spec.

import {keys as libp2pKeys} from '@libp2p/crypto'
import {type PrivateKey as Libp2pPrivateKey} from '@libp2p/interface'
import {createCipheriv, createDecipheriv, createPrivateKey, createPublicKey, generateKeyPairSync, type KeyObject, randomBytes} from 'node:crypto'
import {existsSync} from 'node:fs'
import {chmod, mkdir, open, readFile, rename, writeFile} from 'node:fs/promises'
import {dirname, join} from 'node:path'

import {derivePeerIdFromPublicKey} from './peer-id.js'
import {withProcessLock} from './process-lock.js'
import {
  signInstallCert as signInstallCertHelper,
  signParleyHandshake as signParleyHandshakeHelper,
  signPeerRecord as signPeerRecordHelper,
  signPeerTreeCert as signPeerTreeCertHelper,
} from './sign.js'

/**
 * Phase 9 / AMENDMENT_TOFU §A3.1, §A4.7, §A4.9.x — L1 install identity service.
 *
 * Files written under `installDir` (default `~/.brv/identity/`):
 *   - install.master.key   — random 32-byte AES key (rotated on regenerate)
 *   - install.key.enc      — AES-256-GCM-encrypted Ed25519 private key bytes
 *   - install.cert.json    — InstallCertificate (plaintext, self-signed)
 *   - peer-id              — peer_id string (52 chars + newline)
 *
 * All files: mode 0600. Parent directory: mode 0700.
 *
 * Crypto-storage pattern intentionally mirrors `FileProviderKeychainStore`
 * (existing pattern in the project). One difference: 12-byte IV for
 * AES-256-GCM (NIST SP 800-38D recommendation) rather than the 16-byte
 * IV the provider keychain uses.
 *
 * API contract: NO accessor exposes the raw private key. All signing
 * routes through the typed-per-intent helpers from sign.ts, which
 * apply domain separation.
 */

// ─── file names + crypto constants ──────────────────────────────────────────

const MASTER_KEY_FILE = 'install.master.key'
const ENCRYPTED_KEY_FILE = 'install.key.enc'
const CERT_FILE = 'install.cert.json'
const PEER_ID_FILE = 'peer-id'
const LOCK_FILE = '.install-identity.lock'
const ALGORITHM = 'aes-256-gcm'
const MASTER_KEY_LENGTH = 32
const IV_LENGTH = 12  // NIST SP 800-38D recommended IV length for GCM
const AUTH_TAG_LENGTH = 16
// Approximate; ignores leap days (off by 1–2 days). Acceptable per AMENDMENT_TOFU
// §A4.9.x which specifies "+5y" without calendar-day precision.
const FIVE_YEARS_MS = 5 * 365 * 24 * 60 * 60 * 1000
const MAX_DISPLAY_HANDLE_LENGTH = 64

// ─── types ──────────────────────────────────────────────────────────────────

export interface InstallCertificate {
  readonly cert_kind: 'install'
  readonly display_handle?: string
  readonly expires_at: string
  readonly issued_at: string
  readonly public_key: {
    readonly alg: 'ed25519'
    readonly key: string  // base64 of raw 32-byte pubkey
  }
  readonly signature: string
  readonly subject_id: string
  readonly version: 1
}

export interface InstallIdentity {
  readonly cert: InstallCertificate
  readonly peerId: string
  readonly publicKey: KeyObject
}

export interface InstallIdentityServiceDeps {
  readonly clock?: () => Date
  readonly installDir: string
}

// Internal — never leaves the service.
interface LoadedIdentity {
  readonly cert: InstallCertificate
  readonly peerId: string
  readonly privateKey: KeyObject
  readonly publicKey: KeyObject
}

// ─── service ────────────────────────────────────────────────────────────────

export class InstallIdentityService {
  private cache: LoadedIdentity | undefined
  private readonly clock: () => Date
  private readonly installDir: string

  public constructor(deps: InstallIdentityServiceDeps) {
    this.installDir = deps.installDir
    this.clock = deps.clock ?? (() => new Date())
  }

  /**
   * Return the absolute path to the install directory used by this
   * service. Slice 9.4b — `PeerTreeIdentityService` uses this to write
   * its L2 keystore alongside the L1 install files.
   */
  public getInstallDir(): string {
    return this.installDir
  }

  /**
   * Return the L1 install private key as a Node KeyObject. Used by
   * the peer-tree-signer to sign the L2 cert payload with the L1 key
   * (the L1→L2 binding). Callers MUST route signing through the
   * domain-separated `signX` helpers — there is no general `signRaw`.
   */
  public async getL1PrivateKey(): Promise<KeyObject> {
    const loaded = await this.ensureLoaded()
    return loaded.privateKey
  }

  /**
   * Return the L1 install key as a libp2p PrivateKey object.
   *
   * NARROW CONTROLLED EXCEPTION to the "no raw private key" invariant
   * (AMENDMENT_TOFU §A7 — same key drives libp2p Noise AND brv L1
   * application signatures, so libp2p needs the key material to run
   * Noise handshakes). Callers MUST use this ONLY for libp2p host
   * setup; all brv-side signing routes through the typed `signX`
   * helpers above which apply domain separation.
   *
   * Returns the libp2p PrivateKey object (NOT raw bytes). Libp2p's
   * key abstraction holds the bytes internally; once handed to
   * libp2p, the material lives in libp2p's memory.
   */
  public async getLibp2pPrivateKey(): Promise<Libp2pPrivateKey> {
    const loaded = await this.ensureLoaded()
    // Build libp2p's 64-byte raw form: [private_seed(32)][public(32)].
    // JsonWebKey type already declares `d?: string` and `x?: string`,
    // so no `as` cast is needed (opencode round-3 MINOR-4).
    const jwk = loaded.privateKey.export({format: 'jwk'})
    if (typeof jwk.d !== 'string' || typeof jwk.x !== 'string') {
      throw new TypeError('Ed25519 private KeyObject JWK is missing `d` or `x` field')
    }

    const privateSeed = Buffer.from(jwk.d, 'base64url')
    const publicBytes = Buffer.from(jwk.x, 'base64url')
    if (privateSeed.length !== 32 || publicBytes.length !== 32) {
      throw new TypeError(
        `Ed25519 private/public byte lengths wrong: d=${privateSeed.length}, x=${publicBytes.length}`,
      )
    }

    const raw = new Uint8Array(Buffer.concat([privateSeed, publicBytes]))
    return libp2pKeys.privateKeyFromRaw(raw)
  }

  /**
   * Return the raw 32-byte Ed25519 public key bytes for the L1 install
   * identity. Used by the peer-tree-signer to compute
   * `parent_install.install_pubkey_fingerprint` and by verifiers that
   * need the raw key for derivePeerId / fingerprint checks.
   */
  public async getRawPublicKey(): Promise<Uint8Array> {
    const loaded = await this.ensureLoaded()
    const jwk = loaded.publicKey.export({format: 'jwk'})
    if (typeof jwk.x !== 'string') {
      throw new TypeError('Ed25519 public KeyObject JWK is missing `x` field')
    }

    return new Uint8Array(Buffer.from(jwk.x, 'base64url'))
  }

  /**
   * Load the current install identity from disk; generate a fresh one if
   * absent. Idempotent. Most callers should use this.
   */
  public async loadOrGenerate(opts: {displayHandle?: string} = {}): Promise<InstallIdentity> {
    if (this.cache) return this.toPublicShape(this.cache)

    if (this.identityExists()) {
      const loaded = await this.loadFromDisk()
      this.cache = loaded
      return this.toPublicShape(loaded)
    }

    return this.regenerate(opts)
  }

  /**
   * Regenerate the L1 keypair. Produces a NEW peer_id. Rotates the
   * master key + re-encrypts. Caller MUST out-of-band notify any
   * previously-pinned peers — they will see the new peer_id as a
   * new peer (per AMENDMENT_TOFU §A3.3 step 4 + v1 limitation #6).
   */
  public async regenerate(opts: {displayHandle?: string} = {}): Promise<InstallIdentity> {
    // NFC-normalize at the boundary so the persisted form (and thus the
    // signed cert payload) is always in canonical Unicode form (opencode
    // round-2 MEDIUM).
    const normalizedHandle =
      opts.displayHandle === undefined ? undefined : normalizeHandle(opts.displayHandle)

    // Wrap the entire write window in a cross-process lock so two brv
    // processes calling regenerate concurrently cannot produce a split
    // master-key / encrypted-key state (opencode round-2 MEDIUM).
    // The lock lives at <installDir>/.install-identity.lock and is
    // unlinked on success OR error.
    await mkdir(this.installDir, {mode: 0o700, recursive: true})
    return withProcessLock(join(this.installDir, LOCK_FILE), async () => {
      const {privateKey, publicKey} = generateKeyPairSync('ed25519')
      const peerId = derivePeerIdFromPublicKey(publicKey)

      const now = this.clock()
      const cert = await this.buildSelfSignedCert({
        displayHandle: normalizedHandle,
        issuedAt: now,
        peerId,
        privateKey,
        publicKey,
      })

      await this.persist({cert, privateKey, publicKey})

      const loaded: LoadedIdentity = {cert, peerId, privateKey, publicKey}
      this.cache = loaded
      return this.toPublicShape(loaded)
    })
  }

  /**
   * Re-sign install.cert with the SAME key, advancing `expires_at`.
   * Use when the existing cert is close to expiry.
   */
  public async renewCert(): Promise<InstallCertificate> {
    const loaded = await this.ensureLoaded()
    return withProcessLock(join(this.installDir, LOCK_FILE), async () => {
      const now = this.clock()
      const cert = await this.buildSelfSignedCert({
        displayHandle: loaded.cert.display_handle,
        issuedAt: now,
        peerId: loaded.peerId,
        privateKey: loaded.privateKey,
        publicKey: loaded.publicKey,
      })
      await this.writeCertOnly(cert)
      this.cache = {...loaded, cert}
      return cert
    })
  }

  /** Sign an InstallCertificate payload with the L1 install key. */
  public async signInstallCert(payload: unknown): Promise<string> {
    const loaded = await this.ensureLoaded()
    return signInstallCertHelper(payload, loaded.privateKey)
  }

  /** Sign a Parley handshake envelope with the L1 install key. */
  public async signParleyHandshake(payload: unknown): Promise<string> {
    const loaded = await this.ensureLoaded()
    return signParleyHandshakeHelper(payload, loaded.privateKey)
  }

  /** Sign a brv-internal discovery peer record with the L1 install key. */
  public async signPeerRecord(payload: unknown): Promise<string> {
    const loaded = await this.ensureLoaded()
    return signPeerRecordHelper(payload, loaded.privateKey)
  }

  /** Sign a PeerTreeCertificate payload with the L1 install key. */
  public async signPeerTreeCert(payload: unknown): Promise<string> {
    const loaded = await this.ensureLoaded()
    return signPeerTreeCertHelper(payload, loaded.privateKey)
  }

  // ─── internals ────────────────────────────────────────────────────────────

  private async buildSelfSignedCert(args: {
    displayHandle?: string
    issuedAt: Date
    peerId: string
    privateKey: KeyObject
    publicKey: KeyObject
  }): Promise<InstallCertificate> {
    const pubJwk = args.publicKey.export({format: 'jwk'}) as {x?: string}
    if (typeof pubJwk.x !== 'string') {
      throw new TypeError('Ed25519 KeyObject JWK is missing the `x` field')
    }

    const expiresAt = new Date(args.issuedAt.getTime() + FIVE_YEARS_MS)
    const payload = stripUndefined<Omit<InstallCertificate, 'signature'>>({
      cert_kind: 'install',
      display_handle: args.displayHandle,
      expires_at: expiresAt.toISOString(),
      issued_at: args.issuedAt.toISOString(),
      public_key: {
        alg: 'ed25519',
        // The JWK `x` field is base64url; AMENDMENT_TOFU spec calls for
        // base64 of raw bytes. Convert.
        key: Buffer.from(pubJwk.x, 'base64url').toString('base64'),
      },
      subject_id: args.peerId,
      version: 1,
    })

    const signature = signInstallCertHelper(payload, args.privateKey)
    return {...payload, signature}
  }

  private async ensureLoaded(): Promise<LoadedIdentity> {
    if (this.cache) return this.cache
    if (!this.identityExists()) {
      throw new Error(
        'install identity not initialised; call loadOrGenerate() first',
      )
    }

    const loaded = await this.loadFromDisk()
    this.cache = loaded
    return loaded
  }

  private identityExists(): boolean {
    return (
      existsSync(join(this.installDir, MASTER_KEY_FILE)) &&
      existsSync(join(this.installDir, ENCRYPTED_KEY_FILE)) &&
      existsSync(join(this.installDir, CERT_FILE))
    )
  }

  private async loadFromDisk(): Promise<LoadedIdentity> {
    const masterKey = await readFile(join(this.installDir, MASTER_KEY_FILE))
    const encrypted = await readFile(join(this.installDir, ENCRYPTED_KEY_FILE))
    const certRaw = await readFile(join(this.installDir, CERT_FILE), 'utf8')

    if (masterKey.length !== MASTER_KEY_LENGTH) {
      throw new Error(`install.master.key has wrong length: ${masterKey.length}`)
    }

    const privateKeyDer = decryptKeyFile(masterKey, encrypted)
    const privateKey = createPrivateKey({format: 'der', key: privateKeyDer, type: 'pkcs8'})
    const publicKey = createPublicKey(privateKey)
    const peerId = derivePeerIdFromPublicKey(publicKey)
    const cert: InstallCertificate = JSON.parse(certRaw)

    // Sanity: the cert on disk must match the key we just decrypted.
    if (cert.subject_id !== peerId) {
      throw new Error(
        `install.cert.json subject_id (${cert.subject_id}) does not match decrypted key’s peer_id (${peerId})`,
      )
    }

    return {cert, peerId, privateKey, publicKey}
  }

  private async persist(args: {
    cert: InstallCertificate
    privateKey: KeyObject
    publicKey: KeyObject
  }): Promise<void> {
    await mkdir(this.installDir, {mode: 0o700, recursive: true})
    // mkdir does not chmod an existing directory; ensure mode 0700.
    if (process.platform !== 'win32') {
      await chmod(this.installDir, 0o700)
    }

    const masterKey = randomBytes(MASTER_KEY_LENGTH)
    const privateKeyDer = args.privateKey.export({format: 'der', type: 'pkcs8'})
    const encrypted = encryptKeyFile(masterKey, privateKeyDer)

    await atomicWrite(join(this.installDir, MASTER_KEY_FILE), masterKey)
    await atomicWrite(join(this.installDir, ENCRYPTED_KEY_FILE), encrypted)
    await atomicWrite(
      join(this.installDir, CERT_FILE),
      Buffer.from(`${JSON.stringify(args.cert, undefined, 2)}\n`, 'utf8'),
    )
    await atomicWrite(
      join(this.installDir, PEER_ID_FILE),
      Buffer.from(`${args.cert.subject_id}\n`, 'utf8'),
    )
  }

  private toPublicShape(loaded: LoadedIdentity): InstallIdentity {
    return {cert: loaded.cert, peerId: loaded.peerId, publicKey: loaded.publicKey}
  }

  private async writeCertOnly(cert: InstallCertificate): Promise<void> {
    await atomicWrite(
      join(this.installDir, CERT_FILE),
      Buffer.from(`${JSON.stringify(cert, undefined, 2)}\n`, 'utf8'),
    )
  }
}

// ─── crypto helpers ─────────────────────────────────────────────────────────

function encryptKeyFile(masterKey: Buffer, plaintext: Buffer): Buffer {
  const iv = randomBytes(IV_LENGTH)
  const cipher = createCipheriv(ALGORITHM, masterKey, iv, {authTagLength: AUTH_TAG_LENGTH})
  const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()])
  const authTag = cipher.getAuthTag()
  // Layout: [IV(12)][AUTH_TAG(16)][CIPHERTEXT(...)]
  return Buffer.concat([iv, authTag, ciphertext])
}

function decryptKeyFile(masterKey: Buffer, blob: Buffer): Buffer {
  if (blob.length < IV_LENGTH + AUTH_TAG_LENGTH) {
    throw new Error('install.key.enc is truncated or corrupt')
  }

  const iv = blob.subarray(0, IV_LENGTH)
  const authTag = blob.subarray(IV_LENGTH, IV_LENGTH + AUTH_TAG_LENGTH)
  const ciphertext = blob.subarray(IV_LENGTH + AUTH_TAG_LENGTH)
  const decipher = createDecipheriv(ALGORITHM, masterKey, iv, {authTagLength: AUTH_TAG_LENGTH})
  decipher.setAuthTag(authTag)
  return Buffer.concat([decipher.update(ciphertext), decipher.final()])
}

// ─── file helpers ───────────────────────────────────────────────────────────

async function atomicWrite(target: string, data: Buffer): Promise<void> {
  // Write to a sibling `.tmp.<pid>.<rand>` file with mode 0600, then
  // atomic-rename to the final path. Matches the pattern used in
  // profile-metadata-store / file-provider-keychain-store.
  const tmp = `${target}.tmp.${process.pid}.${randomBytes(4).toString('hex')}`
  await writeFile(tmp, data, {mode: 0o600})
  await rename(tmp, target)
  // Some platforms drop mode bits on rename; re-apply for defense.
  if (process.platform !== 'win32') {
    await chmod(target, 0o600)
  }

  // Fsync the parent directory so the rename is durable across a crash
  // (opencode round-2 MINOR). On ext3 / older filesystems, a crash
  // between rename and the directory entry being journaled can lose
  // the write. Best-effort: not all platforms support directory fsync.
  if (process.platform !== 'win32') {
    const dirHandle = await open(dirname(target), 'r').catch(() => {})
    if (dirHandle) {
      await dirHandle.sync().catch(() => {})
      await dirHandle.close().catch(() => {})
    }
  }
}

// ─── validation helpers ─────────────────────────────────────────────────────

/**
 * Validate AND NFC-normalize a display handle (opencode round-2 MEDIUM).
 *
 * NFC-normalization MUST happen on the persisted form, not just for the
 * length check. Two visually identical handles with different NFC byte
 * sequences would otherwise canonicalize to different bytes (different
 * signatures, collision false positives, lookup mismatches).
 */
function normalizeHandle(handle: string): string {
  const normalized = handle.normalize('NFC')
  if (normalized.length > MAX_DISPLAY_HANDLE_LENGTH) {
    throw new RangeError(
      `display_handle MUST be ≤ ${MAX_DISPLAY_HANDLE_LENGTH} characters; got ${normalized.length}`,
    )
  }

  return normalized
}

function stripUndefined<T extends object>(obj: T): T {
  const out = {} as T
  for (const k of Object.keys(obj) as Array<keyof T>) {
    if (obj[k] !== undefined) out[k] = obj[k]
  }

  return out
}
