/**
 * Format-detector tests.
 *
 * `getFormatForRead(filePath)` is a pure extension-based dispatcher used
 * by the query/search read path to route between the legacy markdown
 * reader and the HTML reader.
 */

import {expect} from 'chai'

import {getFormatForRead} from '../../../../../../src/server/infra/render/format/format-detector.js'

describe('format-detector', () => {
  describe('getFormatForRead', () => {
    it('returns "html" for .html files', () => {
      expect(getFormatForRead('/path/to/topic.html')).to.equal('html')
    })

    it('returns "html" for .htm files', () => {
      expect(getFormatForRead('/path/to/topic.htm')).to.equal('html')
    })

    it('returns "markdown" for .md files', () => {
      expect(getFormatForRead('/path/to/topic.md')).to.equal('markdown')
    })

    it('returns "markdown" for unknown extensions', () => {
      expect(getFormatForRead('/path/to/topic.txt')).to.equal('markdown')
    })

    it('returns "markdown" for files with no extension', () => {
      expect(getFormatForRead('/path/to/README')).to.equal('markdown')
    })

    it('is case-insensitive on the extension', () => {
      expect(getFormatForRead('/path/to/Topic.HTML')).to.equal('html')
      expect(getFormatForRead('/path/to/Topic.MD')).to.equal('markdown')
    })

    it('handles relative paths', () => {
      expect(getFormatForRead('topic.html')).to.equal('html')
      expect(getFormatForRead('./nested/topic.html')).to.equal('html')
    })

    it('treats only the final segment\'s extension', () => {
      // A directory named `foo.html/` should not flip a `.md` file to html.
      expect(getFormatForRead('/path/foo.html/inner.md')).to.equal('markdown')
    })
  })
})
