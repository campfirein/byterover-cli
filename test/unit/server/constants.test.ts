import {expect} from 'chai'

import {CONTEXT_TREE_GITIGNORE_PATTERNS} from '../../../src/server/constants.js'

describe('CONTEXT_TREE_GITIGNORE_PATTERNS', () => {
  it('should exclude adaptive-generated abstract files', () => {
    expect(CONTEXT_TREE_GITIGNORE_PATTERNS).to.include('*.abstract.md')
  })

  it('should exclude adaptive-generated overview files', () => {
    expect(CONTEXT_TREE_GITIGNORE_PATTERNS).to.include('*.overview.md')
  })

  it('should still exclude legacy infrastructure files', () => {
    expect(CONTEXT_TREE_GITIGNORE_PATTERNS).to.include('.gitignore')
    expect(CONTEXT_TREE_GITIGNORE_PATTERNS).to.include('.snapshot.json')
    expect(CONTEXT_TREE_GITIGNORE_PATTERNS).to.include('_manifest.json')
    expect(CONTEXT_TREE_GITIGNORE_PATTERNS).to.include('_index.md')
  })

  it('should NOT exclude index.html — it is sync-tracked', () => {
    // Guard against accidental re-introduction. The navigation index ships to
    // peers via CoGit; gitignoring it would force a `brv index rebuild` after
    // every pull. The legacy underscore name must not creep back in either.
    expect(CONTEXT_TREE_GITIGNORE_PATTERNS).to.not.include('index.html')
    expect(CONTEXT_TREE_GITIGNORE_PATTERNS).to.not.include('_index.html')
  })

  describe('OS-generated junk files', () => {
    it('should exclude macOS junk (Finder metadata + AppleDouble forks)', () => {
      expect(CONTEXT_TREE_GITIGNORE_PATTERNS).to.include('.DS_Store')
      expect(CONTEXT_TREE_GITIGNORE_PATTERNS).to.include('._*')
    })

    it('should exclude Windows junk (thumbnail cache + folder config)', () => {
      expect(CONTEXT_TREE_GITIGNORE_PATTERNS).to.include('Thumbs.db')
      expect(CONTEXT_TREE_GITIGNORE_PATTERNS).to.include('ehthumbs.db')
      expect(CONTEXT_TREE_GITIGNORE_PATTERNS).to.include('Desktop.ini')
    })

    it('should exclude Linux junk (KDE metadata + FUSE/NFS hidden files)', () => {
      expect(CONTEXT_TREE_GITIGNORE_PATTERNS).to.include('.directory')
      expect(CONTEXT_TREE_GITIGNORE_PATTERNS).to.include('.fuse_hidden*')
      expect(CONTEXT_TREE_GITIGNORE_PATTERNS).to.include('.nfs*')
    })

    it('should exclude editor swap / backup / temp files', () => {
      expect(CONTEXT_TREE_GITIGNORE_PATTERNS).to.include('*.swp')
      expect(CONTEXT_TREE_GITIGNORE_PATTERNS).to.include('*.swo')
      expect(CONTEXT_TREE_GITIGNORE_PATTERNS).to.include('*~')
      expect(CONTEXT_TREE_GITIGNORE_PATTERNS).to.include('.#*')
      expect(CONTEXT_TREE_GITIGNORE_PATTERNS).to.include('*.bak')
      expect(CONTEXT_TREE_GITIGNORE_PATTERNS).to.include('*.tmp')
    })

    it('should deliberately NOT include trash folders (out of scope per ENG-2154)', () => {
      expect(CONTEXT_TREE_GITIGNORE_PATTERNS).to.not.include('.Trashes')
      expect(CONTEXT_TREE_GITIGNORE_PATTERNS).to.not.include('.Trash-*')
      expect(CONTEXT_TREE_GITIGNORE_PATTERNS).to.not.include('$RECYCLE.BIN/')
    })
  })
})
