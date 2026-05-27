import {expect} from 'chai'

import {
  htmlRelatedPaths,
  optStrTyped,
  parseFactBullets,
  parseFacts,
  parseFrontmatter,
  parseNarrative,
  parseRawConcept,
  parseReason,
  parseSection,
  pythonStrLen,
  strListTyped,
} from '../../../../../src/server/infra/migrate/parsers.js'

describe('migrate/parsers', () => {
  describe('parseFrontmatter', () => {
    it('returns no-frontmatter shape when content does not start with ---', () => {
      const r = parseFrontmatter('hello body')
      expect(r.frontmatter).to.equal(undefined)
      expect(r.body).to.equal('hello body')
      expect(r.yamlBlock).to.equal('')
      expect(r.parseError).to.equal(undefined)
    })

    it('parses well-formed LF frontmatter', () => {
      const r = parseFrontmatter('---\ntitle: Hello\n---\nbody')
      expect(r.frontmatter).to.deep.equal({title: 'Hello'})
      expect(r.body).to.equal('body')
      expect(r.parseError).to.equal(undefined)
    })

    it('parses well-formed CRLF frontmatter', () => {
      const r = parseFrontmatter('---\r\ntitle: Hello\r\n---\r\nbody')
      expect(r.frontmatter).to.deep.equal({title: 'Hello'})
      expect(r.body).to.equal('body')
      expect(r.parseError).to.equal(undefined)
    })

    it('returns unterminated-delimiter error when no closing fence', () => {
      const r = parseFrontmatter('---\ntitle: x\n## not a fence\n')
      expect(r.parseError).to.equal('unterminated-frontmatter-delimiter')
    })

    it('returns frontmatter-not-a-mapping error when YAML parses to non-object', () => {
      const r = parseFrontmatter('---\n- list\n- of\n- strings\n---\nbody')
      expect(r.parseError).to.match(/frontmatter-not-a-mapping \(got list\)/)
    })

    it('returns yaml-parse-error on malformed YAML', () => {
      const r = parseFrontmatter('---\n  bad: indent: oops\n---\nbody')
      expect(r.parseError).to.match(/^yaml-parse-error: /)
    })

    it('keeps ISO-style timestamps as strings (matches Python FrontmatterLoader)', () => {
      const r = parseFrontmatter('---\ncreatedAt: 2026-05-25T05:18:57.589Z\n---\nbody')
      expect(r.frontmatter?.createdAt).to.equal('2026-05-25T05:18:57.589Z')
    })

    it('parses YAML 1.1 booleans (yes/no/on/off) as booleans', () => {
      const r = parseFrontmatter('---\na: yes\nb: on\nc: No\n---\nbody')
      expect(r.frontmatter).to.deep.equal({a: true, b: true, c: false})
    })
  })

  describe('optStrTyped', () => {
    it('returns the string when value is a string', () => {
      const w: string[] = []
      expect(optStrTyped('hi', 'title', w)).to.equal('hi')
      expect(w).to.have.lengthOf(0)
    })

    it('returns undefined when value is undefined/null (no warning)', () => {
      const w: string[] = []
      expect(optStrTyped(undefined, 'title', w)).to.equal(undefined)
      expect(optStrTyped(null, 'title', w)).to.equal(undefined)
      expect(w).to.have.lengthOf(0)
    })

    it('warns with Python-style type name on mismatch', () => {
      const w: string[] = []
      expect(optStrTyped(42, 'title', w)).to.equal(undefined)
      expect(w[0]).to.equal('frontmatter-type-mismatch:title expected string, got int')

      const w2: string[] = []
      expect(optStrTyped(true, 'title', w2)).to.equal(undefined)
      expect(w2[0]).to.equal('frontmatter-type-mismatch:title expected string, got bool')

      const w3: string[] = []
      expect(optStrTyped([1, 2], 'tags', w3)).to.equal(undefined)
      expect(w3[0]).to.equal('frontmatter-type-mismatch:tags expected string, got list')
    })
  })

  describe('strListTyped', () => {
    it('splits a comma-separated string into trimmed parts', () => {
      const w: string[] = []
      expect(strListTyped('a, b ,c', 'tags', w)).to.deep.equal(['a', 'b', 'c'])
      expect(w).to.have.lengthOf(0)
    })

    it('returns [] for undefined/null', () => {
      const w: string[] = []
      expect(strListTyped(undefined, 'tags', w)).to.deep.equal([])
      expect(strListTyped(null, 'tags', w)).to.deep.equal([])
      expect(w).to.have.lengthOf(0)
    })

    it('passes through a list of strings', () => {
      const w: string[] = []
      expect(strListTyped(['a', 'b'], 'tags', w)).to.deep.equal(['a', 'b'])
      expect(w).to.have.lengthOf(0)
    })

    it('warns on mixed-type list, drops non-strings', () => {
      const w: string[] = []
      expect(strListTyped(['a', 2, 'b'], 'tags', w)).to.deep.equal(['a', 'b'])
      expect(w[0]).to.equal(
        'frontmatter-type-mismatch:tags contained 1 non-string element(s) — dropped',
      )
    })

    it('warns on wrong outer type', () => {
      const w: string[] = []
      expect(strListTyped(42, 'tags', w)).to.deep.equal([])
      expect(w[0]).to.equal(
        'frontmatter-type-mismatch:tags expected string or list, got int',
      )
    })
  })

  describe('htmlRelatedPaths', () => {
    it('rewrites .md → .html, leaves others alone', () => {
      expect(htmlRelatedPaths(['@a/b.md', '@c/d', 'e/f.html'])).to.deep.equal([
        '@a/b.html',
        '@c/d',
        'e/f.html',
      ])
    })
  })

  describe('parseSection', () => {
    it('returns the body of a named section', () => {
      const body = `## Reason
this is the reason
spanning two lines

## Facts
- a
`
      expect(parseSection(body, 'Reason')).to.equal('this is the reason\nspanning two lines')
    })

    it('is case-insensitive', () => {
      expect(parseSection('## reason\nfoo', 'Reason')).to.equal('foo')
    })

    it('returns undefined when section is missing', () => {
      expect(parseSection('## Other\nx', 'Reason')).to.equal(undefined)
    })

    it('stops at next ## section (back-to-back, no blank line)', () => {
      const body = '## Reason\nfoo\n## Facts\nbar'
      expect(parseSection(body, 'Reason')).to.equal('foo')
    })

    it('does not falsely terminate at ## inside a fenced block', () => {
      const body = `## Reason
text
\`\`\`
## not a section
\`\`\`
more text

## Facts
- a
`
      const r = parseSection(body, 'Reason')
      expect(r).to.include('## not a section')
    })

    it('stops at horizontal rule terminator', () => {
      const body = `## Reason
content here

---

trailing snippet
`
      expect(parseSection(body, 'Reason')).to.equal('content here')
    })

    it('handles end-of-input correctly when section has no trailing newline', () => {
      // This is the critical \Z → (?![\s\S]) regression test from
      // codex's review.
      expect(parseSection('## Reason\nfoo', 'Reason')).to.equal('foo')
      expect(parseSection('## Reason\nfoo\nbar', 'Reason')).to.equal('foo\nbar')
    })
  })

  describe('parseReason', () => {
    it('is a thin wrapper around parseSection("Reason")', () => {
      expect(parseReason('## Reason\nhi')).to.equal('hi')
    })
  })

  describe('parseRawConcept', () => {
    it('routes singular and plural labels to the same target', () => {
      const body = `## Raw Concept
**Tasks:**
implement plural support

**Files:**
- src/a.ts
- src/b.ts
`
      const {rawConcept, warnings} = parseRawConcept(body)
      expect(rawConcept.task).to.equal('implement plural support')
      expect(rawConcept.files).to.deep.equal(['src/a.ts', 'src/b.ts'])
      expect(warnings).to.have.lengthOf(0)
    })

    it('warns + drops unknown labels with char count', () => {
      const body = `## Raw Concept
**MysteryLabel:**
some content here
`
      const {warnings} = parseRawConcept(body)
      expect(warnings[0]).to.match(/^dropped-raw-concept-subsection:MysteryLabel \(\d+ chars\)$/)
    })

    it('returns {} when no Raw Concept section present', () => {
      const {rawConcept, warnings} = parseRawConcept('## Facts\n- a')
      expect(rawConcept).to.deep.equal({})
      expect(warnings).to.have.lengthOf(0)
    })

    it('extracts patterns subsection with backtick form', () => {
      const body = `## Raw Concept
**Patterns:**
- \`^foo$\` (flags: i) - matches foo
- \`^bar$\` - matches bar
`
      const {rawConcept} = parseRawConcept(body)
      expect(rawConcept.patterns).to.have.lengthOf(2)
      expect(rawConcept.patterns?.[0]).to.deep.equal({
        description: 'matches foo',
        flags: 'i',
        pattern: '^foo$',
      })
      expect(rawConcept.patterns?.[1]).to.deep.equal({
        description: 'matches bar',
        pattern: '^bar$',
      })
    })
  })

  describe('parseNarrative', () => {
    it('extracts canonical subsections', () => {
      const body = `## Narrative
### Structure
the structure body

### Rules
- MUST do thing

### Dependencies
deps content
`
      const {extras, narrative, warnings} = parseNarrative(body)
      expect(narrative.structure).to.equal('the structure body')
      expect(narrative.rules).to.equal('- MUST do thing')
      expect(narrative.dependencies).to.equal('deps content')
      expect(extras).to.deep.equal({})
      expect(warnings).to.have.lengthOf(0)
    })

    it('routes unknown ### subsections via NARRATIVE_SUBSECTION_HEURISTIC', () => {
      const body = `## Narrative
### Patterns
- p1
- p2

### Decisions
- d1
`
      const {extras} = parseNarrative(body)
      expect(extras.patterns).to.deep.equal(['p1', 'p2'])
      expect(extras.decisions).to.deep.equal(['d1'])
    })

    it('warns on unmappable ### subsections', () => {
      const body = `## Narrative
### Mystery
- m1
`
      const {warnings} = parseNarrative(body)
      expect(warnings[0]).to.match(/^dropped-narrative-subsection:Mystery \(\d+ chars\)$/)
    })

    it('extracts diagrams from ### Diagrams', () => {
      const body = `## Narrative
### Diagrams

**Architecture**
\`\`\`mermaid
graph LR; A --> B
\`\`\`

\`\`\`plantuml
@startuml
A -> B
@enduml
\`\`\`
`
      const {narrative} = parseNarrative(body)
      expect(narrative.diagrams).to.have.lengthOf(2)
      expect(narrative.diagrams?.[0]).to.deep.include({
        title: 'Architecture',
        type: 'mermaid',
      })
      expect(narrative.diagrams?.[1]?.type).to.equal('plantuml')
    })
  })

  describe('parseFactBullets', () => {
    it('parses structured **subject**: statement [category] form', () => {
      const facts = parseFactBullets('- **api**: returns JSON [convention]')
      expect(facts).to.deep.equal([
        {category: 'convention', statement: 'returns JSON', subject: 'api'},
      ])
    })

    it('parses plain bullet form', () => {
      const facts = parseFactBullets('- some plain fact')
      expect(facts).to.deep.equal([{statement: 'some plain fact'}])
    })

    it('skips non-bullet lines', () => {
      const facts = parseFactBullets('- a\nplain text\n- b')
      expect(facts).to.deep.equal([{statement: 'a'}, {statement: 'b'}])
    })
  })

  describe('parseFacts', () => {
    it('parses the ## Facts section as fact bullets', () => {
      const facts = parseFacts('## Facts\n- one\n* two\n1. three')
      expect(facts).to.have.lengthOf(3)
    })

    it('returns [] when ## Facts is missing', () => {
      expect(parseFacts('## Reason\nx')).to.deep.equal([])
    })
  })

  describe('pythonStrLen', () => {
    it('counts code points, not UTF-16 units (matches Python len())', () => {
      // The emoji is one code point but two UTF-16 code units.
      expect(pythonStrLen('a😀b')).to.equal(3)
      expect('a😀b'.length).to.equal(4)
    })

    it('matches JS .length for BMP text', () => {
      expect(pythonStrLen('hello')).to.equal(5)
    })
  })
})
