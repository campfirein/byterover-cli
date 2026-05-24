/**
 * bv-topic validator tests.
 *
 * The root container element. Carries frontmatter as attributes:
 *   - `path` — required; non-empty string identifying the topic
 *   - `title` — required; non-empty string
 *   - `summary` — optional; one-line summary (any non-empty string)
 *   - `tags` — optional; comma-separated category tags
 *   - `keywords` — optional; comma-separated retrieval keywords
 *   - `related` — optional; comma-separated `@domain/topic` cross-refs
 *
 * Notably absent: `importance`, `maturity`, `recency`, `updatedat`,
 * `createdAt`. Per the runtime-signals migration these are sidecar
 * state — per-user / per-machine — not file content. Including them
 * here would re-introduce the noise-from-implicit-state problem the
 * migration solved.
 *
 * Light validation; strict validation per ADR-007 §13 is future work.
 * Unknown attributes are tolerated (parse-and-skip — no warning emitted);
 * test confirms tolerance, not absence.
 */

import {expect} from 'chai'

import type {ElementNode} from '../../../../../../src/server/core/domain/render/element-types.js'

import {validateBvTopic} from '../../../../../../src/server/infra/render/elements/bv-topic/validator.js'

function makeNode(attributes: Record<string, string>, tagName = 'bv-topic'): ElementNode {
  return {attributes, children: [], tagName, type: 'element'}
}

describe('bv-topic validator', () => {
  describe('valid', () => {
    it('accepts the minimum: `path` + `title`', () => {
      const result = validateBvTopic(makeNode({path: 'security/auth', title: 'JWT auth'}))
      expect(result.valid).to.equal(true)
    })

    it('accepts all frontmatter attributes set together', () => {
      const result = validateBvTopic(makeNode({
        keywords: 'jwt,refresh,token',
        path: 'security/auth',
        related: '@security/cookies,@security/oauth',
        summary: 'JWT auth design overview',
        tags: 'security,authentication',
        title: 'JWT auth',
      }))
      expect(result.valid).to.equal(true)
    })

    it('tolerates unknown attributes (parse-and-skip — light validation)', () => {
      const result = validateBvTopic(makeNode({path: 'x', someFutureAttr: 'whatever', title: 't'}))
      expect(result.valid).to.equal(true)
    })

    it('tolerates empty list-shaped attributes', () => {
      const result = validateBvTopic(makeNode({
        keywords: '',
        path: 'x',
        tags: '',
        title: 't',
      }))
      expect(result.valid).to.equal(true)
    })
  })

  describe('invalid', () => {
    it('rejects missing `path`', () => {
      const result = validateBvTopic(makeNode({title: 't'}))
      expect(result.valid).to.equal(false)
      if (!result.valid) {
        expect(result.errors.some((e) => e.field === 'path')).to.equal(true)
      }
    })

    it('rejects empty `path`', () => {
      const result = validateBvTopic(makeNode({path: '', title: 't'}))
      expect(result.valid).to.equal(false)
    })

    it('rejects missing `title`', () => {
      const result = validateBvTopic(makeNode({path: 'x'}))
      expect(result.valid).to.equal(false)
      if (!result.valid) {
        expect(result.errors.some((e) => e.field === 'title')).to.equal(true)
      }
    })

    it('rejects empty `title`', () => {
      const result = validateBvTopic(makeNode({path: 'x', title: ''}))
      expect(result.valid).to.equal(false)
    })

    it('rejects wrong tag name (defensive — registry should never call wrong validator)', () => {
      const result = validateBvTopic(makeNode({path: 'x', title: 't'}, 'bv-rule'))
      expect(result.valid).to.equal(false)
      if (!result.valid) {
        expect(result.errors.some((e) => e.field === 'tagName')).to.equal(true)
      }
    })
  })

  describe('reserved attributes are rejected at validation', () => {
    // These fields lived on bv-topic in an earlier draft. They were
    // moved to the runtime-signal sidecar store (per-user, per-machine,
    // bumped on every brv query) so re-introducing them here would
    // revert that migration. The schema's `.superRefine` rejects them
    // so the calling agent gets a structured `attribute-validation`
    // error and the correction loop fires — silent passthrough would
    // mask the contract violation.
    for (const field of ['importance', 'maturity', 'recency', 'createdat', 'updatedat']) {
      it(`rejects \`${field}\` as a reserved system attribute`, () => {
        const result = validateBvTopic(makeNode({[field]: 'whatever', path: 'x', title: 't'}))
        expect(result.valid).to.equal(false)
        if (result.valid) return
        expect(result.errors.some((e) => e.field === field)).to.equal(true)
      })
    }
  })
})
