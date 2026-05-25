import {expect} from 'chai'

import type {QueryLogMatchedDoc} from '../../../../../src/server/core/domain/entities/query-log-entry.js'

import {ExtensionAwareFormatDetector} from '../../../../../src/server/infra/render/format/extension-aware-format-detector.js'

describe('ExtensionAwareFormatDetector', () => {
  let detector: ExtensionAwareFormatDetector

  beforeEach(() => {
    detector = new ExtensionAwareFormatDetector()
  })

  it('should return undefined when matchedDocs is empty', () => {
    expect(detector.detect([])).to.be.undefined
  })

  it("should return 'markdown' for a single .md doc", () => {
    const docs: QueryLogMatchedDoc[] = [{path: 'design/caching.md', score: 0.9, title: 'Caching'}]
    expect(detector.detect(docs)).to.equal('markdown')
  })

  it("should return 'html' for a single .html doc", () => {
    const docs: QueryLogMatchedDoc[] = [{path: 'design/caching.html', score: 0.9, title: 'Caching'}]
    expect(detector.detect(docs)).to.equal('html')
  })

  it("should treat .htm as html (legacy extension)", () => {
    const docs: QueryLogMatchedDoc[] = [{path: 'design/caching.htm', score: 0.9, title: 'Caching'}]
    expect(detector.detect(docs)).to.equal('html')
  })

  it("should return 'html' when ANY doc is .html (mixed-format query)", () => {
    // Post-migration, HTML is the new emission format. Any HTML doc retrieved
    // is the load-bearing signal: this query touched the new format. Reporting
    // 'markdown' for a mixed result would hide HTML traffic from telemetry.
    const docs: QueryLogMatchedDoc[] = [
      {path: 'a.md', score: 0.9, title: 'A'},
      {path: 'b.html', score: 0.85, title: 'B'},
      {path: 'c.md', score: 0.8, title: 'C'},
    ]
    expect(detector.detect(docs)).to.equal('html')
  })

  it("should return 'markdown' when all docs are markdown (legacy-only query)", () => {
    const docs: QueryLogMatchedDoc[] = [
      {path: 'a.md', score: 0.9, title: 'A'},
      {path: 'b.md', score: 0.85, title: 'B'},
    ]
    expect(detector.detect(docs)).to.equal('markdown')
  })

  it("should normalize path case before matching", () => {
    const docs: QueryLogMatchedDoc[] = [{path: 'design/Caching.HTML', score: 0.9, title: 'Caching'}]
    expect(detector.detect(docs)).to.equal('html')
  })

  it("should treat shared-source paths ([alias]:rel/path.html) the same as local paths", () => {
    const docs: QueryLogMatchedDoc[] = [{path: '[shared]:design/caching.html', score: 0.9, title: 'Caching'}]
    expect(detector.detect(docs)).to.equal('html')
  })

  it("should default to markdown for paths with no extension (defensive)", () => {
    // Stub-grade fallback. No production path produces extensionless context-tree
    // files today, but if one ever does we shouldn't return undefined and corrupt
    // telemetry rollups — pick the legacy default.
    const docs: QueryLogMatchedDoc[] = [{path: 'design/no-extension', score: 0.9, title: 'X'}]
    expect(detector.detect(docs)).to.equal('markdown')
  })
})
