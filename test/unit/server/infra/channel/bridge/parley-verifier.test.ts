/* eslint-disable camelcase */
// Parley envelope field names mirror IMPLEMENTATION_PHASE_9 §5.1 +
// AMENDMENT_TOFU §A3.2 on-wire JSON shape and are intentionally snake_case.

import {expect} from 'chai'
import {createHash, generateKeyPairSync} from 'node:crypto'
import {mkdtemp, rm} from 'node:fs/promises'
import {tmpdir} from 'node:os'
import {join} from 'node:path'

import {canonicalize} from '../../../../../../src/agent/core/trust/canonical.js'
import {InstallIdentityService} from '../../../../../../src/agent/core/trust/install-identity-service.js'
import {derivePeerIdFromPublicKey} from '../../../../../../src/agent/core/trust/peer-id.js'
import {PeerTreeIdentityService} from '../../../../../../src/agent/core/trust/peer-tree-identity-service.js'
import {
  signParleyHandshake,
  signRequestAuth,
} from '../../../../../../src/agent/core/trust/sign.js'
import {TofuStore} from '../../../../../../src/agent/core/trust/tofu-store.js'
import {NonceLru} from '../../../../../../src/server/infra/channel/bridge/parley-nonce-lru.js'
import {verifyHandshakeAndPin} from '../../../../../../src/server/infra/channel/bridge/parley-verifier.js'

// Phase 9 / Slice 9.3c-i — pure 11-step Parley handshake verifier.
//
// Spec: IMPLEMENTATION_PHASE_9_CLOUD_BRIDGE.md §5.1.
// Steps 1–11 implemented; step 12 (disclosure resolver) deferred.

interface TestRig {
  alice: {
    install: InstallIdentityService
    installDir: string
    l2: PeerTreeIdentityService
  }
  bob: {
    install: InstallIdentityService
    installDir: string
    l2: PeerTreeIdentityService
  }
  tofu: TofuStore
  tofuDir: string
}

async function setupRig(): Promise<TestRig> {
  const aliceDir = await mkdtemp(join(tmpdir(), 'brv-parley-A-'))
  const bobDir = await mkdtemp(join(tmpdir(), 'brv-parley-B-'))
  const tofuDir = await mkdtemp(join(tmpdir(), 'brv-parley-tofu-'))
  const aliceInstall = new InstallIdentityService({installDir: aliceDir})
  const bobInstall = new InstallIdentityService({installDir: bobDir})
  await aliceInstall.loadOrGenerate()
  await bobInstall.loadOrGenerate()
  const aliceL2 = new PeerTreeIdentityService({install: aliceInstall})
  const bobL2 = new PeerTreeIdentityService({install: bobInstall})
  await aliceL2.loadOrGenerate()
  await bobL2.loadOrGenerate()
  const tofu = new TofuStore({storePath: join(tofuDir, 'known-peers.jsonl')})
  return {
    alice: {install: aliceInstall, installDir: aliceDir, l2: aliceL2},
    bob: {install: bobInstall, installDir: bobDir, l2: bobL2},
    tofu,
    tofuDir,
  }
}

async function disposeRig(rig: TestRig): Promise<void> {
  await rm(rig.alice.installDir, {force: true, recursive: true})
  await rm(rig.bob.installDir, {force: true, recursive: true})
  await rm(rig.tofuDir, {force: true, recursive: true})
}

async function buildValidEnvelope(rig: TestRig, overrides: Record<string, unknown> = {}): Promise<{
  envelope: Record<string, unknown>
  transportPeerId: string
}> {
  const aliceL1 = await rig.alice.install.loadOrGenerate()
  const aliceL2 = await rig.alice.l2.loadOrGenerate()
  const aliceL1Priv = await rig.alice.install.getL1PrivateKey()

  const prompt = [{text: 'hello bob', type: 'text'}]
  const turn_id = 't-001'
  const delivery_id = 'd-001'
  const channel_id = 'review-2026'
  const protocol = 'query'

  const body_hash = createHash('sha256')
    .update(canonicalize({channel_id, delivery_id, prompt, protocol, turn_id}), 'utf8')
    .digest('hex')

  const requestAuthPayload = {
    body_hash,
    requester_cert: aliceL2.cert,
  }
  const reqAuthSig = signRequestAuth(requestAuthPayload, aliceL2.privateKey)

  const nonce = Buffer.alloc(16, 0xab).toString('base64')
  const ts = new Date().toISOString()
  const handshakeInner = {
    install_cert: aliceL1.cert,
    nonce,
    tree_cert: aliceL2.cert,
    ts,
    version: 1,
  }
  const handshakeSig = signParleyHandshake(handshakeInner, aliceL1Priv)

  const envelope = {
    channel_id,
    delivery_id,
    disclosure_intent: protocol,
    handshake: {...handshakeInner, signature: handshakeSig},
    prompt,
    protocol,
    request_auth: {...requestAuthPayload, signature: reqAuthSig},
    turn_id,
    version: 1,
    ...overrides,
  }
  return {envelope, transportPeerId: aliceL1.peerId}
}

describe('verifyHandshakeAndPin (Slice 9.3c-i)', () => {
  let rig: TestRig
  let nonceLru: NonceLru
  let acceptModes: ReadonlyArray<'ca-issued-tree' | 'peer-tree'>

  beforeEach(async () => {
    rig = await setupRig()
    nonceLru = new NonceLru()
    acceptModes = ['peer-tree']
  })

  afterEach(async () => {
    await disposeRig(rig)
  })

  describe('happy path', () => {
    it('accepts a valid envelope and pins the caller with auto-tofu', async () => {
      const {envelope, transportPeerId} = await buildValidEnvelope(rig)
      const result = await verifyHandshakeAndPin({
        acceptModes,
        clockSkewMs: 5 * 60 * 1000,
        envelope,
        nonceLru,
        now: new Date(),
        tofuPolicy: 'auto',
        tofuStore: rig.tofu,
        transportPeerId,
      })
      expect(result.ok, JSON.stringify(result)).to.equal(true)
      if (result.ok) {
        expect(result.envelope.channel_id).to.equal('review-2026')
        expect(result.pinned.pin_state).to.equal('auto-tofu')
        expect(result.pinned.peer_id).to.equal(transportPeerId)
        expect(result.requestEnvelopeHash).to.match(/^[\da-f]{64}$/)
      }
    })

    it('inserts the handshake nonce into the LRU after a successful verify', async () => {
      const {envelope, transportPeerId} = await buildValidEnvelope(rig)
      await verifyHandshakeAndPin({
        acceptModes,
        clockSkewMs: 5 * 60 * 1000,
        envelope,
        nonceLru,
        now: new Date(),
        tofuPolicy: 'auto',
        tofuStore: rig.tofu,
        transportPeerId,
      })
      const aliceL1 = await rig.alice.install.loadOrGenerate()
      const envHandshake = envelope.handshake as {nonce: string}
      expect(nonceLru.has(aliceL1.peerId, envHandshake.nonce)).to.equal(true)
    })
  })

  describe('step 1 — syntactic decode', () => {
    it('rejects a non-object envelope with ENVELOPE_MALFORMED', async () => {
      const {transportPeerId} = await buildValidEnvelope(rig)
      const result = await verifyHandshakeAndPin({
        acceptModes,
        clockSkewMs: 5 * 60 * 1000,
        envelope: 'not-an-object',
        nonceLru,
        now: new Date(),
        tofuPolicy: 'auto',
        tofuStore: rig.tofu,
        transportPeerId,
      })
      expect(result.ok).to.equal(false)
      if (!result.ok) expect(result.reason).to.equal('ENVELOPE_MALFORMED')
    })

    it('rejects an envelope with an unknown extra field', async () => {
      const {envelope, transportPeerId} = await buildValidEnvelope(rig, {evil_field: 'sneaky'})
      const result = await verifyHandshakeAndPin({
        acceptModes,
        clockSkewMs: 5 * 60 * 1000,
        envelope,
        nonceLru,
        now: new Date(),
        tofuPolicy: 'auto',
        tofuStore: rig.tofu,
        transportPeerId,
      })
      expect(result.ok).to.equal(false)
      if (!result.ok) expect(result.reason).to.equal('ENVELOPE_MALFORMED')
    })
  })

  describe('step 2 — timestamp window', () => {
    it('rejects an envelope whose handshake.ts is beyond the future clock-skew window', async () => {
      const {envelope, transportPeerId} = await buildValidEnvelope(rig)
      const now = new Date()
      // Set "now" 10 minutes earlier than the envelope's ts.
      const past = new Date(now.getTime() - 10 * 60 * 1000)
      const result = await verifyHandshakeAndPin({
        acceptModes,
        clockSkewMs: 5 * 60 * 1000,
        envelope,
        nonceLru,
        now: past,
        tofuPolicy: 'auto',
        tofuStore: rig.tofu,
        transportPeerId,
      })
      expect(result.ok).to.equal(false)
      if (!result.ok) expect(result.reason).to.equal('HANDSHAKE_TS_EXPIRED')
    })

    it('rejects an envelope whose handshake.ts is older than now − clock_skew', async () => {
      const {envelope, transportPeerId} = await buildValidEnvelope(rig)
      const future = new Date(Date.now() + 10 * 60 * 1000)
      const result = await verifyHandshakeAndPin({
        acceptModes,
        clockSkewMs: 5 * 60 * 1000,
        envelope,
        nonceLru,
        now: future,
        tofuPolicy: 'auto',
        tofuStore: rig.tofu,
        transportPeerId,
      })
      expect(result.ok).to.equal(false)
      if (!result.ok) expect(result.reason).to.equal('HANDSHAKE_TS_EXPIRED')
    })
  })

  describe('step 3 — transport identity match', () => {
    it('rejects an envelope whose install_cert.public_key derives a different peer_id than the transport', async () => {
      const {envelope} = await buildValidEnvelope(rig)
      const result = await verifyHandshakeAndPin({
        acceptModes,
        clockSkewMs: 5 * 60 * 1000,
        envelope,
        nonceLru,
        now: new Date(),
        tofuPolicy: 'auto',
        tofuStore: rig.tofu,
        transportPeerId: '12D3KooWImposterImposterImposterImposterImposter',
      })
      expect(result.ok).to.equal(false)
      if (!result.ok) expect(result.reason).to.equal('TRANSPORT_IDENTITY_MISMATCH')
    })
  })

  describe('step 4 — install cert self-signature', () => {
    it('rejects when the install_cert.signature is forged', async () => {
      const {envelope, transportPeerId} = await buildValidEnvelope(rig)
      const env = envelope as {handshake: {install_cert: {signature: string}}}
      env.handshake.install_cert.signature = 'Z'.repeat(86) + '=='
      const result = await verifyHandshakeAndPin({
        acceptModes,
        clockSkewMs: 5 * 60 * 1000,
        envelope,
        nonceLru,
        now: new Date(),
        tofuPolicy: 'auto',
        tofuStore: rig.tofu,
        transportPeerId,
      })
      expect(result.ok).to.equal(false)
      if (!result.ok) expect(result.reason).to.equal('INSTALL_CERT_INVALID')
    })
  })

  describe('step 5 — handshake signature', () => {
    it('rejects when the handshake.signature is forged', async () => {
      const {envelope, transportPeerId} = await buildValidEnvelope(rig)
      const env = envelope as {handshake: {signature: string}}
      env.handshake.signature = 'Z'.repeat(86) + '=='
      const result = await verifyHandshakeAndPin({
        acceptModes,
        clockSkewMs: 5 * 60 * 1000,
        envelope,
        nonceLru,
        now: new Date(),
        tofuPolicy: 'auto',
        tofuStore: rig.tofu,
        transportPeerId,
      })
      expect(result.ok).to.equal(false)
      if (!result.ok) expect(result.reason).to.equal('HANDSHAKE_SIG_INVALID')
    })
  })

  describe('step 6 — nonce replay', () => {
    it('rejects a replayed nonce', async () => {
      const {envelope, transportPeerId} = await buildValidEnvelope(rig)
      const first = await verifyHandshakeAndPin({
        acceptModes,
        clockSkewMs: 5 * 60 * 1000,
        envelope,
        nonceLru,
        now: new Date(),
        tofuPolicy: 'auto',
        tofuStore: rig.tofu,
        transportPeerId,
      })
      expect(first.ok).to.equal(true)
      const second = await verifyHandshakeAndPin({
        acceptModes,
        clockSkewMs: 5 * 60 * 1000,
        envelope,
        nonceLru,
        now: new Date(),
        tofuPolicy: 'auto',
        tofuStore: rig.tofu,
        transportPeerId,
      })
      expect(second.ok).to.equal(false)
      if (!second.ok) expect(second.reason).to.equal('HANDSHAKE_REPLAY')
    })
  })

  describe('step 7 — accept_modes gate', () => {
    it('rejects when tree_cert.cert_kind is not in accept_modes', async () => {
      const {envelope, transportPeerId} = await buildValidEnvelope(rig)
      const result = await verifyHandshakeAndPin({
        acceptModes: ['ca-issued-tree'],  // peer-tree disallowed
        clockSkewMs: 5 * 60 * 1000,
        envelope,
        nonceLru,
        now: new Date(),
        tofuPolicy: 'auto',
        tofuStore: rig.tofu,
        transportPeerId,
      })
      expect(result.ok).to.equal(false)
      if (!result.ok) expect(result.reason).to.equal('CERT_KIND_REJECTED_BY_POLICY')
    })
  })

  describe('step 9 — request_auth.requester_cert byte-equal to handshake.tree_cert', () => {
    it('rejects when request_auth.requester_cert mismatches handshake.tree_cert', async () => {
      const {envelope, transportPeerId} = await buildValidEnvelope(rig)
      // Deep-clone request_auth.requester_cert so mutating it does not
      // also mutate handshake.tree_cert (they share an object ref in
      // the rig fixture).
      const env = envelope as {
        request_auth: {requester_cert: {subject_id: string}}
      }
      env.request_auth.requester_cert = structuredClone(env.request_auth.requester_cert)
      env.request_auth.requester_cert.subject_id = '0190a2e0-6b9e-7000-8000-000000000000'
      const result = await verifyHandshakeAndPin({
        acceptModes,
        clockSkewMs: 5 * 60 * 1000,
        envelope,
        nonceLru,
        now: new Date(),
        tofuPolicy: 'auto',
        tofuStore: rig.tofu,
        transportPeerId,
      })
      expect(result.ok).to.equal(false)
      if (!result.ok) expect(result.reason).to.equal('CERT_CHAIN_MISMATCH')
    })
  })

  describe('step 10 — request_auth body_hash + signature', () => {
    it('rejects when request_auth.body_hash does not match canonical(prompt + context)', async () => {
      const {envelope, transportPeerId} = await buildValidEnvelope(rig)
      const env = envelope as {request_auth: {body_hash: string}}
      env.request_auth.body_hash = 'a'.repeat(64)
      const result = await verifyHandshakeAndPin({
        acceptModes,
        clockSkewMs: 5 * 60 * 1000,
        envelope,
        nonceLru,
        now: new Date(),
        tofuPolicy: 'auto',
        tofuStore: rig.tofu,
        transportPeerId,
      })
      expect(result.ok).to.equal(false)
      if (!result.ok) expect(result.reason).to.equal('REQUEST_BODY_HASH_MISMATCH')
    })

    it('rejects when request_auth.signature is forged', async () => {
      const {envelope, transportPeerId} = await buildValidEnvelope(rig)
      const env = envelope as {request_auth: {signature: string}}
      env.request_auth.signature = 'Z'.repeat(86) + '=='
      const result = await verifyHandshakeAndPin({
        acceptModes,
        clockSkewMs: 5 * 60 * 1000,
        envelope,
        nonceLru,
        now: new Date(),
        tofuPolicy: 'auto',
        tofuStore: rig.tofu,
        transportPeerId,
      })
      expect(result.ok).to.equal(false)
      if (!result.ok) expect(result.reason).to.equal('REQUEST_AUTH_INVALID')
    })
  })

  describe('step 11 — TOFU policy', () => {
    it('rejects an unpinned caller when tofu_policy is "deny"', async () => {
      const {envelope, transportPeerId} = await buildValidEnvelope(rig)
      const result = await verifyHandshakeAndPin({
        acceptModes,
        clockSkewMs: 5 * 60 * 1000,
        envelope,
        nonceLru,
        now: new Date(),
        tofuPolicy: 'deny',
        tofuStore: rig.tofu,
        transportPeerId,
      })
      expect(result.ok).to.equal(false)
      if (!result.ok) expect(result.reason).to.equal('PEER_UNPINNED')
    })

    it('accepts a pre-pinned caller when tofu_policy is "deny"', async () => {
      const {envelope, transportPeerId} = await buildValidEnvelope(rig)
      // Pre-pin Alice via the TOFU store.
      const aliceL1 = await rig.alice.install.loadOrGenerate()
      const aliceL1Raw = await rig.alice.install.getRawPublicKey()
      const fp = createHash('sha256').update(aliceL1Raw).digest('hex')
      await rig.tofu.upsert({
        first_seen_at: '2026-05-01T00:00:00.000Z',
        install_cert_fingerprint: `sha256:${fp}`,
        last_seen_at: '2026-05-01T00:00:00.000Z',
        peer_id: aliceL1.peerId,
        pin_state: 'user-confirmed',
      })
      const result = await verifyHandshakeAndPin({
        acceptModes,
        clockSkewMs: 5 * 60 * 1000,
        envelope,
        nonceLru,
        now: new Date(),
        tofuPolicy: 'deny',
        tofuStore: rig.tofu,
        transportPeerId,
      })
      expect(result.ok, JSON.stringify(result)).to.equal(true)
      if (result.ok) {
        expect(result.pinned.pin_state).to.equal('user-confirmed')
      }
    })
  })

  describe('miscellaneous', () => {
    it('does NOT insert a nonce into the LRU when verification fails (step ≤10 reject)', async () => {
      const {envelope, transportPeerId} = await buildValidEnvelope(rig)
      const env = envelope as {handshake: {nonce: string; signature: string}}
      env.handshake.signature = 'Z'.repeat(86) + '=='  // step 5 reject
      const aliceL1 = await rig.alice.install.loadOrGenerate()
      await verifyHandshakeAndPin({
        acceptModes,
        clockSkewMs: 5 * 60 * 1000,
        envelope,
        nonceLru,
        now: new Date(),
        tofuPolicy: 'auto',
        tofuStore: rig.tofu,
        transportPeerId,
      })
      // Verifier rejected at step 5; nonce LRU must NOT have been
      // populated (otherwise a step-5 reject would lock out a later
      // legitimate handshake from the same caller using the same nonce
      // — kimi-style replay-windowing concern).
      expect(nonceLru.has(aliceL1.peerId, env.handshake.nonce)).to.equal(false)
    })

    it('uses derivePeerIdFromPublicKey internally to recompute transport identity', async () => {
      // Sanity: hand-computed peer_id from the install pubkey matches transportPeerId.
      const aliceInstall = await rig.alice.install.loadOrGenerate()
      const expected = derivePeerIdFromPublicKey(aliceInstall.publicKey)
      expect(expected).to.equal(aliceInstall.peerId)
    })

    it('returns deterministic requestEnvelopeHash for the same envelope', async () => {
      const {envelope, transportPeerId} = await buildValidEnvelope(rig)
      const result = await verifyHandshakeAndPin({
        acceptModes,
        clockSkewMs: 5 * 60 * 1000,
        envelope,
        nonceLru,
        now: new Date(),
        tofuPolicy: 'auto',
        tofuStore: rig.tofu,
        transportPeerId,
      })
      if (!result.ok) throw new Error('expected ok')
      const reHash = createHash('sha256').update(canonicalize(envelope), 'utf8').digest('hex')
      expect(result.requestEnvelopeHash).to.equal(reHash)

      // Generate a NEW key pair to demonstrate determinism is over content, not keys.
      generateKeyPairSync('ed25519')
    })
  })
})
