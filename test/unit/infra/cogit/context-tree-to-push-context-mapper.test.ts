import {expect} from 'chai'

import type {ContextFileContent} from '../../../../src/server/core/interfaces/context-tree/i-context-file-reader.js'

import {mapToPushContexts} from '../../../../src/server/infra/cogit/context-tree-to-push-context-mapper.js'

describe('mapToPushContexts', () => {
  describe('mapping added files', () => {
    it('should map added files to push contexts with operation "add"', () => {
      const addedFiles: ContextFileContent[] = [
        {
          content: 'File content here',
          keywords: [],
          path: 'structure/context.md',
          tags: [],
          title: 'Structure Context',
        },
      ]

      const result = mapToPushContexts({addedFiles, deletedPaths: [], modifiedFiles: []})

      expect(result).to.have.lengthOf(1)
      expect(result[0].operation).to.equal('add')
    })

    it('should set correct path, title, and content from file content', () => {
      const addedFiles: ContextFileContent[] = [
        {
          content: '# My Title\n\nSome content here',
          keywords: [],
          path: 'design/patterns/context.md',
          tags: [],
          title: 'My Title',
        },
      ]

      const result = mapToPushContexts({addedFiles, deletedPaths: [], modifiedFiles: []})

      expect(result[0].path).to.equal('design/patterns/context.md')
      expect(result[0].title).to.equal('My Title')
      expect(result[0].content).to.equal('# My Title\n\nSome content here')
    })

    it('should set empty tags array', () => {
      const addedFiles: ContextFileContent[] = [
        {
          content: 'Some content',
          keywords: [],
          path: 'test/context.md',
          tags: [],
          title: 'Test',
        },
      ]

      const result = mapToPushContexts({addedFiles, deletedPaths: [], modifiedFiles: []})

      expect(result[0].tags).to.deep.equal([])
    })
  })

  describe('edge cases', () => {
    it('should return empty array when all inputs are empty', () => {
      const result = mapToPushContexts({addedFiles: [], deletedPaths: [], modifiedFiles: []})

      expect(result).to.deep.equal([])
    })

    it('should preserve order of added files', () => {
      const addedFiles: ContextFileContent[] = [
        {content: 'First', keywords: [], path: 'first/context.md', tags: [], title: 'First'},
        {content: 'Second', keywords: [], path: 'second/context.md', tags: [], title: 'Second'},
        {content: 'Third', keywords: [], path: 'third/context.md', tags: [], title: 'Third'},
      ]

      const result = mapToPushContexts({addedFiles, deletedPaths: [], modifiedFiles: []})

      expect(result).to.have.lengthOf(3)
      expect(result[0].path).to.equal('first/context.md')
      expect(result[1].path).to.equal('second/context.md')
      expect(result[2].path).to.equal('third/context.md')
    })
  })

  describe('multiple files', () => {
    it('should map all added files correctly', () => {
      const addedFiles: ContextFileContent[] = [
        {content: 'Content A', keywords: [], path: 'a/context.md', tags: [], title: 'Title A'},
        {content: 'Content B', keywords: [], path: 'b/context.md', tags: [], title: 'Title B'},
      ]

      const result = mapToPushContexts({addedFiles, deletedPaths: [], modifiedFiles: []})

      expect(result).to.have.lengthOf(2)

      expect(result[0].content).to.equal('Content A')
      expect(result[0].path).to.equal('a/context.md')
      expect(result[0].title).to.equal('Title A')
      expect(result[0].operation).to.equal('add')
      expect(result[0].tags).to.deep.equal([])

      expect(result[1].content).to.equal('Content B')
      expect(result[1].path).to.equal('b/context.md')
      expect(result[1].title).to.equal('Title B')
      expect(result[1].operation).to.equal('add')
      expect(result[1].tags).to.deep.equal([])
    })
  })

  describe('mapping modified files', () => {
    it('should map modified files to push contexts with operation "edit"', () => {
      const modifiedFiles: ContextFileContent[] = [
        {
          content: 'Updated content',
          keywords: [],
          path: 'structure/context.md',
          tags: [],
          title: 'Updated Title',
        },
      ]

      const result = mapToPushContexts({addedFiles: [], deletedPaths: [], modifiedFiles})

      expect(result).to.have.lengthOf(1)
      expect(result[0].operation).to.equal('edit')
      expect(result[0].path).to.equal('structure/context.md')
      expect(result[0].title).to.equal('Updated Title')
      expect(result[0].content).to.equal('Updated content')
      expect(result[0].tags).to.deep.equal([])
    })

    it('should map multiple modified files correctly', () => {
      const modifiedFiles: ContextFileContent[] = [
        {content: 'Updated A', keywords: [], path: 'a/context.md', tags: [], title: 'Title A'},
        {content: 'Updated B', keywords: [], path: 'b/context.md', tags: [], title: 'Title B'},
      ]

      const result = mapToPushContexts({addedFiles: [], deletedPaths: [], modifiedFiles})

      expect(result).to.have.lengthOf(2)
      expect(result[0].operation).to.equal('edit')
      expect(result[1].operation).to.equal('edit')
    })
  })

  describe('mixing added and modified files', () => {
    it('should process both added and modified files', () => {
      const addedFiles: ContextFileContent[] = [
        {content: 'New content', keywords: [], path: 'new/context.md', tags: [], title: 'New File'},
      ]
      const modifiedFiles: ContextFileContent[] = [
        {content: 'Updated content', keywords: [], path: 'existing/context.md', tags: [], title: 'Updated File'},
      ]

      const result = mapToPushContexts({addedFiles, deletedPaths: [], modifiedFiles})

      expect(result).to.have.lengthOf(2)
    })

    it('should place added files before modified files', () => {
      const addedFiles: ContextFileContent[] = [
        {content: 'New', keywords: [], path: 'new/context.md', tags: [], title: 'New'},
      ]
      const modifiedFiles: ContextFileContent[] = [
        {content: 'Updated', keywords: [], path: 'existing/context.md', tags: [], title: 'Updated'},
      ]

      const result = mapToPushContexts({addedFiles, deletedPaths: [], modifiedFiles})

      expect(result[0].operation).to.equal('add')
      expect(result[0].path).to.equal('new/context.md')
      expect(result[1].operation).to.equal('edit')
      expect(result[1].path).to.equal('existing/context.md')
    })

    it('should handle multiple added and modified files', () => {
      const addedFiles: ContextFileContent[] = [
        {content: 'New 1', keywords: [], path: 'new1/context.md', tags: [], title: 'New 1'},
        {content: 'New 2', keywords: [], path: 'new2/context.md', tags: [], title: 'New 2'},
      ]
      const modifiedFiles: ContextFileContent[] = [
        {content: 'Updated 1', keywords: [], path: 'existing1/context.md', tags: [], title: 'Updated 1'},
        {content: 'Updated 2', keywords: [], path: 'existing2/context.md', tags: [], title: 'Updated 2'},
      ]

      const result = mapToPushContexts({addedFiles, deletedPaths: [], modifiedFiles})

      expect(result).to.have.lengthOf(4)
      expect(result[0].operation).to.equal('add')
      expect(result[1].operation).to.equal('add')
      expect(result[2].operation).to.equal('edit')
      expect(result[3].operation).to.equal('edit')
    })
  })

  describe('mapping deleted files', () => {
    it('should map deleted paths to push contexts with operation "delete"', () => {
      const deletedPaths = ['obsolete/context.md']

      const result = mapToPushContexts({addedFiles: [], deletedPaths, modifiedFiles: []})

      expect(result).to.have.lengthOf(1)
      expect(result[0].operation).to.equal('delete')
    })

    it('should set correct path for deleted files', () => {
      const deletedPaths = ['structure/old/context.md']

      const result = mapToPushContexts({addedFiles: [], deletedPaths, modifiedFiles: []})

      expect(result[0].path).to.equal('structure/old/context.md')
    })

    it('should set empty content and title for delete operation', () => {
      const deletedPaths = ['test/context.md']

      const result = mapToPushContexts({addedFiles: [], deletedPaths, modifiedFiles: []})

      expect(result[0].content).to.equal('')
      expect(result[0].title).to.equal('')
      expect(result[0].tags).to.deep.equal([])
    })

    it('should map multiple deleted paths correctly', () => {
      const deletedPaths = ['a/context.md', 'b/context.md', 'c/context.md']

      const result = mapToPushContexts({addedFiles: [], deletedPaths, modifiedFiles: []})

      expect(result).to.have.lengthOf(3)
      expect(result[0].operation).to.equal('delete')
      expect(result[0].path).to.equal('a/context.md')
      expect(result[1].operation).to.equal('delete')
      expect(result[1].path).to.equal('b/context.md')
      expect(result[2].operation).to.equal('delete')
      expect(result[2].path).to.equal('c/context.md')
    })
  })

  describe('mixing added, modified, and deleted files', () => {
    it('should process all three operation types', () => {
      const addedFiles: ContextFileContent[] = [
        {content: 'New content', keywords: [], path: 'new/context.md', tags: [], title: 'New File'},
      ]
      const modifiedFiles: ContextFileContent[] = [
        {content: 'Updated content', keywords: [], path: 'existing/context.md', tags: [], title: 'Updated File'},
      ]
      const deletedPaths = ['obsolete/context.md']

      const result = mapToPushContexts({addedFiles, deletedPaths, modifiedFiles})

      expect(result).to.have.lengthOf(3)
    })

    it('should place operations in order: added, edited, deleted', () => {
      const addedFiles: ContextFileContent[] = [
        {content: 'New', keywords: [], path: 'new/context.md', tags: [], title: 'New'},
      ]
      const modifiedFiles: ContextFileContent[] = [
        {content: 'Updated', keywords: [], path: 'existing/context.md', tags: [], title: 'Updated'},
      ]
      const deletedPaths = ['obsolete/context.md']

      const result = mapToPushContexts({addedFiles, deletedPaths, modifiedFiles})

      expect(result[0].operation).to.equal('add')
      expect(result[0].path).to.equal('new/context.md')
      expect(result[1].operation).to.equal('edit')
      expect(result[1].path).to.equal('existing/context.md')
      expect(result[2].operation).to.equal('delete')
      expect(result[2].path).to.equal('obsolete/context.md')
    })

    it('should handle multiple files of each operation type', () => {
      const addedFiles: ContextFileContent[] = [
        {content: 'New 1', keywords: [], path: 'new1/context.md', tags: [], title: 'New 1'},
        {content: 'New 2', keywords: [], path: 'new2/context.md', tags: [], title: 'New 2'},
      ]
      const modifiedFiles: ContextFileContent[] = [
        {content: 'Updated 1', keywords: [], path: 'existing1/context.md', tags: [], title: 'Updated 1'},
      ]
      const deletedPaths = ['obsolete1/context.md', 'obsolete2/context.md']

      const result = mapToPushContexts({addedFiles, deletedPaths, modifiedFiles})

      expect(result).to.have.lengthOf(5)
      expect(result[0].operation).to.equal('add')
      expect(result[1].operation).to.equal('add')
      expect(result[2].operation).to.equal('edit')
      expect(result[3].operation).to.equal('delete')
      expect(result[4].operation).to.equal('delete')
    })
  })

  // Slice 8.7 — channel/<id>/turns/<turnId>/** is ephemeral per-turn ACP
  // state and must NOT be pushed via CoGit. The mapper relies on
  // isExcludedFromSync(), which delegates to isChannelTurnArtifact().
  // The channel's meta.json (durable definition) still flows through.
  describe('filters channel turn artifacts (Slice 8.7)', () => {
    it('should drop added channel turn artifacts (events.jsonl, turn.json, deliveries/*.json)', () => {
      const addedFiles: ContextFileContent[] = [
        {content: '{}', keywords: [], path: 'channel/foo/turns/abc/events.jsonl', tags: [], title: 'turn events'},
        {content: '{}', keywords: [], path: 'channel/foo/turns/abc/turn.json', tags: [], title: 'turn snapshot'},
        {content: '{}', keywords: [], path: 'channel/foo/turns/abc/deliveries/d1.json', tags: [], title: 'delivery'},
        {content: 'kept', keywords: [], path: 'channel/foo/meta.json', tags: [], title: 'channel meta'},
        {content: 'kept', keywords: [], path: 'domain/context.md', tags: [], title: 'normal knowledge'},
      ]

      const result = mapToPushContexts({addedFiles, deletedPaths: [], modifiedFiles: []})

      expect(result).to.have.lengthOf(2)
      expect(result.map((r) => r.path)).to.deep.equal(['channel/foo/meta.json', 'domain/context.md'])
    })

    it('should drop modified channel turn artifacts', () => {
      const modifiedFiles: ContextFileContent[] = [
        {content: '{}', keywords: [], path: 'channel/foo/turns/abc/events.jsonl', tags: [], title: 'turn events'},
        {content: 'updated', keywords: [], path: 'channel/foo/meta.json', tags: [], title: 'channel meta'},
      ]

      const result = mapToPushContexts({addedFiles: [], deletedPaths: [], modifiedFiles})

      expect(result).to.have.lengthOf(1)
      expect(result[0].path).to.equal('channel/foo/meta.json')
      expect(result[0].operation).to.equal('edit')
    })

    it('should drop deleted channel turn paths', () => {
      const deletedPaths = [
        'channel/foo/turns/abc/events.jsonl',
        'channel/foo/turns/abc/turn.json',
        'channel/foo/meta.json',
      ]

      const result = mapToPushContexts({addedFiles: [], deletedPaths, modifiedFiles: []})

      expect(result).to.have.lengthOf(1)
      expect(result[0].path).to.equal('channel/foo/meta.json')
      expect(result[0].operation).to.equal('delete')
    })

    it('should keep paths for a channel literally named "turns" (segments[0]=channel required)', () => {
      const addedFiles: ContextFileContent[] = [
        {content: 'kept', keywords: [], path: 'channel/turns/meta.json', tags: [], title: 'channel named turns'},
      ]

      const result = mapToPushContexts({addedFiles, deletedPaths: [], modifiedFiles: []})

      expect(result).to.have.lengthOf(1)
      expect(result[0].path).to.equal('channel/turns/meta.json')
    })
  })
})
