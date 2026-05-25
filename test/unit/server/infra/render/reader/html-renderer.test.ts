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
})
