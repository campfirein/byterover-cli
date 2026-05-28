import {expect} from 'chai'
import {access, mkdir, readFile, writeFile} from 'node:fs/promises'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import {restore, type SinonStub, stub} from 'sinon'

import type {DreamLogEntry} from '../../../../src/server/infra/dream/dream-log-schema.js'

import {EMPTY_DREAM_STATE} from '../../../../src/server/infra/dream/dream-state-schema.js'
import {type DreamUndoDeps, undoLastDream} from '../../../../src/server/infra/dream/dream-undo.js'

/** Build a completed dream log entry with optional operation overrides. */
function completedLog(operations: DreamLogEntry['operations'] = []): DreamLogEntry {
  return {
    completedAt: Date.now(),
    id: 'drm-1000',
    operations,
    startedAt: Date.now() - 1000,
    status: 'completed',
    summary: {consolidated: 0, errors: 0, flaggedForReview: 0, pruned: 0, synthesized: 0},
    taskId: 'task-1',
    trigger: 'cli',
  }
}

describe('undoLastDream', () => {
  let ctxDir: string
  let dreamLogStore: {getById: SinonStub; save: SinonStub}
  let dreamStateService: {read: SinonStub; write: SinonStub}
  let manifestService: {buildManifest: SinonStub}
  let deps: DreamUndoDeps

  beforeEach(async () => {
    ctxDir = join(tmpdir(), `brv-undo-test-${Date.now()}`)
    await mkdir(ctxDir, {recursive: true})

    dreamLogStore = {
      getById: stub().resolves(completedLog()),
      save: stub().resolves(),
    }
    dreamStateService = {
      read: stub().resolves({...EMPTY_DREAM_STATE, lastDreamLogId: 'drm-1000', totalDreams: 1}),
      write: stub().resolves(),
    }
    manifestService = {
      buildManifest: stub().resolves({}),
    }

    deps = {contextTreeDir: ctxDir, dreamLogStore, dreamStateService, manifestService}
  })

  afterEach(() => {
    restore()
  })

  // ── Precondition checks ───────────────────────────────────────────────────

  it('throws when no dream to undo (lastDreamLogId is null)', async () => {
    dreamStateService.read.resolves({...EMPTY_DREAM_STATE})

    try {
      await undoLastDream(deps)
      expect.fail('should have thrown')
    } catch (error) {
      expect((error as Error).message).to.include('No dream to undo')
    }
  })

  it('throws when dream log not found', async () => {
    dreamLogStore.getById.resolves(null)

    try {
      await undoLastDream(deps)
      expect.fail('should have thrown')
    } catch (error) {
      expect((error as Error).message).to.include('not found')
    }
  })

  it('throws when dream already undone', async () => {
    const undoneLog: DreamLogEntry = {
      completedAt: Date.now(),
      id: 'drm-1000',
      operations: [],
      startedAt: Date.now() - 1000,
      status: 'undone',
      summary: {consolidated: 0, errors: 0, flaggedForReview: 0, pruned: 0, synthesized: 0},
      trigger: 'cli',
      undoneAt: Date.now(),
    }
    dreamLogStore.getById.resolves(undoneLog)

    try {
      await undoLastDream(deps)
      expect.fail('should have thrown')
    } catch (error) {
      expect((error as Error).message).to.include('already undone')
    }
  })

  it('throws when dream status is error', async () => {
    const errorLog: DreamLogEntry = {
      completedAt: Date.now(),
      error: 'boom',
      id: 'drm-1000',
      operations: [],
      startedAt: Date.now() - 1000,
      status: 'error',
      summary: {consolidated: 0, errors: 0, flaggedForReview: 0, pruned: 0, synthesized: 0},
      trigger: 'cli',
    }
    dreamLogStore.getById.resolves(errorLog)

    try {
      await undoLastDream(deps)
      expect.fail('should have thrown')
    } catch (error) {
      expect((error as Error).message).to.include('Cannot undo')
    }
  })

  it('allows undo of partial dreams', async () => {
    const partialLog: DreamLogEntry = {
      abortReason: 'Timeout',
      completedAt: Date.now(),
      id: 'drm-1000',
      operations: [],
      startedAt: Date.now() - 1000,
      status: 'partial',
      summary: {consolidated: 0, errors: 0, flaggedForReview: 0, pruned: 0, synthesized: 0},
      trigger: 'cli',
    }
    dreamLogStore.getById.resolves(partialLog)

    const result = await undoLastDream(deps)
    expect(result.dreamId).to.equal('drm-1000')
  })

  // ── CONSOLIDATE/MERGE undo ────────────────────────────────────────────────

  it('undoes MERGE: restores source files from previousTexts', async () => {
    await mkdir(join(ctxDir, 'auth'), {recursive: true})
    await writeFile(join(ctxDir, 'auth/login.md'), 'Merged content')

    dreamLogStore.getById.resolves(completedLog([{
      action: 'MERGE',
      inputFiles: ['auth/login.md', 'auth/login-v2.md'],
      needsReview: true,
      outputFile: 'auth/login.md',
      previousTexts: {
        'auth/login-v2.md': 'Original login-v2 content',
        'auth/login.md': 'Original login content',
      },
      reason: 'Redundant',
      type: 'CONSOLIDATE',
    }]))

    const result = await undoLastDream(deps)

    expect(result.restoredFiles).to.include('auth/login.md')
    expect(result.restoredFiles).to.include('auth/login-v2.md')

    const login = await readFile(join(ctxDir, 'auth/login.md'), 'utf8')
    expect(login).to.equal('Original login content')
    const loginV2 = await readFile(join(ctxDir, 'auth/login-v2.md'), 'utf8')
    expect(loginV2).to.equal('Original login-v2 content')
  })

  it('undoes MERGE: deletes output file when not in previousTexts', async () => {
    await mkdir(join(ctxDir, 'auth'), {recursive: true})
    await writeFile(join(ctxDir, 'auth/combined.md'), 'Merged content')

    dreamLogStore.getById.resolves(completedLog([{
      action: 'MERGE',
      inputFiles: ['auth/a.md', 'auth/b.md'],
      needsReview: true,
      outputFile: 'auth/combined.md',
      previousTexts: {
        'auth/a.md': 'Content A',
        'auth/b.md': 'Content B',
      },
      reason: 'Merge',
      type: 'CONSOLIDATE',
    }]))

    const result = await undoLastDream(deps)

    expect(result.deletedFiles).to.include('auth/combined.md')
    expect(result.restoredFiles).to.include('auth/a.md')
    expect(result.restoredFiles).to.include('auth/b.md')

    let exists = true
    try {
      await access(join(ctxDir, 'auth/combined.md'))
    } catch {
      exists = false
    }

    expect(exists).to.be.false
  })

  // ── CONSOLIDATE/TEMPORAL_UPDATE undo ──────────────────────────────────────

  it('undoes TEMPORAL_UPDATE: restores original content', async () => {
    await mkdir(join(ctxDir, 'api'), {recursive: true})
    await writeFile(join(ctxDir, 'api/rate-limits.md'), 'Updated content')

    dreamLogStore.getById.resolves(completedLog([{
      action: 'TEMPORAL_UPDATE',
      inputFiles: ['api/rate-limits.md'],
      needsReview: true,
      previousTexts: {'api/rate-limits.md': 'Original rate limits'},
      reason: 'Outdated',
      type: 'CONSOLIDATE',
    }]))

    const result = await undoLastDream(deps)

    expect(result.restoredFiles).to.include('api/rate-limits.md')
    const content = await readFile(join(ctxDir, 'api/rate-limits.md'), 'utf8')
    expect(content).to.equal('Original rate limits')
  })

  // ── CONSOLIDATE/CROSS_REFERENCE undo ──────────────────────────────────────

  it('skips legacy CROSS_REFERENCE entries without previousTexts', async () => {
    dreamLogStore.getById.resolves(completedLog([{
      action: 'CROSS_REFERENCE',
      inputFiles: ['auth/jwt.md', 'auth/oauth.md'],
      needsReview: false,
      reason: 'Related',
      type: 'CONSOLIDATE',
    }]))

    const result = await undoLastDream(deps)

    expect(result.restoredFiles).to.be.empty
    expect(result.deletedFiles).to.be.empty
  })

  it('restores files for CROSS_REFERENCE when previousTexts were captured', async () => {
    await mkdir(join(ctxDir, 'auth'), {recursive: true})
    await writeFile(join(ctxDir, 'auth/jwt.md'), 'Updated jwt')
    await writeFile(join(ctxDir, 'auth/oauth.md'), 'Updated oauth')

    dreamLogStore.getById.resolves(completedLog([{
      action: 'CROSS_REFERENCE',
      inputFiles: ['auth/jwt.md', 'auth/oauth.md'],
      needsReview: true,
      previousTexts: {
        'auth/jwt.md': 'Original jwt',
        'auth/oauth.md': 'Original oauth',
      },
      reason: 'Related',
      type: 'CONSOLIDATE',
    }]))

    const result = await undoLastDream(deps)

    expect(result.restoredFiles).to.include('auth/jwt.md')
    expect(result.restoredFiles).to.include('auth/oauth.md')
    expect(await readFile(join(ctxDir, 'auth/jwt.md'), 'utf8')).to.equal('Original jwt')
    expect(await readFile(join(ctxDir, 'auth/oauth.md'), 'utf8')).to.equal('Original oauth')
  })

  // ── SYNTHESIZE undo (forward-compatible) ──────────────────────────────────

  it('undoes SYNTHESIZE: deletes created file', async () => {
    await mkdir(join(ctxDir, 'auth'), {recursive: true})
    await writeFile(join(ctxDir, 'auth/overview.md'), 'Synthesized content')

    dreamLogStore.getById.resolves(completedLog([{
      action: 'CREATE',
      confidence: 0.9,
      needsReview: false,
      outputFile: 'auth/overview.md',
      sources: ['auth/jwt.md', 'auth/oauth.md'],
      type: 'SYNTHESIZE',
    }]))

    const result = await undoLastDream(deps)

    expect(result.deletedFiles).to.include('auth/overview.md')
    let exists = true
    try {
      await access(join(ctxDir, 'auth/overview.md'))
    } catch {
      exists = false
    }

    expect(exists).to.be.false
  })

  it('throws for SYNTHESIZE/UPDATE (no previousTexts to restore)', async () => {
    await mkdir(join(ctxDir, 'auth'), {recursive: true})
    await writeFile(join(ctxDir, 'auth/overview.md'), 'Updated content')

    dreamLogStore.getById.resolves(completedLog([{
      action: 'UPDATE',
      confidence: 0.8,
      needsReview: false,
      outputFile: 'auth/overview.md',
      sources: ['auth/jwt.md'],
      type: 'SYNTHESIZE',
    }]))

    const result = await undoLastDream(deps)

    // Error collected, file NOT deleted
    expect(result.errors.length).to.be.greaterThan(0)
    expect(result.errors[0]).to.include('SYNTHESIZE/UPDATE')
    expect(result.deletedFiles).to.be.empty

    const content = await readFile(join(ctxDir, 'auth/overview.md'), 'utf8')
    expect(content).to.equal('Updated content')
  })

  // ── PRUNE undo (forward-compatible) ───────────────────────────────────────

  it('undoes PRUNE/ARCHIVE: calls archiveService.restoreEntry with stubPath', async () => {
    const archiveService = {restoreEntry: stub().resolves('auth/old-doc.md')}

    dreamLogStore.getById.resolves(completedLog([{
      action: 'ARCHIVE',
      file: 'auth/old-doc.md',
      needsReview: false,
      reason: 'Stale',
      stubPath: '_archived/auth/old-doc.stub.md',
      type: 'PRUNE',
    }]))

    const result = await undoLastDream({...deps, archiveService})

    expect(archiveService.restoreEntry.calledOnce).to.be.true
    expect(archiveService.restoreEntry.firstCall.args[0]).to.equal('_archived/auth/old-doc.stub.md')
    expect(result.restoredArchives).to.include('auth/old-doc.md')
  })

  it('undoes PRUNE/ARCHIVE: restores from previousTexts (tool-mode) when present, ignoring stubPath', async () => {
    // Tool-mode finalize writes a PRUNE/ARCHIVE op with `previousTexts`
    // instead of `stubPath`. Undo should write the body back to its
    // original location and remove the .brv/archive/<path> copy.
    const brvDir = join(tmpdir(), `brv-undo-tm-${Date.now()}-${Math.random().toString(36).slice(2)}`)
    await mkdir(join(brvDir, 'context-tree'), {recursive: true})
    await mkdir(join(brvDir, 'archive', 'testing'), {recursive: true})
    const originalContent = '<bv-topic path="testing/old" title="O">restored body</bv-topic>'
    await writeFile(join(brvDir, 'archive', 'testing', 'old.html'), originalContent, 'utf8')

    dreamLogStore.getById.resolves(completedLog([{
      action: 'ARCHIVE',
      file: 'testing/old.html',
      needsReview: false,
      previousTexts: {'testing/old.html': originalContent},
      reason: 'tool-mode finalize',
      type: 'PRUNE',
    }]))

    const result = await undoLastDream({
      ...deps,
      contextTreeDir: join(brvDir, 'context-tree'),
    })

    expect(result.restoredFiles).to.include('testing/old.html')
    const restoredBody = await readFile(join(brvDir, 'context-tree', 'testing', 'old.html'), 'utf8')
    expect(restoredBody).to.equal(originalContent)
    // .brv/archive/<path> copy must be removed so we don't leave a stale duplicate.
    try {
      await access(join(brvDir, 'archive', 'testing', 'old.html'))
      expect.fail('archive copy should have been deleted')
    } catch (error) {
      expect((error as NodeJS.ErrnoException).code).to.equal('ENOENT')
    }
  })

  it('undoes PRUNE/ARCHIVE: restores original mtime via utimes() when previousMtimes is present', async () => {
    // Without this, writeFile stamps the restore wall-clock as the new
    // mtime and a topic archived as stale-mtime (>60d for draft) silently
    // drops below the prune threshold on the next scan even though the
    // file is back.
    const brvDir = join(tmpdir(), `brv-undo-mtime-${Date.now()}-${Math.random().toString(36).slice(2)}`)
    await mkdir(join(brvDir, 'context-tree'), {recursive: true})
    await mkdir(join(brvDir, 'archive'), {recursive: true})
    await writeFile(join(brvDir, 'archive', 'stale.html'), 'x', 'utf8')

    const seventyDaysAgoMs = Date.now() - 70 * 24 * 60 * 60 * 1000

    dreamLogStore.getById.resolves(completedLog([{
      action: 'ARCHIVE',
      file: 'stale.html',
      needsReview: false,
      previousMtimes: {'stale.html': seventyDaysAgoMs},
      previousTexts: {'stale.html': '<bv-topic path="stale" title="S"/>'},
      reason: 'tool-mode finalize',
      type: 'PRUNE',
    }]))

    await undoLastDream({...deps, contextTreeDir: join(brvDir, 'context-tree')})

    const {stat} = await import('node:fs/promises')
    const stats = await stat(join(brvDir, 'context-tree', 'stale.html'))
    // Allow a small tolerance for filesystem mtime precision (e.g. APFS = 1ns; HFS+ = 1s)
    expect(stats.mtimeMs).to.be.closeTo(seventyDaysAgoMs, 2000)
  })

  it('undoes PRUNE/ARCHIVE: restores sidecar signals via runtimeSignalStore.set when previousSignals is present', async () => {
    // Without this, the file returns but signals (importance, maturity,
    // accessCount...) are reset to defaults, so a topic archived as
    // low-importance (importance < 35) won't re-surface on the next
    // prune scan even though the file is back.
    const brvDir = join(tmpdir(), `brv-undo-signals-${Date.now()}-${Math.random().toString(36).slice(2)}`)
    await mkdir(join(brvDir, 'context-tree'), {recursive: true})
    await mkdir(join(brvDir, 'archive'), {recursive: true})
    await writeFile(join(brvDir, 'archive', 'lowimp.html'), 'x', 'utf8')

    const signalStoreStub = {set: stub().resolves()}

    dreamLogStore.getById.resolves(completedLog([{
      action: 'ARCHIVE',
      file: 'lowimp.html',
      needsReview: false,
      previousSignals: {
        'lowimp.html': {accessCount: 3, importance: 15, maturity: 'draft', recency: 0.7, updateCount: 1},
      },
      previousTexts: {'lowimp.html': '<bv-topic path="lowimp" title="L"/>'},
      reason: 'tool-mode finalize',
      type: 'PRUNE',
    }]))

    await undoLastDream({
      ...deps,
      contextTreeDir: join(brvDir, 'context-tree'),
      runtimeSignalStore: signalStoreStub,
    })

    expect(signalStoreStub.set.calledOnce, 'expected runtimeSignalStore.set to be called').to.equal(true)
    expect(signalStoreStub.set.firstCall.args[0]).to.equal('lowimp.html')
    expect(signalStoreStub.set.firstCall.args[1]).to.deep.include({importance: 15, maturity: 'draft'})
  })

  it('undoes PRUNE/ARCHIVE: skips signal restore gracefully for legacy logs without previousSignals', async () => {
    // Backward compat: older log entries (pre-fix) don't carry previousSignals.
    // Undo must still restore the file body without throwing.
    const brvDir = join(tmpdir(), `brv-undo-legacy-${Date.now()}-${Math.random().toString(36).slice(2)}`)
    await mkdir(join(brvDir, 'context-tree'), {recursive: true})
    await mkdir(join(brvDir, 'archive'), {recursive: true})
    await writeFile(join(brvDir, 'archive', 'old.html'), 'x', 'utf8')

    const signalStoreStub = {set: stub().resolves()}

    dreamLogStore.getById.resolves(completedLog([{
      action: 'ARCHIVE',
      file: 'old.html',
      needsReview: false,
      previousTexts: {'old.html': '<bv-topic path="old" title="O"/>'},
      reason: 'tool-mode finalize',
      type: 'PRUNE',
    }]))

    const result = await undoLastDream({
      ...deps,
      contextTreeDir: join(brvDir, 'context-tree'),
      runtimeSignalStore: signalStoreStub,
    })

    expect(result.restoredFiles).to.include('old.html')
    expect(signalStoreStub.set.called, 'set must not be called when previousSignals is absent').to.equal(false)
  })

  it('skips PRUNE/KEEP (no-op)', async () => {
    dreamLogStore.getById.resolves(completedLog([{
      action: 'KEEP',
      file: 'auth/important.md',
      needsReview: false,
      reason: 'Active',
      type: 'PRUNE',
    }]))

    const result = await undoLastDream(deps)
    expect(result.restoredFiles).to.be.empty
    expect(result.deletedFiles).to.be.empty
  })

  it('undoes PRUNE/SUGGEST_MERGE: removes from pendingMerges', async () => {
    dreamStateService.read.resolves({
      ...EMPTY_DREAM_STATE,
      lastDreamLogId: 'drm-1000',
      pendingMerges: [
        {mergeTarget: 'auth/target.md', sourceFile: 'auth/source.md'},
        {mergeTarget: 'api/other.md', sourceFile: 'api/src.md'},
      ],
      totalDreams: 1,
    })

    dreamLogStore.getById.resolves(completedLog([{
      action: 'SUGGEST_MERGE',
      file: 'auth/source.md',
      mergeTarget: 'auth/target.md',
      needsReview: false,
      reason: 'Similar',
      type: 'PRUNE',
    }]))

    await undoLastDream(deps)

    const writtenState = dreamStateService.write.firstCall.args[0]
    expect(writtenState.pendingMerges).to.have.lengthOf(1)
    expect(writtenState.pendingMerges[0].sourceFile).to.equal('api/src.md')
  })

  // ── Post-undo checks ─────────────────────────────────────────────────────

  it('marks dream log as undone with undoneAt', async () => {
    const result = await undoLastDream(deps)

    expect(result.dreamId).to.equal('drm-1000')

    const savedLog = dreamLogStore.save.lastCall.args[0]
    expect(savedLog.status).to.equal('undone')
    expect(savedLog.undoneAt).to.be.a('number')
    expect(savedLog.id).to.equal('drm-1000')
  })

  it('rewinds dream state: nulls lastDreamAt and decrements totalDreams', async () => {
    dreamStateService.read.resolves({
      ...EMPTY_DREAM_STATE,
      lastDreamLogId: 'drm-1000',
      totalDreams: 3,
    })

    await undoLastDream(deps)

    const writtenState = dreamStateService.write.firstCall.args[0]
    expect(writtenState.lastDreamAt).to.be.null
    expect(writtenState.totalDreams).to.equal(2)
  })

  it('does not decrement totalDreams below zero', async () => {
    dreamStateService.read.resolves({
      ...EMPTY_DREAM_STATE,
      lastDreamLogId: 'drm-1000',
      totalDreams: 0,
    })

    await undoLastDream(deps)

    const writtenState = dreamStateService.write.firstCall.args[0]
    expect(writtenState.totalDreams).to.equal(0)
  })

  it('rebuilds manifest after undo', async () => {
    await undoLastDream(deps)
    expect(manifestService.buildManifest.calledOnce).to.be.true
  })

  // ── Mixed operations and partial failure ──────────────────────────────────

  it('reverses operations in reverse order', async () => {
    await mkdir(join(ctxDir, 'auth'), {recursive: true})
    await mkdir(join(ctxDir, 'api'), {recursive: true})
    await writeFile(join(ctxDir, 'auth/login.md'), 'Merged')
    await writeFile(join(ctxDir, 'api/config.md'), 'Updated')

    dreamLogStore.getById.resolves(completedLog([
      {
        action: 'MERGE',
        inputFiles: ['auth/login.md', 'auth/signup.md'],
        needsReview: true,
        outputFile: 'auth/login.md',
        previousTexts: {'auth/login.md': 'Original login', 'auth/signup.md': 'Original signup'},
        reason: 'Merge',
        type: 'CONSOLIDATE',
      },
      {
        action: 'TEMPORAL_UPDATE',
        inputFiles: ['api/config.md'],
        needsReview: true,
        previousTexts: {'api/config.md': 'Original config'},
        reason: 'Update',
        type: 'CONSOLIDATE',
      },
    ]))

    const result = await undoLastDream(deps)

    expect(result.restoredFiles).to.have.lengthOf(3)

    const login = await readFile(join(ctxDir, 'auth/login.md'), 'utf8')
    expect(login).to.equal('Original login')
    const signup = await readFile(join(ctxDir, 'auth/signup.md'), 'utf8')
    expect(signup).to.equal('Original signup')
    const config = await readFile(join(ctxDir, 'api/config.md'), 'utf8')
    expect(config).to.equal('Original config')
  })

  it('continues on error and collects errors', async () => {
    await mkdir(join(ctxDir, 'api'), {recursive: true})
    await writeFile(join(ctxDir, 'api/config.md'), 'Updated')

    dreamLogStore.getById.resolves(completedLog([
      {
        action: 'MERGE',
        inputFiles: ['auth/a.md', 'auth/b.md'],
        needsReview: true,
        outputFile: 'auth/a.md',
        // No previousTexts — will cause error
        reason: 'Merge',
        type: 'CONSOLIDATE',
      },
      {
        action: 'TEMPORAL_UPDATE',
        inputFiles: ['api/config.md'],
        needsReview: true,
        previousTexts: {'api/config.md': 'Original'},
        reason: 'Update',
        type: 'CONSOLIDATE',
      },
    ]))

    const result = await undoLastDream(deps)

    expect(result.errors.length).to.be.greaterThan(0)
    expect(result.restoredFiles).to.include('api/config.md')
  })

  it('returns empty result for dream with no operations', async () => {
    const result = await undoLastDream(deps)

    expect(result.dreamId).to.equal('drm-1000')
    expect(result.restoredFiles).to.be.empty
    expect(result.deletedFiles).to.be.empty
    expect(result.restoredArchives).to.be.empty
    expect(result.errors).to.be.empty
  })

  // ── Review cleanup on undo ──────────────────────────────────────────────

  it('marks curate log operations as rejected when undo reverses needsReview ops', async () => {
    const curateLogStore = {
      batchUpdateOperationReviewStatus: stub().resolves(true),
      list: stub().resolves([
        {
          completedAt: Date.now(),
          id: 'cur-5000',
          input: {context: 'dream'},
          operations: [{
            filePath: join(ctxDir, 'auth/stale.md'),
            needsReview: true,
            path: 'auth/stale.md',
            reviewStatus: 'pending',
            status: 'success',
            type: 'DELETE',
          }],
          startedAt: Date.now(),
          status: 'completed',
          summary: {added: 0, deleted: 0, failed: 0, merged: 0, updated: 0},
          taskId: 'task-1',
        },
        {
          completedAt: Date.now(),
          id: 'cur-6000',
          input: {context: 'dream'},
          operations: [{
            filePath: join(ctxDir, 'auth/keep.md'),
            needsReview: true,
            path: 'auth/keep.md',
            reviewStatus: 'pending',
            status: 'success',
            type: 'DELETE',
          }],
          startedAt: Date.now(),
          status: 'completed',
          summary: {added: 0, deleted: 0, failed: 0, merged: 0, updated: 0},
          taskId: 'task-2',
        },
      ]),
    }

    const reviewBackupStore = {delete: stub().resolves()}

    const archiveService = {restoreEntry: stub().resolves('auth/stale.md')}

    dreamLogStore.getById.resolves(completedLog([{
      action: 'ARCHIVE',
      file: 'auth/stale.md',
      needsReview: true,
      reason: 'Stale',
      stubPath: '_archived/auth/stale.stub.md',
      type: 'PRUNE',
    }]))

    await undoLastDream({...deps, archiveService, curateLogStore, reviewBackupStore})

    expect(curateLogStore.list.calledOnce).to.be.true
    expect(curateLogStore.batchUpdateOperationReviewStatus.calledOnce).to.be.true
    const [logId, updates] = curateLogStore.batchUpdateOperationReviewStatus.firstCall.args
    expect(logId).to.equal('cur-5000')
    expect(updates).to.deep.equal([{operationIndex: 0, reviewStatus: 'rejected'}])
  })

  it('falls back to matching the exact dream review entry when legacy dream logs have no taskId', async () => {
    const curateLogStore = {
      batchUpdateOperationReviewStatus: stub().resolves(true),
      list: stub().resolves([
        {
          completedAt: Date.now(),
          id: 'cur-legacy',
          input: {context: 'dream'},
          operations: [{
            filePath: join(ctxDir, 'auth/login.md'),
            needsReview: true,
            path: 'auth/login.md',
            reviewStatus: 'pending',
            status: 'success',
            type: 'UPDATE',
          }],
          startedAt: Date.now(),
          status: 'completed',
          summary: {added: 0, deleted: 0, failed: 0, merged: 0, updated: 1},
          taskId: 'task-old',
        },
      ]),
    }
    const reviewBackupStore = {delete: stub().resolves()}

    const legacyLog = completedLog([{
      action: 'TEMPORAL_UPDATE',
      inputFiles: ['auth/login.md'],
      needsReview: true,
      previousTexts: {'auth/login.md': 'Original login'},
      reason: 'Normalize chronology',
      type: 'CONSOLIDATE',
    }])
    delete legacyLog.taskId
    dreamLogStore.getById.resolves(legacyLog)

    await undoLastDream({...deps, curateLogStore, reviewBackupStore})

    expect(curateLogStore.batchUpdateOperationReviewStatus.calledOnce).to.be.true
    const [logId, updates] = curateLogStore.batchUpdateOperationReviewStatus.firstCall.args
    expect(logId).to.equal('cur-legacy')
    expect(updates).to.deep.equal([{operationIndex: 0, reviewStatus: 'rejected'}])
  })

  it('deletes review backups for undone needsReview operations', async () => {
    const curateLogStore = {
      batchUpdateOperationReviewStatus: stub().resolves(true),
      list: stub().resolves([]),
    }

    const reviewBackupStore = {delete: stub().resolves()}

    await mkdir(join(ctxDir, 'auth'), {recursive: true})
    await writeFile(join(ctxDir, 'auth/login.md'), 'Merged')

    dreamLogStore.getById.resolves(completedLog([{
      action: 'MERGE',
      inputFiles: ['auth/login.md', 'auth/signup.md'],
      needsReview: true,
      outputFile: 'auth/login.md',
      previousTexts: {'auth/login.md': 'Original login', 'auth/signup.md': 'Original signup'},
      reason: 'Merge',
      type: 'CONSOLIDATE',
    }]))

    await undoLastDream({...deps, curateLogStore, reviewBackupStore})

    // Should delete backups for all files involved in needsReview ops
    expect(reviewBackupStore.delete.called).to.be.true
    const deletedPaths = reviewBackupStore.delete.getCalls().map((c: {args: string[]}) => c.args[0])
    expect(deletedPaths).to.include('auth/login.md')
    expect(deletedPaths).to.include('auth/signup.md')
  })

  it('skips review cleanup when curateLogStore is not provided', async () => {
    dreamLogStore.getById.resolves(completedLog([{
      action: 'ARCHIVE',
      file: 'auth/stale.md',
      needsReview: true,
      reason: 'Stale',
      stubPath: '_archived/auth/stale.stub.md',
      type: 'PRUNE',
    }]))

    const archiveService = {restoreEntry: stub().resolves('auth/stale.md')}

    // No curateLogStore or reviewBackupStore — should not crash
    const result = await undoLastDream({...deps, archiveService})
    expect(result.restoredArchives).to.include('auth/stale.md')
  })
})
