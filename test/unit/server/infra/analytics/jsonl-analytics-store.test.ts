/* eslint-disable camelcase */
import {expect} from 'chai'
import {randomUUID} from 'node:crypto'
import {mkdir, readFile, stat, writeFile} from 'node:fs/promises'
import {tmpdir} from 'node:os'
import {join} from 'node:path'

import type {StoredAnalyticsRecord} from '../../../../../src/shared/analytics/stored-record.js'

import {JsonlAnalyticsStore, JsonlCapFullError} from '../../../../../src/server/infra/analytics/jsonl-analytics-store.js'
import {MAX_ATTEMPTS, StoredAnalyticsRecordSchema} from '../../../../../src/shared/analytics/stored-record.js'

const validIdentity = {
  device_id: '550e8400-e29b-41d4-a716-446655440000',
}

async function freshTempDir(): Promise<string> {
  const dir = join(tmpdir(), `jsonl-store-${randomUUID()}`)
  await mkdir(dir, {recursive: true})
  return dir
}

function makeRecord(overrides: Partial<StoredAnalyticsRecord> = {}): StoredAnalyticsRecord {
  return {
    attempts: 0,
    id: randomUUID(),
    identity: validIdentity,
    name: 'cli_invocation',
    properties: {},
    status: 'pending',
    timestamp: Date.now(),
    ...overrides,
  }
}

async function readJsonlRows(filePath: string): Promise<StoredAnalyticsRecord[]> {
  try {
    const content = await readFile(filePath, 'utf8')
    const records: StoredAnalyticsRecord[] = []
    for (const line of content.split('\n')) {
      if (line.length === 0) continue
      const parsed = StoredAnalyticsRecordSchema.parse(JSON.parse(line))
      records.push(parsed)
    }

    return records
  } catch {
    return []
  }
}

function findRow(rows: StoredAnalyticsRecord[], id: string): StoredAnalyticsRecord {
  const row = rows.find((r) => r.id === id)
  if (row === undefined) throw new Error(`expected row with id=${id}`)
  return row
}

describe('JsonlAnalyticsStore', () => {
  describe('append()', () => {
    it('should write one row plus newline to a fresh file', async () => {
      const baseDir = await freshTempDir()
      const store = new JsonlAnalyticsStore({baseDir})
      const record = makeRecord({id: 'rec-1', name: 'event-a'})

      await store.append(record)

      const filePath = join(baseDir, 'analytics-queue.jsonl')
      const content = await readFile(filePath, 'utf8')
      expect(content.endsWith('\n')).to.equal(true)
      expect(content.split('\n').filter((l) => l.length > 0)).to.have.lengthOf(1)
      const rows = await readJsonlRows(filePath)
      expect(rows[0].id).to.equal('rec-1')
      expect(rows[0].name).to.equal('event-a')
    })

    it('should append multiple rows in arrival order', async () => {
      const baseDir = await freshTempDir()
      const store = new JsonlAnalyticsStore({baseDir})

      await store.append(makeRecord({id: 'r1'}))
      await store.append(makeRecord({id: 'r2'}))
      await store.append(makeRecord({id: 'r3'}))

      const rows = await readJsonlRows(join(baseDir, 'analytics-queue.jsonl'))
      expect(rows.map((r) => r.id)).to.deep.equal(['r1', 'r2', 'r3'])
    })

    it('should create the base directory if it does not exist', async () => {
      const parent = await freshTempDir()
      const baseDir = join(parent, 'nested', 'path')
      const store = new JsonlAnalyticsStore({baseDir})

      await store.append(makeRecord({id: 'r1'}))

      const stats = await stat(join(baseDir, 'analytics-queue.jsonl'))
      expect(stats.isFile()).to.equal(true)
    })
  })

  describe("updateStatus(ids, 'sent')", () => {
    it('should flip status to sent and leave attempts unchanged', async () => {
      const baseDir = await freshTempDir()
      const store = new JsonlAnalyticsStore({baseDir})
      await store.append(makeRecord({attempts: 1, id: 'r1', status: 'pending'}))

      await store.updateStatus(['r1'], 'sent')

      const rows = await readJsonlRows(join(baseDir, 'analytics-queue.jsonl'))
      expect(rows[0].status).to.equal('sent')
      expect(rows[0].attempts).to.equal(1)
    })

    it('should leave other rows untouched', async () => {
      const baseDir = await freshTempDir()
      const store = new JsonlAnalyticsStore({baseDir})
      await store.append(makeRecord({id: 'r1'}))
      await store.append(makeRecord({id: 'r2'}))
      await store.append(makeRecord({id: 'r3'}))

      await store.updateStatus(['r2'], 'sent')

      const rows = await readJsonlRows(join(baseDir, 'analytics-queue.jsonl'))
      expect(findRow(rows, 'r1').status).to.equal('pending')
      expect(findRow(rows, 'r2').status).to.equal('sent')
      expect(findRow(rows, 'r3').status).to.equal('pending')
    })

    it('should be no-op for empty ids array', async () => {
      const baseDir = await freshTempDir()
      const store = new JsonlAnalyticsStore({baseDir})
      await store.append(makeRecord({id: 'r1'}))

      await store.updateStatus([], 'sent')

      const rows = await readJsonlRows(join(baseDir, 'analytics-queue.jsonl'))
      expect(rows[0].status).to.equal('pending')
    })

    it('should be no-op for non-matching ids', async () => {
      const baseDir = await freshTempDir()
      const store = new JsonlAnalyticsStore({baseDir})
      await store.append(makeRecord({id: 'r1'}))

      await store.updateStatus(['does-not-exist'], 'sent')

      const rows = await readJsonlRows(join(baseDir, 'analytics-queue.jsonl'))
      expect(rows[0].status).to.equal('pending')
    })
  })

  describe("updateStatus(ids, 'failed') retry-cap policy", () => {
    it('should keep status pending after first failure (attempts=1)', async () => {
      const baseDir = await freshTempDir()
      const store = new JsonlAnalyticsStore({baseDir})
      await store.append(makeRecord({attempts: 0, id: 'r1', status: 'pending'}))

      await store.updateStatus(['r1'], 'failed')

      const rows = await readJsonlRows(join(baseDir, 'analytics-queue.jsonl'))
      expect(rows[0].status).to.equal('pending')
      expect(rows[0].attempts).to.equal(1)
    })

    it('should still be pending after second failure (attempts=2)', async () => {
      const baseDir = await freshTempDir()
      const store = new JsonlAnalyticsStore({baseDir})
      await store.append(makeRecord({attempts: 0, id: 'r1', status: 'pending'}))

      await store.updateStatus(['r1'], 'failed')
      await store.updateStatus(['r1'], 'failed')

      const rows = await readJsonlRows(join(baseDir, 'analytics-queue.jsonl'))
      expect(rows[0].status).to.equal('pending')
      expect(rows[0].attempts).to.equal(2)
    })

    it(`should transition to terminal 'failed' at MAX_ATTEMPTS (${MAX_ATTEMPTS})`, async () => {
      const baseDir = await freshTempDir()
      const store = new JsonlAnalyticsStore({baseDir})
      await store.append(makeRecord({attempts: 0, id: 'r1', status: 'pending'}))

      for (let i = 0; i < MAX_ATTEMPTS; i++) {
        // eslint-disable-next-line no-await-in-loop
        await store.updateStatus(['r1'], 'failed')
      }

      const rows = await readJsonlRows(join(baseDir, 'analytics-queue.jsonl'))
      expect(rows[0].status).to.equal('failed')
      expect(rows[0].attempts).to.equal(MAX_ATTEMPTS)
    })

    it("should be no-op on a row already at terminal 'failed' (no overshoot)", async () => {
      const baseDir = await freshTempDir()
      const store = new JsonlAnalyticsStore({baseDir})
      await store.append(makeRecord({attempts: 0, id: 'r1', status: 'pending'}))
      for (let i = 0; i < MAX_ATTEMPTS; i++) {
        // eslint-disable-next-line no-await-in-loop
        await store.updateStatus(['r1'], 'failed')
      }

      await store.updateStatus(['r1'], 'failed')

      const rows = await readJsonlRows(join(baseDir, 'analytics-queue.jsonl'))
      expect(rows[0].status).to.equal('failed')
      expect(rows[0].attempts).to.equal(MAX_ATTEMPTS)
    })
  })

  describe('list()', () => {
    it('should return empty result when file does not exist', async () => {
      const baseDir = await freshTempDir()
      const store = new JsonlAnalyticsStore({baseDir})

      const result = await store.list({limit: 10, offset: 0})

      expect(result.rows).to.deep.equal([])
      expect(result.total).to.equal(0)
    })

    it('should paginate via offset and limit', async () => {
      const baseDir = await freshTempDir()
      const store = new JsonlAnalyticsStore({baseDir})
      for (let i = 0; i < 10; i++) {
        // eslint-disable-next-line no-await-in-loop
        await store.append(makeRecord({id: `r${i}`, timestamp: i}))
      }

      const page1 = await store.list({limit: 3, offset: 0})
      const page2 = await store.list({limit: 3, offset: 3})

      expect(page1.rows).to.have.lengthOf(3)
      expect(page2.rows).to.have.lengthOf(3)
      expect(page1.total).to.equal(10)
      expect(page2.total).to.equal(10)
      const ids = [...page1.rows.map((r) => r.id), ...page2.rows.map((r) => r.id)]
      expect(new Set(ids).size).to.equal(6) // no duplicates between pages
    })

    it('should filter by eventName', async () => {
      const baseDir = await freshTempDir()
      const store = new JsonlAnalyticsStore({baseDir})
      await store.append(makeRecord({id: 'r1', name: 'event-a'}))
      await store.append(makeRecord({id: 'r2', name: 'event-b'}))
      await store.append(makeRecord({id: 'r3', name: 'event-a'}))

      const result = await store.list({eventName: 'event-a', limit: 10, offset: 0})

      expect(result.total).to.equal(2)
      expect(result.rows.map((r) => r.id).sort()).to.deep.equal(['r1', 'r3'])
    })

    it('should filter by status', async () => {
      const baseDir = await freshTempDir()
      const store = new JsonlAnalyticsStore({baseDir})
      await store.append(makeRecord({id: 'r1'}))
      await store.append(makeRecord({id: 'r2'}))
      await store.append(makeRecord({id: 'r3'}))
      await store.updateStatus(['r2'], 'sent')

      const pending = await store.list({limit: 10, offset: 0, status: 'pending'})
      const sent = await store.list({limit: 10, offset: 0, status: 'sent'})

      expect(pending.total).to.equal(2)
      expect(sent.total).to.equal(1)
      expect(sent.rows[0].id).to.equal('r2')
    })

    it('should filter by both eventName and status', async () => {
      const baseDir = await freshTempDir()
      const store = new JsonlAnalyticsStore({baseDir})
      await store.append(makeRecord({id: 'r1', name: 'event-a'}))
      await store.append(makeRecord({id: 'r2', name: 'event-b'}))
      await store.append(makeRecord({id: 'r3', name: 'event-a'}))
      await store.updateStatus(['r1'], 'sent')

      const result = await store.list({eventName: 'event-a', limit: 10, offset: 0, status: 'sent'})

      expect(result.total).to.equal(1)
      expect(result.rows[0].id).to.equal('r1')
    })

    it('should sort by (timestamp DESC, id DESC) for stable ordering on same-timestamp', async () => {
      const baseDir = await freshTempDir()
      const store = new JsonlAnalyticsStore({baseDir})
      await store.append(makeRecord({id: 'aaa', timestamp: 100}))
      await store.append(makeRecord({id: 'bbb', timestamp: 200}))
      await store.append(makeRecord({id: 'ccc', timestamp: 100}))

      const result = await store.list({limit: 10, offset: 0})

      // Newest timestamp first; same timestamp tie broken by id DESC
      expect(result.rows.map((r) => r.id)).to.deep.equal(['bbb', 'ccc', 'aaa'])
    })

    it('should return correct total post-filter when offset > total', async () => {
      const baseDir = await freshTempDir()
      const store = new JsonlAnalyticsStore({baseDir})
      await store.append(makeRecord({id: 'r1'}))

      const result = await store.list({limit: 10, offset: 100})

      expect(result.rows).to.deep.equal([])
      expect(result.total).to.equal(1)
    })
  })

  describe('loadPending()', () => {
    it('should return empty when file does not exist', async () => {
      const baseDir = await freshTempDir()
      const store = new JsonlAnalyticsStore({baseDir})

      const rows = await store.loadPending()

      expect(rows).to.deep.equal([])
    })

    it("should return only 'pending' rows", async () => {
      const baseDir = await freshTempDir()
      const store = new JsonlAnalyticsStore({baseDir})
      await store.append(makeRecord({id: 'r1'}))
      await store.append(makeRecord({id: 'r2'}))
      await store.append(makeRecord({id: 'r3'}))
      await store.updateStatus(['r2'], 'sent')

      const rows = await store.loadPending()

      expect(rows.map((r) => r.id).sort()).to.deep.equal(['r1', 'r3'])
    })

    it('should include pending rows with attempts > 0 (in-flight retries)', async () => {
      const baseDir = await freshTempDir()
      const store = new JsonlAnalyticsStore({baseDir})
      await store.append(makeRecord({id: 'r1', status: 'pending'}))
      await store.updateStatus(['r1'], 'failed') // attempts=1, still pending

      const rows = await store.loadPending()

      expect(rows).to.have.lengthOf(1)
      expect(rows[0].id).to.equal('r1')
      expect(rows[0].status).to.equal('pending')
      expect(rows[0].attempts).to.equal(1)
    })

    it("should exclude rows that reached terminal 'failed'", async () => {
      const baseDir = await freshTempDir()
      const store = new JsonlAnalyticsStore({baseDir})
      await store.append(makeRecord({id: 'r1'}))
      for (let i = 0; i < MAX_ATTEMPTS; i++) {
        // eslint-disable-next-line no-await-in-loop
        await store.updateStatus(['r1'], 'failed')
      }

      const rows = await store.loadPending()

      expect(rows).to.deep.equal([])
    })
  })

  describe('concurrency (write serialization)', () => {
    it('should not lose appends interleaved with updateStatus', async () => {
      const baseDir = await freshTempDir()
      const store = new JsonlAnalyticsStore({baseDir})
      await store.append(makeRecord({id: 'r1'}))
      await store.append(makeRecord({id: 'r2'}))
      await store.append(makeRecord({id: 'r3'}))

      // Interleave: kick off updateStatus + a fresh append without awaiting; both go into writeChain.
      const updatePromise = store.updateStatus(['r1', 'r2'], 'sent')
      const appendPromise = store.append(makeRecord({id: 'r-NEW'}))

      await Promise.all([updatePromise, appendPromise])

      const rows = await readJsonlRows(join(baseDir, 'analytics-queue.jsonl'))
      const ids = rows.map((r) => r.id).sort()
      expect(ids).to.include('r-NEW') // append must NOT be lost by the rewrite
      expect(rows).to.have.lengthOf(4)
      expect(findRow(rows, 'r1').status).to.equal('sent')
      expect(findRow(rows, 'r2').status).to.equal('sent')
    })
  })

  describe('cap edge cases', () => {
    it('should drop oldest sent row when row cap exceeded', async () => {
      const baseDir = await freshTempDir()
      const store = new JsonlAnalyticsStore({baseDir, maxRows: 3})
      await store.append(makeRecord({id: 'r1', timestamp: 100}))
      await store.append(makeRecord({id: 'r2', timestamp: 200}))
      await store.append(makeRecord({id: 'r3', timestamp: 300}))
      await store.updateStatus(['r1', 'r2'], 'sent') // r1 oldest sent; r2 newer sent

      await store.append(makeRecord({id: 'r4', timestamp: 400})) // triggers cap

      const rows = await readJsonlRows(join(baseDir, 'analytics-queue.jsonl'))
      const ids = rows.map((r) => r.id).sort()
      expect(ids).to.not.include('r1') // oldest sent dropped
      expect(ids).to.include('r2')
      expect(ids).to.include('r3')
      expect(ids).to.include('r4')
      expect(store.droppedSentCount()).to.equal(1)
    })

    it('should drop multiple oldest sent rows in one compaction pass (single append)', async () => {
      // Locks in the single-pass compaction invariant: dropping N sent
      // rows in one append must drop the N oldest ones and stop dropping
      // as soon as the file is under cap.
      const baseDir = await freshTempDir()
      const store = new JsonlAnalyticsStore({baseDir, maxRows: 4})
      await store.append(makeRecord({id: 's1', timestamp: 100}))
      await store.append(makeRecord({id: 's2', timestamp: 200}))
      await store.append(makeRecord({id: 's3', timestamp: 300}))
      await store.append(makeRecord({id: 'p4', timestamp: 400})) // pending
      await store.updateStatus(['s1', 's2', 's3'], 'sent')

      // Two new pending rows pushes count to 6 — must drop two oldest sent (s1, s2).
      await store.append(makeRecord({id: 'p5', timestamp: 500}))
      await store.append(makeRecord({id: 'p6', timestamp: 600}))

      const rows = await readJsonlRows(join(baseDir, 'analytics-queue.jsonl'))
      const ids = rows.map((r) => r.id)
      expect(ids).to.not.include('s1')
      expect(ids).to.not.include('s2')
      expect(ids).to.include('s3') // newest sent survives
      expect(ids).to.include('p4')
      expect(ids).to.include('p5')
      expect(ids).to.include('p6')
      expect(store.droppedSentCount()).to.equal(2)
    })

    it('should preserve pending and failed rows during compaction', async () => {
      const baseDir = await freshTempDir()
      const store = new JsonlAnalyticsStore({baseDir, maxRows: 3})
      await store.append(makeRecord({id: 'r1', timestamp: 100})) // pending
      await store.append(makeRecord({id: 'r2', timestamp: 200})) // sent (will be dropped)
      await store.append(makeRecord({id: 'r3', timestamp: 300})) // pending
      await store.updateStatus(['r2'], 'sent')

      await store.append(makeRecord({id: 'r4', timestamp: 400})) // triggers cap

      const rows = await readJsonlRows(join(baseDir, 'analytics-queue.jsonl'))
      const ids = rows.map((r) => r.id).sort()
      expect(ids).to.include('r1') // pending preserved
      expect(ids).to.include('r3') // pending preserved
      expect(ids).to.not.include('r2') // sent dropped
    })

    it('should throw JsonlCapFullError when cap full of pending+failed (no sent to drop)', async () => {
      const baseDir = await freshTempDir()
      const store = new JsonlAnalyticsStore({baseDir, maxRows: 2})
      await store.append(makeRecord({id: 'r1', timestamp: 100}))
      await store.append(makeRecord({id: 'r2', timestamp: 200})) // both pending; no sent rows

      // The new record cannot land — file already at cap and no sent rows to evict.
      // The store throws JsonlCapFullError so AnalyticsClient can skip its mirror queue.push,
      // preserving the JSONL=truth invariant. A silent return would let the queue diverge from disk.
      let caught: unknown
      try {
        await store.append(makeRecord({id: 'r3', timestamp: 300}))
      } catch (error) {
        caught = error
      }

      expect(caught, 'append must throw on cap-full silent-drop').to.be.instanceOf(JsonlCapFullError)
      expect((caught as JsonlCapFullError).recordId).to.equal('r3')

      const rows = await readJsonlRows(join(baseDir, 'analytics-queue.jsonl'))
      const ids = rows.map((r) => r.id).sort()
      expect(ids).to.not.include('r3')
      expect(ids).to.deep.equal(['r1', 'r2'])
      expect(store.droppedFullCount()).to.equal(1)
    })

    it('should track droppedFullCount cumulatively across multiple cap-full throws', async () => {
      const baseDir = await freshTempDir()
      const store = new JsonlAnalyticsStore({baseDir, maxRows: 1})
      await store.append(makeRecord({id: 'r1'}))

      // Each cap-full append throws; counter increments before the throw so callers can still observe it.
      for (const id of ['r2', 'r3']) {
        let caught: unknown
        try {
          // eslint-disable-next-line no-await-in-loop
          await store.append(makeRecord({id}))
        } catch (error) {
          caught = error
        }

        expect(caught, `append('${id}') must throw on cap-full`).to.be.instanceOf(JsonlCapFullError)
      }

      expect(store.droppedFullCount()).to.equal(2)
    })

    it('should throw JsonlCapFullError after partial byte-cap compaction insufficient to make room', async () => {
      const baseDir = await freshTempDir()
      // Tight byte cap so a single big pending row + a tiny sent row + a new big pending row
      // exceeds cap even after dropping the small sent row.
      const big = 'x'.repeat(400)
      const tiny = 'x'.repeat(10)
      const store = new JsonlAnalyticsStore({baseDir, maxBytes: 900, maxRows: 10_000})
      await store.append(makeRecord({id: 'sent-tiny', properties: {data: tiny}}))
      await store.updateStatus(['sent-tiny'], 'sent')
      await store.append(makeRecord({id: 'p1', properties: {data: big}})) // ~400-byte payload, fits

      // p2 is ~400 bytes; together with p1 (~400) the two pending rows alone are ~800 bytes.
      // Dropping sent-tiny saves ~10 bytes; combined with p1+p2 the file is still over the 900-byte cap.
      let caught: unknown
      try {
        await store.append(makeRecord({id: 'p2', properties: {data: big}}))
      } catch (error) {
        caught = error
      }

      expect(caught, 'append must throw when even full sent compaction leaves file over byte cap').to.be.instanceOf(
        JsonlCapFullError,
      )
      expect((caught as JsonlCapFullError).recordId).to.equal('p2')

      // The store still persisted the sent-row drop (partial compaction) before throwing,
      // so observers see the most-up-to-date state on disk.
      const rows = await readJsonlRows(join(baseDir, 'analytics-queue.jsonl'))
      const ids = rows.map((r) => r.id).sort()
      expect(ids).to.deep.equal(['p1']) // sent-tiny dropped, p2 not added
      expect(store.droppedFullCount()).to.equal(1)
      expect(store.droppedSentCount()).to.equal(1)
    })

    it('should silently skip malformed JSON lines on read', async () => {
      const baseDir = await freshTempDir()
      const filePath = join(baseDir, 'analytics-queue.jsonl')
      const good = makeRecord({id: 'good'})
      // Two bad lines (non-JSON garbage) sandwiching a good one.
      await writeFile(
        filePath,
        ['this is not json', JSON.stringify(good), 'partial-write-{'].join('\n') + '\n',
        'utf8',
      )
      const store = new JsonlAnalyticsStore({baseDir})

      const rows = await store.loadPending()

      expect(rows).to.have.lengthOf(1)
      expect(rows[0].id).to.equal('good')
    })

    it('should silently skip schema-invalid JSON objects on read', async () => {
      const baseDir = await freshTempDir()
      const filePath = join(baseDir, 'analytics-queue.jsonl')
      const good = makeRecord({id: 'good'})
      // First line parses as JSON but fails Zod (missing required fields).
      await writeFile(
        filePath,
        [JSON.stringify({notAValidRecord: true}), JSON.stringify(good)].join('\n') + '\n',
        'utf8',
      )
      const store = new JsonlAnalyticsStore({baseDir})

      const rows = await store.loadPending()

      expect(rows).to.have.lengthOf(1)
      expect(rows[0].id).to.equal('good')
    })

    it('should respect byte cap as well as row cap', async () => {
      const baseDir = await freshTempDir()
      const big = 'x'.repeat(200)
      // Compute the serialized row size dynamically so the cap holds 2 rows comfortably
      // but 3 rows tip over, regardless of identity/uuid serialization length drift.
      const sampleSize = JSON.stringify(makeRecord({properties: {data: big}})).length + 1
      const maxBytes = sampleSize * 2 + 50
      const store = new JsonlAnalyticsStore({baseDir, maxBytes, maxRows: 10_000})
      await store.append(makeRecord({id: 'r1', properties: {data: big}}))
      await store.append(makeRecord({id: 'r2', properties: {data: big}}))
      await store.updateStatus(['r1'], 'sent')

      await store.append(makeRecord({id: 'r3', properties: {data: big}})) // triggers byte-cap

      const rows = await readJsonlRows(join(baseDir, 'analytics-queue.jsonl'))
      const ids = rows.map((r) => r.id).sort()
      expect(ids).to.not.include('r1') // dropped (sent + oldest)
      expect(store.droppedSentCount()).to.be.greaterThanOrEqual(1)
    })
  })

  describe('clear() — M4.1 truncate on auth transition', () => {
    it('should remove every row regardless of status', async () => {
      const baseDir = await freshTempDir()
      const store = new JsonlAnalyticsStore({baseDir})
      await store.append(makeRecord({id: 'pending'}))
      await store.append(makeRecord({id: 'sent'}))
      await store.append(makeRecord({id: 'failed'}))
      await store.updateStatus(['sent'], 'sent')
      // Push the third row to terminal 'failed' by hammering past the cap.
      // Promise.all is safe here: writeChain serializes them in fire-order.
      await Promise.all(
        Array.from({length: MAX_ATTEMPTS}, () => store.updateStatus(['failed'], 'failed')),
      )

      await store.clear()

      const rows = await readJsonlRows(join(baseDir, 'analytics-queue.jsonl'))
      expect(rows).to.have.lengthOf(0)
    })

    it('should leave the file empty (zero bytes), not absent', async () => {
      const baseDir = await freshTempDir()
      const store = new JsonlAnalyticsStore({baseDir})
      await store.append(makeRecord({id: 'r1'}))

      await store.clear()

      const stats = await stat(join(baseDir, 'analytics-queue.jsonl'))
      expect(stats.size).to.equal(0)
    })

    it('should be a no-op when the file does not exist yet', async () => {
      const baseDir = await freshTempDir()
      const store = new JsonlAnalyticsStore({baseDir})

      // Must not throw even when no append has happened.
      await store.clear()

      const rows = await readJsonlRows(join(baseDir, 'analytics-queue.jsonl'))
      expect(rows).to.have.lengthOf(0)
    })

    it('should NOT reset cumulative lifetime counters (droppedFullCount, droppedSentCount)', async () => {
      const baseDir = await freshTempDir()
      // Force a `droppedSent` via byte-cap (mirror earlier cap test).
      const big = 'x'.repeat(200)
      const sampleSize = JSON.stringify(makeRecord({properties: {data: big}})).length + 1
      const store = new JsonlAnalyticsStore({baseDir, maxBytes: sampleSize * 2 + 50, maxRows: 10_000})
      await store.append(makeRecord({id: 'r1', properties: {data: big}}))
      await store.append(makeRecord({id: 'r2', properties: {data: big}}))
      await store.updateStatus(['r1'], 'sent')
      await store.append(makeRecord({id: 'r3', properties: {data: big}})) // drops r1
      const droppedBefore = store.droppedSentCount()
      expect(droppedBefore).to.be.greaterThanOrEqual(1)

      await store.clear()

      expect(store.droppedSentCount()).to.equal(droppedBefore)
    })

    it('should serialize through the write chain (concurrent append + clear preserves the clear)', async () => {
      const baseDir = await freshTempDir()
      const store = new JsonlAnalyticsStore({baseDir})
      // Seed and immediately race a clear + a new append.
      await store.append(makeRecord({id: 'old-1'}))
      await store.append(makeRecord({id: 'old-2'}))

      // Fire concurrently — order of enqueue determines the on-disk state.
      const clearPromise = store.clear()
      const appendPromise = store.append(makeRecord({id: 'new-1'}))
      await Promise.all([clearPromise, appendPromise])

      const rows = await readJsonlRows(join(baseDir, 'analytics-queue.jsonl'))
      const ids = rows.map((r) => r.id)
      expect(ids).to.not.include('old-1')
      expect(ids).to.not.include('old-2')
      // The append enqueued AFTER clear must survive (queue order serializes writes).
      expect(ids).to.include('new-1')
    })
  })
})
