import {expect} from 'chai'

import {advertisedCapabilities, classifyDriver} from '../../../../../src/server/infra/channel/driver-class-classifier.js'

describe('driver-class-classifier', () => {
  describe('classifyDriver', () => {
    it('returns C-prime when session/new failed', () => {
      expect(
        classifyDriver({
          agentCapabilities: {promptCapabilities: {embeddedContext: true, image: true}},
          sessionNewSucceeded: false,
        }),
      ).to.equal('C-prime')
    })

    it('returns A when embeddedContext + image and session/new succeeded', () => {
      expect(
        classifyDriver({
          agentCapabilities: {promptCapabilities: {embeddedContext: true, image: true}},
          sessionNewSucceeded: true,
        }),
      ).to.equal('A')
    })

    it('returns A when embeddedContext + toolCallSupport', () => {
      expect(
        classifyDriver({
          agentCapabilities: {promptCapabilities: {embeddedContext: true}, toolCallSupport: true},
          sessionNewSucceeded: true,
        }),
      ).to.equal('A')
    })

    it('returns B for a baseline ACP agent (no embeddedContext)', () => {
      expect(
        classifyDriver({
          agentCapabilities: {promptCapabilities: {embeddedContext: false}},
          sessionNewSucceeded: true,
        }),
      ).to.equal('B')
    })

    it('returns B when no capabilities advertised but session/new succeeded', () => {
      expect(classifyDriver({sessionNewSucceeded: true})).to.equal('B')
    })

    it('honors an explicit _meta["brv.driverClass"] override', () => {
      expect(
        classifyDriver({
          _meta: {'brv.driverClass': 'C-prime'},
          agentCapabilities: {promptCapabilities: {embeddedContext: true, image: true}},
          sessionNewSucceeded: true,
        }),
      ).to.equal('C-prime')
    })
  })

  describe('advertisedCapabilities', () => {
    it('lists every advertised capability', () => {
      expect(
        advertisedCapabilities({
          agentCapabilities: {promptCapabilities: {embeddedContext: true, image: true}, toolCallSupport: true},
          sessionNewSucceeded: true,
        }),
      ).to.deep.equal(['embeddedContext', 'image', 'toolCallSupport'])
    })

    it('returns an empty list when nothing is advertised', () => {
      expect(advertisedCapabilities({sessionNewSucceeded: true})).to.deep.equal([])
    })
  })
})
