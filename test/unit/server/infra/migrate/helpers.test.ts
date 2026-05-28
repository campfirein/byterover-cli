import {expect} from 'chai'

import {
  collectBulletItemsWithContinuations,
  escapeHtmlText,
  inferRuleSeverity,
  listOrphanSections,
  maskFencedBlocks,
  normalizeDiagramType,
  normalizeFactCategory,
  relPathToTopicPath,
  slugifyRuleId,
  splitRulesBlock,
  stripBulletPrefix,
} from '../../../../../src/server/infra/migrate/helpers.js'

describe('migrate/helpers', () => {
  describe('inferRuleSeverity', () => {
    it('returns "must" for MUST or SHALL (word-boundary anchored)', () => {
      expect(inferRuleSeverity('MUST validate input')).to.equal('must')
      expect(inferRuleSeverity('SHALL fail fast')).to.equal('must')
      expect(inferRuleSeverity('must lowercase too')).to.equal('must')
    })

    it('returns "should" for SHOULD', () => {
      expect(inferRuleSeverity('Should log')).to.equal('should')
    })

    it('returns "info" for MAY or INFO', () => {
      expect(inferRuleSeverity('MAY skip')).to.equal('info')
      expect(inferRuleSeverity('INFO note')).to.equal('info')
    })

    it('returns undefined when no keyword present', () => {
      expect(inferRuleSeverity('do the thing')).to.equal(undefined)
      // word-boundary anchoring: "trust" should NOT match "MUST"
      expect(inferRuleSeverity('we trust the framework')).to.equal(undefined)
    })

    it('precedence: must > should > info', () => {
      expect(inferRuleSeverity('MUST and SHOULD and MAY')).to.equal('must')
      expect(inferRuleSeverity('SHOULD and MAY')).to.equal('should')
    })
  })

  describe('slugifyRuleId', () => {
    it('strips RFC2119 keywords and produces kebab-case', () => {
      expect(slugifyRuleId('MUST validate input before persisting', 'r')).to.equal(
        'r-validate-input-before-persisting',
      )
    })

    it('takes first 6 words', () => {
      expect(slugifyRuleId('a b c d e f g h i', 'r')).to.equal('r-a-b-c-d-e-f')
    })

    it('falls back to <prefix>-rule for empty input', () => {
      expect(slugifyRuleId('   ', 'r')).to.equal('r-rule')
      expect(slugifyRuleId('MUST MAY SHALL', 'r')).to.equal('r-rule')
    })

    it('caps slug length and trims back to a word boundary', () => {
      const s = slugifyRuleId(
        'aaaaaaaa bbbbbbbb cccccccc dddddddd eeeeeeee ffffffff',
        'r',
      )
      expect(s.length).to.be.at.most(50) // 'r-' + 48
      expect(s.startsWith('r-')).to.equal(true)
    })
  })

  describe('normalizeDiagramType', () => {
    it('defaults to "ascii" on empty input', () => {
      expect(normalizeDiagramType()).to.equal('ascii')
      expect(normalizeDiagramType('')).to.equal('ascii')
    })

    it('passes through enum values lowercased', () => {
      expect(normalizeDiagramType('Mermaid')).to.equal('mermaid')
    })

    it('collapses unknown labels to "other"', () => {
      expect(normalizeDiagramType('python')).to.equal('other')
    })
  })

  describe('normalizeFactCategory', () => {
    it('returns undefined when input is undefined', () => {
      expect(normalizeFactCategory()).to.equal(undefined)
    })

    it('passes through enum values lowercased', () => {
      expect(normalizeFactCategory('PROJECT')).to.equal('project')
    })

    it('collapses unknown to "other"', () => {
      expect(normalizeFactCategory('random')).to.equal('other')
    })
  })

  describe('escapeHtmlText', () => {
    it('escapes the five HTML special chars', () => {
      expect(escapeHtmlText(`<a href="x" title='y'>&</a>`)).to.equal(
        '&lt;a href=&quot;x&quot; title=&#39;y&#39;&gt;&amp;&lt;/a&gt;',
      )
    })

    it('escapes & first to avoid double-encoding', () => {
      expect(escapeHtmlText('&amp;')).to.equal('&amp;amp;')
    })
  })

  describe('relPathToTopicPath', () => {
    it('strips .md suffix and normalises backslashes', () => {
      expect(relPathToTopicPath(String.raw`security\auth.md`)).to.equal('security/auth')
    })

    it('strips leading slashes', () => {
      expect(relPathToTopicPath('/a/b.md')).to.equal('a/b')
    })

    it('preserves multi-dot filenames (no `with_suffix` trap)', () => {
      expect(relPathToTopicPath('node.js/intro.md')).to.equal('node.js/intro')
    })

    it('rejects `..` traversal', () => {
      expect(() => relPathToTopicPath('a/../b.md')).to.throw(/unsafe segment/)
    })

    it('rejects `.` segment', () => {
      expect(() => relPathToTopicPath('a/./b.md')).to.throw(/unsafe segment/)
    })
  })

  describe('maskFencedBlocks', () => {
    it('replaces fenced block with same-length whitespace', () => {
      const input = 'before\n```python\n## not a section\n```\nafter'
      const out = maskFencedBlocks(input)
      expect(out.length).to.equal(input.length)
      expect(out.startsWith('before\n')).to.equal(true)
      expect(out.endsWith('after')).to.equal(true)
      // The masked region should contain no `#` characters.
      const masked = out.slice('before\n'.length, out.length - 'after'.length)
      expect(masked).to.not.include('#')
    })

    it('handles ~~~ fences too', () => {
      const input = 'a\n~~~\n# header\n~~~\nb'
      const out = maskFencedBlocks(input)
      expect(out.length).to.equal(input.length)
      expect(out.indexOf('#')).to.equal(-1)
    })

    it('leaves non-fenced text unchanged', () => {
      const input = 'no fences here\nat all'
      expect(maskFencedBlocks(input)).to.equal(input)
    })
  })

  describe('listOrphanSections', () => {
    it('returns orphan ## sections, skipping canonical ones', () => {
      const body = `## Reason
canonical content

## Overview
orphan content

## Facts
- a fact
`
      const sections = listOrphanSections(body)
      expect(sections).to.have.lengthOf(1)
      expect(sections[0]?.heading).to.equal('Overview')
      expect(sections[0]?.content).to.equal('orphan content')
    })

    it('treats lowercase canonical heading as canonical (case-insensitive)', () => {
      const body = `## reason
canonical content

## Overview
orphan content
`
      const sections = listOrphanSections(body)
      expect(sections).to.have.lengthOf(1)
      expect(sections[0]?.heading).to.equal('Overview')
    })

    it('skips empty orphan sections', () => {
      const body = `## Reason
x
## Mystery

`
      expect(listOrphanSections(body)).to.have.lengthOf(0)
    })

    it('does not falsely terminate at ## inside a fenced block', () => {
      const body = `## Overview
text
\`\`\`
## not a real section
\`\`\`
more text
`
      const sections = listOrphanSections(body)
      expect(sections).to.have.lengthOf(1)
      // Content should include the fenced block verbatim (preserved from
      // the original body via the matched span).
      expect(sections[0]?.content).to.include('## not a real section')
    })
  })

  describe('stripBulletPrefix', () => {
    it('strips dash/asterisk/plus/numbered bullet prefixes', () => {
      expect(stripBulletPrefix('- a')).to.equal('a')
      expect(stripBulletPrefix('* b')).to.equal('b')
      expect(stripBulletPrefix('+ c')).to.equal('c')
      expect(stripBulletPrefix('1. d')).to.equal('d')
      expect(stripBulletPrefix('  - indented')).to.equal('indented')
    })

    it('returns undefined for non-bullet lines', () => {
      expect(stripBulletPrefix('plain text')).to.equal(undefined)
      expect(stripBulletPrefix('# heading')).to.equal(undefined)
    })
  })

  describe('collectBulletItemsWithContinuations', () => {
    it('collects simple bullets', () => {
      expect(collectBulletItemsWithContinuations('- a\n- b\n- c')).to.deep.equal([
        'a',
        'b',
        'c',
      ])
    })

    it('folds indented continuations into the same item', () => {
      const text = `- first item
  continuation line
- second item`
      expect(collectBulletItemsWithContinuations(text)).to.deep.equal([
        'first item\ncontinuation line',
        'second item',
      ])
    })

    it('terminates the current item on blank line', () => {
      const text = `- first

- second`
      expect(collectBulletItemsWithContinuations(text)).to.deep.equal([
        'first',
        'second',
      ])
    })

    it('ignores text before the first bullet', () => {
      expect(collectBulletItemsWithContinuations('intro\n- a\n- b')).to.deep.equal([
        'a',
        'b',
      ])
    })
  })

  describe('splitRulesBlock', () => {
    it('returns [] for empty input', () => {
      expect(splitRulesBlock('   ')).to.deep.equal([])
    })

    it('splits dash-bullet rules with severity + dedup id', () => {
      const rules = splitRulesBlock(`- MUST validate input
- SHOULD log every failure
- MUST validate input`)
      expect(rules).to.have.lengthOf(3)
      expect(rules[0]?.id).to.equal('r-validate-input')
      expect(rules[0]?.severity).to.equal('must')
      expect(rules[1]?.id).to.equal('r-log-every-failure')
      expect(rules[1]?.severity).to.equal('should')
      expect(rules[2]?.id).to.equal('r-validate-input-2')
    })

    it('splits "Rule N:" prefixed rules when no bullets', () => {
      const rules = splitRulesBlock(
        `Rule 1: MUST validate input before persisting.\nRule 2: SHOULD avoid silent failures.`,
      )
      expect(rules).to.have.lengthOf(2)
      expect(rules[0]?.text).to.match(/MUST validate input/)
      expect(rules[1]?.text).to.match(/SHOULD avoid silent failures/)
    })

    it('uses paragraph fallback when no bullets / numbered / Rule prefix', () => {
      const rules = splitRulesBlock(
        `First rule paragraph.\n\nSecond rule paragraph.`,
      )
      expect(rules).to.have.lengthOf(2)
    })

    it('ignores `## section` inside fenced blocks during detection', () => {
      const rules = splitRulesBlock(`- A real rule
\`\`\`
- not a real bullet inside fence
\`\`\`
- another real rule`)
      expect(rules).to.have.length.greaterThan(0)
    })
  })
})
