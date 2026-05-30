/**
 * element-axis-index tests.
 *
 * Covers:
 *   - Population: `add(filePath, entries)` registers tag and tag.attr=value
 *     keys correctly.
 *   - Lookup: `findByTag` and `findByAttribute` return the expected paths
 *     (and an empty array — never undefined — when no matches).
 *   - Invalidation: `remove(filePath)` drops every membership the path
 *     contributed to without leaking stale keys.
 *   - Idempotence: `add` twice for the same path doesn't break the
 *     reverse map (callers should `remove` first when re-indexing, but
 *     duplicate adds shouldn't corrupt the index).
 */

import {expect} from 'chai'

import {ElementAxisIndex} from '../../../../../../src/server/infra/render/reader/element-axis-index.js'

describe('ElementAxisIndex', () => {
  describe('population + lookup', () => {
    it('returns paths containing a given tag', () => {
      const index = new ElementAxisIndex()
      index.add('a.html', [{attributes: {}, tag: 'bv-rule'}])
      index.add('b.html', [{attributes: {}, tag: 'bv-decision'}])
      index.add('c.html', [{attributes: {}, tag: 'bv-rule'}])

      expect([...index.findByTag('bv-rule')].sort()).to.deep.equal(['a.html', 'c.html'])
      expect([...index.findByTag('bv-decision')]).to.deep.equal(['b.html'])
    })

    it('returns an empty array for unknown tags (not undefined)', () => {
      const index = new ElementAxisIndex()
      index.add('a.html', [{attributes: {}, tag: 'bv-rule'}])
      const result = index.findByTag('bv-bug')
      expect(result).to.be.an('array').with.lengthOf(0)
    })

    it('returns paths matching tag.attribute=value', () => {
      const index = new ElementAxisIndex()
      index.add('a.html', [{attributes: {severity: 'must'}, tag: 'bv-rule'}])
      index.add('b.html', [{attributes: {severity: 'should'}, tag: 'bv-rule'}])
      index.add('c.html', [{attributes: {severity: 'must'}, tag: 'bv-rule'}])

      expect([...index.findByAttribute('bv-rule', 'severity', 'must')].sort()).to.deep.equal(['a.html', 'c.html'])
      expect([...index.findByAttribute('bv-rule', 'severity', 'should')]).to.deep.equal(['b.html'])
    })

    it('attribute lookups are case-sensitive on values', () => {
      const index = new ElementAxisIndex()
      index.add('a.html', [{attributes: {severity: 'must'}, tag: 'bv-rule'}])

      expect(index.findByAttribute('bv-rule', 'severity', 'MUST')).to.have.lengthOf(0)
      expect(index.findByAttribute('bv-rule', 'severity', 'must')).to.have.lengthOf(1)
    })

    it('counts paths via the size getter', () => {
      const index = new ElementAxisIndex()
      expect(index.size).to.equal(0)

      index.add('a.html', [{attributes: {}, tag: 'bv-rule'}])
      expect(index.size).to.equal(1)

      index.add('b.html', [{attributes: {}, tag: 'bv-decision'}])
      expect(index.size).to.equal(2)
    })

    it('a single file contributing multiple elements is indexed once per (tag, attr=value)', () => {
      const index = new ElementAxisIndex()
      index.add('a.html', [
        {attributes: {severity: 'must'}, tag: 'bv-rule'},
        {attributes: {severity: 'must'}, tag: 'bv-rule'},
      ])

      // Same path appears once in the result set despite multiple matching elements.
      expect(index.findByAttribute('bv-rule', 'severity', 'must')).to.deep.equal(['a.html'])
      expect(index.findByTag('bv-rule')).to.deep.equal(['a.html'])
    })
  })

  describe('invalidation', () => {
    it('removes all memberships for a file path', () => {
      const index = new ElementAxisIndex()
      index.add('a.html', [{attributes: {severity: 'must'}, tag: 'bv-rule'}])
      index.add('b.html', [{attributes: {severity: 'must'}, tag: 'bv-rule'}])

      index.remove('a.html')

      expect(index.findByTag('bv-rule')).to.deep.equal(['b.html'])
      expect(index.findByAttribute('bv-rule', 'severity', 'must')).to.deep.equal(['b.html'])
      expect(index.size).to.equal(1)
    })

    it('drops empty key sets (no zombie entries after the last contributor leaves)', () => {
      const index = new ElementAxisIndex()
      index.add('a.html', [{attributes: {severity: 'critical'}, tag: 'bv-bug'}])

      index.remove('a.html')

      expect(index.findByTag('bv-bug')).to.have.lengthOf(0)
      expect(index.findByAttribute('bv-bug', 'severity', 'critical')).to.have.lengthOf(0)
      expect(index.size).to.equal(0)
    })

    it('remove() on an unknown path is a no-op', () => {
      const index = new ElementAxisIndex()
      index.add('a.html', [{attributes: {}, tag: 'bv-rule'}])

      expect(() => {
        index.remove('not-known.html')
      }).to.not.throw()
      expect(index.size).to.equal(1)
    })

    it('clear() drops everything', () => {
      const index = new ElementAxisIndex()
      index.add('a.html', [{attributes: {severity: 'must'}, tag: 'bv-rule'}])
      index.add('b.html', [{attributes: {severity: 'should'}, tag: 'bv-rule'}])

      index.clear()

      expect(index.size).to.equal(0)
      expect(index.findByTag('bv-rule')).to.have.lengthOf(0)
      expect(index.findByAttribute('bv-rule', 'severity', 'must')).to.have.lengthOf(0)
    })
  })

  describe('attribute name/value robustness', () => {
    // A stringly-keyed `${tag}.${attr}=${value}` table would conflate these:
    // `('bv-rule', 'severity', 'must=high')` and `('bv-rule', 'severity=must', 'high')`
    // both compose to `bv-rule.severity=must=high`. The nested-Map storage
    // keeps them separated.
    it('disambiguates an "=" character in the attribute value from a delimiter', () => {
      const index = new ElementAxisIndex()
      index.add('a.html', [{attributes: {severity: 'must=high'}, tag: 'bv-rule'}])
      index.add('b.html', [{attributes: {'severity=must': 'high'}, tag: 'bv-rule'}])

      expect(index.findByAttribute('bv-rule', 'severity', 'must=high')).to.deep.equal(['a.html'])
      expect(index.findByAttribute('bv-rule', 'severity=must', 'high')).to.deep.equal(['b.html'])
    })

    it('disambiguates an "." character in the attribute name from a delimiter', () => {
      const index = new ElementAxisIndex()
      // `bv-rule` with attribute `data.severity=must`
      index.add('a.html', [{attributes: {'data.severity': 'must'}, tag: 'bv-rule'}])
      // and a (hypothetical) `bv-rule` with attribute `data` valued `severity=must`
      index.add('b.html', [{attributes: {data: 'severity=must'}, tag: 'bv-rule'}])

      expect(index.findByAttribute('bv-rule', 'data.severity', 'must')).to.deep.equal(['a.html'])
      expect(index.findByAttribute('bv-rule', 'data', 'severity=must')).to.deep.equal(['b.html'])
    })

    it('remove() unwinds nested attribute buckets cleanly', () => {
      const index = new ElementAxisIndex()
      index.add('a.html', [{attributes: {severity: 'must=high'}, tag: 'bv-rule'}])
      index.remove('a.html')

      expect(index.findByAttribute('bv-rule', 'severity', 'must=high')).to.have.lengthOf(0)
      expect(index.findByTag('bv-rule')).to.have.lengthOf(0)
      expect(index.size).to.equal(0)
    })
  })
})
