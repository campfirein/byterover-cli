/* eslint-disable camelcase */
import {expect} from 'chai'

import {AnalyticsTrackPayloadSchema} from '../../../../../../src/shared/transport/events/analytics-events.js'

describe('AnalyticsTrackPayloadSchema', () => {
  describe('valid payloads', () => {
    it('should accept {event} only', () => {
      const result = AnalyticsTrackPayloadSchema.safeParse({event: 'cli_invocation'})
      expect(result.success).to.equal(true)
    })

    it('should accept {event, properties}', () => {
      const result = AnalyticsTrackPayloadSchema.safeParse({
        event: 'cli_invocation',
        properties: {command_id: 'status'},
      })
      expect(result.success).to.equal(true)
    })

    it('should accept empty properties object', () => {
      const result = AnalyticsTrackPayloadSchema.safeParse({event: 'e', properties: {}})
      expect(result.success).to.equal(true)
    })
  })

  describe('invalid payloads', () => {
    it('should reject missing event', () => {
      const result = AnalyticsTrackPayloadSchema.safeParse({properties: {x: 1}})
      expect(result.success).to.equal(false)
    })

    it('should reject empty-string event', () => {
      const result = AnalyticsTrackPayloadSchema.safeParse({event: ''})
      expect(result.success).to.equal(false)
    })

    it('should reject non-string event', () => {
      const result = AnalyticsTrackPayloadSchema.safeParse({event: 42})
      expect(result.success).to.equal(false)
    })

    it('should reject non-object properties', () => {
      const result = AnalyticsTrackPayloadSchema.safeParse({event: 'e', properties: 'oops'})
      expect(result.success).to.equal(false)
    })

    it('should reject array properties', () => {
      const result = AnalyticsTrackPayloadSchema.safeParse({event: 'e', properties: [1, 2]})
      expect(result.success).to.equal(false)
    })

    it('should reject null payload', () => {
      const result = AnalyticsTrackPayloadSchema.safeParse(null)
      expect(result.success).to.equal(false)
    })
  })
})
