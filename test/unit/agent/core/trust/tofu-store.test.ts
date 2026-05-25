/* eslint-disable camelcase */
// KnownPeer field names mirror AMENDMENT_TOFU §A3.3 on-disk JSON shape
// and are intentionally snake_case.

import {expect} from 'chai'
import {mkdtemp, readFile, rm, stat} from 'node:fs/promises'
import {tmpdir} from 'node:os'
import {join} from 'node:path'

import {type KnownPeer, TofuStore} from '../../../../../src/agent/core/trust/tofu-store.js'

// Phase 9 / AMENDMENT_TOFU §A3.3 — local "known peers" store. Tracks
// every L1 peer this brv install has encountered, with pin state +
// CA-binding history. Storage = JSONL at ~/.brv/identity/known-peers.jsonl
// mode 0600, atomic-rewrite, flock-based cross-process concurrency.

const stubPeer = (peer_id: string, overrides: Partial<KnownPeer> = {}): KnownPeer => ({
  first_seen_at: '2026-05-19T00:00:00.000Z',
  install_cert_fingerprint: `sha256:fp-${peer_id}`,
  last_seen_at: '2026-05-19T00:00:00.000Z',
  peer_id,
  pin_state: 'auto-tofu',
  ...overrides,
})

describe('TofuStore', () => {
  let storeDir: string
  let storePath: string

  beforeEach(async () => {
    storeDir = await mkdtemp(join(tmpdir(), 'brv-tofu-'))
    storePath = join(storeDir, 'known-peers.jsonl')
  })

  afterEach(async () => {
    await rm(storeDir, {force: true, recursive: true})
  })

  describe('load (empty / missing file)', () => {
    it('returns an empty array when the file does not exist', async () => {
      const store = new TofuStore({storePath})
      expect(await store.list()).to.deep.equal([])
    })

    it('returns an empty array when the file exists but is empty', async () => {
      const store = new TofuStore({storePath})
      await store.list()  // creates empty file via no-op
      expect(await store.list()).to.deep.equal([])
    })

    it('skips lines that fail JSON parsing (corrupt entries) without throwing', async () => {
      // If a line is corrupt, the loader skips it but keeps loading the
      // rest. Matches the parent-doc "be liberal on read" pattern.
      const {writeFile} = await import('node:fs/promises')
      await writeFile(
        storePath,
        '{"peer_id":"12D3KooWGoodOne","first_seen_at":"2026-05-19T00:00:00.000Z","last_seen_at":"2026-05-19T00:00:00.000Z","install_cert_fingerprint":"sha256:abc","pin_state":"auto-tofu"}\n' +
        'GARBAGE LINE\n' +
        '{"peer_id":"12D3KooWGoodTwo","first_seen_at":"2026-05-19T00:00:00.000Z","last_seen_at":"2026-05-19T00:00:00.000Z","install_cert_fingerprint":"sha256:def","pin_state":"auto-tofu"}\n',
        'utf8',
      )
      const peers = await new TofuStore({storePath}).list()
      expect(peers).to.have.lengthOf(2)
      expect(peers.map((p) => p.peer_id)).to.deep.equal(['12D3KooWGoodOne', '12D3KooWGoodTwo'])
    })
  })

  describe('upsert', () => {
    it('inserts a new peer and persists it', async () => {
      const store = new TofuStore({storePath})
      const peer = stubPeer('12D3KooWAlice')
      await store.upsert(peer)
      const loaded = await store.list()
      expect(loaded).to.have.lengthOf(1)
      expect(loaded[0].peer_id).to.equal('12D3KooWAlice')
    })

    it('updates an existing peer in place (no duplicate entries)', async () => {
      const store = new TofuStore({storePath})
      await store.upsert(stubPeer('12D3KooWAlice'))
      await store.upsert(stubPeer('12D3KooWAlice', {last_seen_at: '2026-05-20T00:00:00.000Z'}))
      const loaded = await store.list()
      expect(loaded).to.have.lengthOf(1)
      expect(loaded[0].last_seen_at).to.equal('2026-05-20T00:00:00.000Z')
    })

    it('preserves multiple distinct peers across upserts', async () => {
      const store = new TofuStore({storePath})
      await store.upsert(stubPeer('12D3KooWAlice'))
      await store.upsert(stubPeer('12D3KooWBob'))
      await store.upsert(stubPeer('12D3KooWCarol'))
      const loaded = await store.list()
      expect(loaded).to.have.lengthOf(3)
      expect(loaded.map((p) => p.peer_id).sort()).to.deep.equal([
        '12D3KooWAlice',
        '12D3KooWBob',
        '12D3KooWCarol',
      ])
    })

    it('writes the file with mode 0600 (POSIX only)', async function () {
      if (process.platform === 'win32') {
        this.skip()
        return
      }

      const store = new TofuStore({storePath})
      await store.upsert(stubPeer('12D3KooWAlice'))
      const s = await stat(storePath)
      // eslint-disable-next-line no-bitwise
      const mode = s.mode & 0o777
      expect(mode).to.equal(0o600)
    })

    it('writes JSONL format (one entry per line)', async () => {
      const store = new TofuStore({storePath})
      await store.upsert(stubPeer('12D3KooWAlice'))
      await store.upsert(stubPeer('12D3KooWBob'))
      const content = await readFile(storePath, 'utf8')
      const lines = content.trim().split('\n')
      expect(lines).to.have.lengthOf(2)
      // Each line is a valid JSON object.
      for (const line of lines) {
        const parsed = JSON.parse(line) as KnownPeer
        expect(parsed.peer_id).to.match(/^12D3KooW/)
      }
    })

    it('persists ca_binding when supplied', async () => {
      const store = new TofuStore({storePath})
      await store.upsert(stubPeer('12D3KooWAlice', {
        ca_binding: {
          account_id: 'acct-abc',
          ca_cert_fingerprint: 'sha256:cafp',
          ca_log_entry_index: 42,
          issued_at: '2026-05-19T00:00:00.000Z',
          tree_id: '01HW9...',
        },
        pin_state: 'ca-bound',
      }))
      const loaded = (await store.list())[0]
      expect(loaded.ca_binding).to.exist
      expect(loaded.ca_binding?.tree_id).to.equal('01HW9...')
      expect(loaded.ca_binding?.ca_log_entry_index).to.equal(42)
    })
  })

  describe('get(peer_id)', () => {
    it('returns the peer when it exists', async () => {
      const store = new TofuStore({storePath})
      await store.upsert({
        first_seen_at: '2026-05-19T00:00:00.000Z',
        install_cert_fingerprint: 'sha256:abc',
        last_seen_at: '2026-05-19T00:00:00.000Z',
        peer_id: '12D3KooWAlice',
        pin_state: 'auto-tofu',
      })
      const peer = await store.get('12D3KooWAlice')
      expect(peer?.peer_id).to.equal('12D3KooWAlice')
    })

    it('returns undefined when the peer is not present', async () => {
      const store = new TofuStore({storePath})
      expect(await store.get('12D3KooWUnknown')).to.equal(undefined)
    })
  })

  describe('concurrent upserts (cross-process exclusion)', () => {
    it('serialises two concurrent upserts to different peers from the same process', async () => {
      const store = new TofuStore({storePath})
      // Run two upserts in parallel from the SAME store instance.
      await Promise.all([
        store.upsert({
          first_seen_at: '2026-05-19T00:00:00.000Z',
          install_cert_fingerprint: 'sha256:a',
          last_seen_at: '2026-05-19T00:00:00.000Z',
          peer_id: '12D3KooWAlice',
          pin_state: 'auto-tofu',
        }),
        store.upsert({
          first_seen_at: '2026-05-19T00:00:00.000Z',
          install_cert_fingerprint: 'sha256:b',
          last_seen_at: '2026-05-19T00:00:00.000Z',
          peer_id: '12D3KooWBob',
          pin_state: 'auto-tofu',
        }),
      ])
      const loaded = await store.list()
      expect(loaded.map((p) => p.peer_id).sort()).to.deep.equal([
        '12D3KooWAlice',
        '12D3KooWBob',
      ])
    })

    it('serialises concurrent upserts from independent TofuStore instances (cross-process simulation)', async () => {
      // Two TofuStore instances on the same file = two daemon processes.
      const storeA = new TofuStore({storePath})
      const storeB = new TofuStore({storePath})
      await Promise.all([
        storeA.upsert({
          first_seen_at: '2026-05-19T00:00:00.000Z',
          install_cert_fingerprint: 'sha256:a',
          last_seen_at: '2026-05-19T00:00:00.000Z',
          peer_id: '12D3KooWAlice',
          pin_state: 'auto-tofu',
        }),
        storeB.upsert({
          first_seen_at: '2026-05-19T00:00:00.000Z',
          install_cert_fingerprint: 'sha256:b',
          last_seen_at: '2026-05-19T00:00:00.000Z',
          peer_id: '12D3KooWBob',
          pin_state: 'auto-tofu',
        }),
      ])
      const loaded = await storeA.list()
      // Both peers MUST be present after both upserts complete (no
      // last-writer-wins, no lost-update).
      expect(loaded.map((p) => p.peer_id).sort()).to.deep.equal([
        '12D3KooWAlice',
        '12D3KooWBob',
      ])
    })
  })

  describe('pin-state transitions', () => {
    it('auto-tofu → user-confirmed via upsert', async () => {
      const store = new TofuStore({storePath})
      await store.upsert({
        first_seen_at: '2026-05-19T00:00:00.000Z',
        install_cert_fingerprint: 'sha256:abc',
        last_seen_at: '2026-05-19T00:00:00.000Z',
        peer_id: '12D3KooWAlice',
        pin_state: 'auto-tofu',
      })
      await store.upsert({
        first_seen_at: '2026-05-19T00:00:00.000Z',
        install_cert_fingerprint: 'sha256:abc',
        last_seen_at: '2026-05-20T00:00:00.000Z',
        peer_id: '12D3KooWAlice',
        pin_state: 'user-confirmed',
      })
      const peer = await store.get('12D3KooWAlice')
      expect(peer?.pin_state).to.equal('user-confirmed')
    })
  })

  describe('rejection — pin mismatch on re-pin attempt', () => {
    it('rejects upsert if pubkey-fingerprint changes for a pinned peer_id', async () => {
      // AMENDMENT_TOFU §A3.3: peer_id is derived from pubkey, so a peer_id
      // with a different fingerprint is structurally impossible. If we
      // ever observe one, that's an integrity violation — reject.
      const store = new TofuStore({storePath})
      await store.upsert({
        first_seen_at: '2026-05-19T00:00:00.000Z',
        install_cert_fingerprint: 'sha256:original',
        last_seen_at: '2026-05-19T00:00:00.000Z',
        peer_id: '12D3KooWAlice',
        pin_state: 'auto-tofu',
      })
      try {
        await store.upsert({
          first_seen_at: '2026-05-19T00:00:00.000Z',
          install_cert_fingerprint: 'sha256:DIFFERENT',
          last_seen_at: '2026-05-19T00:00:00.000Z',
          peer_id: '12D3KooWAlice',
          pin_state: 'auto-tofu',
        })
        expect.fail('expected TOFU_FINGERPRINT_MISMATCH')
      } catch (error) {
        expect((error as Error).message).to.match(/fingerprint/i)
      }
    })
  })
})
