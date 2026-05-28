import {expect} from 'chai'

import {isArchiveStub, isDerivedArtifact, isExcludedFromSync} from '../../../../src/server/infra/context-tree/derived-artifact.js'

describe('derived-artifact predicates', () => {
  describe('isDerivedArtifact', () => {
    it('should return true for _index.md at root', () => {
      expect(isDerivedArtifact('_index.md')).to.be.true
    })

    it('should return true for _index.md in a subdirectory', () => {
      expect(isDerivedArtifact('domain/_index.md')).to.be.true
      expect(isDerivedArtifact('domain/topic/_index.md')).to.be.true
    })

    it('should return true for _manifest.json', () => {
      expect(isDerivedArtifact('_manifest.json')).to.be.true
    })

    it('should return true for index.html at the context-tree root', () => {
      expect(isDerivedArtifact('index.html')).to.be.true
    })

    it('should return false for user-authored index.html nested under a domain', () => {
      // The navigation index is the root file only. A topic at `<domain>/index.html`
      // must remain searchable + syncable like any other topic.
      expect(isDerivedArtifact('architecture/index.html')).to.be.false
      expect(isDerivedArtifact('web/landing/index.html')).to.be.false
    })

    it('should return false for regular .html topic files', () => {
      expect(isDerivedArtifact('features/auth.html')).to.be.false
      expect(isDerivedArtifact('architecture/api/rest.html')).to.be.false
    })

    it('should return true for .full.md inside _archived/', () => {
      expect(isDerivedArtifact('_archived/auth/tokens.full.md')).to.be.true
      expect(isDerivedArtifact('_archived/api/endpoints/legacy.full.md')).to.be.true
    })

    it('should return false for .stub.md inside _archived/ (stubs are searchable)', () => {
      expect(isDerivedArtifact('_archived/auth/tokens.stub.md')).to.be.false
      expect(isDerivedArtifact('_archived/api/endpoints/legacy.stub.md')).to.be.false
    })

    it('should return false for regular .md files', () => {
      expect(isDerivedArtifact('domain/context.md')).to.be.false
      expect(isDerivedArtifact('auth/jwt-tokens.md')).to.be.false
    })

    it('should return false for files that contain _index in the name but are not _index.md', () => {
      expect(isDerivedArtifact('domain/_index_backup.md')).to.be.false
    })

    it('should return false for .full.md outside _archived/', () => {
      expect(isDerivedArtifact('domain/something.full.md')).to.be.false
    })

    it('should handle Windows-style backslash paths', () => {
      expect(isDerivedArtifact(String.raw`domain\_index.md`)).to.be.true
      expect(isDerivedArtifact(String.raw`_archived\auth\tokens.full.md`)).to.be.true
    })
  })

  describe('isArchiveStub', () => {
    it('should return true for .stub.md inside _archived/', () => {
      expect(isArchiveStub('_archived/auth/tokens.stub.md')).to.be.true
    })

    it('should return true for deeply nested stubs', () => {
      expect(isArchiveStub('_archived/api/endpoints/v1/legacy.stub.md')).to.be.true
    })

    it('should return false for .full.md inside _archived/', () => {
      expect(isArchiveStub('_archived/auth/tokens.full.md')).to.be.false
    })

    it('should return false for .stub.md outside _archived/', () => {
      expect(isArchiveStub('domain/something.stub.md')).to.be.false
    })

    it('should return false for regular .md files', () => {
      expect(isArchiveStub('domain/context.md')).to.be.false
    })

    it('should return false for _index.md', () => {
      expect(isArchiveStub('_index.md')).to.be.false
    })

    it('should handle Windows-style backslash paths', () => {
      expect(isArchiveStub(String.raw`_archived\auth\tokens.stub.md`)).to.be.true
    })
  })

  describe('isExcludedFromSync', () => {
    it('should return true for _index.md (derived artifact)', () => {
      expect(isExcludedFromSync('domain/_index.md')).to.be.true
    })

    it('should return true for _manifest.json (derived artifact)', () => {
      expect(isExcludedFromSync('_manifest.json')).to.be.true
    })

    it('should return true for .full.md in _archived/ (derived artifact)', () => {
      expect(isExcludedFromSync('_archived/auth/tokens.full.md')).to.be.true
    })

    it('should return true for .stub.md in _archived/ (archive stub)', () => {
      expect(isExcludedFromSync('_archived/auth/tokens.stub.md')).to.be.true
    })

    it('should return false for regular .md files', () => {
      expect(isExcludedFromSync('domain/context.md')).to.be.false
      expect(isExcludedFromSync('auth/jwt-tokens.md')).to.be.false
    })

    it('should return false for the navigation index.html (sync-tracked)', () => {
      // Carve-out: index.html is derived (excluded from BM25 + query) but
      // sync-tracked so peers consume the latest version without rebuild.
      expect(isExcludedFromSync('index.html')).to.be.false
    })

    it('should return false for user-authored nested index.html (regular topic)', () => {
      // A topic at `<domain>/index.html` is a regular topic — must sync.
      expect(isExcludedFromSync('architecture/index.html')).to.be.false
      expect(isExcludedFromSync('web/landing/index.html')).to.be.false
    })
  })
})
