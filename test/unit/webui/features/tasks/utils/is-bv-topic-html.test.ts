import {expect} from 'chai'

import {isBvTopicHtml} from '../../../../../../src/webui/features/tasks/utils/is-bv-topic-html.js'

describe('isBvTopicHtml', () => {
  it('matches a bare <bv-topic> opener', () => {
    expect(isBvTopicHtml('<bv-topic title="t">body</bv-topic>')).to.equal(true)
  })

  it('matches when preceded by whitespace', () => {
    expect(isBvTopicHtml('\n  <bv-topic>body</bv-topic>')).to.equal(true)
  })

  it('matches when wrapped in a ```html fence', () => {
    expect(isBvTopicHtml('```html\n<bv-topic>body</bv-topic>\n```')).to.equal(true)
  })

  it('matches when wrapped in a bare ``` fence', () => {
    expect(isBvTopicHtml('```\n<bv-topic>body</bv-topic>\n```')).to.equal(true)
  })

  it('matches with a leading UTF-8 BOM', () => {
    expect(isBvTopicHtml('\uFEFF<bv-topic>body</bv-topic>')).to.equal(true)
  })

  it('matches with BOM + html fence combined', () => {
    expect(isBvTopicHtml('\uFEFF```html\n<bv-topic>body</bv-topic>')).to.equal(true)
  })

  it('rejects content with a leading prose sentence', () => {
    // Prose preamble is not a structural wrapper — leave it as markdown rather
    // than risk feeding malformed HTML into the editorial viewer.
    expect(isBvTopicHtml("Here's the topic:\n<bv-topic>body</bv-topic>")).to.equal(false)
  })

  it('rejects markdown content', () => {
    expect(isBvTopicHtml('# A heading\nsome text')).to.equal(false)
  })

  it('rejects unrelated HTML', () => {
    expect(isBvTopicHtml('<div>not a topic</div>')).to.equal(false)
  })
})
