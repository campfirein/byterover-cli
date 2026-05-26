import {expect} from 'chai'

import {
  ANALYTICS_DISCLOSURE_SECTIONS,
  ANALYTICS_PRIVACY_URL,
} from '../../../../../src/webui/features/analytics/constants.js'

describe('analytics constants', () => {
  describe('ANALYTICS_DISCLOSURE_SECTIONS', () => {
    it('contains the five required sections in ticket-spec order', () => {
      const labels = ANALYTICS_DISCLOSURE_SECTIONS.map((s) => s.label)
      expect(labels).to.deep.equal([
        'WHAT IS COLLECTED',
        'WHICH SURFACES ARE TRACKED',
        'WHERE IT GOES',
        'CROSS-DEVICE ALIAS',
        'HOW TO DISABLE',
      ])
    })

    it('every section has a non-empty body', () => {
      for (const section of ANALYTICS_DISCLOSURE_SECTIONS) {
        expect(section.body.length).to.be.greaterThan(0)
      }
    })

    it('every section has an icon component reference', () => {
      for (const section of ANALYTICS_DISCLOSURE_SECTIONS) {
        expect(section.icon).to.exist
        expect(['function', 'object']).to.include(typeof section.icon)
      }
    })
  })

  describe('ANALYTICS_PRIVACY_URL', () => {
    it('is a https URL', () => {
      expect(ANALYTICS_PRIVACY_URL).to.match(/^https:\/\//)
    })

    it('points at the byterover privacy docs', () => {
      expect(ANALYTICS_PRIVACY_URL).to.include('byterover.dev/privacy')
    })
  })
})
