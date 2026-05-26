/* eslint-disable camelcase */
import {expect} from 'chai'

import {AnalyticsBatch} from '../../../../../../src/server/core/domain/analytics/batch.js'

const validIdentity = {
  device_id: '550e8400-e29b-41d4-a716-446655440000',
}

const eventA = {
  identity: validIdentity,
  name: 'event_a',
  properties: {x: 1},
  timestamp: 1_700_000_000_000,
}

const eventB = {
  identity: validIdentity,
  name: 'event_b',
  properties: {y: 'hello'},
  timestamp: 1_700_000_000_001,
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
        events: [{identity: validIdentity, properties: {}, timestamp: 1}],
        schema_version: 1,
      }
      expect(AnalyticsBatch.fromJson(json)).to.be.undefined
    })

    it('should return undefined when an event has non-string name', () => {
      const json = {
        events: [{identity: validIdentity, name: 123, properties: {}, timestamp: 1}],
        schema_version: 1,
      }
      expect(AnalyticsBatch.fromJson(json)).to.be.undefined
    })

    it('should return undefined when an event is missing identity', () => {
      const json = {
        events: [{name: 'x', properties: {}, timestamp: 1}],
        schema_version: 1,
      }
      expect(AnalyticsBatch.fromJson(json)).to.be.undefined
    })

    it('should return undefined when identity is missing device_id', () => {
      const json = {
        events: [{identity: {}, name: 'x', properties: {}, timestamp: 1}],
        schema_version: 1,
      }
      expect(AnalyticsBatch.fromJson(json)).to.be.undefined
    })

    it('should return undefined when identity has empty device_id', () => {
      const json = {
        events: [{identity: {device_id: ''}, name: 'x', properties: {}, timestamp: 1}],
        schema_version: 1,
      }
      expect(AnalyticsBatch.fromJson(json)).to.be.undefined
    })

    it('should return undefined when an event has non-number timestamp', () => {
      const json = {
        events: [{identity: validIdentity, name: 'x', properties: {}, timestamp: 'now'}],
        schema_version: 1,
      }
      expect(AnalyticsBatch.fromJson(json)).to.be.undefined
    })

    it('should return undefined when an event has non-object properties', () => {
      const json = {
        events: [{identity: validIdentity, name: 'x', properties: 'foo', timestamp: 1}],
        schema_version: 1,
      }
      expect(AnalyticsBatch.fromJson(json)).to.be.undefined
    })
  })
})
