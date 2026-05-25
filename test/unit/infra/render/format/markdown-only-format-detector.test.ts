import {expect} from 'chai'

import type {QueryLogMatchedDoc} from '../../../../../src/server/core/domain/entities/query-log-entry.js'

import {MarkdownOnlyFormatDetector} from '../../../../../src/server/infra/render/format/markdown-only-format-detector.js'

describe('MarkdownOnlyFormatDetector', () => {
  let detector: MarkdownOnlyFormatDetector

  beforeEach(() => {
    detector = new MarkdownOnlyFormatDetector()
  })

  it('should return undefined when matchedDocs is empty', () => {
    expect(detector.detect([])).to.be.undefined
  })

  it("should return 'markdown' when at least one .md doc is present", () => {
    const docs: QueryLogMatchedDoc[] = [{path: 'design/caching.md', score: 0.9, title: 'Caching'}]

    expect(detector.detect(docs)).to.equal('markdown')
  })

  it("should return 'markdown' even when docs have .html extensions (legacy stub semantics)", () => {
    // This stub IS the pre-migration behaviour — extension-blind, always
    // 'markdown'. Production now wires ExtensionAwareFormatDetector instead.
    // The stub is retained so callers / tests that pin legacy semantics can
    // opt into it explicitly.
    const docs: QueryLogMatchedDoc[] = [{path: 'design/caching.html', score: 0.9, title: 'Caching'}]

    expect(detector.detect(docs)).to.equal('markdown')
  })

  it('should return the same answer for any doc count >= 1', () => {
    const oneDoc: QueryLogMatchedDoc[] = [{path: 'a.md', score: 0.9, title: 'A'}]
    const manyDocs: QueryLogMatchedDoc[] = [
      {path: 'a.md', score: 0.9, title: 'A'},
      {path: 'b.md', score: 0.8, title: 'B'},
      {path: 'c.md', score: 0.7, title: 'C'},
    ]

    expect(detector.detect(oneDoc)).to.equal('markdown')
    expect(detector.detect(manyDocs)).to.equal('markdown')
  })
})
