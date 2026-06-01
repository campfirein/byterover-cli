/**
 * html-renderer tests.
 *
 * `renderHtmlTopicForLlm` is the bridge between an indexed `<bv-topic>`
 * document and the markdown-shaped string the Tier 2 direct-response
 * formatter (and any other LLM-facing consumer) reads. The tests below
 * lock the contract on:
 *   - tag-level semantic prefixing (e.g. `bv-rule[severity=must]` →
 *     `- **Rule** [must]: …`)
 *   - bv-topic frontmatter lift (title / summary / tags / keywords /
 *     related)
 *   - graceful behaviour on malformed / partial input (parse5-driven
 *     forgiveness mirrors the rest of the reader pipeline)
 *   - no `<bv-*>` markup or attribute syntax in the rendered output
 */

import {expect} from 'chai'

import {renderHtmlTopicForLlm} from '../../../../../../src/server/infra/render/reader/html-renderer.js'

describe('renderHtmlTopicForLlm', () => {
  it('lifts bv-topic frontmatter into a header block', () => {
    const html = `<bv-topic path="security/auth" title="JWT Auth" summary="JWT design" tags="security,jwt" keywords="jwt,refresh" related="@security/oauth"></bv-topic>`
    const out = renderHtmlTopicForLlm(html)

    expect(out).to.include('# JWT Auth')
    expect(out).to.include('> JWT design')
    expect(out).to.include('Tags: security,jwt')
    expect(out).to.include('Keywords: jwt,refresh')
    expect(out).to.include('Related: @security/oauth')
  })

  it('omits header lines for absent attributes (no empty `> ` etc.)', () => {
    const html = '<bv-topic path="x" title="t"></bv-topic>'
    const out = renderHtmlTopicForLlm(html)

    expect(out).to.equal('# t')
  })

  it('renders bv-rule with severity and id metadata', () => {
    const html = `<bv-topic path="x" title="t">
      <bv-rule severity="must" id="r-validate">Always validate JWT signatures.</bv-rule>
    </bv-topic>`
    const out = renderHtmlTopicForLlm(html)

    expect(out).to.include('- **Rule** [must] (r-validate): Always validate JWT signatures.')
  })

  it('renders bv-fact with subject/category/value metadata', () => {
    const html = `<bv-topic path="x" title="t">
      <bv-fact subject="signing_algorithm" category="convention" value="RS256">All service-to-service JWTs are signed with RS256.</bv-fact>
    </bv-topic>`
    const out = renderHtmlTopicForLlm(html)

    expect(out).to.include(
      '- **Fact** (subject=signing_algorithm, category=convention, value=RS256): All service-to-service JWTs are signed with RS256.',
    )
  })

  it('renders bv-decision with id metadata', () => {
    const html = `<bv-topic path="x" title="t">
      <bv-decision id="d-rs256">Use RS256 over HS256.</bv-decision>
    </bv-topic>`
    const out = renderHtmlTopicForLlm(html)

    expect(out).to.include('- **Decision** (d-rs256): Use RS256 over HS256.')
  })

  it('renders bv-reason / bv-task as labelled blocks', () => {
    const html = `<bv-topic path="x" title="t">
      <bv-reason>Document JWT design.</bv-reason>
      <bv-task>Capture decisions and operating rules.</bv-task>
    </bv-topic>`
    const out = renderHtmlTopicForLlm(html)

    expect(out).to.include('**Reason:** Document JWT design.')
    expect(out).to.include('**Task:** Capture decisions and operating rules.')
  })

  it('output contains no `<bv-*>` markup or attribute syntax', () => {
    const html = `<bv-topic path="x" title="t" summary="s">
      <bv-rule severity="must" id="r-1">x</bv-rule>
      <bv-decision id="d-1">y</bv-decision>
      <bv-fact subject="s" value="v">z</bv-fact>
    </bv-topic>`
    const out = renderHtmlTopicForLlm(html)

    // No tag openings
    expect(out).to.not.match(/<bv-/)
    // No attribute syntax (`name="value"`) — the renderer pulls
    // attribute payload into prose like `[must]` and `(subject=s)`,
    // never as raw `attr="value"`.
    expect(out).to.not.match(/\s\w+="/)
  })

  it('skips elements with empty inner text (no zero-content bullets)', () => {
    const html = `<bv-topic path="x" title="t">
      <bv-rule severity="must"></bv-rule>
      <bv-decision>has content</bv-decision>
    </bv-topic>`
    const out = renderHtmlTopicForLlm(html)

    expect(out).to.include('Decision')
    expect(out).to.include('has content')
    // The empty bv-rule should not produce a stray `- **Rule** [must]: ` line
    expect(out.split('\n').filter((line) => line.trim() === '- **Rule** [must]:')).to.have.lengthOf(0)
  })

  it('falls back to a generic bullet for unknown bv-* tags (vocabulary-additive)', () => {
    // `bv-future-element` isn't in today's registry; the renderer
    // shouldn't drop it — the vocabulary is intentionally additive.
    const html = `<bv-topic path="x" title="t">
      <bv-future-element>future content here</bv-future-element>
    </bv-topic>`
    const out = renderHtmlTopicForLlm(html)

    expect(out).to.include('- future content here')
  })

  it('does not throw on malformed HTML (parse5 is forgiving)', () => {
    expect(() => renderHtmlTopicForLlm('<bv-topic path="x" title="t"><bv-rule>unclosed')).to.not.throw()
  })

  it('returns an empty string when given empty input (no bv-topic, no children)', () => {
    expect(renderHtmlTopicForLlm('')).to.equal('')
  })

  it('produces deterministic output for a representative full topic', () => {
    const html = `<bv-topic path="security/auth" title="JWT auth" summary="JWT design.">
      <bv-reason>Document JWT.</bv-reason>
      <bv-rule severity="must" id="r-1">Validate signatures.</bv-rule>
      <bv-decision id="d-1">Use RS256.</bv-decision>
      <bv-fact subject="alg" value="RS256">All service tokens use RS256.</bv-fact>
    </bv-topic>`
    const out = renderHtmlTopicForLlm(html)

    expect(out).to.equal(
      '# JWT auth\n> JWT design.\n\n**Reason:** Document JWT.\n\n- **Rule** [must] (r-1): Validate signatures.\n\n- **Decision** (d-1): Use RS256.\n\n- **Fact** (subject=alg, value=RS256): All service tokens use RS256.',
    )
  })

  describe('inline <img> (ENG-3021)', () => {
    it('renders <img src alt> inside a <bv-decision> as CommonMark image syntax', () => {
      // The motivating bug: an `<img>` embedded inside body content used to
      // disappear because `getInnerText` skips void elements. The renderer
      // now uses a markdown-aware inline extractor that translates `<img>`
      // to `![alt](src)`.
      const html = '<bv-topic path="x" title="t"><bv-decision id="d-1">Diagram: <img src="https://example.com/arch.png" alt="System architecture"/>. See spec.</bv-decision></bv-topic>'
      const out = renderHtmlTopicForLlm(html)
      expect(out).to.include('![System architecture](https://example.com/arch.png)')
      // Surrounding prose still present — the image is inserted inline, not as a replacement
      expect(out).to.include('Diagram:')
      expect(out).to.include('See spec.')
    })

    it('renders <img> with no alt as ![](src) — valid CommonMark click target', () => {
      const html = '<bv-topic path="x" title="t"><bv-decision id="d-1"><img src="https://example.com/x.png"/></bv-decision></bv-topic>'
      const out = renderHtmlTopicForLlm(html)
      expect(out).to.include('![](https://example.com/x.png)')
    })

    it('drops <img> with no src — would emit broken ![alt]() syntax otherwise', () => {
      // alt text without src cannot produce a working markdown image. Silent
      // drop is safer than emitting a broken-link target downstream parsers
      // may render as plain bracketed text. The indexer still surfaces the
      // alt separately via extractImageContent for BM25 purposes.
      const html = '<bv-topic path="x" title="t"><bv-decision id="d-1">Text <img alt="lonely alt"/> tail.</bv-decision></bv-topic>'
      const out = renderHtmlTopicForLlm(html)
      expect(out).to.not.include('![')
      expect(out).to.include('Text')
      expect(out).to.include('tail.')
    })

    it('escapes `]` in alt by collapsing to space — only `]` terminates the alt span, `[` is harmless', () => {
      // A literal `]` in alt would terminate the markdown image's alt span
      // early. Cheaper to collapse to a space than to backslash-escape.
      // `[` is left untouched — it's valid inside an alt and never closes
      // the span.
      const html = '<bv-topic path="x" title="t"><bv-decision id="d-1"><img src="https://x.com/a.png" alt="Phase [2] diagram"/></bv-decision></bv-topic>'
      const out = renderHtmlTopicForLlm(html)
      // `]` is gone; only one closing bracket should appear in the rendered
      // string for this image — the one closing the alt span before `(src)`.
      const altSpan = out.match(/!\[([^\]]*)]/)
      expect(altSpan, 'image alt span').to.exist
      expect(altSpan![1]).to.not.include(']') // confirms `]` was scrubbed inside alt
      expect(altSpan![1]).to.include('Phase')
      expect(altSpan![1]).to.include('2')
      expect(altSpan![1]).to.include('diagram')
      // Full image syntax still parses to the right URL
      expect(out).to.include('](https://x.com/a.png)')
    })

    it("falls back to CommonMark autolink form when src contains ')'", () => {
      // A literal `)` in src would close the markdown image's URL span early.
      // CommonMark's `<url>` autolink syntax tolerates parenthesised URLs;
      // the rendered click target is still useful, just without the alt text.
      const html = '<bv-topic path="x" title="t"><bv-decision id="d-1"><img src="https://example.com/path(v2).png" alt="any"/></bv-decision></bv-topic>'
      const out = renderHtmlTopicForLlm(html)
      expect(out).to.include('<https://example.com/path(v2).png>')
      expect(out).to.not.match(/!\[any\]\(https:\/\/example\.com\/path\(v2\)\.png\)/)
    })

    it('renders top-level <img> sibling of <bv-*> as the image markdown', () => {
      // Rare but legal — top-level `<img>` directly under `<bv-topic>` is
      // handled by `renderChild`'s `<img>` case (vs the inline path used
      // inside `<bv-*>` bodies).
      const html = '<bv-topic path="x" title="t"><img src="https://example.com/x.png" alt="hero"/></bv-topic>'
      const out = renderHtmlTopicForLlm(html)
      expect(out).to.include('![hero](https://example.com/x.png)')
    })

    it('preserves the BM25-friendly side-effect: rendered output contains the URL host + path tokens', () => {
      // Sanity check that downstream tokenization sees the URL — the
      // indexer wires `extractImageContent` separately, but the rendered
      // output ALSO carries the URL inside the `(src)` span. Belt + braces.
      const html = '<bv-topic path="x" title="t"><bv-decision id="d-1"><img src="https://example.com/architecture/v2/system-overview.png" alt="System overview"/></bv-decision></bv-topic>'
      const out = renderHtmlTopicForLlm(html)
      expect(out).to.include('example.com')
      expect(out).to.include('system-overview.png')
      expect(out).to.include('System overview')
    })
  })
})
