import {expect} from 'chai'
import {mkdir, readFile, rm, writeFile} from 'node:fs/promises'
import {tmpdir} from 'node:os'
import {join} from 'node:path'

import {BRV_DIR, CONTEXT_TREE_DIR} from '../../../../src/server/constants.js'
import {FileContextTreeSnapshotService} from '../../../../src/server/infra/context-tree/file-context-tree-snapshot-service.js'

describe('FileContextTreeSnapshotService', () => {
  let testDir: string
  let contextTreeDir: string
  let service: FileContextTreeSnapshotService

  beforeEach(async () => {
    testDir = join(tmpdir(), `brv-test-${Date.now()}`)
    contextTreeDir = join(testDir, BRV_DIR, CONTEXT_TREE_DIR)
    await mkdir(contextTreeDir, {recursive: true})
    service = new FileContextTreeSnapshotService({baseDirectory: testDir})
  })

  afterEach(async () => {
    await rm(testDir, {force: true, recursive: true})
  })

  describe('constructor', () => {
    it('should use process.cwd() when no baseDirectory provided', async () => {
      const defaultService = new FileContextTreeSnapshotService()
      // Should not throw when calling methods (will use cwd)
      const hasSnapshot = await defaultService.hasSnapshot()
      expect(hasSnapshot).to.be.a('boolean')
    })

    it('should use provided baseDirectory', async () => {
      const customService = new FileContextTreeSnapshotService({baseDirectory: testDir})
      await customService.saveSnapshot()
      const hasSnapshot = await customService.hasSnapshot()
      expect(hasSnapshot).to.be.true
    })
  })

  describe('hasSnapshot', () => {
    it('should return false when no snapshot exists', async () => {
      const result = await service.hasSnapshot()
      expect(result).to.be.false
    })

    it('should return true when snapshot exists', async () => {
      await service.saveSnapshot()
      const result = await service.hasSnapshot()
      expect(result).to.be.true
    })

    it('should use directory parameter over baseDirectory', async () => {
      const otherDir = join(tmpdir(), `brv-other-${Date.now()}`)
      const otherContextDir = join(otherDir, BRV_DIR, CONTEXT_TREE_DIR)
      await mkdir(otherContextDir, {recursive: true})

      try {
        // Save snapshot in other directory
        await service.saveSnapshot(otherDir)

        // Check in base directory - should be false
        const hasInBase = await service.hasSnapshot()
        expect(hasInBase).to.be.false

        // Check in other directory - should be true
        const hasInOther = await service.hasSnapshot(otherDir)
        expect(hasInOther).to.be.true
      } finally {
        await rm(otherDir, {force: true, recursive: true})
      }
    })
  })

  describe('getCurrentState', () => {
    it('should return empty map for empty directory', async () => {
      const state = await service.getCurrentState()
      expect(state.size).to.equal(0)
    })

    it('should detect all .md files', async () => {
      const domainDir = join(contextTreeDir, 'test_domain')
      await mkdir(domainDir, {recursive: true})
      await writeFile(join(domainDir, 'context.md'), '# Test')
      await writeFile(join(domainDir, 'best_practices.md'), '# Best Practices')

      const state = await service.getCurrentState()
      expect(state.size).to.equal(2)
      expect(state.has('test_domain/context.md')).to.be.true
      expect(state.has('test_domain/best_practices.md')).to.be.true
    })

    it('should ignore non-.md files but detect all .md files (except README)', async () => {
      const domainDir = join(contextTreeDir, 'test_domain')
      await mkdir(domainDir, {recursive: true})
      await writeFile(join(domainDir, 'other.txt'), 'content')
      await writeFile(join(domainDir, 'data.json'), '{}')
      await writeFile(join(domainDir, 'context.md'), '# Context')
      await writeFile(join(domainDir, 'notes.md'), '# Notes')

      const state = await service.getCurrentState()
      expect(state.size).to.equal(2)
      expect(state.has('test_domain/context.md')).to.be.true
      expect(state.has('test_domain/notes.md')).to.be.true
      expect(state.has('test_domain/other.txt')).to.be.false
      expect(state.has('test_domain/data.json')).to.be.false
    })

    it('should track context.md in hidden directories', async () => {
      const hiddenDir = join(contextTreeDir, '.hidden')
      await mkdir(hiddenDir, {recursive: true})
      await writeFile(join(hiddenDir, 'context.md'), '# Hidden')

      const state = await service.getCurrentState()
      expect(state.size).to.equal(1)
      expect(state.has('.hidden/context.md')).to.be.true
    })

    it('should detect hidden .md files', async () => {
      const domainDir = join(contextTreeDir, 'test_domain')
      await mkdir(domainDir, {recursive: true})
      await writeFile(join(domainDir, '.hidden.md'), '# Hidden')

      const state = await service.getCurrentState()
      expect(state.size).to.equal(1)
      expect(state.has('test_domain/.hidden.md')).to.be.true
    })

    it('should ignore snapshot file', async () => {
      await service.saveSnapshot()
      const state = await service.getCurrentState()
      expect(state.has('.snapshot.json')).to.be.false
    })

    it('should scan nested directories', async () => {
      const nestedDir = join(contextTreeDir, 'domain', 'topic', 'subtopic')
      await mkdir(nestedDir, {recursive: true})
      await writeFile(join(nestedDir, 'context.md'), '# Nested')

      const state = await service.getCurrentState()
      expect(state.size).to.equal(1)
      expect(state.has('domain/topic/subtopic/context.md')).to.be.true
    })

    it('should compute correct hash for file content', async () => {
      const domainDir = join(contextTreeDir, 'test')
      await mkdir(domainDir, {recursive: true})
      await writeFile(join(domainDir, 'context.md'), '# Test Content')

      const state = await service.getCurrentState()
      const fileState = state.get('test/context.md')

      expect(fileState).to.not.be.undefined
      expect(fileState!.hash).to.be.a('string')
      expect(fileState!.hash).to.have.lengthOf(64) // SHA-256 hex length
    })

    it('should compute correct size for file', async () => {
      const content = '# Test Content'
      const domainDir = join(contextTreeDir, 'test')
      await mkdir(domainDir, {recursive: true})
      await writeFile(join(domainDir, 'context.md'), content)

      const state = await service.getCurrentState()
      const fileState = state.get('test/context.md')

      expect(fileState).to.not.be.undefined
      expect(fileState!.size).to.equal(Buffer.byteLength(content))
    })

    it('should return different hashes for different content', async () => {
      const dir1 = join(contextTreeDir, 'dir1')
      const dir2 = join(contextTreeDir, 'dir2')
      await mkdir(dir1, {recursive: true})
      await mkdir(dir2, {recursive: true})
      await writeFile(join(dir1, 'context.md'), '# Content A')
      await writeFile(join(dir2, 'context.md'), '# Content B')

      const state = await service.getCurrentState()
      const hash1 = state.get('dir1/context.md')!.hash
      const hash2 = state.get('dir2/context.md')!.hash

      expect(hash1).to.not.equal(hash2)
    })

    it('should return same hash for same content', async () => {
      const dir1 = join(contextTreeDir, 'dir1')
      const dir2 = join(contextTreeDir, 'dir2')
      await mkdir(dir1, {recursive: true})
      await mkdir(dir2, {recursive: true})
      await writeFile(join(dir1, 'context.md'), '# Same Content')
      await writeFile(join(dir2, 'context.md'), '# Same Content')

      const state = await service.getCurrentState()
      const hash1 = state.get('dir1/context.md')!.hash
      const hash2 = state.get('dir2/context.md')!.hash

      expect(hash1).to.equal(hash2)
    })

    it('should return empty map when directory does not exist', async () => {
      const nonExistentService = new FileContextTreeSnapshotService({
        baseDirectory: '/non/existent/path',
      })

      const state = await nonExistentService.getCurrentState()
      expect(state.size).to.equal(0)
    })

    it('should track all .md files when multiple files exist in same directory', async () => {
      const domainDir = join(contextTreeDir, 'design')
      await mkdir(domainDir, {recursive: true})
      await writeFile(join(domainDir, 'overview.md'), '# Overview')
      await writeFile(join(domainDir, 'details.md'), '# Details')
      await writeFile(join(domainDir, 'context.md'), '# Context')

      const state = await service.getCurrentState()
      expect(state.size).to.equal(3)
      expect(state.has('design/overview.md')).to.be.true
      expect(state.has('design/details.md')).to.be.true
      expect(state.has('design/context.md')).to.be.true
    })

    it('should track context.md in multiple directories', async () => {
      const designDir = join(contextTreeDir, 'design')
      const codeDir = join(contextTreeDir, 'code')
      const testDir = join(contextTreeDir, 'testing')
      await mkdir(designDir, {recursive: true})
      await mkdir(codeDir, {recursive: true})
      await mkdir(testDir, {recursive: true})
      await writeFile(join(designDir, 'context.md'), '# Design')
      await writeFile(join(codeDir, 'context.md'), '# Code')
      await writeFile(join(testDir, 'context.md'), '# Testing')

      const state = await service.getCurrentState()
      expect(state.size).to.equal(3)
      expect(state.has('design/context.md')).to.be.true
      expect(state.has('code/context.md')).to.be.true
      expect(state.has('testing/context.md')).to.be.true
    })

    it('should track README.md in subdirectories', async () => {
      const domainDir = join(contextTreeDir, 'test_domain')
      await mkdir(domainDir, {recursive: true})
      await writeFile(join(domainDir, 'README.md'), '# Readme - should be tracked in subdirectory')
      await writeFile(join(domainDir, 'context.md'), '# Context')

      const state = await service.getCurrentState()
      expect(state.size).to.equal(2)
      expect(state.has('test_domain/context.md')).to.be.true
      expect(state.has('test_domain/README.md')).to.be.true
    })

    it('should track README.md in multiple subdirectories', async () => {
      const dir1 = join(contextTreeDir, 'domain1')
      const dir2 = join(contextTreeDir, 'domain2')
      await mkdir(dir1, {recursive: true})
      await mkdir(dir2, {recursive: true})
      await writeFile(join(dir1, 'README.md'), '# Readme 1')
      await writeFile(join(dir1, 'best_practices.md'), '# Best Practices')
      await writeFile(join(dir2, 'README.md'), '# Readme 2')
      await writeFile(join(dir2, 'jwt_tokens.md'), '# JWT Tokens')

      const state = await service.getCurrentState()
      expect(state.size).to.equal(4)
      expect(state.has('domain1/best_practices.md')).to.be.true
      expect(state.has('domain2/jwt_tokens.md')).to.be.true
      expect(state.has('domain1/README.md')).to.be.true
      expect(state.has('domain2/README.md')).to.be.true
    })

    it('should ignore README.md at root of context-tree', async () => {
      await writeFile(join(contextTreeDir, 'README.md'), '# Root Readme')
      const domainDir = join(contextTreeDir, 'design')
      await mkdir(domainDir, {recursive: true})
      await writeFile(join(domainDir, 'context.md'), '# Design')

      const state = await service.getCurrentState()
      expect(state.size).to.equal(1)
      expect(state.has('design/context.md')).to.be.true
      expect(state.has('README.md')).to.be.false
    })

    it('should track lowercase readme.md (only README.md is ignored)', async () => {
      const domainDir = join(contextTreeDir, 'test_domain')
      await mkdir(domainDir, {recursive: true})
      await writeFile(join(domainDir, 'readme.md'), '# lowercase readme')

      const state = await service.getCurrentState()
      expect(state.size).to.equal(1)
      expect(state.has('test_domain/readme.md')).to.be.true
    })

    // Slice 9.1 regression-guard: per-channel ACP turn transcripts now
    // live at `<projectRoot>/.brv/channel-history/<channelId>/turns/<turnId>.ndjson`,
    // OUTSIDE the cogit-scanned `.brv/context-tree/` mount. The snapshot
    // service must therefore NOT enumerate anything under that sibling
    // directory — even if someone misuses the path by placing a `.md`
    // file under it. Without this guard, a future refactor that broadens
    // the scan root to `.brv/` would silently start syncing transcripts
    // to cogit, leaking high-volume ephemeral log data into the curated
    // knowledge tree.
    it('should NOT enumerate files under .brv/channel-history/ (Slice 9.1 — structural isolation)', async () => {
      // Set up a valid context-tree file so the scanner doesn't return empty.
      const domainDir = join(contextTreeDir, 'design')
      await mkdir(domainDir, {recursive: true})
      await writeFile(join(domainDir, 'context.md'), '# Design')

      // Sibling channel-history mount with the exact Slice 9.1 layout.
      const channelHistoryDir = join(testDir, BRV_DIR, 'channel-history', 'pi-test')
      const channelTurnsDir = join(channelHistoryDir, 'turns')
      await mkdir(channelTurnsDir, {recursive: true})
      await writeFile(join(channelTurnsDir, '01HX.ndjson'), '{"kind":"message","content":"hi","seq":0}\n')
      await writeFile(join(channelHistoryDir, 'index.jsonl'), '{"turnId":"01HX","status":"completed"}\n')
      // Adversarial case: someone misnames a transcript piece as .md.
      // Still must NOT appear in the snapshot state.
      await writeFile(join(channelHistoryDir, 'leaked.md'), '# transcript leak attempt')

      const state = await service.getCurrentState()
      expect(state.has('design/context.md')).to.be.true
      // No transcript files should appear — by any extension, under any path.
      for (const key of state.keys()) {
        expect(key, `unexpected channel-history path in snapshot: ${key}`).to.not.match(/channel-history/)
      }
    })
  })

  describe('saveSnapshot and getChanges', () => {
    it('should detect no changes after saving snapshot', async () => {
      const domainDir = join(contextTreeDir, 'design')
      await mkdir(domainDir, {recursive: true})
      await writeFile(join(domainDir, 'context.md'), '# Design')

      await service.saveSnapshot()
      const changes = await service.getChanges()

      expect(changes.added).to.be.empty
      expect(changes.modified).to.be.empty
      expect(changes.deleted).to.be.empty
    })

    it('should detect added files', async () => {
      await service.saveSnapshot()

      const domainDir = join(contextTreeDir, 'new_domain')
      await mkdir(domainDir, {recursive: true})
      await writeFile(join(domainDir, 'context.md'), '# New')

      const changes = await service.getChanges()
      expect(changes.added).to.include('new_domain/context.md')
      expect(changes.modified).to.be.empty
      expect(changes.deleted).to.be.empty
    })

    it('should detect modified files', async () => {
      const domainDir = join(contextTreeDir, 'design')
      await mkdir(domainDir, {recursive: true})
      await writeFile(join(domainDir, 'context.md'), '# Original')

      await service.saveSnapshot()

      await writeFile(join(domainDir, 'context.md'), '# Modified content')

      const changes = await service.getChanges()
      expect(changes.added).to.be.empty
      expect(changes.modified).to.include('design/context.md')
      expect(changes.deleted).to.be.empty
    })

    it('should detect deleted files', async () => {
      const domainDir = join(contextTreeDir, 'design')
      await mkdir(domainDir, {recursive: true})
      const filePath = join(domainDir, 'context.md')
      await writeFile(filePath, '# Design')

      await service.saveSnapshot()

      await rm(filePath)

      const changes = await service.getChanges()
      expect(changes.added).to.be.empty
      expect(changes.modified).to.be.empty
      expect(changes.deleted).to.include('design/context.md')
    })

    it('should detect multiple types of changes', async () => {
      // Initial state
      const designDir = join(contextTreeDir, 'design')
      const codeDir = join(contextTreeDir, 'code_style')
      await mkdir(designDir, {recursive: true})
      await mkdir(codeDir, {recursive: true})
      await writeFile(join(designDir, 'context.md'), '# Design')
      await writeFile(join(codeDir, 'context.md'), '# Code')

      await service.saveSnapshot()

      // Make changes
      await writeFile(join(designDir, 'context.md'), '# Design Modified')
      await rm(join(codeDir, 'context.md'))
      const newDir = join(contextTreeDir, 'testing')
      await mkdir(newDir, {recursive: true})
      await writeFile(join(newDir, 'context.md'), '# Testing')

      const changes = await service.getChanges()
      expect(changes.modified).to.include('design/context.md')
      expect(changes.deleted).to.include('code_style/context.md')
      expect(changes.added).to.include('testing/context.md')
    })

    it('should detect added dynamic filename (e.g., best_practices.md)', async () => {
      await service.saveSnapshot()

      const domainDir = join(contextTreeDir, 'code_style')
      await mkdir(domainDir, {recursive: true})
      await writeFile(join(domainDir, 'best_practices.md'), '# Best Practices')

      const changes = await service.getChanges()
      expect(changes.added).to.include('code_style/best_practices.md')
      expect(changes.modified).to.be.empty
      expect(changes.deleted).to.be.empty
    })

    it('should detect modified dynamic filename', async () => {
      const domainDir = join(contextTreeDir, 'auth')
      await mkdir(domainDir, {recursive: true})
      await writeFile(join(domainDir, 'jwt_tokens.md'), '# Original JWT')

      await service.saveSnapshot()

      await writeFile(join(domainDir, 'jwt_tokens.md'), '# Modified JWT with refresh tokens')

      const changes = await service.getChanges()
      expect(changes.added).to.be.empty
      expect(changes.modified).to.include('auth/jwt_tokens.md')
      expect(changes.deleted).to.be.empty
    })

    it('should detect deleted dynamic filename', async () => {
      const domainDir = join(contextTreeDir, 'patterns')
      await mkdir(domainDir, {recursive: true})
      await writeFile(join(domainDir, 'repository_pattern.md'), '# Repository Pattern')

      await service.saveSnapshot()

      await rm(join(domainDir, 'repository_pattern.md'))

      const changes = await service.getChanges()
      expect(changes.added).to.be.empty
      expect(changes.modified).to.be.empty
      expect(changes.deleted).to.include('patterns/repository_pattern.md')
    })

    it('should detect changes in mixed context.md and dynamic filenames', async () => {
      const domainDir = join(contextTreeDir, 'architecture')
      await mkdir(domainDir, {recursive: true})
      await writeFile(join(domainDir, 'context.md'), '# Architecture Overview')
      await writeFile(join(domainDir, 'hexagonal.md'), '# Hexagonal Architecture')

      await service.saveSnapshot()

      // Modify context.md, add new dynamic file, delete hexagonal.md
      await writeFile(join(domainDir, 'context.md'), '# Architecture Overview - Updated')
      await writeFile(join(domainDir, 'clean_architecture.md'), '# Clean Architecture')
      await rm(join(domainDir, 'hexagonal.md'))

      const changes = await service.getChanges()
      expect(changes.modified).to.include('architecture/context.md')
      expect(changes.added).to.include('architecture/clean_architecture.md')
      expect(changes.deleted).to.include('architecture/hexagonal.md')
    })

    it('should detect README.md in subdirectory as added', async () => {
      await service.saveSnapshot()

      const domainDir = join(contextTreeDir, 'test_domain')
      await mkdir(domainDir, {recursive: true})
      await writeFile(join(domainDir, 'README.md'), '# This should be tracked in subdirectory')
      await writeFile(join(domainDir, 'actual_content.md'), '# This should be detected')

      const changes = await service.getChanges()
      expect(changes.added).to.have.lengthOf(2)
      expect(changes.added).to.include('test_domain/actual_content.md')
      expect(changes.added).to.include('test_domain/README.md')
    })

    it('should detect README.md in subdirectory as modified', async () => {
      const domainDir = join(contextTreeDir, 'test_domain')
      await mkdir(domainDir, {recursive: true})
      await writeFile(join(domainDir, 'README.md'), '# Original')
      await writeFile(join(domainDir, 'context.md'), '# Context')

      await service.saveSnapshot()

      // Modify README.md
      await writeFile(join(domainDir, 'README.md'), '# Modified README')

      const changes = await service.getChanges()
      expect(changes.added).to.be.empty
      expect(changes.modified).to.include('test_domain/README.md')
      expect(changes.deleted).to.be.empty
    })

    it('should detect README.md in subdirectory as deleted', async () => {
      const domainDir = join(contextTreeDir, 'test_domain')
      await mkdir(domainDir, {recursive: true})
      await writeFile(join(domainDir, 'README.md'), '# Readme')
      await writeFile(join(domainDir, 'context.md'), '# Context')

      await service.saveSnapshot()

      // Delete README.md
      await rm(join(domainDir, 'README.md'))

      const changes = await service.getChanges()
      expect(changes.added).to.be.empty
      expect(changes.modified).to.be.empty
      expect(changes.deleted).to.include('test_domain/README.md')
    })

    it('should NOT detect root README.md as added', async () => {
      await service.saveSnapshot()

      // Add README.md at root - should be ignored
      await writeFile(join(contextTreeDir, 'README.md'), '# Root README - ignored')
      // Add file in subdirectory - should be detected
      const domainDir = join(contextTreeDir, 'test_domain')
      await mkdir(domainDir, {recursive: true})
      await writeFile(join(domainDir, 'content.md'), '# This should be detected')

      const changes = await service.getChanges()
      expect(changes.added).to.have.lengthOf(1)
      expect(changes.added).to.include('test_domain/content.md')
      expect(changes.added).to.not.include('README.md')
    })

    it('should NOT detect root README.md as modified', async () => {
      // Create root README.md first (though it won't be tracked)
      await writeFile(join(contextTreeDir, 'README.md'), '# Original Root')
      const domainDir = join(contextTreeDir, 'test_domain')
      await mkdir(domainDir, {recursive: true})
      await writeFile(join(domainDir, 'context.md'), '# Context')

      await service.saveSnapshot()

      // Modify root README.md - should not trigger change
      await writeFile(join(contextTreeDir, 'README.md'), '# Modified Root README')

      const changes = await service.getChanges()
      expect(changes.added).to.be.empty
      expect(changes.modified).to.be.empty
      expect(changes.deleted).to.be.empty
    })

    it('should NOT detect root README.md as deleted', async () => {
      // Create root README.md first (though it won't be tracked)
      await writeFile(join(contextTreeDir, 'README.md'), '# Root README')
      const domainDir = join(contextTreeDir, 'test_domain')
      await mkdir(domainDir, {recursive: true})
      await writeFile(join(domainDir, 'context.md'), '# Context')

      await service.saveSnapshot()

      // Delete root README.md - should not trigger change
      await rm(join(contextTreeDir, 'README.md'))

      const changes = await service.getChanges()
      expect(changes.added).to.be.empty
      expect(changes.modified).to.be.empty
      expect(changes.deleted).to.be.empty
    })
  })

  describe('getChanges without snapshot', () => {
    it('should return empty changes when no snapshot exists', async () => {
      const domainDir = join(contextTreeDir, 'design')
      await mkdir(domainDir, {recursive: true})
      await writeFile(join(domainDir, 'context.md'), '# Design')

      const changes = await service.getChanges()
      expect(changes.added).to.be.empty
      expect(changes.modified).to.be.empty
      expect(changes.deleted).to.be.empty
    })
  })

  describe('initEmptySnapshot', () => {
    it('should create an empty snapshot file', async () => {
      await service.initEmptySnapshot()

      const hasSnapshot = await service.hasSnapshot()
      expect(hasSnapshot).to.be.true
    })

    it('should create snapshot with no files tracked', async () => {
      // Add some files first
      const domainDir = join(contextTreeDir, 'design')
      await mkdir(domainDir, {recursive: true})
      await writeFile(join(domainDir, 'context.md'), '# Design')

      // Init empty snapshot
      await service.initEmptySnapshot()

      // All files should appear as added
      const changes = await service.getChanges()
      expect(changes.added).to.include('design/context.md')
      expect(changes.modified).to.be.empty
      expect(changes.deleted).to.be.empty
    })

    it('should overwrite existing snapshot with empty one', async () => {
      // Create initial snapshot with files
      const domainDir = join(contextTreeDir, 'design')
      await mkdir(domainDir, {recursive: true})
      await writeFile(join(domainDir, 'context.md'), '# Design')
      await service.saveSnapshot()

      // Verify no changes initially
      let changes = await service.getChanges()
      expect(changes.added).to.be.empty

      // Init empty snapshot
      await service.initEmptySnapshot()

      // Now file should appear as added
      changes = await service.getChanges()
      expect(changes.added).to.include('design/context.md')
    })

    it('should write valid JSON to snapshot file', async () => {
      await service.initEmptySnapshot()

      const snapshotPath = join(contextTreeDir, '.snapshot.json')
      const content = await readFile(snapshotPath, 'utf8')
      const json = JSON.parse(content)

      expect(json.version).to.equal(1)
      expect(json.createdAt).to.be.a('string')
      expect(json.files).to.deep.equal({})
    })
  })

  describe('saveSnapshot', () => {
    it('should write valid JSON to snapshot file', async () => {
      const domainDir = join(contextTreeDir, 'design')
      await mkdir(domainDir, {recursive: true})
      await writeFile(join(domainDir, 'context.md'), '# Design')

      await service.saveSnapshot()

      const snapshotPath = join(contextTreeDir, '.snapshot.json')
      const content = await readFile(snapshotPath, 'utf8')
      const json = JSON.parse(content)

      expect(json.version).to.equal(1)
      expect(json.createdAt).to.be.a('string')
      expect(json.files['design/context.md']).to.exist
      expect(json.files['design/context.md'].hash).to.be.a('string')
      expect(json.files['design/context.md'].size).to.be.a('number')
    })

    it('should overwrite existing snapshot', async () => {
      const domainDir = join(contextTreeDir, 'design')
      await mkdir(domainDir, {recursive: true})
      await writeFile(join(domainDir, 'context.md'), '# Original')

      await service.saveSnapshot()

      // Modify file and save again
      await writeFile(join(domainDir, 'context.md'), '# Modified')
      await service.saveSnapshot()

      // Should have no changes after second save
      const changes = await service.getChanges()
      expect(changes.added).to.be.empty
      expect(changes.modified).to.be.empty
      expect(changes.deleted).to.be.empty
    })

    it('should use directory parameter', async () => {
      const otherDir = join(tmpdir(), `brv-other-${Date.now()}`)
      const otherContextDir = join(otherDir, BRV_DIR, CONTEXT_TREE_DIR)
      await mkdir(otherContextDir, {recursive: true})

      try {
        await service.saveSnapshot(otherDir)

        const snapshotPath = join(otherContextDir, '.snapshot.json')
        const content = await readFile(snapshotPath, 'utf8')
        const json = JSON.parse(content)

        expect(json.version).to.equal(1)
      } finally {
        await rm(otherDir, {force: true, recursive: true})
      }
    })
  })

  describe('getChanges', () => {
    it('should use directory parameter', async () => {
      const otherDir = join(tmpdir(), `brv-other-${Date.now()}`)
      const otherContextDir = join(otherDir, BRV_DIR, CONTEXT_TREE_DIR)
      await mkdir(otherContextDir, {recursive: true})

      try {
        // Save empty snapshot in other dir
        await service.initEmptySnapshot(otherDir)

        // Add file to other dir
        const domainDir = join(otherContextDir, 'design')
        await mkdir(domainDir, {recursive: true})
        await writeFile(join(domainDir, 'context.md'), '# Design')

        // Get changes from other dir
        const changes = await service.getChanges(otherDir)
        expect(changes.added).to.include('design/context.md')
      } finally {
        await rm(otherDir, {force: true, recursive: true})
      }
    })

    it('should handle corrupted snapshot file gracefully', async () => {
      const snapshotPath = join(contextTreeDir, '.snapshot.json')
      await writeFile(snapshotPath, 'not valid json')

      // Should return empty changes (like no snapshot)
      const changes = await service.getChanges()
      expect(changes.added).to.be.empty
      expect(changes.modified).to.be.empty
      expect(changes.deleted).to.be.empty
    })

    it('should handle snapshot with unsupported version', async () => {
      const snapshotPath = join(contextTreeDir, '.snapshot.json')
      await writeFile(snapshotPath, JSON.stringify({createdAt: new Date().toISOString(), files: {}, version: 999}))

      // Should return empty changes (like no snapshot)
      const changes = await service.getChanges()
      expect(changes.added).to.be.empty
      expect(changes.modified).to.be.empty
      expect(changes.deleted).to.be.empty
    })
  })

  describe('Cross-platform path handling', () => {
    it('should normalize paths to forward slashes regardless of platform', async () => {
      // Create a nested directory structure
      const nestedDir = join(contextTreeDir, 'auth', 'jwt')
      await mkdir(nestedDir, {recursive: true})
      await writeFile(join(nestedDir, 'context.md'), '# Auth JWT Context')

      const state = await service.getCurrentState()

      // Path should always use forward slashes, regardless of platform
      const paths = [...state.keys()]
      expect(paths).to.have.lengthOf(1)
      expect(paths[0]).to.equal('auth/jwt/context.md')
      expect(paths[0]).to.not.include('\\')
    })

    it('should save snapshot with normalized paths', async () => {
      // Create nested files
      const nestedDir = join(contextTreeDir, 'api', 'endpoints')
      await mkdir(nestedDir, {recursive: true})
      await writeFile(join(nestedDir, 'context.md'), '# API Endpoints')

      await service.saveSnapshot()

      // Read and verify the snapshot
      const snapshotPath = join(contextTreeDir, '.snapshot.json')
      const snapshotContent = await readFile(snapshotPath, 'utf8')
      const snapshot = JSON.parse(snapshotContent)

      // All paths in snapshot should use forward slashes
      const filePaths = Object.keys(snapshot.files)
      expect(filePaths).to.have.lengthOf(1)
      expect(filePaths[0]).to.equal('api/endpoints/context.md')
      expect(filePaths[0]).to.not.include('\\')
    })

    it('should detect changes correctly with normalized paths', async () => {
      // Create initial file and save snapshot
      const nestedDir = join(contextTreeDir, 'services', 'auth')
      await mkdir(nestedDir, {recursive: true})
      await writeFile(join(nestedDir, 'context.md'), '# Auth Service')
      await service.saveSnapshot()

      // Modify the file
      await writeFile(join(nestedDir, 'context.md'), '# Auth Service Updated')

      const changes = await service.getChanges()

      // Modified path should use forward slashes
      expect(changes.modified).to.have.lengthOf(1)
      expect(changes.modified[0]).to.equal('services/auth/context.md')
      expect(changes.modified[0]).to.not.include('\\')
    })
  })
})
