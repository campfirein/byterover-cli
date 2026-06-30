/* eslint-disable camelcase */
import {expect} from 'chai'

import {
  AnalyticsEvents,
  AnalyticsListRequestSchema,
  AnalyticsListResponseSchema,
} from '../../../../../src/shared/transport/events/analytics-events.js'

const validIdentity = {device_id: '550e8400-e29b-41d4-a716-446655440000'}

function makeValidRow(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    attempts: 0,
    id: 'rec-1',
    identity: validIdentity,
    name: 'cli_invocation',
    properties: {},
    status: 'pending',
    timestamp: 1_700_000_000_000,
    ...overrides,
  }
}

describe('analytics:list transport schema (M11.1)', () => {
  describe('event constant', () => {
    it('should expose LIST = "analytics:list"', () => {
      expect(AnalyticsEvents.LIST).to.equal('analytics:list')
    })
  })

  describe('AnalyticsListRequestSchema', () => {
    it('should accept a minimal valid request {offset, limit}', () => {
      const parsed = AnalyticsListRequestSchema.safeParse({limit: 50, offset: 0})
      expect(parsed.success, 'minimal request must validate').to.equal(true)
    })

    it('should accept a request with optional eventName + status filters', () => {
      const parsed = AnalyticsListRequestSchema.safeParse({
        eventName: 'cli_invocation',
        limit: 10,
        offset: 0,
        status: 'pending',
      })
      expect(parsed.success).to.equal(true)
    })

    it('should reject offset < 0', () => {
      const parsed = AnalyticsListRequestSchema.safeParse({limit: 10, offset: -1})
      expect(parsed.success).to.equal(false)
    })

    it('should reject limit < 1', () => {
      const parsed = AnalyticsListRequestSchema.safeParse({limit: 0, offset: 0})
      expect(parsed.success).to.equal(false)
    })

    it('should reject limit > 200', () => {
      const parsed = AnalyticsListRequestSchema.safeParse({limit: 201, offset: 0})
      expect(parsed.success).to.equal(false)
    })

    it('should reject non-integer offset/limit', () => {
      expect(AnalyticsListRequestSchema.safeParse({limit: 1.5, offset: 0}).success).to.equal(false)
      expect(AnalyticsListRequestSchema.safeParse({limit: 10, offset: 1.5}).success).to.equal(false)
    })

    it('should reject an unknown status value', () => {
      const parsed = AnalyticsListRequestSchema.safeParse({limit: 10, offset: 0, status: 'archived'})
      expect(parsed.success).to.equal(false)
    })

    it('should reject when offset is missing', () => {
      const parsed = AnalyticsListRequestSchema.safeParse({limit: 10})
      expect(parsed.success).to.equal(false)
    })

    it('should reject when limit is missing', () => {
      const parsed = AnalyticsListRequestSchema.safeParse({offset: 0})
      expect(parsed.success).to.equal(false)
    })
  })

  describe('AnalyticsListResponseSchema', () => {
    it('should accept a response with empty rows + total=0', () => {
      const parsed = AnalyticsListResponseSchema.safeParse({rows: [], total: 0})
      expect(parsed.success).to.equal(true)
    })

    it('should accept a response with one valid row + total=1', () => {
      const parsed = AnalyticsListResponseSchema.safeParse({rows: [makeValidRow()], total: 1})
      expect(parsed.success).to.equal(true)
    })

    it('should reject a response when a row is malformed (missing required field)', () => {
      const malformed = {...makeValidRow(), id: undefined}
      const parsed = AnalyticsListResponseSchema.safeParse({rows: [malformed], total: 1})
      expect(parsed.success).to.equal(false)
    })

    it('should reject a response when total is negative', () => {
      const parsed = AnalyticsListResponseSchema.safeParse({rows: [], total: -1})
      expect(parsed.success).to.equal(false)
    })

    it('should reject a response when total is non-integer', () => {
      const parsed = AnalyticsListResponseSchema.safeParse({rows: [], total: 1.5})
      expect(parsed.success).to.equal(false)
    })
  })
})
