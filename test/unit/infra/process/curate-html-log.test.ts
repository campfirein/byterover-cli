import {expect} from 'chai'
import {mkdir, mkdtemp, readFile, rm, writeFile} from 'node:fs/promises'
import {tmpdir} from 'node:os'
import {join, relative} from 'node:path'

import type {HtmlWriteResult} from '../../../../src/server/infra/render/writer/html-writer.js'

import {backupContextTreeFile, buildCurateHtmlLogEntry} from '../../../../src/server/infra/process/curate-html-log.js'
import {FileReviewBackupStore} from '../../../../src/server/infra/storage/file-review-backup-store.js'

// ── Fixtures ──────────────────────────────────────────────────────────────────

const SUCCESS: HtmlWriteResult = {
  filePath: '/project/.brv/context-tree/security/auth.html',
  ok: true,
  written: '<bv-topic path="security/auth"></bv-topic>',
}

const FAILURE: HtmlWriteResult = {
  errors: [
    {kind: 'missing-bv-topic', message: 'Curate output must contain exactly one <bv-topic> root.'},
  ],
  ok: false,
}

function baseInput() {
  return {
    completedAt: 1_700_000_010_000,
    confirmOverwrite: false,
    existedBefore: false,
    // Absolute path — mirrors what writeHtmlTopic returns. Review-handler
    // and dream-executor both treat `op.filePath` as absolute.
    filePath: '/project/.brv/context-tree/security/auth.html',
    id: 'cur-1700000000000',
    reviewDisabled: false,
    startedAt: 1_700_000_000_000,
    taskId: 'task-abc',
    topicPath: 'security/auth',
    writeResult: SUCCESS,
  }
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('buildCurateHtmlLogEntry', () => {
  describe('success with meta.impact = high', () => {
    it('sets needsReview = true and reviewStatus = pending when reviewDisabled = false', () => {
      const entry = buildCurateHtmlLogEntry({
        ...baseInput(),
        meta: {impact: 'high', reason: 'Locks JWT alg.', summary: 'JWT RS256.', type: 'ADD'},
      })

      expect(entry.status).to.equal('completed')
      expect(entry.operations).to.have.lengthOf(1)
      const op = entry.operations[0]
      expect(op.needsReview).to.equal(true)
      expect(op.reviewStatus).to.equal('pending')
      expect(op.impact).to.equal('high')
      expect(op.type).to.equal('ADD')
      expect(op.reason).to.equal('Locks JWT alg.')
      expect(op.summary).to.equal('JWT RS256.')
      expect(op.status).to.equal('success')
    })

    it('suppresses needsReview when reviewDisabled = true', () => {
      const entry = buildCurateHtmlLogEntry({
        ...baseInput(),
        meta: {impact: 'high', type: 'ADD'},
        reviewDisabled: true,
      })

      const op = entry.operations[0]
      expect(op.needsReview).to.equal(false)
      expect(op.reviewStatus).to.be.undefined
      expect(op.impact).to.equal('high')
    })
  })

  describe('success with meta.impact = low', () => {
    it('sets needsReview = false and omits reviewStatus', () => {
      const entry = buildCurateHtmlLogEntry({
        ...baseInput(),
        meta: {impact: 'low', type: 'UPDATE'},
      })

      const op = entry.operations[0]
      expect(op.needsReview).to.equal(false)
      expect(op.reviewStatus).to.be.undefined
      expect(op.impact).to.equal('low')
    })
  })

  describe('success without meta', () => {
    it('falls back to writer-derived type and omits impact / needsReview', () => {
      const entry = buildCurateHtmlLogEntry({...baseInput()})

      const op = entry.operations[0]
      expect(op.type).to.equal('ADD') // existedBefore: false → ADD
      expect(op.impact).to.be.undefined
      expect(op.needsReview).to.be.undefined
      expect(op.reviewStatus).to.be.undefined
      expect(op.reason).to.be.undefined
    })
  })

  describe('type derivation', () => {
    it('defaults to UPDATE when existedBefore = true and confirmOverwrite = true, no meta.type', () => {
      const entry = buildCurateHtmlLogEntry({...baseInput(), confirmOverwrite: true, existedBefore: true})
      expect(entry.operations[0].type).to.equal('UPDATE')
    })

    it('defaults to ADD when existedBefore = true but confirmOverwrite = false', () => {
      // existedBefore + confirmOverwrite=false is a writer "path-exists" failure scenario;
      // type fallback only treats it as UPDATE when overwrite was confirmed.
      const entry = buildCurateHtmlLogEntry({...baseInput(), confirmOverwrite: false, existedBefore: true})
      expect(entry.operations[0].type).to.equal('ADD')
    })

    it('lets agent-asserted meta.type win over writer fallback (MERGE)', () => {
      const entry = buildCurateHtmlLogEntry({
        ...baseInput(),
        confirmOverwrite: true,
        existedBefore: true,
        meta: {type: 'MERGE'},
      })
      expect(entry.operations[0].type).to.equal('MERGE')
    })

    it('lets agent-asserted meta.type win over writer fallback (ADD on UPDATE-ish state)', () => {
      const entry = buildCurateHtmlLogEntry({
        ...baseInput(),
        confirmOverwrite: true,
        existedBefore: true,
        meta: {type: 'ADD'},
      })
      expect(entry.operations[0].type).to.equal('ADD')
    })
  })

  describe('failure path', () => {
    it('returns error entry with failed operation and preserves error message', () => {
      const entry = buildCurateHtmlLogEntry({...baseInput(), writeResult: FAILURE})

      expect(entry.status).to.equal('error')
      if (entry.status !== 'error') throw new Error('unreachable')
      expect(entry.error).to.contain('missing-bv-topic')

      expect(entry.operations).to.have.lengthOf(1)
      const op = entry.operations[0]
      expect(op.status).to.equal('failed')
      expect(op.needsReview).to.equal(false)
      expect(op.reviewStatus).to.be.undefined
      expect(op.message).to.contain('Curate output must contain exactly one')
    })

    it('uses sentinel path on failure when topicPath is unknown', () => {
      const entry = buildCurateHtmlLogEntry({
        ...baseInput(),
        topicPath: undefined,
        writeResult: FAILURE,
      })
      expect(entry.operations[0].path).to.equal('<unknown>')
    })

    it('failed entry still includes meta.impact when present (telemetry) but does not surface for review', () => {
      const entry = buildCurateHtmlLogEntry({
        ...baseInput(),
        meta: {impact: 'high', type: 'ADD'},
        writeResult: FAILURE,
      })

      const op = entry.operations[0]
      expect(op.status).to.equal('failed')
      expect(op.needsReview).to.equal(false)
      expect(op.reviewStatus).to.be.undefined
    })
  })

  describe('backupContextTreeFile (regression for `brv review reject` restoring prior content)', () => {
    // Mirrors main's `backupBeforeWrite` contract: before any destructive
    // write under the context-tree root, capture the existing bytes into
    // `<brvDir>/review-backups/<relativePath>` via the store. Without this,
    // `brv review reject` deletes the file (review-handler treats missing
    // backup as ADD → unlink).

    let projectRoot: string

    beforeEach(async () => {
      projectRoot = await mkdtemp(join(tmpdir(), 'backup-helper-'))
    })

    afterEach(async () => {
      await rm(projectRoot, {force: true, recursive: true})
    })

    async function seedTopic(relativePath: string, content: string): Promise<string> {
      const absolutePath = join(projectRoot, '.brv', 'context-tree', relativePath)
      await mkdir(join(absolutePath, '..'), {recursive: true})
      await writeFile(absolutePath, content, 'utf8')
      return absolutePath
    }

    function backupStoreFor(): FileReviewBackupStore {
      return new FileReviewBackupStore(join(projectRoot, '.brv'))
    }

    it('saves prior file bytes to the backup store when the file exists', async () => {
      const absolutePath = await seedTopic('security/auth.html', '<bv-topic path="security/auth">prior</bv-topic>')
      const store = backupStoreFor()
      const contextTreeRoot = join(projectRoot, '.brv', 'context-tree')

      await backupContextTreeFile({absoluteFilePath: absolutePath, contextTreeRoot, reviewBackupStore: store, reviewDisabled: false})

      const backupContent = await store.read(relative(contextTreeRoot, absolutePath))
      expect(backupContent).to.equal('<bv-topic path="security/auth">prior</bv-topic>')
    })

    it('no-ops when the file does not exist (ADD case — ENOENT swallowed)', async () => {
      const store = backupStoreFor()
      const contextTreeRoot = join(projectRoot, '.brv', 'context-tree')
      const absent = join(contextTreeRoot, 'never/written.html')

      // Should not throw.
      await backupContextTreeFile({absoluteFilePath: absent, contextTreeRoot, reviewBackupStore: store, reviewDisabled: false})

      const backupContent = await store.read('never/written.html')
      expect(backupContent).to.equal(null)
    })

    it('skips backup creation when reviewDisabled = true', async () => {
      const absolutePath = await seedTopic('x/y.html', 'prior')
      const store = backupStoreFor()
      const contextTreeRoot = join(projectRoot, '.brv', 'context-tree')

      await backupContextTreeFile({absoluteFilePath: absolutePath, contextTreeRoot, reviewBackupStore: store, reviewDisabled: true})

      const backupContent = await store.read('x/y.html')
      expect(backupContent).to.equal(null)
    })

    it('first-write-wins (delegated to the store): second call does not overwrite the snapshot', async () => {
      const absolutePath = await seedTopic('x/y.html', 'snapshot-at-last-push')
      const store = backupStoreFor()
      const contextTreeRoot = join(projectRoot, '.brv', 'context-tree')

      // First backup captures the snapshot.
      await backupContextTreeFile({absoluteFilePath: absolutePath, contextTreeRoot, reviewBackupStore: store, reviewDisabled: false})

      // File evolves on disk, then a second curate triggers another backup attempt.
      await writeFile(absolutePath, 'newer-content', 'utf8')
      await backupContextTreeFile({absoluteFilePath: absolutePath, contextTreeRoot, reviewBackupStore: store, reviewDisabled: false})

      // The backup must still hold the original snapshot — multiple curates between
      // pushes must not erode the "state at last push" guarantee.
      const backupContent = await store.read('x/y.html')
      expect(backupContent).to.equal('snapshot-at-last-push')
    })

    it('I/O failure does not throw (best-effort; backup must never block curate)', async () => {
      const store = backupStoreFor()
      const contextTreeRoot = join(projectRoot, '.brv', 'context-tree')
      // Path that doesn't resolve under context-tree-root and isn't readable.
      const garbage = '/proc/this-cannot-be-read-or-resolved/xxx'

      await backupContextTreeFile({absoluteFilePath: garbage, contextTreeRoot, reviewBackupStore: store, reviewDisabled: false})

      // No exception, no backup.
      expect(await store.list()).to.have.lengthOf(0)
    })

    // Sanity: this is the exact bytes-as-saved snapshot the rejected `brv review reject`
    // reads. If this round-trip breaks, the restore path breaks silently.
    it('backup content round-trips through the store byte-for-byte', async () => {
      const absolutePath = await seedTopic('x/y.html', '<bv-topic>\n  <bv-rule>α β γ</bv-rule>\n</bv-topic>')
      const store = backupStoreFor()
      const contextTreeRoot = join(projectRoot, '.brv', 'context-tree')

      await backupContextTreeFile({absoluteFilePath: absolutePath, contextTreeRoot, reviewBackupStore: store, reviewDisabled: false})
      const backupContent = await readFile(join(projectRoot, '.brv', 'review-backups', 'x/y.html'), 'utf8')
      expect(backupContent).to.equal('<bv-topic>\n  <bv-rule>α β γ</bv-rule>\n</bv-topic>')
    })
  })

  describe('filePath convention (regression — see review-handler contract)', () => {
    it('preserves the caller-supplied absolute filePath verbatim on the operation', () => {
      // review-handler.ts:117 + dream-executor convention: op.filePath is
      // absolute. The handler does `relative(contextTreeDir, op.filePath)`
      // to derive its display key — passing a relative path produces a
      // garbage key and `brv review approve <taskId>` silently no-ops.
      const entry = buildCurateHtmlLogEntry({
        ...baseInput(),
        filePath: '/abs/.brv/context-tree/x/y.html',
        meta: {impact: 'high', type: 'ADD'},
      })
      expect(entry.operations[0].filePath).to.equal('/abs/.brv/context-tree/x/y.html')
    })
  })

  describe('entry shape', () => {
    it('includes startedAt, completedAt, taskId, id, format = html', () => {
      const entry = buildCurateHtmlLogEntry({...baseInput()})

      expect(entry.id).to.equal('cur-1700000000000')
      expect(entry.taskId).to.equal('task-abc')
      expect(entry.startedAt).to.equal(1_700_000_000_000)
      expect(entry.format).to.equal('html')
      if (entry.status !== 'completed') throw new Error('expected completed')
      expect(entry.completedAt).to.equal(1_700_000_010_000)
    })

    it('threads intent into input.context', () => {
      const entry = buildCurateHtmlLogEntry({...baseInput(), intent: 'remember JWT decision'})
      expect(entry.input.context).to.equal('remember JWT decision')
    })

    it('falls back to a sentinel intent when none supplied', () => {
      const entry = buildCurateHtmlLogEntry({...baseInput()})
      expect(entry.input.context).to.be.a('string').and.not.equal('')
    })

    it('computes summary from operations (success ADD increments added)', () => {
      const entry = buildCurateHtmlLogEntry({...baseInput(), meta: {type: 'ADD'}})
      expect(entry.summary.added).to.equal(1)
      expect(entry.summary.failed).to.equal(0)
    })

    it('computes summary from operations (failure increments failed)', () => {
      const entry = buildCurateHtmlLogEntry({...baseInput(), writeResult: FAILURE})
      expect(entry.summary.failed).to.equal(1)
      expect(entry.summary.added).to.equal(0)
    })
  })
})
