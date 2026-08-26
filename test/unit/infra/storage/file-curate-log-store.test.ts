import {expect} from 'chai'
import {mkdir, readdir, rm, writeFile} from 'node:fs/promises'
import {tmpdir} from 'node:os'
import {join} from 'node:path'

import type {CurateLogEntry} from '../../../../src/server/core/domain/entities/curate-log-entry.js'

import {FileCurateLogStore} from '../../../../src/server/infra/storage/file-curate-log-store.js'

function makeEntry(overrides: Partial<CurateLogEntry> & {id: string}): CurateLogEntry {
  return {
    input: {},
    operations: [],
    startedAt: Date.now(),
    status: 'processing',
    summary: {added: 0, deleted: 0, failed: 0, merged: 0, updated: 0},
    taskId: `task-${overrides.id}`,
    ...overrides,
  } as CurateLogEntry
}

/** Poll until the .json file count in dir stabilises (two consecutive reads match). */
async function waitForPruneToSettle(dir: string): Promise<void> {
  const count = async (): Promise<number> => {
    try {
      const files = await readdir(dir)
      return files.filter((f: string) => f.endsWith('.json')).length
    } catch {
      return 0
    }
  }

  let prev = await count()
  for (let i = 0; i < 50; i++) {
    // eslint-disable-next-line no-await-in-loop
    await new Promise((r) => {
      setTimeout(r, 2)
    })
    // eslint-disable-next-line no-await-in-loop
    const cur = await count()
    if (cur === prev) return
    prev = cur
  }
}

describe('FileCurateLogStore', () => {
  let tempDir: string
  let store: FileCurateLogStore

  beforeEach(async () => {
    tempDir = join(tmpdir(), `brv-curate-log-test-${Date.now()}-${Math.random().toString(36).slice(2)}`)
    await mkdir(tempDir, {recursive: true})
    store = new FileCurateLogStore({baseDir: tempDir})
  })

  afterEach(async () => {
    await rm(tempDir, {force: true, recursive: true})
  })

  // ==========================================================================
  // getNextId
  // ==========================================================================

  describe('getNextId', () => {
    it('should return a cur-{timestamp} formatted ID', async () => {
      const id = await store.getNextId()
      expect(id).to.match(/^cur-\d+$/)
    })

    it('should return monotonically increasing IDs in the same millisecond', async () => {
      // Get several IDs rapidly (sequential, not parallel, to test monotonic guarantee)
      const ids = [
        await store.getNextId(),
        await store.getNextId(),
        await store.getNextId(),
        await store.getNextId(),
        await store.getNextId(),
      ]

      for (let i = 1; i < ids.length; i++) {
        const prev = Number(ids[i - 1].slice(4))
        const curr = Number(ids[i].slice(4))
        expect(curr).to.be.greaterThan(prev)
      }
    })
  })

  // ==========================================================================
  // save + getById
  // ==========================================================================

  describe('save + getById', () => {
    it('should save and retrieve an entry', async () => {
      const id = await store.getNextId()
      const entry = makeEntry({id})

      await store.save(entry)
      const retrieved = await store.getById(id)

      expect(retrieved).to.deep.equal(entry)
    })

    it('should save a completed entry with all fields', async () => {
      const id = await store.getNextId()
      const entry: CurateLogEntry = {
        completedAt: Date.now(),
        id,
        input: {context: 'test context', files: ['src/auth.ts']},
        operations: [{path: '/a.md', status: 'success', type: 'ADD'}],
        response: 'Done!',
        reviewIntegrity: {status: 'verified'},
        startedAt: Date.now() - 1000,
        status: 'completed',
        summary: {added: 1, deleted: 0, failed: 0, merged: 0, updated: 0},
        taskId: 'task-1',
      }

      await store.save(entry)
      const retrieved = await store.getById(id)

      expect(retrieved).to.deep.equal(entry)
      expect(retrieved?.status).to.equal('completed')
      expect(retrieved?.reviewIntegrity).to.deep.equal({status: 'verified'})
    })

    it('should save an error entry', async () => {
      const id = await store.getNextId()
      const entry: CurateLogEntry = {
        completedAt: Date.now(),
        error: 'Something went wrong',
        id,
        input: {},
        operations: [],
        startedAt: Date.now() - 500,
        status: 'error',
        summary: {added: 0, deleted: 0, failed: 0, merged: 0, updated: 0},
        taskId: 'task-err',
      }

      await store.save(entry)
      const retrieved = await store.getById(id)

      expect(retrieved?.status).to.equal('error')
      const errorEntry = retrieved as null | {error?: string; status: string}
      expect(errorEntry?.error).to.equal('Something went wrong')
    })

    it('should return null for non-existent ID', async () => {
      const id = await store.getNextId()
      const result = await store.getById(id)
      expect(result).to.be.null
    })

    it('should return null for corrupted file', async () => {
      const id = await store.getNextId()
      const entry = makeEntry({id})
      await store.save(entry)

      // Corrupt the file
      const logDir = join(tempDir, 'curate-log')
      await writeFile(join(logDir, `${id}.json`), 'not valid json {{{')

      const result = await store.getById(id)
      expect(result).to.be.null
    })

    it('should return null for Zod-invalid file content', async () => {
      const id = await store.getNextId()
      const logDir = join(tempDir, 'curate-log')
      await mkdir(logDir, {recursive: true})

      // Valid JSON but missing required fields
      await writeFile(join(logDir, `${id}.json`), JSON.stringify({id, status: 'unknown_status'}))

      const result = await store.getById(id)
      expect(result).to.be.null
    })

    it('should return null for path traversal attempt', async () => {
      const result = await store.getById('../../../etc/passwd')
      expect(result).to.be.null
    })

    it('should return null for ID with wrong prefix', async () => {
      const result = await store.getById('bad-12345')
      expect(result).to.be.null
    })
  })

  // ==========================================================================
  // list
  // ==========================================================================

  describe('list', () => {
    it('should return empty array when no entries', async () => {
      const entries = await store.list()
      expect(entries).to.have.lengthOf(0)
    })

    it('should return entries sorted newest-first', async () => {
      const id1 = await store.getNextId()
      const id2 = await store.getNextId()
      const id3 = await store.getNextId()

      const now = Date.now()
      const e1 = makeEntry({id: id1, startedAt: now - 3000})
      const e2 = makeEntry({id: id2, startedAt: now - 2000})
      const e3 = makeEntry({id: id3, startedAt: now - 1000})

      await store.save(e1)
      await store.save(e2)
      await store.save(e3)

      const entries = await store.list()

      expect(entries).to.have.lengthOf(3)
      expect(entries[0].id).to.equal(id3)
      expect(entries[1].id).to.equal(id2)
      expect(entries[2].id).to.equal(id1)
    })

    it('should respect limit', async () => {
      const saveEntry = async (): Promise<void> => {
        const id = await store.getNextId()
        await store.save(makeEntry({id}))
      }

      await saveEntry()
      await saveEntry()
      await saveEntry()
      await saveEntry()
      await saveEntry()

      const entries = await store.list({limit: 3})
      expect(entries).to.have.lengthOf(3)
    })

    it('should skip corrupted entries silently', async () => {
      const id1 = await store.getNextId()
      const id2 = await store.getNextId()

      await store.save(makeEntry({id: id1}))
      await store.save(makeEntry({id: id2}))

      // Corrupt first entry
      const logDir = join(tempDir, 'curate-log')
      await writeFile(join(logDir, `${id1}.json`), 'corrupted')

      const entries = await store.list()
      expect(entries).to.have.lengthOf(1)
      expect(entries[0].id).to.equal(id2)
    })

    it('should filter by status', async () => {
      const now = Date.now()
      const idProcessing = await store.getNextId()
      const idCompleted = await store.getNextId()
      const idError = await store.getNextId()

      await store.save(makeEntry({id: idProcessing, startedAt: now - 3000, status: 'processing'}))
      await store.save({
        completedAt: now - 1000,
        id: idCompleted,
        input: {},
        operations: [],
        response: 'ok',
        startedAt: now - 2000,
        status: 'completed',
        summary: {added: 0, deleted: 0, failed: 0, merged: 0, updated: 0},
        taskId: 'task-c',
      })
      await store.save({
        completedAt: now - 500,
        error: 'oops',
        id: idError,
        input: {},
        operations: [],
        startedAt: now - 1500,
        status: 'error',
        summary: {added: 0, deleted: 0, failed: 0, merged: 0, updated: 0},
        taskId: 'task-e',
      })

      const completedOnly = await store.list({status: ['completed']})
      expect(completedOnly).to.have.lengthOf(1)
      expect(completedOnly[0].id).to.equal(idCompleted)

      const both = await store.list({status: ['completed', 'error']})
      expect(both).to.have.lengthOf(2)
    })

    it('should filter by after (startedAt >= after)', async () => {
      const base = Date.now()
      const idOld = await store.getNextId()
      const idNew = await store.getNextId()

      await store.save(makeEntry({id: idOld, startedAt: base - 5000}))
      await store.save(makeEntry({id: idNew, startedAt: base - 1000}))

      const entries = await store.list({after: base - 3000})
      expect(entries).to.have.lengthOf(1)
      expect(entries[0].id).to.equal(idNew)
    })

    it('should filter by before (startedAt <= before)', async () => {
      const base = Date.now()
      const idOld = await store.getNextId()
      const idNew = await store.getNextId()

      await store.save(makeEntry({id: idOld, startedAt: base - 5000}))
      await store.save(makeEntry({id: idNew, startedAt: base - 1000}))

      const entries = await store.list({before: base - 3000})
      expect(entries).to.have.lengthOf(1)
      expect(entries[0].id).to.equal(idOld)
    })

    it('should apply limit after filtering', async () => {
      const now = Date.now()

      // Save 3 completed entries (sequential to get monotonic IDs)
      const completedIds = await Promise.all([store.getNextId(), store.getNextId(), store.getNextId()])
      await Promise.all(
        completedIds.map((id, i) =>
          store.save({
            completedAt: now - i * 1000,
            id,
            input: {},
            operations: [],
            startedAt: now - i * 1000 - 500,
            status: 'completed',
            summary: {added: 0, deleted: 0, failed: 0, merged: 0, updated: 0},
            taskId: `task-${i}`,
          }),
        ),
      )

      // Also save 1 processing entry
      const processingId = await store.getNextId()
      await store.save(makeEntry({id: processingId, startedAt: now - 10_000, status: 'processing'}))

      // Filter by completed, limit 2
      const entries = await store.list({limit: 2, status: ['completed']})
      expect(entries).to.have.lengthOf(2)
      for (const e of entries) {
        expect(e.status).to.equal('completed')
      }
    })
  })

  // ==========================================================================
  // pruning
  // ==========================================================================

  describe('pruning', () => {
    it('should prune oldest entries when maxEntries is exceeded', async () => {
      const storeWithLimit = new FileCurateLogStore({baseDir: tempDir, maxEntries: 3})

      const saveEntry = async (): Promise<string> => {
        const id = await storeWithLimit.getNextId()
        await storeWithLimit.save(makeEntry({id}))
        return id
      }

      const ids = [await saveEntry(), await saveEntry(), await saveEntry(), await saveEntry(), await saveEntry()]

      await waitForPruneToSettle(join(tempDir, 'curate-log'))

      // Only the 3 newest should remain
      const newest = ids.slice(2) // ids[2], ids[3], ids[4]
      const oldest = ids.slice(0, 2) // ids[0], ids[1]

      const newestResults = await Promise.all(newest.map((id) => storeWithLimit.getById(id)))
      const oldestResults = await Promise.all(oldest.map((id) => storeWithLimit.getById(id)))

      for (const result of newestResults) {
        expect(result).to.not.be.null
      }

      for (const result of oldestResults) {
        expect(result).to.be.null
      }
    })

    it('should not prune at old limit (100) and should prune at new limit (1000)', async function () {
      this.timeout(30_000)

      const logDir = join(tempDir, 'curate-log')
      await mkdir(logDir, {recursive: true})

      // Helper: seed N files directly on disk (parallel writes, no store overhead)
      const seedFiles = async (startTs: number, count: number): Promise<void> => {
        const writes: Promise<void>[] = []
        for (let i = 0; i < count; i++) {
          const ts = startTs + i
          const id = `cur-${ts}`
          const entry = {
            completedAt: ts + 1,
            id,
            input: {},
            operations: [],
            startedAt: ts,
            status: 'completed',
            summary: {added: 0, deleted: 0, failed: 0, merged: 0, updated: 0},
            taskId: `task-${id}`,
          }

          writes.push(writeFile(join(logDir, `${id}.json`), JSON.stringify(entry)))
        }

        await Promise.all(writes)
      }

      const countFiles = async (): Promise<number> => {
        const files = await readdir(logDir)
        return files.filter((f: string) => f.endsWith('.json')).length
      }

      const baseTs = 1_700_000_000_000

      // Phase 1: Seed 99 files on disk, then save entry #100 via store
      // Old limit was 100 — must NOT prune
      await seedFiles(baseTs, 99)
      const store100 = new FileCurateLogStore({baseDir: tempDir})
      const id100 = `cur-${baseTs + 99}`
      await store100.save(makeEntry({id: id100, startedAt: baseTs + 99}))
      await waitForPruneToSettle(logDir)

      expect(await countFiles()).to.equal(100)
      expect(await store100.getById(`cur-${baseTs}`)).to.not.be.null // oldest survives

      // Phase 2: Seed up to 999 files, then save entry #1000 via store
      // New limit is 1000 — must NOT prune at boundary
      await seedFiles(baseTs + 100, 899)
      const store1000 = new FileCurateLogStore({baseDir: tempDir})
      const id1000 = `cur-${baseTs + 999}`
      await store1000.save(makeEntry({id: id1000, startedAt: baseTs + 999}))
      await waitForPruneToSettle(logDir)

      expect(await countFiles()).to.equal(1000)
      expect(await store1000.getById(`cur-${baseTs}`)).to.not.be.null // oldest still survives

      // Phase 3: Save entry #1001 via store — exceeds new limit, oldest must be pruned
      const store1001 = new FileCurateLogStore({baseDir: tempDir})
      const id1001 = `cur-${baseTs + 1000}`
      await store1001.save(makeEntry({id: id1001, startedAt: baseTs + 1000}))
      await waitForPruneToSettle(logDir)

      expect(await countFiles()).to.equal(1000)
      expect(await store1001.getById(`cur-${baseTs}`)).to.be.null // oldest pruned
      expect(await store1001.getById(`cur-${baseTs + 1}`)).to.not.be.null // second oldest survives
      expect(await store1001.getById(id1001)).to.not.be.null // newest survives
    })
  })

  // ==========================================================================
  // atomic write
  // ==========================================================================

  describe('atomic write', () => {
    it('should not leave tmp files after successful save', async () => {
      const id = await store.getNextId()
      await store.save(makeEntry({id}))

      const logDir = join(tempDir, 'curate-log')
      const dirContents = await import('node:fs/promises').then((fs) => fs.readdir(logDir))
      const tmpFiles = dirContents.filter((f: string) => f.endsWith('.tmp'))
      expect(tmpFiles).to.have.lengthOf(0)
    })

    it('should overwrite existing entry (idempotent save)', async () => {
      const id = await store.getNextId()
      const first = makeEntry({id, status: 'processing'})
      await store.save(first)

      const updated: CurateLogEntry = {
        completedAt: Date.now(),
        id,
        input: {},
        operations: [],
        response: 'Final answer',
        startedAt: first.startedAt,
        status: 'completed',
        summary: {added: 0, deleted: 0, failed: 0, merged: 0, updated: 0},
        taskId: first.taskId,
      }
      await store.save(updated)

      const retrieved = await store.getById(id)
      expect(retrieved?.status).to.equal('completed')
      const completedEntry = retrieved as null | {response?: string; status: string}
      expect(completedEntry?.response).to.equal('Final answer')
    })
  })

  // ==========================================================================
  // updateOperationReviewStatus
  // ==========================================================================

  describe('updateOperationReviewStatus', () => {
    it('should update the reviewStatus of a specific operation', async () => {
      const id = await store.getNextId()
      const entry: CurateLogEntry = {
        completedAt: Date.now(),
        id,
        input: {},
        operations: [
          {needsReview: true, path: '/a.md', reviewStatus: 'pending', status: 'success', type: 'UPDATE'},
          {needsReview: true, path: '/b.md', reviewStatus: 'pending', status: 'success', type: 'DELETE'},
        ],
        startedAt: Date.now() - 500,
        status: 'completed',
        summary: {added: 0, deleted: 1, failed: 0, merged: 0, updated: 1},
        taskId: 'task-review',
      }
      await store.save(entry)

      const result = await store.updateOperationReviewStatus(id, 0, 'approved')
      expect(result).to.be.true

      const retrieved = await store.getById(id)
      expect(retrieved?.operations[0].reviewStatus).to.equal('approved')
      expect(retrieved?.operations[1].reviewStatus).to.equal('pending')
    })

    it('should return false for non-existent entry', async () => {
      const result = await store.updateOperationReviewStatus('cur-9999999999999', 0, 'approved')
      expect(result).to.be.false
    })

    it('should return false for out-of-bounds operation index', async () => {
      const id = await store.getNextId()
      const entry: CurateLogEntry = {
        completedAt: Date.now(),
        id,
        input: {},
        operations: [{needsReview: true, path: '/a.md', reviewStatus: 'pending', status: 'success', type: 'UPDATE'}],
        startedAt: Date.now() - 500,
        status: 'completed',
        summary: {added: 0, deleted: 0, failed: 0, merged: 0, updated: 1},
        taskId: 'task-review',
      }
      await store.save(entry)

      expect(await store.updateOperationReviewStatus(id, 5, 'approved')).to.be.false
      expect(await store.updateOperationReviewStatus(id, -1, 'approved')).to.be.false
    })

    it('should persist reviewStatus to disk', async () => {
      const id = await store.getNextId()
      const entry: CurateLogEntry = {
        completedAt: Date.now(),
        id,
        input: {},
        operations: [{needsReview: true, path: '/a.md', reviewStatus: 'pending', status: 'success', type: 'DELETE'}],
        startedAt: Date.now() - 500,
        status: 'completed',
        summary: {added: 0, deleted: 1, failed: 0, merged: 0, updated: 0},
        taskId: 'task-review',
      }
      await store.save(entry)

      await store.updateOperationReviewStatus(id, 0, 'rejected')

      // Create a fresh store to verify persistence
      const freshStore = new FileCurateLogStore({baseDir: tempDir})
      const retrieved = await freshStore.getById(id)
      expect(retrieved?.operations[0].reviewStatus).to.equal('rejected')
    })
  })

  // ==========================================================================
  // batchUpdateOperationReviewStatus
  // ==========================================================================

  describe('batchUpdateOperationReviewStatus', () => {
    it('should update multiple operations in a single entry', async () => {
      const id = await store.getNextId()
      const entry: CurateLogEntry = {
        completedAt: Date.now(),
        id,
        input: {},
        operations: [
          {needsReview: true, path: '/a.md', reviewStatus: 'pending', status: 'success', type: 'UPDATE'},
          {needsReview: true, path: '/b.md', reviewStatus: 'pending', status: 'success', type: 'DELETE'},
          {needsReview: true, path: '/c.md', reviewStatus: 'pending', status: 'success', type: 'ADD'},
        ],
        startedAt: Date.now() - 500,
        status: 'completed',
        summary: {added: 1, deleted: 1, failed: 0, merged: 0, updated: 1},
        taskId: 'task-batch',
      }
      await store.save(entry)

      const result = await store.batchUpdateOperationReviewStatus(id, [
        {operationIndex: 0, reviewStatus: 'approved'},
        {operationIndex: 2, reviewStatus: 'rejected'},
      ])
      expect(result).to.be.true

      const retrieved = await store.getById(id)
      expect(retrieved?.operations[0].reviewStatus).to.equal('approved')
      expect(retrieved?.operations[1].reviewStatus).to.equal('pending')
      expect(retrieved?.operations[2].reviewStatus).to.equal('rejected')
    })

    it('should return false for non-existent entry', async () => {
      const result = await store.batchUpdateOperationReviewStatus('cur-9999999999999', [
        {operationIndex: 0, reviewStatus: 'approved'},
      ])
      expect(result).to.be.false
    })

    it('should skip out-of-range indices gracefully', async () => {
      const id = await store.getNextId()
      const entry: CurateLogEntry = {
        completedAt: Date.now(),
        id,
        input: {},
        operations: [{needsReview: true, path: '/a.md', reviewStatus: 'pending', status: 'success', type: 'UPDATE'}],
        startedAt: Date.now() - 500,
        status: 'completed',
        summary: {added: 0, deleted: 0, failed: 0, merged: 0, updated: 1},
        taskId: 'task-batch',
      }
      await store.save(entry)

      const result = await store.batchUpdateOperationReviewStatus(id, [
        {operationIndex: 0, reviewStatus: 'approved'},
        {operationIndex: 5, reviewStatus: 'approved'},
        {operationIndex: -1, reviewStatus: 'approved'},
      ])
      expect(result).to.be.true

      const retrieved = await store.getById(id)
      expect(retrieved?.operations[0].reviewStatus).to.equal('approved')
    })

    it('should persist batch updates to disk', async () => {
      const id = await store.getNextId()
      const entry: CurateLogEntry = {
        completedAt: Date.now(),
        id,
        input: {},
        operations: [
          {needsReview: true, path: '/a.md', reviewStatus: 'pending', status: 'success', type: 'UPDATE'},
          {needsReview: true, path: '/b.md', reviewStatus: 'pending', status: 'success', type: 'DELETE'},
        ],
        startedAt: Date.now() - 500,
        status: 'completed',
        summary: {added: 0, deleted: 1, failed: 0, merged: 0, updated: 1},
        taskId: 'task-batch',
      }
      await store.save(entry)

      await store.batchUpdateOperationReviewStatus(id, [
        {operationIndex: 0, reviewStatus: 'approved'},
        {operationIndex: 1, reviewStatus: 'rejected'},
      ])

      const freshStore = new FileCurateLogStore({baseDir: tempDir})
      const retrieved = await freshStore.getById(id)
      expect(retrieved?.operations[0].reviewStatus).to.equal('approved')
      expect(retrieved?.operations[1].reviewStatus).to.equal('rejected')
    })
  })

  // ==========================================================================
  // reviewStatus in Zod schema
  // ==========================================================================

  describe('reviewStatus schema validation', () => {
    it('should accept entries with reviewStatus field', async () => {
      const id = await store.getNextId()
      const entry: CurateLogEntry = {
        completedAt: Date.now(),
        id,
        input: {},
        operations: [
          {
            confidence: 'low',
            impact: 'high',
            needsReview: true,
            path: '/a.md',
            reason: 'test',
            reviewStatus: 'pending',
            status: 'success',
            type: 'UPDATE',
          },
        ],
        startedAt: Date.now() - 500,
        status: 'completed',
        summary: {added: 0, deleted: 0, failed: 0, merged: 0, updated: 1},
        taskId: 'task-1',
      }
      await store.save(entry)

      const retrieved = await store.getById(id)
      expect(retrieved?.operations[0].reviewStatus).to.equal('pending')
    })

    it('should accept entries without reviewStatus field (backward compatible)', async () => {
      const id = await store.getNextId()
      const entry: CurateLogEntry = {
        completedAt: Date.now(),
        id,
        input: {},
        operations: [{path: '/a.md', status: 'success', type: 'ADD'}],
        startedAt: Date.now() - 500,
        status: 'completed',
        summary: {added: 1, deleted: 0, failed: 0, merged: 0, updated: 0},
        taskId: 'task-1',
      }
      await store.save(entry)

      const retrieved = await store.getById(id)
      expect(retrieved?.operations[0].reviewStatus).to.be.undefined
    })
  })
})
