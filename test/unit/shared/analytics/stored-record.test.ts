/* eslint-disable camelcase */
import {expect} from 'chai'

import {MAX_ATTEMPTS, StoredAnalyticsRecordSchema, toWireEvent} from '../../../../src/shared/analytics/stored-record.js'

const validIdentity = {
  device_id: '550e8400-e29b-41d4-a716-446655440000',
}

const validRecord = {
  attempts: 0,
  id: '11111111-2222-3333-4444-555555555555',
  identity: validIdentity,
  name: 'cli_invocation',
  properties: {x: 1},
  status: 'pending' as const,
  timestamp: 1_700_000_000_000,
}

describe('StoredAnalyticsRecord', () => {
  describe('MAX_ATTEMPTS', () => {
    it('should export the cap as 3', () => {
      expect(MAX_ATTEMPTS).to.equal(3)
    })
  })

  describe('StoredAnalyticsRecordSchema', () => {
    it('should accept a valid record', () => {
      const parsed = StoredAnalyticsRecordSchema.safeParse(validRecord)

      expect(parsed.success).to.equal(true)
      if (parsed.success) {
        expect(parsed.data.id).to.equal(validRecord.id)
        expect(parsed.data.status).to.equal('pending')
        expect(parsed.data.attempts).to.equal(0)
        expect(parsed.data.name).to.equal('cli_invocation')
      }
    })

    it('should accept all three status values', () => {
      for (const status of ['pending', 'sent', 'failed'] as const) {
        const parsed = StoredAnalyticsRecordSchema.safeParse({...validRecord, status})
        expect(parsed.success, `status=${status} should parse`).to.equal(true)
      }
    })

    it('should reject a record missing id', () => {
      const parsed = StoredAnalyticsRecordSchema.safeParse({
        attempts: validRecord.attempts,
        identity: validRecord.identity,
        name: validRecord.name,
        properties: validRecord.properties,
        status: validRecord.status,
        timestamp: validRecord.timestamp,
      })

      expect(parsed.success).to.equal(false)
    })

    it('should reject a record with empty id', () => {
      const parsed = StoredAnalyticsRecordSchema.safeParse({...validRecord, id: ''})

      expect(parsed.success).to.equal(false)
    })

    it('should reject a record with unknown status', () => {
      const parsed = StoredAnalyticsRecordSchema.safeParse({...validRecord, status: 'unknown'})

      expect(parsed.success).to.equal(false)
    })

    it('should reject a record with negative attempts', () => {
      const parsed = StoredAnalyticsRecordSchema.safeParse({...validRecord, attempts: -1})

      expect(parsed.success).to.equal(false)
    })

    it('should reject a record with fractional attempts', () => {
      const parsed = StoredAnalyticsRecordSchema.safeParse({...validRecord, attempts: 1.5})

      expect(parsed.success).to.equal(false)
    })

    it('should reject a record missing identity.device_id', () => {
      const parsed = StoredAnalyticsRecordSchema.safeParse({
        ...validRecord,
        identity: {device_id: ''},
      })

      expect(parsed.success).to.equal(false)
    })

    it('should reject a record with non-object properties', () => {
      const parsed = StoredAnalyticsRecordSchema.safeParse({
        ...validRecord,
        properties: 'not-an-object',
      })

      expect(parsed.success).to.equal(false)
    })

    it('should reject a record missing name', () => {
      const parsed = StoredAnalyticsRecordSchema.safeParse({
        attempts: validRecord.attempts,
        id: validRecord.id,
        identity: validRecord.identity,
        properties: validRecord.properties,
        status: validRecord.status,
        timestamp: validRecord.timestamp,
      })

      expect(parsed.success).to.equal(false)
    })

    it('should reject a record missing timestamp', () => {
      const parsed = StoredAnalyticsRecordSchema.safeParse({
        attempts: validRecord.attempts,
        id: validRecord.id,
        identity: validRecord.identity,
        name: validRecord.name,
        properties: validRecord.properties,
        status: validRecord.status,
      })

      expect(parsed.success).to.equal(false)
    })

    it('should reject a record missing properties', () => {
      const parsed = StoredAnalyticsRecordSchema.safeParse({
        attempts: validRecord.attempts,
        id: validRecord.id,
        identity: validRecord.identity,
        name: validRecord.name,
        status: validRecord.status,
        timestamp: validRecord.timestamp,
      })

      expect(parsed.success).to.equal(false)
    })

    it('should reject a record missing attempts', () => {
      const parsed = StoredAnalyticsRecordSchema.safeParse({
        id: validRecord.id,
        identity: validRecord.identity,
        name: validRecord.name,
        properties: validRecord.properties,
        status: validRecord.status,
        timestamp: validRecord.timestamp,
      })

      expect(parsed.success).to.equal(false)
    })

    it('should reject a record missing status', () => {
      const parsed = StoredAnalyticsRecordSchema.safeParse({
        attempts: validRecord.attempts,
        id: validRecord.id,
        identity: validRecord.identity,
        name: validRecord.name,
        properties: validRecord.properties,
        timestamp: validRecord.timestamp,
      })

      expect(parsed.success).to.equal(false)
    })

    it('should reject a record missing identity', () => {
      const parsed = StoredAnalyticsRecordSchema.safeParse({
        attempts: validRecord.attempts,
        id: validRecord.id,
        name: validRecord.name,
        properties: validRecord.properties,
        status: validRecord.status,
        timestamp: validRecord.timestamp,
      })

      expect(parsed.success).to.equal(false)
    })

    it('should silently strip extra unknown fields (Zod default behavior, matches batch.ts precedent)', () => {
      // Use Zod default strip (NOT `.strict()` or `.passthrough()`). Mirrors batch.ts wire
      // schemas: strip is forward-compatible — a future binary that adds a new known field,
      // reading rows written by the old binary, will not crash. Cost: if a row on disk has
      // unknown extra fields, the M9.2 read-modify-rewrite cycle will lose them.
      const parsed = StoredAnalyticsRecordSchema.safeParse({
        ...validRecord,
        unknown_extra_field: 'should be stripped',
      })

      expect(parsed.success).to.equal(true)
      if (parsed.success) {
        expect(parsed.data).to.not.have.property('unknown_extra_field')
        expect(parsed.data.id).to.equal(validRecord.id)
      }
    })
  })

  describe('toWireEvent()', () => {
    it('should strip id, status, and attempts from the record', () => {
      const wire = toWireEvent(validRecord)

      expect(wire).to.deep.equal({
        identity: validIdentity,
        name: 'cli_invocation',
        properties: {x: 1},
        timestamp: 1_700_000_000_000,
      })
    })

    it('should not retain id field', () => {
      const wire = toWireEvent(validRecord)
      expect(wire).to.not.have.property('id')
    })

    it('should not retain status field', () => {
      const wire = toWireEvent(validRecord)
      expect(wire).to.not.have.property('status')
    })

    it('should not retain attempts field', () => {
      const wire = toWireEvent(validRecord)
      expect(wire).to.not.have.property('attempts')
    })

    it('should preserve identity verbatim including optional fields', () => {
      const recordWithFullIdentity = {
        ...validRecord,
        identity: {
          device_id: validIdentity.device_id,
          email: 'user@example.com',
          name: 'Test User',
          user_id: 'user-123',
        },
      }
      const wire = toWireEvent(recordWithFullIdentity)

      expect(wire.identity).to.deep.equal(recordWithFullIdentity.identity)
    })

    it('should strip local fields when chained after Zod parse (sent record with attempts > 0)', () => {
      const recordWithStatusSent = {...validRecord, attempts: 2, status: 'sent' as const}
      const parsed = StoredAnalyticsRecordSchema.safeParse(recordWithStatusSent)

      expect(parsed.success).to.equal(true)
      if (parsed.success) {
        const wire = toWireEvent(parsed.data)
        expect(wire.name).to.equal('cli_invocation')
        expect(wire).to.not.have.property('attempts')
        expect(wire).to.not.have.property('status')
      }
    })
  })
})
