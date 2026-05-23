import {expect} from 'chai'
import {existsSync, readFileSync, statSync, writeFileSync} from 'node:fs'
import {mkdtemp, rm} from 'node:fs/promises'
import {tmpdir} from 'node:os'
import {join} from 'node:path'

import {
  createFileBackedSessionStore,
  type ParleyAdapterSessionKey,
} from '../../../../../../src/server/infra/channel/bridge/parley-adapter-session-store.js'

// Phase 9.5.3 — unit tests for the file-backed parley adapter session store.

const KEY_A: ParleyAdapterSessionKey = {
  adapterProfile: 'claude-code',
  channelId: 'ch-1',
  projectRoot: '/proj/a',
  senderPeerId: 'peer-abc',
}

const KEY_B: ParleyAdapterSessionKey = {
  adapterProfile: 'claude-code',
  channelId: 'ch-2',
  projectRoot: '/proj/b',
  senderPeerId: 'peer-xyz',
}

describe('ParleyAdapterSessionStore (phase 9.5.3)', () => {
  let tmpDir: string
  const logs: string[] = []
  const log = (msg: string): void => { logs.push(msg) }

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), 'brv-session-store-'))
    logs.length = 0
  })

  afterEach(async () => {
    await rm(tmpDir, {force: true, recursive: true})
  })

  const makeStore = () =>
    createFileBackedSessionStore({
      filePath: join(tmpDir, 'sessions.json'),
      log,
    })

  describe('get()', () => {
    it('returns undefined when no file exists', () => {
      const store = makeStore()
      expect(store.get(KEY_A)).to.equal(undefined)
    })

    it('returns undefined for an unknown key after a write', async () => {
      const store = makeStore()
      await store.set(KEY_A, 'sess-1')
      expect(store.get(KEY_B)).to.equal(undefined)
    })
  })

  describe('set() / get() round-trip', () => {
    it('persists and retrieves a session ID', async () => {
      const store = makeStore()
      await store.set(KEY_A, 'sess-abc')
      expect(store.get(KEY_A)).to.equal('sess-abc')
    })

    it('different keys are stored independently', async () => {
      const store = makeStore()
      await store.set(KEY_A, 'sess-1')
      await store.set(KEY_B, 'sess-2')
      expect(store.get(KEY_A)).to.equal('sess-1')
      expect(store.get(KEY_B)).to.equal('sess-2')
    })

    it('overwrites when called twice for the same key', async () => {
      const store = makeStore()
      await store.set(KEY_A, 'old')
      await store.set(KEY_A, 'new')
      expect(store.get(KEY_A)).to.equal('new')
    })
  })

  describe('atomic write', () => {
    it('file exists after set() and temp file is gone', async () => {
      const store = makeStore()
      const filePath = join(tmpDir, 'sessions.json')
      await store.set(KEY_A, 'sess-x')
      expect(existsSync(filePath)).to.equal(true)
      expect(existsSync(`${filePath}.tmp`)).to.equal(false)
    })

    it('written file is valid JSON parseable as a string record', async () => {
      const store = makeStore()
      await store.set(KEY_A, 'sess-y')
      const raw = JSON.parse(readFileSync(join(tmpDir, 'sessions.json'), 'utf8')) as unknown
      expect(raw).to.be.an('object')
    })
  })

  describe('permissions', () => {
    it('file is 0600 after creation', async () => {
      const store = makeStore()
      await store.set(KEY_A, 'sess-z')
      const stat = statSync(join(tmpDir, 'sessions.json'))
      // eslint-disable-next-line no-bitwise
      expect(stat.mode & 0o777).to.equal(0o600)
    })

    it('re-chmods the file to 0600 if it was changed externally', async () => {
      const store = makeStore()
      const filePath = join(tmpDir, 'sessions.json')
      await store.set(KEY_A, 'sess-1')

      // Externally widen permissions.
      const {chmodSync} = await import('node:fs')
      chmodSync(filePath, 0o644)

      // Another set() should re-chmod.
      await store.set(KEY_B, 'sess-2')
      const stat = statSync(filePath)
      // eslint-disable-next-line no-bitwise
      expect(stat.mode & 0o777).to.equal(0o600)
    })
  })

  describe('mutex — parallel writes', () => {
    it('100 parallel set() calls all land in the final file without corruption', async () => {
      const store = makeStore()
      const writes = Array.from({length: 100}, (_, i) =>
        store.set(
          {...KEY_A, channelId: `ch-${i}`, senderPeerId: `peer-${i}`},
          `sess-${i}`,
        ),
      )
      await Promise.all(writes)

      // All 100 should be readable.
      for (let i = 0; i < 100; i++) {
        const val = store.get({...KEY_A, channelId: `ch-${i}`, senderPeerId: `peer-${i}`})
        expect(val).to.equal(`sess-${i}`)
      }
    })
  })

  describe('delete()', () => {
    it('removes the key; subsequent get() returns undefined', async () => {
      const store = makeStore()
      await store.set(KEY_A, 'to-delete')
      await store.delete(KEY_A)
      expect(store.get(KEY_A)).to.equal(undefined)
    })

    it('delete on a non-existent key is a no-op', async () => {
      const store = makeStore()
      await store.delete(KEY_A) // should not throw
      expect(store.get(KEY_A)).to.equal(undefined)
    })
  })

  describe('gc()', () => {
    it('removes entries whose channelId is not in knownChannelIds', async () => {
      const store = makeStore()
      await store.set(KEY_A, 'sess-a') // channelId = 'ch-1'
      await store.set(KEY_B, 'sess-b') // channelId = 'ch-2'

      const deleted = await store.gc({knownChannelIds: new Set(['ch-1'])})
      expect(deleted).to.equal(1)
      expect(store.get(KEY_A)).to.equal('sess-a') // kept
      expect(store.get(KEY_B)).to.equal(undefined) // removed
    })

    it('keeps all entries when all channelIds are known', async () => {
      const store = makeStore()
      await store.set(KEY_A, 'sess-a')
      await store.set(KEY_B, 'sess-b')

      const deleted = await store.gc({knownChannelIds: new Set(['ch-1', 'ch-2'])})
      expect(deleted).to.equal(0)
    })

    it('removes all entries when knownChannelIds is empty', async () => {
      const store = makeStore()
      await store.set(KEY_A, 'sess-a')
      await store.set(KEY_B, 'sess-b')

      const deleted = await store.gc({knownChannelIds: new Set()})
      expect(deleted).to.equal(2)
      expect(store.get(KEY_A)).to.equal(undefined)
      expect(store.get(KEY_B)).to.equal(undefined)
    })

    it('logs the deletion count', async () => {
      const store = makeStore()
      await store.set(KEY_A, 'sess-a')
      await store.gc({knownChannelIds: new Set()})
      expect(logs.some((m) => m.includes('gc removed 1'))).to.equal(true)
    })

    it('returns 0 when nothing to gc', async () => {
      const store = makeStore()
      const deleted = await store.gc({knownChannelIds: new Set()})
      expect(deleted).to.equal(0)
    })
  })

  describe('invalid JSON on disk', () => {
    it('logs a warning and treats file as empty', async () => {
      const filePath = join(tmpDir, 'sessions.json')
      writeFileSync(filePath, 'not valid json{{{{', 'utf8')
      const store = makeStore()
      expect(store.get(KEY_A)).to.equal(undefined)
      expect(logs.some((m) => m.includes('failed to read') || m.includes('invalid schema'))).to.equal(true)
    })

    it('next set() overwrites the invalid file with valid content', async () => {
      const filePath = join(tmpDir, 'sessions.json')
      writeFileSync(filePath, 'bogus', 'utf8')
      const store = makeStore()
      await store.set(KEY_A, 'recover')
      expect(store.get(KEY_A)).to.equal('recover')
      const raw = readFileSync(filePath, 'utf8')
      JSON.parse(raw) // should not throw
    })

    it('schema-invalid JSON logs and treats as empty', async () => {
      const filePath = join(tmpDir, 'sessions.json')
      // Valid JSON but wrong schema (array instead of object).
      writeFileSync(filePath, JSON.stringify(['not', 'a', 'record']), 'utf8')
      const store = makeStore()
      expect(store.get(KEY_A)).to.equal(undefined)
      expect(logs.some((m) => m.includes('invalid schema'))).to.equal(true)
    })
  })
})
