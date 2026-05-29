/* eslint-disable camelcase */
import {expect} from 'chai'

import {AnalyticsBatch} from '../../../../../../src/server/core/domain/analytics/batch.js'

const validIdentity = {
  device_id: '550e8400-e29b-41d4-a716-446655440000',
}

const eventA = {
  created_at: '2023-11-14T22:13:20+00:00',
  identity: validIdentity,
  name: 'event_a',
  properties: {x: 1},
}

const eventB = {
  created_at: '2023-11-14T22:13:20.001+00:00',
  identity: validIdentity,
  name: 'event_b',
  properties: {y: 'hello'},
}

describe('AnalyticsBatch', () => {
  describe('create()', () => {
    it('should create an empty batch', () => {
      const batch = AnalyticsBatch.create([])

      expect(batch.schema_version).to.equal(1)
      expect(batch.events).to.deep.equal([])
    })

    it('should create a populated batch preserving event order', () => {
      const batch = AnalyticsBatch.create([eventA, eventB])

      expect(batch.events).to.have.lengthOf(2)
      expect(batch.events[0].name).to.equal('event_a')
      expect(batch.events[1].name).to.equal('event_b')
    })
  })

  describe('toJson()', () => {
    it('should serialize an empty batch', () => {
      const batch = AnalyticsBatch.create([])

      expect(batch.toJson()).to.deep.equal({events: [], schema_version: 1})
    })

    it('should serialize a populated batch with all event fields', () => {
      const batch = AnalyticsBatch.create([eventA])
      const json = batch.toJson()

      expect(json.schema_version).to.equal(1)
      expect(json.events).to.have.lengthOf(1)
      expect(json.events[0]).to.deep.equal(eventA)
    })
  })

  describe('round-trip', () => {
    it('should round-trip an empty batch through fromJson', () => {
      const original = AnalyticsBatch.create([])
      const restored = AnalyticsBatch.fromJson(original.toJson())

      expect(restored).to.not.be.undefined
      expect(restored?.schema_version).to.equal(1)
      expect(restored?.events).to.deep.equal([])
    })

    it('should round-trip a populated batch', () => {
      const original = AnalyticsBatch.create([eventA, eventB])
      const restored = AnalyticsBatch.fromJson(original.toJson())

      expect(restored).to.not.be.undefined
      expect(restored?.events).to.have.lengthOf(2)
      expect(restored?.events[0]).to.deep.equal(eventA)
      expect(restored?.events[1]).to.deep.equal(eventB)
    })
  })

  describe('fromJson() rejects malformed input', () => {
    it('should return undefined for null', () => {
      expect(AnalyticsBatch.fromJson(null)).to.be.undefined
    })

    it('should return undefined for non-object primitives', () => {
      expect(AnalyticsBatch.fromJson('string')).to.be.undefined
      expect(AnalyticsBatch.fromJson(123)).to.be.undefined
      expect(AnalyticsBatch.fromJson(true)).to.be.undefined
    })

    it('should return undefined for an array (top-level)', () => {
      expect(AnalyticsBatch.fromJson([])).to.be.undefined
    })

    it('should return undefined when schema_version is missing', () => {
      expect(AnalyticsBatch.fromJson({events: []})).to.be.undefined
    })

    it('should return undefined when schema_version is not 1', () => {
      expect(AnalyticsBatch.fromJson({events: [], schema_version: 2})).to.be.undefined
      expect(AnalyticsBatch.fromJson({events: [], schema_version: 0})).to.be.undefined
      expect(AnalyticsBatch.fromJson({events: [], schema_version: '1'})).to.be.undefined
    })

    it('should return undefined when events is not an array', () => {
      expect(AnalyticsBatch.fromJson({events: {}, schema_version: 1})).to.be.undefined
      expect(AnalyticsBatch.fromJson({events: 'foo', schema_version: 1})).to.be.undefined
      expect(AnalyticsBatch.fromJson({schema_version: 1})).to.be.undefined
    })

    it('should return undefined when an event is missing name', () => {
      const json = {
        events: [{created_at: '2023-11-14T22:13:20+00:00', identity: validIdentity, properties: {}}],
        schema_version: 1,
      }
      expect(AnalyticsBatch.fromJson(json)).to.be.undefined
    })

    it('should return undefined when an event has non-string name', () => {
      const json = {
        events: [{created_at: '2023-11-14T22:13:20+00:00', identity: validIdentity, name: 123, properties: {}}],
        schema_version: 1,
      }
      expect(AnalyticsBatch.fromJson(json)).to.be.undefined
    })

    it('should return undefined when an event is missing identity', () => {
      const json = {
        events: [{created_at: '2023-11-14T22:13:20+00:00', name: 'x', properties: {}}],
        schema_version: 1,
      }
      expect(AnalyticsBatch.fromJson(json)).to.be.undefined
    })

    it('should return undefined when identity is missing device_id', () => {
      const json = {
        events: [{created_at: '2023-11-14T22:13:20+00:00', identity: {}, name: 'x', properties: {}}],
        schema_version: 1,
      }
      expect(AnalyticsBatch.fromJson(json)).to.be.undefined
    })

    it('should return undefined when identity has empty device_id', () => {
      const json = {
        events: [
          {created_at: '2023-11-14T22:13:20+00:00', identity: {device_id: ''}, name: 'x', properties: {}},
        ],
        schema_version: 1,
      }
      expect(AnalyticsBatch.fromJson(json)).to.be.undefined
    })

    it('should return undefined when an event is missing created_at', () => {
      const json = {
        events: [{identity: validIdentity, name: 'x', properties: {}}],
        schema_version: 1,
      }
      expect(AnalyticsBatch.fromJson(json)).to.be.undefined
    })

    it('should return undefined when an event has a non-string created_at', () => {
      const json = {
        events: [{created_at: 1_700_000_000_000, identity: validIdentity, name: 'x', properties: {}}],
        schema_version: 1,
      }
      expect(AnalyticsBatch.fromJson(json)).to.be.undefined
    })

    it('should return undefined when created_at is missing a timezone designator', () => {
      const json = {
        events: [{created_at: '2023-11-14T22:13:20', identity: validIdentity, name: 'x', properties: {}}],
        schema_version: 1,
      }
      expect(AnalyticsBatch.fromJson(json)).to.be.undefined
    })

    it('should accept created_at with Z suffix or numeric offset', () => {
      for (const ts of ['2023-11-14T22:13:20Z', '2023-11-14T22:13:20+07:00', '2023-11-14T22:13:20.123-05:30']) {
        const json = {
          events: [{created_at: ts, identity: validIdentity, name: 'x', properties: {}}],
          schema_version: 1,
        }
        expect(AnalyticsBatch.fromJson(json), `created_at=${ts} should parse`).to.not.be.undefined
      }
    })

    it('should return undefined when an event carries a stray legacy timestamp field', () => {
      // Wire schema is strict: events must be exactly {created_at, identity, name, properties}.
      // A residual `timestamp` from a pre-upgrade producer must be rejected, matching the backend's
      // `forbidNonWhitelisted` semantics in byterover-telemetry PR #21.
      const json = {
        events: [
          {
            created_at: '2023-11-14T22:13:20+00:00',
            identity: validIdentity,
            name: 'x',
            properties: {},
            timestamp: 1_700_000_000_000,
          },
        ],
        schema_version: 1,
      }
      expect(AnalyticsBatch.fromJson(json)).to.be.undefined
    })

    it('should return undefined when an event has non-object properties', () => {
      const json = {
        events: [
          {created_at: '2023-11-14T22:13:20+00:00', identity: validIdentity, name: 'x', properties: 'foo'},
        ],
        schema_version: 1,
      }
      expect(AnalyticsBatch.fromJson(json)).to.be.undefined
    })
  })
})
