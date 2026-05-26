import {expect} from 'chai'

import {GLOBAL_CONFIG_VERSION} from '../../../../../../src/server/constants.js'
import {GlobalConfig} from '../../../../../../src/server/core/domain/entities/global-config.js'

describe('GlobalConfig', () => {
  const validDeviceId = '550e8400-e29b-41d4-a716-446655440000'

  describe('create()', () => {
    it('should create a GlobalConfig with the given deviceId and current version', () => {
      const config = GlobalConfig.create(validDeviceId)

      expect(config.deviceId).to.equal(validDeviceId)
      expect(config.version).to.equal(GLOBAL_CONFIG_VERSION)
    })

    it('should throw an error when deviceId is empty', () => {
      expect(() => GlobalConfig.create('')).to.throw('Device ID cannot be empty')
    })

    it('should throw an error when deviceId is only whitespace', () => {
      expect(() => GlobalConfig.create('   ')).to.throw('Device ID cannot be empty')
    })
  })

  describe('fromJson()', () => {
    it('should deserialize valid JSON', () => {
      const json = {
        deviceId: validDeviceId,
        version: '0.0.1',
      }

      const config = GlobalConfig.fromJson(json)

      expect(config).to.not.be.undefined
      expect(config?.deviceId).to.equal(validDeviceId)
      expect(config?.version).to.equal('0.0.1')
    })

    it('should return undefined for null', () => {
      const config = GlobalConfig.fromJson(null)

      expect(config).to.be.undefined
    })

    it('should return undefined for non-object', () => {
      expect(GlobalConfig.fromJson('string')).to.be.undefined
      expect(GlobalConfig.fromJson(123)).to.be.undefined
      expect(GlobalConfig.fromJson(true)).to.be.undefined
      expect(GlobalConfig.fromJson([])).to.be.undefined
    })

    it('should return undefined when deviceId is missing', () => {
      const json = {version: '0.0.1'}

      const config = GlobalConfig.fromJson(json)

      expect(config).to.be.undefined
    })

    it('should return undefined when deviceId is empty', () => {
      const json = {
        deviceId: '',
        version: '0.0.1',
      }

      const config = GlobalConfig.fromJson(json)

      expect(config).to.be.undefined
    })

    it('should return undefined when deviceId is only whitespace', () => {
      const json = {
        deviceId: '   ',
        version: '0.0.1',
      }

      const config = GlobalConfig.fromJson(json)

      expect(config).to.be.undefined
    })

    it('should return undefined when version is missing', () => {
      const json = {deviceId: validDeviceId}

      const config = GlobalConfig.fromJson(json)

      expect(config).to.be.undefined
    })

    it('should return undefined when deviceId is not a string', () => {
      const json = {
        deviceId: 123,
        version: '0.0.1',
      }

      const config = GlobalConfig.fromJson(json)

      expect(config).to.be.undefined
    })

    it('should return undefined when version is not a string', () => {
      const json = {
        deviceId: validDeviceId,
        version: 1,
      }

      const config = GlobalConfig.fromJson(json)

      expect(config).to.be.undefined
    })
  })

  describe('toJson()', () => {
    it('should serialize to JSON correctly', () => {
      const config = GlobalConfig.create(validDeviceId)
      const json = config.toJson()

      expect(json).to.deep.equal({
        analytics: false,
        deviceId: validDeviceId,
        version: GLOBAL_CONFIG_VERSION,
      })
    })

    it('should roundtrip through fromJson', () => {
      const original = GlobalConfig.create(validDeviceId)
      const json = original.toJson()
      const restored = GlobalConfig.fromJson(json)

      expect(restored).to.not.be.undefined
      expect(restored?.deviceId).to.equal(original.deviceId)
      expect(restored?.version).to.equal(original.version)
      expect(restored?.analytics).to.equal(original.analytics)
    })
  })

  describe('analytics field (ENG-2611)', () => {
    it('should default analytics to false when absent (legacy upgrade)', () => {
      const config = GlobalConfig.fromJson({deviceId: validDeviceId, version: '0.0.1'})

      expect(config).to.not.be.undefined
      expect(config?.analytics).to.equal(false)
    })

    it('should preserve analytics: true when explicitly set', () => {
      const config = GlobalConfig.fromJson({analytics: true, deviceId: validDeviceId, version: '0.0.1'})

      expect(config).to.not.be.undefined
      expect(config?.analytics).to.equal(true)
    })

    it('should preserve analytics: false when explicitly set', () => {
      const config = GlobalConfig.fromJson({analytics: false, deviceId: validDeviceId, version: '0.0.1'})

      expect(config).to.not.be.undefined
      expect(config?.analytics).to.equal(false)
    })

    it('should reject non-boolean analytics value', () => {
      const config = GlobalConfig.fromJson({analytics: 'yes', deviceId: validDeviceId, version: '0.0.1'})

      expect(config).to.be.undefined
    })

    it('should round-trip analytics: true through toJson/fromJson', () => {
      const fromTrue = GlobalConfig.fromJson({analytics: true, deviceId: validDeviceId, version: '0.0.1'})
      expect(fromTrue, 'fromJson must accept valid analytics: true input').to.not.be.undefined
      if (!fromTrue) throw new Error('fromJson returned undefined for valid input')
      const restoredTrue = GlobalConfig.fromJson(fromTrue.toJson())
      expect(restoredTrue?.analytics).to.equal(true)

      const fromFalse = GlobalConfig.fromJson({analytics: false, deviceId: validDeviceId, version: '0.0.1'})
      expect(fromFalse, 'fromJson must accept valid analytics: false input').to.not.be.undefined
      if (!fromFalse) throw new Error('fromJson returned undefined for valid input')
      const restoredFalse = GlobalConfig.fromJson(fromFalse.toJson())
      expect(restoredFalse?.analytics).to.equal(false)
    })

    it('should default analytics to false on create()', () => {
      const config = GlobalConfig.create(validDeviceId)

      expect(config.analytics).to.equal(false)
    })

    it('should include analytics: false explicitly in toJson() of default-created instance', () => {
      const config = GlobalConfig.create(validDeviceId)
      const json = config.toJson()

      expect(json).to.have.property('analytics', false)
    })
  })

  describe('withAnalytics()', () => {
    it('should produce a new instance with the given analytics value', () => {
      const original = GlobalConfig.create(validDeviceId)
      const updated = original.withAnalytics(true)

      expect(updated.analytics).to.equal(true)
      expect(updated.deviceId).to.equal(validDeviceId)
      expect(updated.version).to.equal(GLOBAL_CONFIG_VERSION)
    })

    it('should not mutate the original instance', () => {
      const original = GlobalConfig.create(validDeviceId)
      original.withAnalytics(true)

      expect(original.analytics).to.equal(false)
    })

    it('should return a new instance even when value matches current', () => {
      const original = GlobalConfig.create(validDeviceId)
      const same = original.withAnalytics(false)

      expect(same).to.not.equal(original)
      expect(same.analytics).to.equal(false)
      expect(same.deviceId).to.equal(original.deviceId)
    })
  })

  describe('immutability', () => {
    it('should have readonly properties', () => {
      const config = GlobalConfig.create(validDeviceId)

      // TypeScript prevents this at compile time, but we verify the values don't change
      expect(config.deviceId).to.equal(validDeviceId)
      expect(config.version).to.equal(GLOBAL_CONFIG_VERSION)
    })
  })
})
