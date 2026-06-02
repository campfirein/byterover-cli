import {expect} from 'chai'

import {parseAnalyticsDisclosure} from '../../../../src/shared/utils/parse-analytics-disclosure.js'

describe('parseAnalyticsDisclosure', () => {
  it('extracts each H2 heading as a section label and the following text as its body', () => {
    const md = [
      '# Title',
      '',
      'Intro paragraph the parser must skip.',
      '',
      '## First',
      'First body.',
      '',
      '## Second',
      'Second body.',
    ].join('\n')

    const sections = parseAnalyticsDisclosure(md)

    expect(sections).to.deep.equal([
      {body: 'First body.', label: 'First'},
      {body: 'Second body.', label: 'Second'},
    ])
  })

  it('preserves multi-paragraph and list/code-block bodies verbatim', () => {
    const md = [
      '## How to disable',
      'You can stop sharing at any time by running:',
      '',
      '```',
      'brv settings set analytics.share false',
      '```',
      '',
      'You can also toggle the setting from the Settings page in the TUI.',
    ].join('\n')

    const [section] = parseAnalyticsDisclosure(md)

    expect(section.label).to.equal('How to disable')
    expect(section.body).to.include('You can stop sharing at any time')
    expect(section.body).to.include('```\nbrv settings set analytics.share false\n```')
    expect(section.body).to.include('Settings page in the TUI')
  })

  it('returns an empty array when the input has no H2 headings', () => {
    expect(parseAnalyticsDisclosure('# Only H1\n\nBody.')).to.deep.equal([])
    expect(parseAnalyticsDisclosure('')).to.deep.equal([])
  })

  it('trims leading and trailing whitespace from each body', () => {
    const md = '## A\n\n\nBody A.\n\n\n## B\nBody B.'
    const sections = parseAnalyticsDisclosure(md)

    expect(sections[0].body).to.equal('Body A.')
    expect(sections[1].body).to.equal('Body B.')
  })

  it('drops sections whose body is empty so the webui never renders a blank card', () => {
    const md = ['## Empty', '', '## Has body', 'Body text.'].join('\n')
    const sections = parseAnalyticsDisclosure(md)

    expect(sections.map((s) => s.label)).to.deep.equal(['Has body'])
  })

  it('ignores H3+ headings inside a section body', () => {
    const md = ['## Outer', 'Lead paragraph.', '', '### Nested', 'Nested paragraph.', '', '## Next', 'Next body.'].join('\n')

    const sections = parseAnalyticsDisclosure(md)

    expect(sections.map((s) => s.label)).to.deep.equal(['Outer', 'Next'])
    expect(sections[0].body).to.include('### Nested')
  })
})
