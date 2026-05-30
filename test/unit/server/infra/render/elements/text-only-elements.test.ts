/**
 * Validator tests for the attribute-free text-only elements:
 *   - `<bv-reason>`        — `## Reason` body section
 *   - `<bv-task>`          — `## Raw Concept > Task`
 *   - `<bv-changes>`       — `## Raw Concept > Changes`
 *   - `<bv-files>`         — `## Raw Concept > Files`
 *   - `<bv-flow>`          — `## Raw Concept > Flow`
 *   - `<bv-timestamp>`     — `## Raw Concept > Timestamp`
 *   - `<bv-author>`        — `## Raw Concept > Author`
 *   - `<bv-structure>`     — `## Narrative > Structure`
 *   - `<bv-dependencies>`  — `## Narrative > Dependencies`
 *   - `<bv-highlights>`    — `## Narrative > Highlights`
 *   - `<bv-examples>`      — `## Narrative > Examples`
 *
 * These elements all share the same schema shape (no required or
 * declared attributes; passthrough tolerates anything). One test file
 * exercises the shared invariants without per-element repetition.
 */

import {expect} from 'chai'

import type {ElementNode} from '../../../../../../src/server/core/domain/render/element-types.js'

import {validateBvAuthor} from '../../../../../../src/server/infra/render/elements/bv-author/validator.js'
import {validateBvChanges} from '../../../../../../src/server/infra/render/elements/bv-changes/validator.js'
import {validateBvDependencies} from '../../../../../../src/server/infra/render/elements/bv-dependencies/validator.js'
import {validateBvExamples} from '../../../../../../src/server/infra/render/elements/bv-examples/validator.js'
import {validateBvFiles} from '../../../../../../src/server/infra/render/elements/bv-files/validator.js'
import {validateBvFlow} from '../../../../../../src/server/infra/render/elements/bv-flow/validator.js'
import {validateBvHighlights} from '../../../../../../src/server/infra/render/elements/bv-highlights/validator.js'
import {validateBvReason} from '../../../../../../src/server/infra/render/elements/bv-reason/validator.js'
import {validateBvStructure} from '../../../../../../src/server/infra/render/elements/bv-structure/validator.js'
import {validateBvTask} from '../../../../../../src/server/infra/render/elements/bv-task/validator.js'
import {validateBvTimestamp} from '../../../../../../src/server/infra/render/elements/bv-timestamp/validator.js'

function makeNode(tagName: string, attributes: Record<string, string> = {}): ElementNode {
  return {attributes, children: [], tagName, type: 'element'}
}

const cases: Array<{name: string; tag: string; validate: (n: ElementNode) => {valid: boolean}}> = [
  {name: 'bv-reason', tag: 'bv-reason', validate: validateBvReason},
  {name: 'bv-task', tag: 'bv-task', validate: validateBvTask},
  {name: 'bv-changes', tag: 'bv-changes', validate: validateBvChanges},
  {name: 'bv-files', tag: 'bv-files', validate: validateBvFiles},
  {name: 'bv-flow', tag: 'bv-flow', validate: validateBvFlow},
  {name: 'bv-timestamp', tag: 'bv-timestamp', validate: validateBvTimestamp},
  {name: 'bv-author', tag: 'bv-author', validate: validateBvAuthor},
  {name: 'bv-structure', tag: 'bv-structure', validate: validateBvStructure},
  {name: 'bv-dependencies', tag: 'bv-dependencies', validate: validateBvDependencies},
  {name: 'bv-highlights', tag: 'bv-highlights', validate: validateBvHighlights},
  {name: 'bv-examples', tag: 'bv-examples', validate: validateBvExamples},
]

describe('text-only element validators', () => {
  for (const c of cases) {
    describe(c.name, () => {
      it('accepts an empty attribute set', () => {
        expect(c.validate(makeNode(c.tag)).valid).to.equal(true)
      })

      it('tolerates unknown attributes (parse-and-skip — light validation)', () => {
        expect(c.validate(makeNode(c.tag, {someFutureAttr: 'x'})).valid).to.equal(true)
      })

      it('rejects wrong tag name (defensive — registry should never miswire)', () => {
        const result = c.validate(makeNode('bv-rule'))
        expect(result.valid).to.equal(false)
      })
    })
  }
})
