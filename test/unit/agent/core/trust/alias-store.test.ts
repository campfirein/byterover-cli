import {expect} from 'chai'
import {mkdtemp, readFile, rm, writeFile} from 'node:fs/promises'
import {tmpdir} from 'node:os'
import {join} from 'node:path'

import {AliasStore} from '../../../../../src/agent/core/trust/alias-store.js'

// Phase 9 / Slice 9.5 — local aliases for remote peer_ids so
// `brv channel mention «alice»` resolves locally instead of forcing
// operators to paste 46-char `12D3KooW…` strings.

describe('AliasStore (slice 9.5)', () => {
  let storePath: string
  let tmp: string

  beforeEach(async () => {
    tmp = await mkdtemp(join(tmpdir(), 'alias-store-test-'))
    storePath = join(tmp, 'aliases.json')
  })

  afterEach(async () => {
    await rm(tmp, {force: true, recursive: true})
  })

  describe('list / get', () => {
    it('returns empty list when the file does not exist', async () => {
      const store = new AliasStore({storePath})
      expect(await store.list()).to.deep.equal([])
    })

    it('returns undefined for an unknown alias', async () => {
      const store = new AliasStore({storePath})
      expect(await store.get('bob')).to.equal(undefined)
    })

    it('round-trips a single set + get + list', async () => {
      const store = new AliasStore({storePath})
      await store.set('bob', '12D3KooWBz5odR5rtpf7BLAtvsocDhiSPTy2TmaPaH1LMYaSdUcT')

      expect(await store.get('bob')).to.equal('12D3KooWBz5odR5rtpf7BLAtvsocDhiSPTy2TmaPaH1LMYaSdUcT')
      expect(await store.list()).to.deep.equal([{
        alias: 'bob',
        peerId: '12D3KooWBz5odR5rtpf7BLAtvsocDhiSPTy2TmaPaH1LMYaSdUcT',
      }])
    })
  })

  describe('set semantics', () => {
    it('upsert overwrites the peer_id for an existing alias', async () => {
      const store = new AliasStore({storePath})
      await store.set('alice', '12D3KooWDYtf412cnMMQ7rY4TBYiP67xX4aD89osGNpGqBSDsVTD')
      await store.set('alice', '12D3KooWBJN4DzicDP9sYBMoKBpZ1P6bTCoYgrAiXoiBxDsVUiGW')
      expect(await store.get('alice')).to.equal('12D3KooWBJN4DzicDP9sYBMoKBpZ1P6bTCoYgrAiXoiBxDsVUiGW')
      expect(await store.list()).to.have.length(1)
    })

    it('rejects empty alias names', async () => {
      const store = new AliasStore({storePath})
      try {
        await store.set('', '12D3KooWDYtf412cnMMQ7rY4TBYiP67xX4aD89osGNpGqBSDsVTD')
        expect.fail('expected empty-alias error')
      } catch (error) {
        expect((error as Error).message).to.include('ALIAS_NAME_EMPTY')
      }
    })

    it('rejects whitespace-only alias names', async () => {
      const store = new AliasStore({storePath})
      try {
        await store.set('   ', '12D3KooWDYtf412cnMMQ7rY4TBYiP67xX4aD89osGNpGqBSDsVTD')
        expect.fail('expected empty-alias error')
      } catch (error) {
        expect((error as Error).message).to.include('ALIAS_NAME_EMPTY')
      }
    })

    it('rejects alias names that start with `@` (kimi round-1 MED — orchestrator strips the sigil first)', async () => {
      const store = new AliasStore({storePath})
      try {
        await store.set('@bob', '12D3KooWBz5odR5rtpf7BLAtvsocDhiSPTy2TmaPaH1LMYaSdUcT')
        expect.fail('expected ALIAS_NAME_INVALID')
      } catch (error) {
        expect((error as Error).message).to.include('ALIAS_NAME_INVALID')
      }
    })

    it('rejects alias names containing whitespace mid-string', async () => {
      const store = new AliasStore({storePath})
      try {
        await store.set('bob smith', '12D3KooWBz5odR5rtpf7BLAtvsocDhiSPTy2TmaPaH1LMYaSdUcT')
        expect.fail('expected ALIAS_NAME_INVALID')
      } catch (error) {
        expect((error as Error).message).to.include('ALIAS_NAME_INVALID')
      }
    })

    it('rejects extremely long alias names (>64 chars)', async () => {
      const store = new AliasStore({storePath})
      try {
        await store.set('a'.repeat(65), '12D3KooWBz5odR5rtpf7BLAtvsocDhiSPTy2TmaPaH1LMYaSdUcT')
        expect.fail('expected ALIAS_NAME_TOO_LONG')
      } catch (error) {
        expect((error as Error).message).to.include('ALIAS_NAME_TOO_LONG')
      }
    })

    it('accepts alphanumeric + dash + dot + underscore', async () => {
      const store = new AliasStore({storePath})
      await store.set('bob_v2.test-1', '12D3KooWBz5odR5rtpf7BLAtvsocDhiSPTy2TmaPaH1LMYaSdUcT')
      expect(await store.get('bob_v2.test-1')).to.equal('12D3KooWBz5odR5rtpf7BLAtvsocDhiSPTy2TmaPaH1LMYaSdUcT')
    })

    it('rejects malformed peer_ids', async () => {
      const store = new AliasStore({storePath})
      try {
        await store.set('alice', 'not-a-peer-id')
        expect.fail('expected peer-id-invalid error')
      } catch (error) {
        expect((error as Error).message).to.include('ALIAS_PEER_ID_INVALID')
      }
    })

    it('trims whitespace from the alias name on write', async () => {
      const store = new AliasStore({storePath})
      await store.set('  bob  ', '12D3KooWBz5odR5rtpf7BLAtvsocDhiSPTy2TmaPaH1LMYaSdUcT')
      // Stored under the trimmed form; lookup also trims.
      expect(await store.get('bob')).to.equal('12D3KooWBz5odR5rtpf7BLAtvsocDhiSPTy2TmaPaH1LMYaSdUcT')
      expect(await store.get('  bob  ')).to.equal('12D3KooWBz5odR5rtpf7BLAtvsocDhiSPTy2TmaPaH1LMYaSdUcT')
    })
  })

  describe('remove', () => {
    it('removes an existing alias', async () => {
      const store = new AliasStore({storePath})
      await store.set('alice', '12D3KooWDYtf412cnMMQ7rY4TBYiP67xX4aD89osGNpGqBSDsVTD')
      await store.remove('alice')
      expect(await store.get('alice')).to.equal(undefined)
      expect(await store.list()).to.deep.equal([])
    })

    it('is idempotent when the alias does not exist', async () => {
      const store = new AliasStore({storePath})
      await store.remove('ghost')
      expect(await store.list()).to.deep.equal([])
    })
  })

  describe('on-disk format', () => {
    it('writes deterministic JSON sorted by alias (so diffs stay stable)', async () => {
      const store = new AliasStore({storePath})
      await store.set('charlie', '12D3KooWF84ZsawXH27wQgj44z2vKgvXgEQ36Si6rW2GxaaxY7PV')
      await store.set('alice', '12D3KooWDYtf412cnMMQ7rY4TBYiP67xX4aD89osGNpGqBSDsVTD')
      await store.set('bob', '12D3KooWBz5odR5rtpf7BLAtvsocDhiSPTy2TmaPaH1LMYaSdUcT')

      const raw = await readFile(storePath, 'utf8')
      const parsed = JSON.parse(raw) as {entries: Array<{alias: string}>}
      expect(parsed.entries.map((e) => e.alias)).to.deep.equal(['alice', 'bob', 'charlie'])
    })

    it('tolerates an empty file', async () => {
      await writeFile(storePath, '')
      const store = new AliasStore({storePath})
      expect(await store.list()).to.deep.equal([])
    })

    it('tolerates malformed JSON (returns empty list)', async () => {
      await writeFile(storePath, 'this is not json')
      const store = new AliasStore({storePath})
      expect(await store.list()).to.deep.equal([])
    })
  })

  describe('concurrency', () => {
    it('concurrent set+remove on the same alias converges to a deterministic final state (kimi round-1 LOW)', async () => {
      const store = new AliasStore({storePath})
      const peerId = '12D3KooWBz5odR5rtpf7BLAtvsocDhiSPTy2TmaPaH1LMYaSdUcT'
      // Fire 50 sets + 50 removes concurrently. The flock + in-process
      // queue must serialise them; the final state is "either present
      // or absent" — never half-corrupt.
      const ops: Array<Promise<void>> = []
      for (let i = 0; i < 50; i++) {
        ops.push(store.set('shared', peerId), store.remove('shared'))
      }

      await Promise.all(ops)

      // Final state is one of {present, absent}; verify list size is
      // 0 or 1 (NOT corrupted with stale partial writes).
      const entries = await store.list()
      expect([0, 1]).to.include(entries.length)
      if (entries.length === 1) {
        expect(entries[0].alias).to.equal('shared')
        expect(entries[0].peerId).to.equal(peerId)
      }
    })

    it('two AliasStore instances sharing a storePath serialise via the module-level queue', async () => {
      const peerA = '12D3KooWBz5odR5rtpf7BLAtvsocDhiSPTy2TmaPaH1LMYaSdUcT'
      const peerB = '12D3KooWDYtf412cnMMQ7rY4TBYiP67xX4aD89osGNpGqBSDsVTD'
      const a = new AliasStore({storePath})
      const b = new AliasStore({storePath})
      // Interleaved sets via two store instances on the same file —
      // the in-process queue keyed by absolute path coordinates them.
      await Promise.all([
        a.set('alpha', peerA),
        b.set('beta', peerB),
        a.set('gamma', peerA),
        b.set('delta', peerB),
      ])
      const entries = await a.list()
      expect(entries.map((e) => e.alias).sort()).to.deep.equal(['alpha', 'beta', 'delta', 'gamma'])
    })
  })

  describe('reverse lookup', () => {
    it('findAliasForPeerId returns the alias for a known peer_id', async () => {
      const store = new AliasStore({storePath})
      await store.set('alice', '12D3KooWDYtf412cnMMQ7rY4TBYiP67xX4aD89osGNpGqBSDsVTD')
      expect(await store.findAliasForPeerId('12D3KooWDYtf412cnMMQ7rY4TBYiP67xX4aD89osGNpGqBSDsVTD')).to.equal('alice')
    })

    it('findAliasForPeerId trims input whitespace (kimi round-1 LOW)', async () => {
      const store = new AliasStore({storePath})
      const peerId = '12D3KooWBz5odR5rtpf7BLAtvsocDhiSPTy2TmaPaH1LMYaSdUcT'
      await store.set('alice', peerId)
      expect(await store.findAliasForPeerId(`  ${peerId}  `)).to.equal('alice')
    })

    it('findAliasForPeerId returns undefined when the peer_id is not aliased', async () => {
      const store = new AliasStore({storePath})
      expect(await store.findAliasForPeerId('12D3KooWNk5WQAutHkg2qjQ38HcUvtTiuLtMFRpHFaPkEQq46pP7')).to.equal(undefined)
    })
  })
})
