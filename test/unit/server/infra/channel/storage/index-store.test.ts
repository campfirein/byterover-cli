import {expect} from 'chai'
import {promises as fs} from 'node:fs'
import {dirname} from 'node:path'

import type {Turn} from '../../../../../../src/shared/types/channel.js'

import {ChannelTurnIndexStore} from '../../../../../../src/server/infra/channel/storage/index-store.js'
import {channelPaths} from '../../../../../../src/server/infra/channel/storage/paths.js'
import {ChannelWriteSerializer} from '../../../../../../src/server/infra/channel/storage/write-serializer.js'
import {makeTempContextTree} from '../../../../../helpers/temp-context-tree.js'
import {removeTempDir} from '../../../../../helpers/temp-dir.js'

// Slice 9.3 — per-channel index.jsonl materialises the per-turn fields
// that `brv channel list-turns` and `lookback-builder` consume, so the
// hot read paths no longer open every per-turn NDJSON on every dispatch.
//
// Locked design decisions from the codex+kimi parallel review:
//   Q3: flat JSONL (no SQLite native dep)
//   Q4: full `finalAnswer` materialised in the entry (kimi's call —
//       replaces 20 file opens per dispatch with 1 sequential read)
//   Q6: read-from-both during migration; recovery rebuilds missing
//       entries by scanning the NDJSON
describe('ChannelTurnIndexStore (Slice 9.3)', () => {
  let projectRoot: string
  let store: ChannelTurnIndexStore
  const channelId = 'pi-test'

  const sampleTurn = (turnId: string): Turn => ({
    author: {handle: 'you', kind: 'local-user'},
    channelId,
    endedAt: '2026-05-17T00:00:01.000Z',
    mentions: [],
    promptBlocks: [{text: `hello from ${turnId}`, type: 'text'}],
    promptedBy: 'user',
    startedAt: '2026-05-17T00:00:00.000Z',
    state: 'completed',
    turnId,
  })

  beforeEach(async () => {
    projectRoot = await makeTempContextTree()
    store = new ChannelTurnIndexStore({serializer: new ChannelWriteSerializer()})
  })

  afterEach(async () => {
    await removeTempDir(projectRoot)
  })

  describe('appendEntry', () => {
    it('appends an entry as one JSON line to the per-channel index.jsonl', async () => {
      await store.appendEntry({
        channelId,
        entry: {
          deliveries: [],
          turn: sampleTurn('01HX'),
        },
        projectRoot,
      })

      const file = channelPaths.indexJsonlFile(projectRoot, channelId)
      const raw = await fs.readFile(file, 'utf8')
      const lines = raw.split('\n').filter((l) => l.length > 0)
      expect(lines).to.have.lengthOf(1)
      const parsed = JSON.parse(lines[0]) as {turn: Turn}
      expect(parsed.turn.turnId).to.equal('01HX')
    })

    it('creates the per-channel directory lazily', async () => {
      // index.jsonl lives at .brv/channel-history/<ch>/index.jsonl — the
      // dir may not exist yet when the first turn finalises.
      await store.appendEntry({
        channelId,
        entry: {deliveries: [], turn: sampleTurn('01HX')},
        projectRoot,
      })
      const channelDir = dirname(channelPaths.indexJsonlFile(projectRoot, channelId))
      expect((await fs.stat(channelDir)).isDirectory()).to.equal(true)
    })

    it('appends multiple entries in order (one line per call)', async () => {
      for (const id of ['01HX-a', '01HX-b', '01HX-c']) {
        // eslint-disable-next-line no-await-in-loop
        await store.appendEntry({
          channelId,
          entry: {deliveries: [], turn: sampleTurn(id)},
          projectRoot,
        })
      }

      const file = channelPaths.indexJsonlFile(projectRoot, channelId)
      const raw = await fs.readFile(file, 'utf8')
      const turnIds = raw
        .split('\n')
        .filter((l) => l.length > 0)
        .map((l) => (JSON.parse(l) as {turn: Turn}).turn.turnId)
      expect(turnIds).to.deep.equal(['01HX-a', '01HX-b', '01HX-c'])
    })

    it('serializes concurrent appends via the per-channel write lock', async () => {
      const turns = Array.from({length: 5}, (_, i) => `01HX-${i}`)
      await Promise.all(
        turns.map((id) =>
          store.appendEntry({
            channelId,
            entry: {deliveries: [], turn: sampleTurn(id)},
            projectRoot,
          }),
        ),
      )

      const file = channelPaths.indexJsonlFile(projectRoot, channelId)
      const raw = await fs.readFile(file, 'utf8')
      const lines = raw.split('\n').filter((l) => l.length > 0)
      expect(lines).to.have.lengthOf(5)
      // Each line is a complete parseable JSON (no torn writes).
      for (const line of lines) {
        expect(() => JSON.parse(line)).to.not.throw()
      }
    })

    it('updates the in-memory map (last-writer-wins on duplicate turnId)', async () => {
      const v1 = {...sampleTurn('01HX'), state: 'cancelled' as const}
      const v2 = {...sampleTurn('01HX'), state: 'completed' as const}

      await store.appendEntry({channelId, entry: {deliveries: [], turn: v1}, projectRoot})
      await store.appendEntry({channelId, entry: {deliveries: [], turn: v2}, projectRoot})

      const entries = await store.getEntries({channelId, projectRoot})
      const got = entries.get('01HX')
      expect(got?.turn.state).to.equal('completed')
    })
  })

  describe('getEntries', () => {
    it('returns an empty Map for an unknown channel', async () => {
      const entries = await store.getEntries({channelId, projectRoot})
      expect(entries.size).to.equal(0)
    })

    it('loads entries from disk on first access (lazy load)', async () => {
      // Write directly to disk to simulate a daemon restart after entries
      // were appended in a prior process.
      const file = channelPaths.indexJsonlFile(projectRoot, channelId)
      await fs.mkdir(dirname(file), {recursive: true})
      const line1 = `${JSON.stringify({deliveries: [], turn: sampleTurn('01HX')})}\n`
      const line2 = `${JSON.stringify({deliveries: [], turn: sampleTurn('01HY')})}\n`
      await fs.writeFile(file, line1 + line2)

      const entries = await store.getEntries({channelId, projectRoot})
      expect(entries.size).to.equal(2)
      expect(entries.has('01HX')).to.equal(true)
      expect(entries.has('01HY')).to.equal(true)
    })

    it('tolerates corrupt lines (skips, keeps going)', async () => {
      const file = channelPaths.indexJsonlFile(projectRoot, channelId)
      await fs.mkdir(dirname(file), {recursive: true})
      const lines = [
        JSON.stringify({deliveries: [], turn: sampleTurn('01HX')}),
        '{ this is not valid json',
        JSON.stringify({deliveries: [], turn: sampleTurn('01HY')}),
      ]
      await fs.writeFile(file, `${lines.join('\n')}\n`)

      const entries = await store.getEntries({channelId, projectRoot})
      expect(entries.size).to.equal(2)
    })
  })

  describe('recoverFromNdjson', () => {
    // Slice 9.3 kimi defect #3 (2PC gap): a crash between writing the
    // `_recordType: 'turn_snapshot'` line and appending to index.jsonl
    // leaves the index stale. Daemon startup must rebuild missing
    // entries by scanning the per-turn NDJSON files.
    it('rebuilds missing index entries from turn_snapshot NDJSON lines', async () => {
      // Synthesise an orphan NDJSON (snapshot written, index never updated).
      const ndjson = channelPaths.turnNdjsonFile(projectRoot, channelId, '01HX-orphan')
      await fs.mkdir(dirname(ndjson), {recursive: true})
      const physical = [
        JSON.stringify({channelId, content: 'hi', deliveryId: null, emittedAt: '2026-05-17T00:00:00.000Z', kind: 'message', memberHandle: null, role: 'user', seq: 0, turnId: '01HX-orphan'}),
        JSON.stringify({_recordType: 'turn_snapshot', turn: sampleTurn('01HX-orphan')}),
      ].join('\n')
      await fs.writeFile(ndjson, `${physical}\n`)

      const recovered = await store.recoverFromNdjson({channelId, projectRoot})
      expect(recovered).to.equal(1)

      const entries = await store.getEntries({channelId, projectRoot})
      expect(entries.has('01HX-orphan')).to.equal(true)
    })

    it('does NOT re-append entries that already exist in index.jsonl', async () => {
      // Seed the index first.
      await store.appendEntry({
        channelId,
        entry: {deliveries: [], turn: sampleTurn('01HX-seeded')},
        projectRoot,
      })
      // Also write the matching NDJSON snapshot.
      const ndjson = channelPaths.turnNdjsonFile(projectRoot, channelId, '01HX-seeded')
      await fs.mkdir(dirname(ndjson), {recursive: true})
      await fs.writeFile(
        ndjson,
        `${JSON.stringify({_recordType: 'turn_snapshot', turn: sampleTurn('01HX-seeded')})}\n`,
      )

      const recovered = await store.recoverFromNdjson({channelId, projectRoot})
      expect(recovered).to.equal(0)

      // Index still has exactly one entry for the turn (not two from re-append).
      const indexFile = channelPaths.indexJsonlFile(projectRoot, channelId)
      const indexRaw = await fs.readFile(indexFile, 'utf8')
      const indexLines = indexRaw.split('\n').filter((l) => l.length > 0)
      expect(indexLines).to.have.lengthOf(1)
    })

    it('skips NDJSON files that have no terminal turn_snapshot line (in-flight turns)', async () => {
      // Mid-turn NDJSON with only wire events, no terminal snapshot.
      const ndjson = channelPaths.turnNdjsonFile(projectRoot, channelId, '01HX-inflight')
      await fs.mkdir(dirname(ndjson), {recursive: true})
      const physical = JSON.stringify({channelId, content: 'hi', deliveryId: null, emittedAt: '2026-05-17T00:00:00.000Z', kind: 'message', memberHandle: null, role: 'user', seq: 0, turnId: '01HX-inflight'})
      await fs.writeFile(ndjson, `${physical}\n`)

      const recovered = await store.recoverFromNdjson({channelId, projectRoot})
      expect(recovered).to.equal(0)

      const entries = await store.getEntries({channelId, projectRoot})
      expect(entries.size).to.equal(0)
    })

    it('returns 0 when no per-turn NDJSON files exist', async () => {
      const recovered = await store.recoverFromNdjson({channelId, projectRoot})
      expect(recovered).to.equal(0)
    })

    // Slice 9.7 (codex D5): the lazy hook in `ChannelStore.listTurns`
    // would otherwise pay an O(N) readdir on every call. Gate recovery
    // to first-access-per-daemon-lifetime per (channelId, projectRoot).
    it('runs the readdir sweep only ONCE per (channelId, projectRoot) — D5', async () => {
      // First call: full sweep, recovers an orphan.
      const ndjson = channelPaths.turnNdjsonFile(projectRoot, channelId, '01HX-orphan-A')
      await fs.mkdir(dirname(ndjson), {recursive: true})
      await fs.writeFile(
        ndjson,
        `${JSON.stringify({_recordType: 'turn_snapshot', turn: sampleTurn('01HX-orphan-A')})}\n`,
      )

      expect(await store.recoverFromNdjson({channelId, projectRoot})).to.equal(1)

      // Drop ANOTHER orphan on disk after the gate has closed.
      const ndjson2 = channelPaths.turnNdjsonFile(projectRoot, channelId, '01HX-orphan-B')
      await fs.writeFile(
        ndjson2,
        `${JSON.stringify({_recordType: 'turn_snapshot', turn: sampleTurn('01HX-orphan-B')})}\n`,
      )

      // Second call: gate is closed; orphan-B is NOT recovered.
      // This proves the readdir is skipped (the gate is the perf fix).
      expect(await store.recoverFromNdjson({channelId, projectRoot})).to.equal(0)

      const entries = await store.getEntries({channelId, projectRoot})
      expect(entries.has('01HX-orphan-A')).to.equal(true)
      expect(entries.has('01HX-orphan-B'), 'gate must skip post-startup orphans').to.equal(false)
    })

    it('gates per (channelId, projectRoot) — different channel still recovers', async () => {
      // Seed orphan in channel A, recover it.
      const a = channelPaths.turnNdjsonFile(projectRoot, channelId, '01HX-a')
      await fs.mkdir(dirname(a), {recursive: true})
      await fs.writeFile(a, `${JSON.stringify({_recordType: 'turn_snapshot', turn: sampleTurn('01HX-a')})}\n`)
      expect(await store.recoverFromNdjson({channelId, projectRoot})).to.equal(1)

      // Different channel: gate is per-channel, so this channel's
      // recovery still runs.
      const otherChannel = 'other-channel'
      const b = channelPaths.turnNdjsonFile(projectRoot, otherChannel, '01HX-b')
      await fs.mkdir(dirname(b), {recursive: true})
      // sampleTurn() bakes channelId='pi-test'; switch it here so the
      // recovery's schema parse accepts it.
      const otherTurn = {...sampleTurn('01HX-b'), channelId: otherChannel}
      await fs.writeFile(b, `${JSON.stringify({_recordType: 'turn_snapshot', turn: otherTurn})}\n`)

      expect(await store.recoverFromNdjson({channelId: otherChannel, projectRoot})).to.equal(1)
    })
  })
})
