import {expect} from 'chai'

import type {SettingDescriptor} from '../../../../src/server/core/domain/entities/settings.js'

import {
  InvalidSettingValueError,
  ReadonlySettingKeyError,
  SettingsValidator,
  UnknownSettingKeyError,
} from '../../../../src/server/infra/storage/settings-validator.js'

describe('SettingsValidator', () => {
  const validator = new SettingsValidator()

  describe('validateKey', () => {
    it('returns the descriptor for a known key', () => {
      const descriptor = validator.validateKey('agentPool.maxSize')
      expect(descriptor.key).to.equal('agentPool.maxSize')
      if (descriptor.type === 'integer') {
        expect(descriptor.default).to.be.a('number')
        expect(descriptor.min).to.be.a('number')
        expect(descriptor.max).to.be.a('number')
      } else {
        expect.fail('expected integer descriptor for agentPool.maxSize')
      }
    })

    it('throws UnknownSettingKeyError for an unknown key', () => {
      expect(() => validator.validateKey('not.a.real.key')).to.throw(UnknownSettingKeyError)
    })

    it('includes the offending key on the error', () => {
      try {
        validator.validateKey('not.a.real.key')
        expect.fail('expected throw')
      } catch (error) {
        expect(error).to.be.instanceOf(UnknownSettingKeyError)
        if (error instanceof UnknownSettingKeyError) {
          expect(error.key).to.equal('not.a.real.key')
          expect(error.message).to.include('not.a.real.key')
        }
      }
    })
  })

  describe('validate', () => {
    it('returns the value when within range', () => {
      const result = validator.validate('agentPool.maxSize', 20)
      expect(result).to.equal(20)
    })

    it('throws UnknownSettingKeyError for an unknown key', () => {
      expect(() => validator.validate('nope', 1)).to.throw(UnknownSettingKeyError)
    })

    it('throws InvalidSettingValueError when value is not a number', () => {
      expect(() => validator.validate('agentPool.maxSize', 'twenty')).to.throw(
        InvalidSettingValueError,
      )
    })

    it('throws InvalidSettingValueError when value is a fractional number', () => {
      expect(() => validator.validate('agentPool.maxSize', 1.5)).to.throw(InvalidSettingValueError)
    })

    it('throws InvalidSettingValueError when value is below min', () => {
      try {
        validator.validate('agentPool.maxSize', 0)
        expect.fail('expected throw')
      } catch (error) {
        expect(error).to.be.instanceOf(InvalidSettingValueError)
        if (error instanceof InvalidSettingValueError) {
          expect(error.key).to.equal('agentPool.maxSize')
          expect(error.value).to.equal(0)
          expect(error.message).to.match(/range|min|max/i)
        }
      }
    })

    it('throws InvalidSettingValueError when value is above max', () => {
      const descriptor = validator.validateKey('agentPool.maxSize')
      if (descriptor.type === 'integer') {
        expect(() => validator.validate('agentPool.maxSize', descriptor.max + 1)).to.throw(
          InvalidSettingValueError,
        )
      } else {
        expect.fail('expected integer descriptor')
      }
    })

    it('accepts the minimum boundary value', () => {
      const descriptor = validator.validateKey('agentPool.maxSize')
      if (descriptor.type === 'integer') {
        expect(validator.validate('agentPool.maxSize', descriptor.min)).to.equal(descriptor.min)
      } else {
        expect.fail('expected integer descriptor')
      }
    })

    it('accepts the maximum boundary value', () => {
      const descriptor = validator.validateKey('agentPool.maxSize')
      if (descriptor.type === 'integer') {
        expect(validator.validate('agentPool.maxSize', descriptor.max)).to.equal(descriptor.max)
      } else {
        expect.fail('expected integer descriptor')
      }
    })

    it('validates each registered key independently', () => {
      expect(validator.validate('agentPool.maxConcurrentTasksPerProject', 3)).to.equal(3)
      expect(validator.validate('taskHistory.maxEntries', 5000)).to.equal(5000)
    })

    it('accepts llm.iterationBudgetMs within the documented 60_000 to 3_600_000 ms range', () => {
      expect(validator.validate('llm.iterationBudgetMs', 60_000)).to.equal(60_000)
      expect(validator.validate('llm.iterationBudgetMs', 1_800_000)).to.equal(1_800_000)
      expect(validator.validate('llm.iterationBudgetMs', 3_600_000)).to.equal(3_600_000)
    })

    it('rejects llm.iterationBudgetMs below the 60_000 ms minimum', () => {
      expect(() => validator.validate('llm.iterationBudgetMs', 30_000)).to.throw(InvalidSettingValueError)
    })

    it('rejects llm.iterationBudgetMs above the 3_600_000 ms maximum (M7 T2 tightening)', () => {
      expect(() => validator.validate('llm.iterationBudgetMs', 3_600_001)).to.throw(InvalidSettingValueError)
      expect(() => validator.validate('llm.iterationBudgetMs', 5_400_000)).to.throw(InvalidSettingValueError)
    })

    it('names the key and the expected range on llm.iterationBudgetMs validation failure', () => {
      try {
        validator.validate('llm.iterationBudgetMs', 1)
        expect.fail('expected throw')
      } catch (error) {
        expect(error).to.be.instanceOf(InvalidSettingValueError)
        if (error instanceof InvalidSettingValueError) {
          expect(error.key).to.equal('llm.iterationBudgetMs')
          expect(error.message).to.include('60000')
          expect(error.message).to.include('3600000')
        }
      }
    })

    it('accepts llm.requestTimeoutMs within the documented 10_000 to 3_600_000 ms range', () => {
      expect(validator.validate('llm.requestTimeoutMs', 10_000)).to.equal(10_000)
      expect(validator.validate('llm.requestTimeoutMs', 120_000)).to.equal(120_000)
      expect(validator.validate('llm.requestTimeoutMs', 3_600_000)).to.equal(3_600_000)
    })

    it('rejects llm.requestTimeoutMs below the 10_000 ms minimum', () => {
      expect(() => validator.validate('llm.requestTimeoutMs', 5000)).to.throw(InvalidSettingValueError)
    })

    it('rejects llm.requestTimeoutMs above the 3_600_000 ms maximum (M7 T2 tightening)', () => {
      expect(() => validator.validate('llm.requestTimeoutMs', 3_600_001)).to.throw(InvalidSettingValueError)
      expect(() => validator.validate('llm.requestTimeoutMs', 5_400_000)).to.throw(InvalidSettingValueError)
    })

    it('rejects taskHistory.maxEntries above the 10_000 maximum (M7 T2 tightening)', () => {
      expect(() => validator.validate('taskHistory.maxEntries', 10_001)).to.throw(InvalidSettingValueError)
      expect(() => validator.validate('taskHistory.maxEntries', 50_000)).to.throw(InvalidSettingValueError)
    })

    it('accepts taskHistory.maxEntries up to the new 10_000 maximum', () => {
      expect(validator.validate('taskHistory.maxEntries', 10)).to.equal(10)
      expect(validator.validate('taskHistory.maxEntries', 1000)).to.equal(1000)
      expect(validator.validate('taskHistory.maxEntries', 10_000)).to.equal(10_000)
    })
  })

  describe('validateCoupling', () => {
    it('returns no violations when both keys are within bounds and request <= budget', () => {
      const violations = validator.validateCoupling({
        'llm.iterationBudgetMs': 600_000,
        'llm.requestTimeoutMs': 120_000,
      })
      expect(violations).to.deep.equal([])
    })

    it('flags a violation when requestTimeoutMs exceeds iterationBudgetMs', () => {
      const violations = validator.validateCoupling({
        'llm.iterationBudgetMs': 300_000,
        'llm.requestTimeoutMs': 600_000,
      })
      expect(violations).to.have.lengthOf(1)
      expect(violations[0].keys).to.have.members(['llm.requestTimeoutMs', 'llm.iterationBudgetMs'])
      expect(violations[0].reason).to.include('600000')
      expect(violations[0].reason).to.include('300000')
    })

    it('uses the registered default for the missing key when only one is supplied', () => {
      // Default iterationBudgetMs = 600_000. requestTimeoutMs=900_000 violates.
      const violations = validator.validateCoupling({'llm.requestTimeoutMs': 900_000})
      expect(violations).to.have.lengthOf(1)
    })

    it('returns no violations when neither coupled key is registered in the record', () => {
      const violations = validator.validateCoupling({'agentPool.maxSize': 25})
      expect(violations).to.deep.equal([])
    })
  })

  describe('partition', () => {
    it('separates valid entries from invalid entries', () => {
      const result = validator.partition({
        'agentPool.maxConcurrentTasksPerProject': 'bad',
        'agentPool.maxSize': 25,
        'not.a.key': 7,
        'taskHistory.maxEntries': 5000,
      })

      expect(result.valid).to.deep.equal({
        'agentPool.maxSize': 25,
        'taskHistory.maxEntries': 5000,
      })
      expect(result.invalid).to.have.lengthOf(2)
      const keys = result.invalid.map((i) => i.key).sort()
      expect(keys).to.deep.equal(['agentPool.maxConcurrentTasksPerProject', 'not.a.key'])
    })

    it('returns empty valid/invalid for an empty record', () => {
      const result = validator.partition({})
      expect(result.valid).to.deep.equal({})
      expect(result.invalid).to.deep.equal([])
    })

    it('treats out-of-range values as invalid', () => {
      const result = validator.partition({'agentPool.maxSize': 0})
      expect(result.valid).to.deep.equal({})
      expect(result.invalid).to.have.lengthOf(1)
      expect(result.invalid[0].key).to.equal('agentPool.maxSize')
      expect(result.invalid[0].value).to.equal(0)
    })
  })

  describe('validate (boolean descriptor — T1 update.checkForUpdates)', () => {
    it('accepts true', () => {
      expect(validator.validate('update.checkForUpdates', true)).to.equal(true)
    })

    it('accepts false', () => {
      expect(validator.validate('update.checkForUpdates', false)).to.equal(false)
    })

    it('rejects a numeric value', () => {
      try {
        validator.validate('update.checkForUpdates', 1)
        expect.fail('expected throw')
      } catch (error) {
        expect(error).to.be.instanceOf(InvalidSettingValueError)
        if (error instanceof InvalidSettingValueError) {
          expect(error.key).to.equal('update.checkForUpdates')
          expect(error.message.toLowerCase()).to.include('boolean')
        }
      }
    })

    it('rejects a string value', () => {
      expect(() => validator.validate('update.checkForUpdates', 'true')).to.throw(
        InvalidSettingValueError,
      )
    })

    it('rejects null', () => {
      expect(() => validator.validate('update.checkForUpdates', null)).to.throw(
        InvalidSettingValueError,
      )
    })

    it('rejects missing values (undefined)', () => {
      // Surface a true undefined to the validator via a property access
      // rather than a literal `undefined` argument, to avoid the
      // unicorn/no-useless-undefined rule on direct argument passing.
      const missing: {absent?: unknown} = {}
      expect(() => validator.validate('update.checkForUpdates', missing.absent)).to.throw(
        InvalidSettingValueError,
      )
    })
  })

  describe('partition (mixed integer + boolean)', () => {
    it('puts a valid boolean entry into valid and keeps integer entries beside it', () => {
      const result = validator.partition({
        'agentPool.maxSize': 25,
        'update.checkForUpdates': true,
      })
      expect(result.valid).to.deep.equal({
        'agentPool.maxSize': 25,
        'update.checkForUpdates': true,
      })
      expect(result.invalid).to.deep.equal([])
    })

    it('puts a string masquerading as boolean into invalid', () => {
      const result = validator.partition({'update.checkForUpdates': 'yes'})
      expect(result.valid).to.deep.equal({})
      expect(result.invalid).to.have.lengthOf(1)
      expect(result.invalid[0].key).to.equal('update.checkForUpdates')
      expect(result.invalid[0].value).to.equal('yes')
    })
  })

  describe('readonly-info variant (M16.1)', () => {
    const readonlyInfoRegistry: readonly SettingDescriptor[] = [
      {
        category: 'updates',
        description: 'live operational snapshot for tests',
        key: '_test.snapshot',
        restartRequired: false,
        type: 'readonly-info',
      },
    ]

    describe('constructor accepts an injected registry override', () => {
      it('validateKey resolves keys from the injected registry only', () => {
        const isolated = new SettingsValidator({registry: readonlyInfoRegistry})
        expect(isolated.validateKey('_test.snapshot').type).to.equal('readonly-info')
        expect(() => isolated.validateKey('agentPool.maxSize')).to.throw(UnknownSettingKeyError)
      })
    })

    describe('validate', () => {
      it('throws ReadonlySettingKeyError when called on a readonly-info key', () => {
        const isolated = new SettingsValidator({registry: readonlyInfoRegistry})
        expect(() => isolated.validate('_test.snapshot', {q: 1})).to.throw(ReadonlySettingKeyError)
      })

      it('names the offending key on ReadonlySettingKeyError', () => {
        const isolated = new SettingsValidator({registry: readonlyInfoRegistry})
        try {
          isolated.validate('_test.snapshot', 1)
          expect.fail('expected throw')
        } catch (error) {
          expect(error).to.be.instanceOf(ReadonlySettingKeyError)
          if (error instanceof ReadonlySettingKeyError) {
            expect(error.key).to.equal('_test.snapshot')
            expect(error.message).to.match(/read-only|readonly/i)
          }
        }
      })
    })

    describe('partition', () => {
      it('pushes a readonly-info key found on disk into invalid with a readonly reason', () => {
        const isolated = new SettingsValidator({registry: readonlyInfoRegistry})
        const result = isolated.partition({'_test.snapshot': {q: 1}})
        expect(result.valid).to.deep.equal({})
        expect(result.invalid).to.have.lengthOf(1)
        expect(result.invalid[0].key).to.equal('_test.snapshot')
        expect(result.invalid[0].reason.toLowerCase()).to.include('read')
      })

      it('omits readonly-info keys from the valid record when the file does NOT mention them', () => {
        const isolated = new SettingsValidator({registry: readonlyInfoRegistry})
        const result = isolated.partition({})
        expect(result.valid).to.deep.equal({})
        expect(result.invalid).to.deep.equal([])
      })

      it('still partitions writable keys correctly when mixed with readonly-info entries', () => {
        const mixedRegistry: readonly SettingDescriptor[] = [
          ...readonlyInfoRegistry,
          {
            category: 'concurrency',
            default: 10,
            description: 'test writable',
            key: '_test.writable',
            max: 100,
            min: 1,
            restartRequired: true,
            type: 'integer',
          },
        ]
        const isolated = new SettingsValidator({registry: mixedRegistry})
        const result = isolated.partition({
          '_test.snapshot': {q: 1},
          '_test.writable': 25,
        })
        expect(result.valid).to.deep.equal({'_test.writable': 25})
        expect(result.invalid).to.have.lengthOf(1)
        expect(result.invalid[0].key).to.equal('_test.snapshot')
      })
    })
  })
})
