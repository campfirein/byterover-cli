/**
 * Sanity tests for the curate tool description prompt.
 *
 * The prompt at `src/agent/resources/tools/curate.txt` is the canonical
 * curate output-format contract — it tells the agent that curate output
 * is HTML using the closed `<bv-*>` vocabulary. These tests guard
 * against silent drift: if a future PR adds a new element to the
 * registry but forgets the prompt, or removes a documented attribute
 * without updating downstream consumers, this test fails loudly.
 *
 * The tests are deliberately string-level (not behavioural). The
 * authoring-fluency check (off-tree harness) is the behavioural
 * counterpart.
 */

import {expect} from 'chai'
import {readFileSync} from 'node:fs'
import {join} from 'node:path'

import type {ElementName, ElementNode} from '../../../../../src/server/core/domain/render/element-types.js'

import {ELEMENT_NAMES} from '../../../../../src/server/core/domain/render/element-types.js'
import {ELEMENT_REGISTRY} from '../../../../../src/server/infra/render/elements/registry.js'
import {parseHtml, walkElements} from '../../../../../src/server/infra/render/reader/html-parser.js'

const PROMPT_PATH = join(process.cwd(), 'src/agent/resources/tools/curate.txt')

function loadPrompt(): string {
  return readFileSync(PROMPT_PATH, 'utf8')
}

/**
 * Slice the prompt section that documents a specific `<bv-*>` element.
 *
 * The prompt structure is: each element has its own paragraph block
 * starting with `` `<bv-NAME>` `` and continuing until the next
 * `` `<bv-`-prefixed block, the **Standard HTML inside…** clause, or
 * the **Detail-preservation** clause. Anchoring enum-value tests to
 * this slice catches drift like "severity moved from bv-bug to
 * bv-decision".
 */
function elementSection(prompt: string, tag: ElementName): string {
  const startMarker = `\`<${tag}>\``
  const start = prompt.indexOf(startMarker)
  if (start === -1) return ''
  // End at the next per-element header or a top-level **section** header.
  const rest = prompt.slice(start + startMarker.length)
  const nextElementMatch = rest.match(/`<bv-[a-z-]+>`/)
  const sectionMatch = rest.match(/\n\*\*[A-Z]/)
  const candidates = [nextElementMatch?.index, sectionMatch?.index].filter(
    (i): i is number => typeof i === 'number',
  )
  const endOffset = candidates.length === 0 ? rest.length : Math.min(...candidates)
  return rest.slice(0, endOffset)
}

/** Extract every fenced-block body in the prompt — the worked examples. */
function extractFencedBlocks(prompt: string): string[] {
  const blocks: string[] = []
  const fence = /```(?:html)?\s*\n([\s\S]*?)\n```/g
  let m: null | RegExpExecArray
  while ((m = fence.exec(prompt)) !== null) {
    blocks.push(m[1])
  }

  return blocks
}

function isRegisteredElementName(tag: string): tag is ElementName {
  return (ELEMENT_NAMES as readonly string[]).includes(tag)
}

describe('curate.txt prompt', () => {
  describe('vocabulary coverage', () => {
    it('mentions every element name in the registry', () => {
      const prompt = loadPrompt()
      for (const name of ELEMENT_NAMES) {
        expect(prompt, `expected prompt to mention <${name}>`).to.include(`<${name}>`)
      }
    })

    it('flags `path` and `title` as required attributes on bv-topic', () => {
      const prompt = loadPrompt()
      // Both are REQUIRED on bv-topic per the schema; the prompt must say so.
      expect(prompt).to.match(/`path`[^\n]*REQUIRED/i)
      expect(prompt).to.match(/`title`[^\n]*REQUIRED/i)
    })

    it('lists bv-topic frontmatter optional attributes (summary, tags, keywords, related)', () => {
      const prompt = loadPrompt()
      for (const attr of ['summary', 'tags', 'keywords', 'related']) {
        expect(prompt, `expected prompt to mention bv-topic frontmatter attribute "${attr}"`).to.include(`\`${attr}\``)
      }
    })

    it('explicitly excludes runtime signals from bv-topic attributes', () => {
      const prompt = loadPrompt().toLowerCase()
      // The prompt must instruct the LLM NOT to author runtime-signal
      // attributes — those live in the sidecar store. If this assertion
      // disappears, the LLM may start emitting noisy importance/recency
      // attributes again.
      expect(prompt).to.match(/not.*bv-topic.*importance|importance[\s\S]*sidecar|do not.*importance/)
    })

    // Enum values are anchored to the element's section, not whole-file
    // string match. Catches "severity values moved from bv-bug to
    // bv-decision" drift, which the looser whole-file check would miss.

    it('lists severity enum values inside the bv-rule section (info|should|must)', () => {
      const section = elementSection(loadPrompt(), 'bv-rule')
      for (const value of ['info', 'should', 'must']) {
        expect(section, `expected "${value}" inside <bv-rule> section`).to.include(`"${value}"`)
      }
    })

    it('lists severity enum values inside the bv-bug section (low|medium|high|critical)', () => {
      const section = elementSection(loadPrompt(), 'bv-bug')
      for (const value of ['low', 'medium', 'high', 'critical']) {
        expect(section, `expected "${value}" inside <bv-bug> section`).to.include(`"${value}"`)
      }
    })

    it('lists category enum values inside the bv-fact section', () => {
      const section = elementSection(loadPrompt(), 'bv-fact')
      for (const value of ['personal', 'project', 'preference', 'convention', 'team', 'environment', 'other']) {
        expect(section, `expected category value "${value}" inside <bv-fact> section`).to.include(`"${value}"`)
      }
    })

    it('lists type enum values inside the bv-diagram section', () => {
      const section = elementSection(loadPrompt(), 'bv-diagram')
      for (const value of ['mermaid', 'plantuml', 'ascii', 'dot', 'graphviz']) {
        expect(section, `expected diagram type "${value}" inside <bv-diagram> section`).to.include(`"${value}"`)
      }
    })

    it('declares each registered element somewhere with an explanatory blurb', () => {
      // Stronger drift guard than just-mention: every element must have
      // at least one mention adjacent to either an attribute reference
      // or a "renders as" / "## section" / "block content" / "inline"
      // signal — i.e., the prompt actually describes the element rather
      // than just naming it in passing.
      const prompt = loadPrompt()
      for (const name of ELEMENT_NAMES) {
        if (name === 'bv-topic') continue
        const idx = prompt.indexOf(`<${name}>`)
        expect(idx, `expected <${name}> mentioned`).to.be.greaterThan(-1)
        const window = prompt.slice(idx, idx + 600)
        const hasContext = /renders as|`##|block content|inline|optional|REQUIRED|attribute/i.test(window)
        expect(hasContext, `expected explanatory context near <${name}>`).to.equal(true)
      }
    })
  })

  describe('output contract', () => {
    it('declares the closed vocabulary', () => {
      const prompt = loadPrompt()
      expect(prompt.toLowerCase()).to.include('closed')
    })

    it('forbids prose preamble, code fences, and trailing commentary', () => {
      const prompt = loadPrompt().toLowerCase()
      expect(prompt).to.include('preamble')
      expect(prompt).to.include('code fence')
      expect(prompt).to.include('commentary')
    })

    it('requires exactly one bv-topic root', () => {
      const prompt = loadPrompt()
      expect(prompt.toLowerCase()).to.include('exactly one')
    })

    it('requires lowercase attribute names (HTML5 normalization)', () => {
      const prompt = loadPrompt()
      expect(prompt.toLowerCase()).to.include('lowercase')
    })

    it('forbids clarifying questions', () => {
      const prompt = loadPrompt()
      expect(prompt.toLowerCase()).to.include('clarifying question')
    })
  })

  describe('field coverage matches registry', () => {
    it('mentions every required attribute declared in the registry for every element', () => {
      const prompt = loadPrompt()
      for (const name of ELEMENT_NAMES) {
        for (const attr of ELEMENT_REGISTRY[name].requiredAttributes) {
          expect(prompt, `expected prompt to mention required attr "${attr}" of <${name}>`).to.include(`\`${attr}\``)
        }
      }
    })
  })

  describe('worked examples are themselves registry-valid', () => {
    // The strongest drift guard: parse every example HTML block in the
    // prompt and run each `<bv-*>` element through its registered
    // validator. Catches (a) example typos like `severity="hihg"`,
    // (b) vocabulary drift where the example uses an attribute that no
    // longer exists, and (c) drift where the example demonstrates a
    // shape we no longer accept. The looser whole-file string-match
    // tests above pass even when the examples themselves are invalid.

    it('contains at least one fenced example block', () => {
      const blocks = extractFencedBlocks(loadPrompt())
      expect(blocks.length, 'expected the prompt to include worked examples').to.be.greaterThan(0)
    })

    it('every fenced example block parses cleanly', () => {
      const blocks = extractFencedBlocks(loadPrompt())
      for (const [i, block] of blocks.entries()) {
        expect(() => parseHtml(block), `example block ${i + 1} should parse`).to.not.throw()
      }
    })

    it('every <bv-*> element in every example passes its registered validator', () => {
      const blocks = extractFencedBlocks(loadPrompt())
      for (const [i, block] of blocks.entries()) {
        const elements = walkElements(parseHtml(block))
        for (const el of elements) {
          if (!isRegisteredElementName(el.tagName)) continue
          const result = ELEMENT_REGISTRY[el.tagName].validator(el as ElementNode)
          expect(
            result.valid,
            `example block ${i + 1}: <${el.tagName}> failed validation. ` +
              `errors: ${JSON.stringify(result.valid ? [] : result.errors)}`,
          ).to.equal(true)
        }
      }
    })

    it('every example contains exactly one <bv-topic> root', () => {
      const blocks = extractFencedBlocks(loadPrompt())
      for (const [i, block] of blocks.entries()) {
        const topics = walkElements(parseHtml(block)).filter((e) => e.tagName === 'bv-topic')
        expect(topics.length, `example block ${i + 1} should have exactly one bv-topic`).to.equal(1)
      }
    })
  })
})
