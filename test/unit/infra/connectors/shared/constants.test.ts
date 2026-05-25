import {expect} from 'chai'

import {
  BRV_RULE_MARKERS,
  BRV_RULE_TAG,
  extractInstalledAgentFromBrvSection,
  hasMcpToolsInBrvSection,
} from '../../../../../src/server/infra/connectors/shared/constants.js'

const wrapWithBrvSection = (footer: string): string =>
  `Some user content\n${BRV_RULE_MARKERS.START}\nrule body\n---\n${footer}\n${BRV_RULE_MARKERS.END}\nMore content`

describe('shared/constants', () => {
  describe('extractInstalledAgentFromBrvSection', () => {
    it('returns the agent name when the footer is present inside the BRV section', () => {
      const content = wrapWithBrvSection(`${BRV_RULE_TAG} Codex`)
      expect(extractInstalledAgentFromBrvSection(content)).to.equal('Codex')
    })

    it('returns multi-word agent names verbatim (e.g. "Augment Code")', () => {
      const content = wrapWithBrvSection(`${BRV_RULE_TAG} Augment Code`)
      expect(extractInstalledAgentFromBrvSection(content)).to.equal('Augment Code')
    })

    it('returns undefined when the BRV section has no footer (legacy file)', () => {
      const content = `${BRV_RULE_MARKERS.START}\nrule body without footer\n${BRV_RULE_MARKERS.END}`
      expect(extractInstalledAgentFromBrvSection(content)).to.equal(undefined)
    })

    it('returns undefined when start marker is missing', () => {
      const content = `rule body\n---\n${BRV_RULE_TAG} Codex\n${BRV_RULE_MARKERS.END}`
      expect(extractInstalledAgentFromBrvSection(content)).to.equal(undefined)
    })

    it('returns undefined when end marker is missing', () => {
      const content = `${BRV_RULE_MARKERS.START}\nrule body\n---\n${BRV_RULE_TAG} Codex`
      expect(extractInstalledAgentFromBrvSection(content)).to.equal(undefined)
    })

    it('ignores a footer that appears outside the BRV section', () => {
      const content = `Earlier in the file: ${BRV_RULE_TAG} Codex\n${BRV_RULE_MARKERS.START}\nrule body\n${BRV_RULE_MARKERS.END}`
      expect(extractInstalledAgentFromBrvSection(content)).to.equal(undefined)
    })

    it('returns undefined when end marker precedes start marker', () => {
      const content = `${BRV_RULE_MARKERS.END}\nstuff\n${BRV_RULE_MARKERS.START}\n${BRV_RULE_TAG} Codex`
      expect(extractInstalledAgentFromBrvSection(content)).to.equal(undefined)
    })

    it('returns undefined when the footer line is blank after the tag', () => {
      const content = wrapWithBrvSection(`${BRV_RULE_TAG} `)
      expect(extractInstalledAgentFromBrvSection(content)).to.equal(undefined)
    })

    it('does not match a malformed tag with no space delimiter (e.g. "...CLI forXxx")', () => {
      const content = wrapWithBrvSection(`${BRV_RULE_TAG}Xxx`)
      expect(extractInstalledAgentFromBrvSection(content)).to.equal(undefined)
    })
  })

  describe('hasMcpToolsInBrvSection (regression guard)', () => {
    it('detects brv-query inside the BRV section', () => {
      const content = `${BRV_RULE_MARKERS.START}\nuse the brv-query tool\n${BRV_RULE_MARKERS.END}`
      expect(hasMcpToolsInBrvSection(content)).to.equal(true)
    })

    it('does not flag brv-query that appears only outside the BRV section', () => {
      const content = `brv-query mentioned outside\n${BRV_RULE_MARKERS.START}\nno tools here\n${BRV_RULE_MARKERS.END}`
      expect(hasMcpToolsInBrvSection(content)).to.equal(false)
    })
  })
})
