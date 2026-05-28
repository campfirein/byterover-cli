import {expect} from 'chai'
import {createHash} from 'node:crypto'
import {access, mkdir, readFile, rm, unlink, writeFile} from 'node:fs/promises'
import {tmpdir} from 'node:os'
import {join} from 'node:path'

import {
  BRV_DIR,
  CONTEXT_TREE_BACKUP_DIR,
  CONTEXT_TREE_CONFLICT_DIR,
  CONTEXT_TREE_DIR,
} from '../../../../src/server/constants.js'
import {CogitSnapshotFile} from '../../../../src/server/core/domain/entities/cogit-snapshot-file.js'
import {FileContextTreeMerger} from '../../../../src/server/infra/context-tree/file-context-tree-merger.js'
import {FileContextTreeSnapshotService} from '../../../../src/server/infra/context-tree/file-context-tree-snapshot-service.js'

// Helper: encode content to base64 for CogitSnapshotFile
function toBase64(content: string): string {
  return Buffer.from(content, 'utf8').toString('base64')
}

// Helper: build a CogitSnapshotFile
function makeFile(path: string, content: string): CogitSnapshotFile {
  return new CogitSnapshotFile({
    content: toBase64(content),
    mode: '100644',
    path,
    sha: 'deadbeef',
    size: Buffer.byteLength(content, 'utf8'),
  })
}

// Helper: compute SHA-256 of a string (matches FileContextTreeSnapshotService)
function sha256(content: string): string {
  return createHash('sha256').update(content).digest('hex')
}

describe('FileContextTreeMerger', () => {
  let testDir: string
  let contextTreeDir: string
  let snapshotService: FileContextTreeSnapshotService
  let merger: FileContextTreeMerger

  beforeEach(async () => {
    testDir = join(tmpdir(), `brv-merger-test-${Date.now()}`)
    contextTreeDir = join(testDir, BRV_DIR, CONTEXT_TREE_DIR)
    await mkdir(contextTreeDir, {recursive: true})

    snapshotService = new FileContextTreeSnapshotService({baseDirectory: testDir})
    merger = new FileContextTreeMerger({snapshotService})
  })

  afterEach(async () => {
    await rm(testDir, {force: true, recursive: true})
  })

  describe('merge — remote file added (no local file)', () => {
    it('should write the remote file to context tree', async () => {
      await snapshotService.initEmptySnapshot()

      const result = await merger.merge({
        directory: testDir,
        files: [makeFile('topic/concept.md', '# Concept\nContent here')],
        localChanges: {added: [], deleted: [], modified: []},
      })

      const written = await readFile(join(contextTreeDir, 'topic/concept.md'), 'utf8')
      expect(written).to.equal('# Concept\nContent here')
      expect(result.added).to.deep.equal(['topic/concept.md'])
      expect(result.edited).to.be.empty
      expect(result.deleted).to.be.empty
      expect(result.conflicted).to.be.empty
    })

    it('should save remote file hash and size to snapshot', async () => {
      await snapshotService.initEmptySnapshot()
      const content = '# Concept\nContent here'

      await merger.merge({
        directory: testDir,
        files: [makeFile('topic/concept.md', content)],
        localChanges: {added: [], deleted: [], modified: []},
      })

      const savedState = await snapshotService.getSnapshotState(testDir)
      const state = savedState.get('topic/concept.md')
      expect(state).to.exist
      expect(state!.hash).to.equal(sha256(content))
      expect(state!.size).to.equal(Buffer.byteLength(content, 'utf8'))
    })
  })

  describe('merge — remote file overwrites clean local file', () => {
    it('should overwrite clean local file when remote has newer content', async () => {
      // Write a clean local file and snapshot it
      await writeFile(join(contextTreeDir, 'topic.md'), '# Old content')
      await snapshotService.saveSnapshot()

      const result = await merger.merge({
        directory: testDir,
        files: [makeFile('topic.md', '# New remote content')],
        localChanges: {added: [], deleted: [], modified: []},
      })

      const written = await readFile(join(contextTreeDir, 'topic.md'), 'utf8')
      expect(written).to.equal('# New remote content')
      expect(result.edited).to.deep.equal(['topic.md'])
      expect(result.conflicted).to.be.empty
    })

    it('should skip when remote content matches snapshot (remote unchanged)', async () => {
      const content = '# Same content'
      await writeFile(join(contextTreeDir, 'topic.md'), content)
      await snapshotService.saveSnapshot()

      const result = await merger.merge({
        directory: testDir,
        files: [makeFile('topic.md', content)],
        localChanges: {added: [], deleted: [], modified: []},
      })

      expect(result.edited).to.be.empty
      expect(result.added).to.be.empty
      expect(result.conflicted).to.be.empty
    })
  })

  describe('merge — local wins when remote has not changed', () => {
    it('should keep locally modified file when remote content matches snapshot', async () => {
      // User modified docs.md but remote still has the original version
      await writeFile(join(contextTreeDir, 'docs.md'), '# Original content')
      await snapshotService.saveSnapshot()
      await writeFile(join(contextTreeDir, 'docs.md'), '# My modified content')

      const result = await merger.merge({
        directory: testDir,
        files: [makeFile('docs.md', '# Original content')], // remote = snapshot
        localChanges: {added: [], deleted: [], modified: ['docs.md']},
      })

      // Local modification must be preserved — no rename, no overwrite
      const onDisk = await readFile(join(contextTreeDir, 'docs.md'), 'utf8')
      expect(onDisk).to.equal('# My modified content')
      expect(result.edited).to.be.empty
      expect(result.conflicted).to.be.empty
    })

    it('should keep locally deleted file absent when remote content matches snapshot', async () => {
      const content = '# Soon to be gone'
      await writeFile(join(contextTreeDir, 'deleted.md'), content)
      await snapshotService.saveSnapshot()
      await unlink(join(contextTreeDir, 'deleted.md'))

      const result = await merger.merge({
        directory: testDir,
        files: [makeFile('deleted.md', content)], // remote = snapshot (no change)
        localChanges: {added: [], deleted: ['deleted.md'], modified: []},
      })

      // Local deletion wins — file must stay absent
      try {
        await access(join(contextTreeDir, 'deleted.md'))
        expect.fail('File should not exist')
      } catch {
        // expected
      }

      // File is in the saved snapshot (remote has it) so next getChanges() reports it as deleted
      const savedState = await snapshotService.getSnapshotState(testDir)
      expect(savedState.has('deleted.md')).to.be.true
      expect(result.added).to.not.include('deleted.md')
      expect(result.conflicted).to.be.empty
    })
  })

  describe('merge — conflict: locally added file at same remote path', () => {
    it('should copy original to conflict dir, rename local to _1.md, write remote to original path', async () => {
      // Snapshot is empty but user added a file (not in snapshot = "added")
      await snapshotService.initEmptySnapshot()
      await writeFile(join(contextTreeDir, 'topic.md'), '# My local content')

      const result = await merger.merge({
        directory: testDir,
        files: [makeFile('topic.md', '# Remote content')],
        localChanges: {added: ['topic.md'], deleted: [], modified: []},
      })

      // Original path has remote content
      const original = await readFile(join(contextTreeDir, 'topic.md'), 'utf8')
      expect(original).to.equal('# Remote content')

      // Preserved local file is at the _1.md path
      const preserved = await readFile(join(contextTreeDir, 'topic_1.md'), 'utf8')
      expect(preserved).to.equal('# My local content')

      // topic_1.md (preserved local) is counted as added
      expect(result.added).to.include('topic_1.md')
      expect(result.edited).to.not.include('topic.md')

      // topic.md is reported as conflicted
      expect(result.conflicted).to.deep.equal(['topic.md'])

      // Conflict dir contains the original local content at the original path
      const expectedConflictDir = join(testDir, BRV_DIR, CONTEXT_TREE_CONFLICT_DIR)
      const conflictCopy = await readFile(join(expectedConflictDir, 'topic.md'), 'utf8')
      expect(conflictCopy).to.equal('# My local content')
    })
  })

  describe('merge — conflict: locally modified file at same remote path', () => {
    it('should copy original to conflict dir, rename local to _1.md, write remote to original path', async () => {
      // Write original content, snapshot it, then modify locally and have remote also update
      await writeFile(join(contextTreeDir, 'docs.md'), '# Original content')
      await snapshotService.saveSnapshot()
      await writeFile(join(contextTreeDir, 'docs.md'), '# My modified content')

      const result = await merger.merge({
        directory: testDir,
        files: [makeFile('docs.md', '# Remote updated content')], // remote changed too
        localChanges: {added: [], deleted: [], modified: ['docs.md']},
      })

      const original = await readFile(join(contextTreeDir, 'docs.md'), 'utf8')
      expect(original).to.equal('# Remote updated content')

      const preserved = await readFile(join(contextTreeDir, 'docs_1.md'), 'utf8')
      expect(preserved).to.equal('# My modified content')

      // docs_1.md (preserved local) is counted as added
      expect(result.added).to.include('docs_1.md')
      expect(result.edited).to.not.include('docs.md')

      // docs.md is reported as conflicted
      expect(result.conflicted).to.deep.equal(['docs.md'])

      // Conflict dir contains the pre-conflict local version
      const expectedConflictDir = join(testDir, BRV_DIR, CONTEXT_TREE_CONFLICT_DIR)
      const conflictCopy = await readFile(join(expectedConflictDir, 'docs.md'), 'utf8')
      expect(conflictCopy).to.equal('# My modified content')
    })
  })

  describe('merge — conflict with converged content (both sides made the same change)', () => {
    it('should treat as edited (not conflict) when local and remote content are identical', async () => {
      await snapshotService.initEmptySnapshot()
      const sameContent = '# Same content on both sides'
      await writeFile(join(contextTreeDir, 'topic.md'), sameContent)

      const result = await merger.merge({
        directory: testDir,
        files: [makeFile('topic.md', sameContent)],
        localChanges: {added: ['topic.md'], deleted: [], modified: []},
      })

      // Original path still has the shared content
      const written = await readFile(join(contextTreeDir, 'topic.md'), 'utf8')
      expect(written).to.equal(sameContent)

      // No conflict — no _1.md file, no conflicted entry
      expect(result.conflicted).to.be.empty
      expect(result.edited).to.include('topic.md')
      expect(result.added).to.not.include('topic_1.md')

      // Conflict dir should not exist
      const conflictDirPath = join(testDir, BRV_DIR, CONTEXT_TREE_CONFLICT_DIR)
      try {
        await access(conflictDirPath)
        expect.fail('Conflict dir should not exist when content converged')
      } catch (error) {
        if (!(error instanceof Error && 'code' in error && error.code === 'ENOENT')) throw error
      }
    })

    it('should treat as edited (not conflict) when locally modified file converges with remote', async () => {
      const originalContent = '# Original'
      const convergentContent = '# Same update by both sides'

      await writeFile(join(contextTreeDir, 'docs.md'), originalContent)
      await snapshotService.saveSnapshot()
      await writeFile(join(contextTreeDir, 'docs.md'), convergentContent)

      const result = await merger.merge({
        directory: testDir,
        files: [makeFile('docs.md', convergentContent)],
        localChanges: {added: [], deleted: [], modified: ['docs.md']},
      })

      const written = await readFile(join(contextTreeDir, 'docs.md'), 'utf8')
      expect(written).to.equal(convergentContent)

      expect(result.conflicted).to.be.empty
      expect(result.edited).to.include('docs.md')
    })
  })

  describe('merge — locally deleted file with remote having newer version', () => {
    it('should restore file from remote when remote has newer content than snapshot', async () => {
      // File was tracked in snapshot but now deleted locally
      await writeFile(join(contextTreeDir, 'deleted.md'), '# Original content')
      await snapshotService.saveSnapshot()
      await unlink(join(contextTreeDir, 'deleted.md'))

      // Remote has a NEWER version (different from snapshot)
      const result = await merger.merge({
        directory: testDir,
        files: [makeFile('deleted.md', '# Newer remote version')],
        localChanges: {added: [], deleted: ['deleted.md'], modified: []},
      })

      // File should be restored from remote
      const restored = await readFile(join(contextTreeDir, 'deleted.md'), 'utf8')
      expect(restored).to.equal('# Newer remote version')
      expect(result.added).to.include('deleted.md')
      expect(result.conflicted).to.be.empty
      // User's deletion was overridden — restoredFromRemote must notify the caller
      expect(result.restoredFromRemote).to.deep.equal(['deleted.md'])
    })

    it('should report restoredFromRemote only for user-deleted files, not for brand-new remote files', async () => {
      // 'existing.md' was in snapshot but user deleted it; remote has a newer version
      await writeFile(join(contextTreeDir, 'existing.md'), '# Old content')
      await snapshotService.saveSnapshot()
      await unlink(join(contextTreeDir, 'existing.md'))

      // 'brand-new.md' was NEVER in snapshot — it is genuinely new from remote
      const result = await merger.merge({
        directory: testDir,
        files: [
          makeFile('existing.md', '# Updated by remote'),
          makeFile('brand-new.md', '# New from remote'),
        ],
        localChanges: {added: [], deleted: ['existing.md'], modified: []},
      })

      // Both files are added to disk
      expect(result.added).to.include('existing.md')
      expect(result.added).to.include('brand-new.md')

      // Only the previously-tracked-then-deleted file is in restoredFromRemote
      expect(result.restoredFromRemote).to.deep.equal(['existing.md'])
      expect(result.restoredFromRemote).to.not.include('brand-new.md')
    })
  })

  describe('merge — suffix collision', () => {
    it('should use _2.md when _1.md already exists', async () => {
      await snapshotService.initEmptySnapshot()
      // Both topic.md and topic_1.md exist as "added" local files
      await writeFile(join(contextTreeDir, 'topic.md'), '# Local topic')
      await writeFile(join(contextTreeDir, 'topic_1.md'), '# Already taken suffix')

      const result = await merger.merge({
        directory: testDir,
        files: [makeFile('topic.md', '# Remote topic')],
        localChanges: {added: ['topic.md'], deleted: [], modified: []},
      })

      const preserved = await readFile(join(contextTreeDir, 'topic_2.md'), 'utf8')
      expect(preserved).to.equal('# Local topic')
      expect(result.added).to.include('topic_2.md')
      expect(result.conflicted).to.deep.equal(['topic.md'])
    })
  })

  describe('merge — clean local file not in remote (remote deleted it)', () => {
    it('should delete clean local files that remote does not have', async () => {
      // Create and snapshot two files
      await writeFile(join(contextTreeDir, 'keep.md'), '# Keep this')
      await writeFile(join(contextTreeDir, 'remove.md'), '# Remote deleted this')
      await snapshotService.saveSnapshot()

      // Remote only has 'keep.md' with same content — 'remove.md' was deleted from remote
      const result = await merger.merge({
        directory: testDir,
        files: [makeFile('keep.md', '# Keep this')],
        localChanges: {added: [], deleted: [], modified: []},
      })

      // remove.md should be gone
      try {
        await access(join(contextTreeDir, 'remove.md'))
        expect.fail('File should have been deleted')
      } catch {
        // expected
      }

      expect(result.deleted).to.include('remove.md')
      expect(result.conflicted).to.be.empty
    })

    it('should NOT delete locally added files even if not in remote', async () => {
      // User added 'local-only.md' (not in snapshot = "added")
      await snapshotService.initEmptySnapshot()
      await writeFile(join(contextTreeDir, 'local-only.md'), '# My local work')

      // Remote has nothing
      const result = await merger.merge({
        directory: testDir,
        files: [],
        localChanges: {added: ['local-only.md'], deleted: [], modified: []},
      })

      // local-only.md should still exist
      const content = await readFile(join(contextTreeDir, 'local-only.md'), 'utf8')
      expect(content).to.equal('# My local work')
      expect(result.deleted).to.not.include('local-only.md')
      expect(result.conflicted).to.be.empty
    })

    it('should NOT delete locally modified files even if not in remote (remote deleted them)', async () => {
      // File was in snapshot, user modified it, but remote deleted it
      await writeFile(join(contextTreeDir, 'notes.md'), '# Original')
      await snapshotService.saveSnapshot()
      await writeFile(join(contextTreeDir, 'notes.md'), '# My modifications')

      // Remote has nothing (it deleted the file)
      const result = await merger.merge({
        directory: testDir,
        files: [],
        localChanges: {added: [], deleted: [], modified: ['notes.md']},
      })

      // Local modification wins — file stays
      const content = await readFile(join(contextTreeDir, 'notes.md'), 'utf8')
      expect(content).to.equal('# My modifications')
      expect(result.deleted).to.not.include('notes.md')
      expect(result.conflicted).to.be.empty
    })
  })

  describe('merge — preserveLocalFiles: true (first-time space connect)', () => {
    it('should preserve clean tracked local files that are not in remote', async () => {
      // User curated two files and they are in the snapshot (clean, no changes since last curate)
      await writeFile(join(contextTreeDir, 'project-overview.md'), '# Project overview')
      await writeFile(join(contextTreeDir, 'api-design.md'), '# API design')
      await snapshotService.saveSnapshot()

      // Remote (new space, never seen these files) only has onboarding.md
      const result = await merger.merge({
        directory: testDir,
        files: [makeFile('onboarding.md', '# Welcome to the space')],
        localChanges: {added: [], deleted: [], modified: []},
        preserveLocalFiles: true,
      })

      // Both clean local files must survive
      const overview = await readFile(join(contextTreeDir, 'project-overview.md'), 'utf8')
      expect(overview).to.equal('# Project overview')
      const api = await readFile(join(contextTreeDir, 'api-design.md'), 'utf8')
      expect(api).to.equal('# API design')

      // Remote file was added
      expect(result.added).to.include('onboarding.md')
      // No clean local files were deleted
      expect(result.deleted).to.be.empty
      expect(result.conflicted).to.be.empty
    })

    it('should preserve clean local files AND locally added files when preserveLocalFiles is true', async () => {
      // Clean tracked file
      await writeFile(join(contextTreeDir, 'tracked.md'), '# Tracked clean file')
      await snapshotService.saveSnapshot()
      // New local addition (not yet in snapshot)
      await writeFile(join(contextTreeDir, 'new-idea.md'), '# My new idea')

      // Remote has a completely different file
      const result = await merger.merge({
        directory: testDir,
        files: [makeFile('remote-topic.md', '# From remote')],
        localChanges: {added: ['new-idea.md'], deleted: [], modified: []},
        preserveLocalFiles: true,
      })

      // tracked.md (clean, in snapshot) must survive
      const trackedContent = await readFile(join(contextTreeDir, 'tracked.md'), 'utf8')
      expect(trackedContent).to.equal('# Tracked clean file')
      // new-idea.md (locally added) must survive
      const newContent = await readFile(join(contextTreeDir, 'new-idea.md'), 'utf8')
      expect(newContent).to.equal('# My new idea')
      // remote-topic.md was added
      expect(result.added).to.include('remote-topic.md')
      expect(result.deleted).to.be.empty
    })

    it('should treat tracked+clean local file as conflict when remote has different content (local wins maximum)', async () => {
      // User has a tracked+clean file at the same path as a remote file but with different content.
      // First-time connect has no shared history, so both files are independently authored.
      // Local must NOT be silently overwritten — save local as _N.md, write remote to original path.
      await mkdir(join(contextTreeDir, 'arch'), {recursive: true})
      await writeFile(join(contextTreeDir, 'arch/design.md'), '# My local design')
      await snapshotService.saveSnapshot()
      // File is clean (no modifications since snapshot)

      const result = await merger.merge({
        directory: testDir,
        files: [makeFile('arch/design.md', '# Team design from space')],
        localChanges: {added: [], deleted: [], modified: []},
        preserveLocalFiles: true,
      })

      // Remote content is at the original path
      const original = await readFile(join(contextTreeDir, 'arch/design.md'), 'utf8')
      expect(original).to.equal('# Team design from space')

      // Local content preserved at _N.md
      const preserved = await readFile(join(contextTreeDir, 'arch/design_1.md'), 'utf8')
      expect(preserved).to.equal('# My local design')

      expect(result.conflicted).to.deep.equal(['arch/design.md'])
      expect(result.added).to.include('arch/design_1.md')
      expect(result.edited).to.not.include('arch/design.md')

      // Conflict dir contains the original local content
      const conflictCopy = await readFile(join(testDir, BRV_DIR, CONTEXT_TREE_CONFLICT_DIR, 'arch/design.md'), 'utf8')
      expect(conflictCopy).to.equal('# My local design')
    })

    it('should skip file entirely when remote content matches snapshot (no conflict, not reported as edited)', async () => {
      // When remote content = snapshot content, remote has not changed the file.
      // The early-exit `continue` fires before we reach the preserveLocalFiles branch,
      // so neither conflict nor edit is reported — file is silently left as-is.
      const content = '# Same on all sides'
      await writeFile(join(contextTreeDir, 'topic.md'), content)
      await snapshotService.saveSnapshot()

      const result = await merger.merge({
        directory: testDir,
        files: [makeFile('topic.md', content)],
        localChanges: {added: [], deleted: [], modified: []},
        preserveLocalFiles: true,
      })

      // File stays at original path with same content — nothing to report
      const onDisk = await readFile(join(contextTreeDir, 'topic.md'), 'utf8')
      expect(onDisk).to.equal(content)
      expect(result.conflicted).to.be.empty
      expect(result.edited).to.be.empty
      expect(result.added).to.be.empty
    })

    it('should still delete clean local files when preserveLocalFiles is false (regular pull)', async () => {
      await writeFile(join(contextTreeDir, 'keep.md'), '# Keep this')
      await writeFile(join(contextTreeDir, 'remote-deleted.md'), '# Remote deleted this')
      await snapshotService.saveSnapshot()

      // Same space regular pull — remote deleted 'remote-deleted.md'
      const result = await merger.merge({
        directory: testDir,
        files: [makeFile('keep.md', '# Keep this')],
        localChanges: {added: [], deleted: [], modified: []},
        preserveLocalFiles: false,
      })

      try {
        await access(join(contextTreeDir, 'remote-deleted.md'))
        expect.fail('File should have been deleted')
      } catch {
        // expected
      }

      expect(result.deleted).to.include('remote-deleted.md')
    })
  })

  describe('merge — locally deleted file not in remote', () => {
    it('should leave file absent when local deleted and remote also does not have it', async () => {
      // File was in snapshot but deleted locally; remote also dropped it
      await writeFile(join(contextTreeDir, 'gone.md'), '# Removed by both')
      await snapshotService.saveSnapshot()
      await unlink(join(contextTreeDir, 'gone.md'))

      // No error, no restore
      const result = await merger.merge({
        directory: testDir,
        files: [], // remote does not have it either
        localChanges: {added: [], deleted: ['gone.md'], modified: []},
      })

      try {
        await access(join(contextTreeDir, 'gone.md'))
        expect.fail('File should remain absent')
      } catch {
        // expected
      }

      expect(result.added).to.not.include('gone.md')
      expect(result.edited).to.not.include('gone.md')
      expect(result.deleted).to.not.include('gone.md') // deletion loop only iterates localState (disk), file is not there
      expect(result.conflicted).to.be.empty
    })
  })

  describe('merge — subdirectory paths', () => {
    it('should copy original to conflict dir preserving directory structure', async () => {
      await snapshotService.initEmptySnapshot()
      await mkdir(join(contextTreeDir, 'arch/api'), {recursive: true})
      await writeFile(join(contextTreeDir, 'arch/api/design.md'), '# Local design')

      const result = await merger.merge({
        directory: testDir,
        files: [makeFile('arch/api/design.md', '# Remote design')],
        localChanges: {added: ['arch/api/design.md'], deleted: [], modified: []},
      })

      const original = await readFile(join(contextTreeDir, 'arch/api/design.md'), 'utf8')
      expect(original).to.equal('# Remote design')

      const preserved = await readFile(join(contextTreeDir, 'arch/api/design_1.md'), 'utf8')
      expect(preserved).to.equal('# Local design')

      expect(result.added).to.include('arch/api/design_1.md')
      expect(result.conflicted).to.deep.equal(['arch/api/design.md'])

      // Conflict dir mirrors the subdirectory structure
      const conflictCopy = await readFile(
        join(testDir, BRV_DIR, CONTEXT_TREE_CONFLICT_DIR, 'arch/api/design.md'),
        'utf8',
      )
      expect(conflictCopy).to.equal('# Local design')
    })
  })

  describe('merge — backup and conflict folder behavior', () => {
    it('should delete backup and not create conflict dir when there are no conflicts', async () => {
      await snapshotService.initEmptySnapshot()
      await writeFile(join(contextTreeDir, 'existing.md'), '# Local content')

      const result = await merger.merge({
        directory: testDir,
        files: [makeFile('file.md', '# Remote')],
        localChanges: {added: [], deleted: [], modified: []},
      })

      expect(result.conflicted).to.be.empty

      // Backup must be deleted after a conflict-free merge
      const backupDir = join(testDir, BRV_DIR, CONTEXT_TREE_BACKUP_DIR)
      try {
        await access(backupDir)
        expect.fail('Backup should have been deleted after a conflict-free merge')
      } catch {
        // expected — backup was deleted
      }

      // Conflict dir must not exist
      const conflictDir = join(testDir, BRV_DIR, CONTEXT_TREE_CONFLICT_DIR)
      try {
        await access(conflictDir)
        expect.fail('Conflict dir should not exist when there are no conflicts')
      } catch {
        // expected
      }
    })

    it('should create conflict dir with only conflicted originals and delete backup on success', async () => {
      await snapshotService.initEmptySnapshot()
      await writeFile(join(contextTreeDir, 'conflict.md'), '# My local content')
      await writeFile(join(contextTreeDir, 'clean.md'), '# Clean content')

      const result = await merger.merge({
        directory: testDir,
        files: [
          makeFile('conflict.md', '# Remote content'),
          makeFile('clean.md', '# Clean content'), // not in localChanges → not in locallyChangedPaths → remote overwrites silently
        ],
        localChanges: {added: ['conflict.md'], deleted: [], modified: []},
      })

      const expectedConflictDir = join(testDir, BRV_DIR, CONTEXT_TREE_CONFLICT_DIR)
      expect(result.conflicted).to.deep.equal(['conflict.md'])

      // Conflict dir contains ONLY the conflicted file's original
      const conflictCopy = await readFile(join(expectedConflictDir, 'conflict.md'), 'utf8')
      expect(conflictCopy).to.equal('# My local content')

      // Clean file is NOT in conflict dir
      try {
        await access(join(expectedConflictDir, 'clean.md'))
        expect.fail('Non-conflicted file should not be in conflict dir')
      } catch {
        // expected
      }

      // Backup must be deleted after successful merge
      const backupDir = join(testDir, BRV_DIR, CONTEXT_TREE_BACKUP_DIR)
      try {
        await access(backupDir)
        expect.fail('Backup should have been deleted after successful merge')
      } catch {
        // expected
      }
    })

    it('should clear old conflict dir at start of next merge', async () => {
      // First merge — produces a conflict dir
      await snapshotService.initEmptySnapshot()
      await writeFile(join(contextTreeDir, 'topic.md'), '# My local content')

      await merger.merge({
        directory: testDir,
        files: [makeFile('topic.md', '# Remote content')],
        localChanges: {added: ['topic.md'], deleted: [], modified: []},
      })

      const conflictDir = join(testDir, BRV_DIR, CONTEXT_TREE_CONFLICT_DIR)
      await access(conflictDir) // confirm it exists after first merge

      // Second merge (no new conflicts) — conflict dir from first merge should be cleared
      await snapshotService.saveSnapshot()

      await merger.merge({
        directory: testDir,
        files: [makeFile('topic.md', '# Remote content')],
        localChanges: {added: [], deleted: [], modified: []},
      })

      try {
        await access(conflictDir)
        expect.fail('Old conflict dir should have been cleared at start of next merge')
      } catch {
        // expected — cleared
      }
    })

    it('should auto-restore context tree from backup when merge fails', async () => {
      await snapshotService.initEmptySnapshot()
      await writeFile(join(contextTreeDir, 'existing.md'), '# Local content')

      // Claim 'missing.md' is locally added, but it doesn't exist on disk.
      // runMerge() will throw ENOENT when trying to read it for conflict handling —
      // AFTER the backup has already been created.
      let thrownError: Error | undefined
      try {
        await merger.merge({
          directory: testDir,
          files: [makeFile('missing.md', '# Remote')],
          localChanges: {added: ['missing.md'], deleted: [], modified: []},
        })
        expect.fail('Should have thrown')
      } catch (error) {
        thrownError = error as Error
      }

      expect(thrownError!.message).to.include('restored to its original state')

      // Context tree should be restored to pre-merge state
      const restoredContent = await readFile(join(contextTreeDir, 'existing.md'), 'utf8')
      expect(restoredContent).to.equal('# Local content')

      // Backup must be gone (was used to restore, then deleted)
      const backupDir = join(testDir, BRV_DIR, CONTEXT_TREE_BACKUP_DIR)
      try {
        await access(backupDir)
        expect.fail('Backup should have been consumed during restore')
      } catch {
        // expected
      }

      // Conflict dir must not exist (cleaned up on failure)
      const conflictDir = join(testDir, BRV_DIR, CONTEXT_TREE_CONFLICT_DIR)
      try {
        await access(conflictDir)
        expect.fail('Conflict dir should have been cleaned up on failure')
      } catch {
        // expected
      }
    })
  })

  describe('merge — snapshot atomicity', () => {
    it('should save snapshot from remote states so preserved _N.md files appear as added on next getChanges()', async () => {
      // Set up: snapshot is empty, user has a local file
      await snapshotService.initEmptySnapshot()
      await writeFile(join(contextTreeDir, 'topic.md'), '# My local content')

      // Merge: remote also has topic.md → conflict → local saved as topic_1.md
      await merger.merge({
        directory: testDir,
        files: [makeFile('topic.md', '# Remote content')],
        localChanges: {added: ['topic.md'], deleted: [], modified: []},
      })

      // After merge the snapshot should only contain remote files (topic.md, not topic_1.md).
      // topic_1.md is on disk but absent from snapshot → getChanges() reports it as "added".
      const changes = await snapshotService.getChanges(testDir)
      expect(changes.added).to.include('topic_1.md')
      expect(changes.added).to.not.include('topic.md')
      expect(changes.modified).to.be.empty
    })
  })

  describe('merge — snapshot contains only remote files', () => {
    it('should save only remote files to snapshot (not locally preserved renames)', async () => {
      await snapshotService.initEmptySnapshot()
      await writeFile(join(contextTreeDir, 'conflict.md'), '# Local')

      const result = await merger.merge({
        directory: testDir,
        files: [makeFile('conflict.md', '# Remote conflict'), makeFile('new-file.md', '# Remote new')],
        localChanges: {added: ['conflict.md'], deleted: [], modified: []},
      })

      // Snapshot contains the 2 remote file paths
      const savedState = await snapshotService.getSnapshotState(testDir)
      expect(savedState.size).to.equal(2)
      expect(savedState.has('conflict.md')).to.be.true
      expect(savedState.has('new-file.md')).to.be.true

      // conflict_1.md (preserved local) is in added, NOT in snapshot
      expect(result.added).to.include('conflict_1.md')
      expect(savedState.has('conflict_1.md')).to.be.false

      expect(result.conflicted).to.deep.equal(['conflict.md'])
    })
  })

  // ─────────────────────────────────────────────────────────────────────────
  // User scenario: /space switch when the user has curated multiple local files
  // before connecting to any space, and all of them conflict with the new space.
  // ─────────────────────────────────────────────────────────────────────────
  describe('merge — /space switch: multiple locally-curated files conflict with remote', () => {
    it('should preserve every local copy as _1.md and write remote content to original paths', async () => {
      // User ran `brv curate` adding 3 files locally (no prior space → empty snapshot).
      // They then do /space switch to a space that already has those exact paths with
      // different content → 3-way conflict on all 3 files simultaneously.
      await snapshotService.initEmptySnapshot()
      await writeFile(join(contextTreeDir, 'auth.md'), '# My auth notes')
      await writeFile(join(contextTreeDir, 'api.md'), '# My API notes')
      await writeFile(join(contextTreeDir, 'schema.md'), '# My schema notes')

      const result = await merger.merge({
        directory: testDir,
        files: [
          makeFile('auth.md', '# Team auth context'),
          makeFile('api.md', '# Team API context'),
          makeFile('schema.md', '# Team schema context'),
        ],
        localChanges: {added: ['auth.md', 'api.md', 'schema.md'], deleted: [], modified: []},
      })

      // Remote (team) content is at the original paths after merge
      expect(await readFile(join(contextTreeDir, 'auth.md'), 'utf8')).to.equal('# Team auth context')
      expect(await readFile(join(contextTreeDir, 'api.md'), 'utf8')).to.equal('# Team API context')
      expect(await readFile(join(contextTreeDir, 'schema.md'), 'utf8')).to.equal('# Team schema context')

      // User's original content is saved at _1.md paths for review
      expect(await readFile(join(contextTreeDir, 'auth_1.md'), 'utf8')).to.equal('# My auth notes')
      expect(await readFile(join(contextTreeDir, 'api_1.md'), 'utf8')).to.equal('# My API notes')
      expect(await readFile(join(contextTreeDir, 'schema_1.md'), 'utf8')).to.equal('# My schema notes')

      // All 3 paths reported as conflicted; _1.md copies reported as added
      expect(result.conflicted).to.have.members(['auth.md', 'api.md', 'schema.md'])
      expect(result.added).to.have.members(['auth_1.md', 'api_1.md', 'schema_1.md'])

      // .brv/context-tree-conflicts/ holds the pre-merge local content for manual review
      const conflictDir = join(testDir, BRV_DIR, CONTEXT_TREE_CONFLICT_DIR)
      expect(await readFile(join(conflictDir, 'auth.md'), 'utf8')).to.equal('# My auth notes')
      expect(await readFile(join(conflictDir, 'api.md'), 'utf8')).to.equal('# My API notes')
      expect(await readFile(join(conflictDir, 'schema.md'), 'utf8')).to.equal('# My schema notes')
    })
  })

  // ─────────────────────────────────────────────────────────────────────────
  // User scenario: brv init → /space switch immediately (no local curation yet)
  // ─────────────────────────────────────────────────────────────────────────
  describe('merge — /space switch on a brand-new empty context tree', () => {
    it('should write all remote files to disk when there is nothing local', async () => {
      // User just ran `brv init` — context tree is empty, snapshot is empty.
      // /space switch should pull everything from the new space.
      await snapshotService.initEmptySnapshot()

      const result = await merger.merge({
        directory: testDir,
        files: [
          makeFile('design/overview.md', '# Design overview'),
          makeFile('backend/api.md', '# Backend API'),
          makeFile('frontend/components.md', '# Frontend components'),
        ],
        localChanges: {added: [], deleted: [], modified: []},
      })

      expect(result.added).to.have.members(['design/overview.md', 'backend/api.md', 'frontend/components.md'])
      expect(result.edited).to.be.empty
      expect(result.deleted).to.be.empty
      expect(result.conflicted).to.be.empty

      expect(await readFile(join(contextTreeDir, 'design/overview.md'), 'utf8')).to.equal('# Design overview')
      expect(await readFile(join(contextTreeDir, 'backend/api.md'), 'utf8')).to.equal('# Backend API')
      expect(await readFile(join(contextTreeDir, 'frontend/components.md'), 'utf8')).to.equal('# Frontend components')
    })
  })

  // ─────────────────────────────────────────────────────────────────────────
  // User scenario: /space switch → /space switch again to the same space
  // ─────────────────────────────────────────────────────────────────────────
  describe('merge — second /space switch to the same space produces 0 changes', () => {
    it('should change nothing on the second switch because snapshot already matches remote', async () => {
      // First switch: remote has updated topic.md and added new.md.
      // After the merge completes, the snapshot is saved to reflect the remote state.
      // Second switch to the same space: snapshot now matches remote → nothing to do.
      await writeFile(join(contextTreeDir, 'topic.md'), '# Old local content')
      await snapshotService.saveSnapshot()

      const remoteFiles = [makeFile('topic.md', '# Team content'), makeFile('new.md', '# New topic')]

      // First /space switch
      const firstSwitch = await merger.merge({
        directory: testDir,
        files: remoteFiles,
        localChanges: {added: [], deleted: [], modified: []},
      })
      expect(firstSwitch.edited).to.include('topic.md')
      expect(firstSwitch.added).to.include('new.md')

      // Second /space switch — same remote, snapshot was saved after first merge
      const secondSwitch = await merger.merge({
        directory: testDir,
        files: remoteFiles,
        localChanges: {added: [], deleted: [], modified: []},
      })

      expect(secondSwitch.added).to.be.empty
      expect(secondSwitch.edited).to.be.empty
      expect(secondSwitch.deleted).to.be.empty
      expect(secondSwitch.conflicted).to.be.empty
    })

    it('should leave getChanges() returning 0 after a successful merge (snapshot reflects remote)', async () => {
      // After /space switch completes, the snapshot is updated to match the remote state.
      // So `getChanges()` — which powers the "you have local changes" check — should return
      // nothing: disk content matches the saved snapshot.
      await writeFile(join(contextTreeDir, 'docs.md'), '# Old docs')
      await snapshotService.saveSnapshot()

      await merger.merge({
        directory: testDir,
        files: [makeFile('docs.md', '# Updated docs'), makeFile('guide.md', '# New guide')],
        localChanges: {added: [], deleted: [], modified: []},
      })

      const changes = await snapshotService.getChanges(testDir)
      expect(changes.added).to.be.empty
      expect(changes.modified).to.be.empty
      expect(changes.deleted).to.be.empty
    })
  })

  // ─────────────────────────────────────────────────────────────────────────
  // User scenario: /space switch with a complex mix of local changes
  // ─────────────────────────────────────────────────────────────────────────
  describe('merge — /space switch with all types of local changes at once', () => {
    it('should apply the correct merge rule to each file independently', async () => {
      // Three-way state table — what each file looks like at each stage:
      //
      // File           | snapshot   | local       | remote      | expected
      // ────────────────────────────────────────────────────────────────────────
      // service.md     | 'svc-v1'   | (unchanged) | 'svc-v2'    | edited
      // deprecated.md  | 'dep-orig' | (unchanged) | absent      | deleted
      // conflict.md    | 'conf-orig'| 'conf-local'| 'conf-remote'| conflict → _1.md
      // converged.md   | 'conv-orig'| 'conv-new'  | 'conv-new'  | edited (no conflict)
      // stable.md      | 'stable'   | (unchanged) | 'stable'    | skipped
      // arch/new.md    | absent     | 'arch-new'  | absent      | preserved
      // remote-only.md | absent     | absent      | 'remote-new'| added

      // ── Phase 1: write initial files, take snapshot ──────────────────────
      await mkdir(join(contextTreeDir, 'arch'), {recursive: true})
      await writeFile(join(contextTreeDir, 'service.md'), 'svc-v1')
      await writeFile(join(contextTreeDir, 'deprecated.md'), 'dep-orig')
      await writeFile(join(contextTreeDir, 'conflict.md'), 'conf-orig')
      await writeFile(join(contextTreeDir, 'converged.md'), 'conv-orig')
      await writeFile(join(contextTreeDir, 'stable.md'), 'stable')
      await snapshotService.saveSnapshot()

      // ── Phase 2: user makes local edits (simulates `brv curate` + manual edits) ──
      await writeFile(join(contextTreeDir, 'arch/new.md'), 'arch-new') // added — not in snapshot
      await writeFile(join(contextTreeDir, 'conflict.md'), 'conf-local') // modified
      await writeFile(join(contextTreeDir, 'converged.md'), 'conv-new') // modified (same as remote will be)

      // ── Phase 3: user does /space switch → merger called with new space's files ──
      const result = await merger.merge({
        directory: testDir,
        files: [
          makeFile('service.md', 'svc-v2'), // remote updated service
          // deprecated.md absent from remote
          makeFile('conflict.md', 'conf-remote'), // remote updated conflict (different from local)
          makeFile('converged.md', 'conv-new'), // remote updated converged (same as local!)
          makeFile('stable.md', 'stable'), // remote unchanged (same hash as snapshot)
          makeFile('remote-only.md', 'remote-new'), // only in remote
          // arch/new.md absent from remote
        ],
        localChanges: {added: ['arch/new.md'], deleted: [], modified: ['conflict.md', 'converged.md']},
      })

      // service.md: remote wins over unchanged local
      expect(result.edited).to.include('service.md')
      expect(await readFile(join(contextTreeDir, 'service.md'), 'utf8')).to.equal('svc-v2')

      // deprecated.md: absent from remote, not locally changed → deleted
      expect(result.deleted).to.include('deprecated.md')
      try {
        await access(join(contextTreeDir, 'deprecated.md'))
        expect.fail('deprecated.md should have been deleted')
      } catch {
        /* expected */
      }

      // conflict.md: 'conf-local' ≠ 'conf-remote' → local saved as _1.md, remote at original path
      expect(result.conflicted).to.deep.equal(['conflict.md'])
      expect(result.added).to.include('conflict_1.md')
      expect(await readFile(join(contextTreeDir, 'conflict.md'), 'utf8')).to.equal('conf-remote')
      expect(await readFile(join(contextTreeDir, 'conflict_1.md'), 'utf8')).to.equal('conf-local')

      // converged.md: 'conv-new' === 'conv-new' → both sides same → no conflict, just edited
      expect(result.edited).to.include('converged.md')
      expect(result.conflicted).to.not.include('converged.md')

      // stable.md: remote hash === snapshot hash → skip (disk untouched)
      expect(result.edited).to.not.include('stable.md')

      // remote-only.md: new from remote → added to disk
      expect(result.added).to.include('remote-only.md')
      expect(await readFile(join(contextTreeDir, 'remote-only.md'), 'utf8')).to.equal('remote-new')

      // arch/new.md: locally added, absent from remote → preserved (not deleted)
      expect(result.deleted).to.not.include('arch/new.md')
      expect(await readFile(join(contextTreeDir, 'arch/new.md'), 'utf8')).to.equal('arch-new')
    })
  })

  describe('merge — index.html (derived navigation artifact)', () => {
    // index.html is sync-tracked so peers receive the latest navigation without
    // running rebuild, but the merger must never surface it as a conflict: the
    // file is derived from the topic set, so any divergence is spurious and the
    // caller regenerates it post-merge.
    it('does not flag index.html as a conflict when local and remote diverge', async () => {
      // Snapshot has the file at content X
      await writeFile(join(contextTreeDir, 'index.html'), '<bv-index project="x">snapshot</bv-index>')
      await snapshotService.saveSnapshot(testDir)

      // Local modified it to Y
      await writeFile(join(contextTreeDir, 'index.html'), '<bv-index project="x">local</bv-index>')

      // Remote arrives with Z
      const result = await merger.merge({
        directory: testDir,
        files: [makeFile('index.html', '<bv-index project="x">remote</bv-index>')],
        localChanges: {added: [], deleted: [], modified: ['index.html']},
      })

      expect(result.conflicted).to.be.empty
      expect(result.edited).to.not.include('index.html')
      expect(result.added).to.not.include('index.html')

      // Local content untouched — caller will regenerate from merged topics.
      const onDisk = await readFile(join(contextTreeDir, 'index.html'), 'utf8')
      expect(onDisk).to.equal('<bv-index project="x">local</bv-index>')
    })

    it('does not write a conflict-dir copy for index.html', async () => {
      await writeFile(join(contextTreeDir, 'index.html'), '<bv-index project="x">snapshot</bv-index>')
      await snapshotService.saveSnapshot(testDir)
      await writeFile(join(contextTreeDir, 'index.html'), '<bv-index project="x">local</bv-index>')

      await merger.merge({
        directory: testDir,
        files: [makeFile('index.html', '<bv-index project="x">remote</bv-index>')],
        localChanges: {added: [], deleted: [], modified: ['index.html']},
      })

      const conflictDir = join(testDir, BRV_DIR, CONTEXT_TREE_CONFLICT_DIR)
      const exists = await access(join(conflictDir, 'index.html'))
        .then(() => true)
        .catch(() => false)
      expect(exists).to.equal(false)
    })
  })
})
