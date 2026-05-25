import {expect} from 'chai'

import {isArchiveStub, isChannelTurnArtifact, isDerivedArtifact, isExcludedFromSync} from '../../../../src/server/infra/context-tree/derived-artifact.js'

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
  })

  // Slice 8.7 — channel turn artifacts (events.jsonl, turn.json,
  // deliveries/*.json under channel/<id>/turns/<turnId>/) are ephemeral
  // per-turn ACP state, not knowledge. Excluded from sync ONLY — they are
  // intentionally NOT classified as derived artifacts (which would also
  // remove them from query/manifest/archive/summary surfaces). The
  // channel's own meta.json stays synced.
  describe('isChannelTurnArtifact', () => {
    it('should return true for events.jsonl under channel/<id>/turns/<turnId>/', () => {
      expect(isChannelTurnArtifact('channel/foo/turns/abc123/events.jsonl')).to.be.true
    })

    it('should return true for turn.json under channel/<id>/turns/<turnId>/', () => {
      expect(isChannelTurnArtifact('channel/foo/turns/abc123/turn.json')).to.be.true
    })

    it('should return true for delivery snapshots under deliveries/', () => {
      expect(isChannelTurnArtifact('channel/foo/turns/abc123/deliveries/del-xyz.json')).to.be.true
    })

    it('should return true for any nested file under channel/<id>/turns/', () => {
      expect(isChannelTurnArtifact('channel/foo/turns/abc/some/deep/nested/file.txt')).to.be.true
    })

    it('should return false for channel/<id>/meta.json (durable channel definition)', () => {
      expect(isChannelTurnArtifact('channel/foo/meta.json')).to.be.false
    })

    it('should return false for a channel literally named "turns" (segments[0]=channel required)', () => {
      expect(isChannelTurnArtifact('channel/turns/meta.json')).to.be.false
    })

    it('should return false for non-channel paths that happen to contain "turns"', () => {
      expect(isChannelTurnArtifact('turns/whatever.json')).to.be.false
      expect(isChannelTurnArtifact('domain/turns/notes.md')).to.be.false
      expect(isChannelTurnArtifact('foo/channel/bar/turns/x.json')).to.be.false
    })

    it('should return false for regular knowledge files', () => {
      expect(isChannelTurnArtifact('domain/context.md')).to.be.false
      expect(isChannelTurnArtifact('_index.md')).to.be.false
    })

    it('should handle Windows-style backslash paths', () => {
      expect(isChannelTurnArtifact(String.raw`channel\foo\turns\abc\events.jsonl`)).to.be.true
      expect(isChannelTurnArtifact(String.raw`channel\foo\meta.json`)).to.be.false
    })

    it('should NOT be reclassified by isDerivedArtifact (separation of concerns)', () => {
      // Channel turn files are excluded from sync but are NOT generic
      // derived artifacts. Keeping them out of isDerivedArtifact protects
      // query/manifest/archive/summary paths from accidentally hiding them.
      expect(isDerivedArtifact('channel/foo/turns/abc/events.jsonl')).to.be.false
    })
  })

  describe('isExcludedFromSync — channel turn artifacts (Slice 8.7)', () => {
    it('should return true for events.jsonl under a channel turn', () => {
      expect(isExcludedFromSync('channel/foo/turns/abc/events.jsonl')).to.be.true
    })

    it('should return true for turn.json under a channel turn', () => {
      expect(isExcludedFromSync('channel/foo/turns/abc/turn.json')).to.be.true
    })

    it('should return true for a delivery snapshot under a channel turn', () => {
      expect(isExcludedFromSync('channel/foo/turns/abc/deliveries/d1.json')).to.be.true
    })

    it('should return false for channel/<id>/meta.json (kept synced)', () => {
      expect(isExcludedFromSync('channel/foo/meta.json')).to.be.false
    })
  })
})
