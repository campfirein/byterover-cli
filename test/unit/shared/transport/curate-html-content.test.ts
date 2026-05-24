import {expect} from 'chai'

import {decodeCurateHtmlContent, encodeCurateHtmlContent} from '../../../../src/shared/transport/curate-html-content.js'

describe('curate-html-content', () => {
  describe('encodeCurateHtmlContent', () => {
    it('encodes html and confirmOverwrite as JSON', () => {
      const encoded = encodeCurateHtmlContent({confirmOverwrite: true, html: '<bv-topic path="x/y"></bv-topic>'})
      const parsed = JSON.parse(encoded)
      expect(parsed.html).to.equal('<bv-topic path="x/y"></bv-topic>')
      expect(parsed.confirmOverwrite).to.equal(true)
    })

    it('omits confirmOverwrite when undefined', () => {
      const encoded = encodeCurateHtmlContent({html: '<bv-topic></bv-topic>'})
      const parsed = JSON.parse(encoded)
      expect(parsed.html).to.equal('<bv-topic></bv-topic>')
      expect(parsed.confirmOverwrite).to.be.undefined
    })
  })

  describe('decodeCurateHtmlContent', () => {
    it('decodes JSON-encoded content', () => {
      const content = JSON.stringify({confirmOverwrite: true, html: '<bv-topic></bv-topic>'})
      const decoded = decodeCurateHtmlContent(content)
      expect(decoded.html).to.equal('<bv-topic></bv-topic>')
      expect(decoded.confirmOverwrite).to.equal(true)
    })

    it('throws a version-mismatch error on invalid JSON', () => {
      expect(() => decodeCurateHtmlContent('not-json{')).to.throw(/version mismatch/i)
    })

    it('throws when payload is JSON but missing string html field', () => {
      const content = JSON.stringify({confirmOverwrite: true})
      expect(() => decodeCurateHtmlContent(content)).to.throw(/string `html` field/)
    })

    it('throws when html field is not a string', () => {
      const content = JSON.stringify({html: 123})
      expect(() => decodeCurateHtmlContent(content)).to.throw(/string `html` field/)
    })

    it('ignores non-boolean confirmOverwrite', () => {
      const content = JSON.stringify({confirmOverwrite: 'yes', html: '<bv-topic></bv-topic>'})
      const decoded = decodeCurateHtmlContent(content)
      expect(decoded.html).to.equal('<bv-topic></bv-topic>')
      expect(decoded.confirmOverwrite).to.be.undefined
    })

    it('roundtrips with encodeCurateHtmlContent', () => {
      const original = {confirmOverwrite: true, html: '<bv-topic path="security/auth"></bv-topic>'}
      const decoded = decodeCurateHtmlContent(encodeCurateHtmlContent(original))
      expect(decoded.html).to.equal(original.html)
      expect(decoded.confirmOverwrite).to.equal(original.confirmOverwrite)
    })

    it('roundtrips without confirmOverwrite', () => {
      const original = {html: '<bv-topic path="a/b"></bv-topic>'}
      const decoded = decodeCurateHtmlContent(encodeCurateHtmlContent(original))
      expect(decoded.html).to.equal(original.html)
      expect(decoded.confirmOverwrite).to.be.undefined
    })

    it('roundtrips meta field losslessly', () => {
      const original = {
        confirmOverwrite: false,
        html: '<bv-topic path="security/auth"></bv-topic>',
        meta: {
          impact: 'high' as const,
          reason: 'Locks JWT signing algorithm.',
          summary: 'JWT: RS256 over HS256.',
          type: 'ADD' as const,
        },
      }
      const decoded = decodeCurateHtmlContent(encodeCurateHtmlContent(original))
      expect(decoded.html).to.equal(original.html)
      expect(decoded.meta).to.deep.equal(original.meta)
    })

    it('returns meta: undefined when payload omits it', () => {
      const content = JSON.stringify({html: '<bv-topic></bv-topic>'})
      const decoded = decodeCurateHtmlContent(content)
      expect(decoded.meta).to.be.undefined
    })

    it('returns meta: undefined when meta is present but invalid (graceful forward-compat)', () => {
      const content = JSON.stringify({
        html: '<bv-topic></bv-topic>',
        meta: {impact: 'severe'},
      })
      const decoded = decodeCurateHtmlContent(content)
      expect(decoded.meta).to.be.undefined
    })
  })
})
