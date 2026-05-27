import {expect} from 'chai'

import {
  checkUnknownFrontmatterKeys,
  checkYamlHashHazard,
  diagramsSectionSpan,
  extractAllFencedBlocks,
  extractH1Title,
  extractLedeParagraph,
  processOrphanSections,
} from '../../../../../src/server/infra/migrate/heuristics.js'

describe('migrate/heuristics', () => {
  describe('extractH1Title', () => {
    it('returns the first H1 before any ##', () => {
      expect(extractH1Title('# Real Title\nsome body')).to.equal('Real Title')
    })

    it('stops at first ## (returns undefined when no H1 precedes it)', () => {
      expect(extractH1Title('## Section\n# After H2 is ignored')).to.equal(undefined)
    })

    it('returns undefined when no H1 exists', () => {
      expect(extractH1Title('plain body')).to.equal(undefined)
    })
  })

  describe('extractLedeParagraph', () => {
    it('extracts text between H1 and first ##', () => {
      const body = `# Title

This is the lede.

It has two paragraphs.

## Reason
canonical
`
      const lede = extractLedeParagraph(body)
      expect(lede).to.equal('This is the lede.\n\nIt has two paragraphs.')
    })

    it('returns undefined when no H1 / no lede content', () => {
      expect(extractLedeParagraph('## Reason\nx')).to.equal(undefined)
      expect(extractLedeParagraph('# Title\n## Reason\nx')).to.equal(undefined)
    })

    it('terminates at horizontal rule', () => {
      expect(extractLedeParagraph('# T\nlede\n---\nafter')).to.equal('lede')
    })
  })

  describe('checkYamlHashHazard', () => {
    it('flags unquoted scalars containing " #"', () => {
      const w = checkYamlHashHazard('summary: a value # comment')
      expect(w).to.have.lengthOf(1)
      expect(w[0]).to.match(/yaml-comment-truncation:summary/)
    })

    it('does not flag quoted scalars', () => {
      expect(checkYamlHashHazard("summary: 'safe # value'")).to.have.lengthOf(0)
      expect(checkYamlHashHazard('summary: "safe # value"')).to.have.lengthOf(0)
    })

    it('does not flag block scalars (|, >, [, {)', () => {
      expect(checkYamlHashHazard('summary: |\n  with # inside\n  block')).to.have.lengthOf(0)
      expect(checkYamlHashHazard('summary: [a, b # in list]')).to.have.lengthOf(0)
    })
  })

  describe('checkUnknownFrontmatterKeys', () => {
    it('warns on unknown content keys', () => {
      // Frontmatter keys are intentionally snake_case at the YAML
      // boundary — disable the identifier rule for this fixture.
      // eslint-disable-next-line camelcase
      const w = checkUnknownFrontmatterKeys({weird_key: 'x'})
      expect(w).to.deep.equal(['dropped-frontmatter-key:weird_key'])
    })

    it('does not warn on known content keys', () => {
      expect(
        checkUnknownFrontmatterKeys({summary: 'y', tags: ['z'], title: 'x'}),
      ).to.have.lengthOf(0)
    })

    it('does not warn on runtime-signal keys (silently dropped)', () => {
      expect(
        checkUnknownFrontmatterKeys({accessCount: 7, importance: 1, recency: 0.5}),
      ).to.have.lengthOf(0)
    })
  })

  describe('extractAllFencedBlocks', () => {
    it('promotes fenced blocks with known languages by enum', () => {
      const body = '\n```mermaid\ngraph LR; A --> B\n```\n'
      const out = extractAllFencedBlocks(body, [])
      expect(out).to.have.lengthOf(1)
      expect(out[0]?.type).to.equal('mermaid')
      expect(out[0]?.content).to.equal('graph LR; A --> B')
    })

    it('collapses unknown languages to "other"', () => {
      const body = '\n```python\nprint("hi")\n```\n'
      const out = extractAllFencedBlocks(body, [])
      expect(out[0]?.type).to.equal('other')
    })

    it('skips blocks that overlap excludeSpans', () => {
      const body = '\n```a\nx\n```\n\n```b\ny\n```\n'
      // Exclude the first fence span. find its bounds.
      const firstFenceStart = body.indexOf('```a')
      const firstFenceEnd = body.indexOf('```\n', firstFenceStart) + 3
      const out = extractAllFencedBlocks(body, [[firstFenceStart, firstFenceEnd + 1]])
      expect(out).to.have.lengthOf(1)
    })

    it('captures **Title** preceding the fence (no blank line between)', () => {
      const body = '\n**Architecture**\n```mermaid\ngraph LR; A --> B\n```\n'
      const out = extractAllFencedBlocks(body, [])
      expect(out[0]?.title).to.equal('Architecture')
    })
  })

  describe('diagramsSectionSpan', () => {
    it('returns undefined when no Narrative section', () => {
      expect(diagramsSectionSpan('## Reason\nx')).to.equal(undefined)
    })

    it('returns undefined when Narrative has no Diagrams subsection', () => {
      const body = '## Narrative\n### Structure\nx'
      expect(diagramsSectionSpan(body)).to.equal(undefined)
    })

    it('replicates Python oracle: returns empty span (greedy `\\s*\\n` consumes body)', () => {
      // The Python oracle's regex `###\s*Diagrams\s*\n([\s\S]*?)(?=...|\Z)`
      // has a greedy `\s*\n` prefix that consumes all trailing whitespace,
      // leaving group 1 at zero length whether or not another section
      // follows. Result: dedup span is always empty, and the diagram emits
      // twice in <bv-topic> output (once via narrative.diagrams, once via
      // extract_all_fenced_blocks). The TS port preserves this behavior
      // for oracle parity — fixing the regex would change report JSON /
      // HTML output and is a separate task.
      const body = `## Narrative
### Diagrams

\`\`\`mermaid
graph LR; A --> B
\`\`\`
`
      const span = diagramsSectionSpan(body)
      expect(span).to.not.equal(undefined)
      const [start, end] = span as [number, number]
      expect(end - start).to.equal(0)
    })
  })

  describe('processOrphanSections', () => {
    it('routes ## Overview → reason when canonical reason is empty', () => {
      const {extras, warnings} = processOrphanSections({
        body: '## Overview\nrouted reason content',
        canonicalNarrative: {},
        canonicalReason: undefined,
        canonicalSummaryAttr: '',
      })
      expect(extras.reason).to.equal('routed reason content')
      expect(warnings).to.have.lengthOf(0)
    })

    it('drops + warns when canonical reason is already populated', () => {
      const {extras, warnings} = processOrphanSections({
        body: '## Overview\norphan content',
        canonicalNarrative: {},
        canonicalReason: 'already-there',
        canonicalSummaryAttr: '',
      })
      expect(extras.reason).to.equal(undefined)
      expect(warnings[0]).to.match(/dropped-orphan-section:Overview \(canonical <bv-reason>/)
    })

    it('routes ## Patterns to extras.patterns (multiple)', () => {
      const {extras} = processOrphanSections({
        body: '## Patterns\n- p1\n- p2\n- p3',
        canonicalNarrative: {},
        canonicalReason: undefined,
        canonicalSummaryAttr: '',
      })
      expect(extras.patterns).to.deep.equal(['p1', 'p2', 'p3'])
    })

    it('routes ## Rules via splitRulesBlock', () => {
      const {extras} = processOrphanSections({
        body: '## Rules\n- MUST validate\n- SHOULD log',
        canonicalNarrative: {},
        canonicalReason: undefined,
        canonicalSummaryAttr: '',
      })
      expect(extras.rules).to.have.lengthOf(2)
      expect(extras.rules?.[0]?.severity).to.equal('must')
      expect(extras.rules?.[1]?.severity).to.equal('should')
    })

    it('warns when orphan heading has no heuristic mapping', () => {
      const {warnings} = processOrphanSections({
        body: '## TotallyUnknown\nsome content',
        canonicalNarrative: {},
        canonicalReason: undefined,
        canonicalSummaryAttr: '',
      })
      expect(warnings[0]).to.match(/^dropped-orphan-section:TotallyUnknown \(\d+ chars — no bv-\* target\)$/)
    })

    it('warns when orphan Evidence has no parseable fact bullets', () => {
      const {warnings} = processOrphanSections({
        body: '## Evidence\njust prose, no bullets at all',
        canonicalNarrative: {},
        canonicalReason: undefined,
        canonicalSummaryAttr: '',
      })
      expect(warnings[0]).to.match(/^dropped-orphan-section:Evidence \(no parseable fact bullets in \d+ chars\)$/)
    })
  })
})
