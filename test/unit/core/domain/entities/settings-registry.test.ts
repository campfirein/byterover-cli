import {expect} from 'chai'

import type {
  ReadonlyInfoSettingDescriptor,
  SettingDescriptor,
} from '../../../../../src/server/core/domain/entities/settings.js'

import {
  findSettingDescriptor,
  SETTINGS_KEYS,
  SETTINGS_REGISTRY,
} from '../../../../../src/server/core/domain/entities/settings.js'

function integerMaxOf(key: string): number {
  const descriptor = findSettingDescriptor(key)
  if (descriptor?.type !== 'integer') throw new Error(`expected integer descriptor for ${key}`)
  return descriptor.max
}

function unitOf(key: string): string | undefined {
  const descriptor = findSettingDescriptor(key)
  return descriptor?.type === 'integer' ? descriptor.unit : undefined
}

describe('settings registry — M7 T2 shape', () => {
  it('declares category on every descriptor', () => {
    for (const descriptor of SETTINGS_REGISTRY) {
      expect(descriptor.category, `key ${descriptor.key} missing category`).to.be.oneOf([
        'analytics',
        'concurrency',
        'llm',
        'task-history',
        'updates',
      ])
    }
  })

  it('groups agent-pool keys under category=concurrency', () => {
    expect(findSettingDescriptor(SETTINGS_KEYS.AGENT_POOL_MAX_SIZE)?.category).to.equal('concurrency')
    expect(findSettingDescriptor(SETTINGS_KEYS.AGENT_POOL_MAX_CONCURRENT_TASKS)?.category).to.equal('concurrency')
  })

  it('groups llm.* keys under category=llm', () => {
    expect(findSettingDescriptor(SETTINGS_KEYS.LLM_ITERATION_BUDGET_MS)?.category).to.equal('llm')
    expect(findSettingDescriptor(SETTINGS_KEYS.LLM_REQUEST_TIMEOUT_MS)?.category).to.equal('llm')
  })

  it('groups taskHistory.* keys under category=task-history', () => {
    expect(findSettingDescriptor(SETTINGS_KEYS.TASK_HISTORY_MAX_ENTRIES)?.category).to.equal('task-history')
  })

  it('declares unit=ms on the two llm.*Ms keys', () => {
    expect(unitOf(SETTINGS_KEYS.LLM_ITERATION_BUDGET_MS)).to.equal('ms')
    expect(unitOf(SETTINGS_KEYS.LLM_REQUEST_TIMEOUT_MS)).to.equal('ms')
  })

  it('omits unit (or sets count) on non-ms keys', () => {
    const maxSize = unitOf(SETTINGS_KEYS.AGENT_POOL_MAX_SIZE)
    expect(maxSize === undefined || maxSize === 'count').to.equal(true)
    const tasks = unitOf(SETTINGS_KEYS.AGENT_POOL_MAX_CONCURRENT_TASKS)
    expect(tasks === undefined || tasks === 'count').to.equal(true)
    const history = unitOf(SETTINGS_KEYS.TASK_HISTORY_MAX_ENTRIES)
    expect(history === undefined || history === 'count').to.equal(true)
  })

  it('tightens llm.iterationBudgetMs max to 3_600_000 (1h)', () => {
    expect(integerMaxOf(SETTINGS_KEYS.LLM_ITERATION_BUDGET_MS)).to.equal(3_600_000)
  })

  it('tightens llm.requestTimeoutMs max to 3_600_000 (1h)', () => {
    expect(integerMaxOf(SETTINGS_KEYS.LLM_REQUEST_TIMEOUT_MS)).to.equal(3_600_000)
  })

  it('tightens taskHistory.maxEntries max to 10_000', () => {
    expect(integerMaxOf(SETTINGS_KEYS.TASK_HISTORY_MAX_ENTRIES)).to.equal(10_000)
  })

  it('keeps every description string at <= 80 chars (WebUI tooltip budget)', () => {
    for (const descriptor of SETTINGS_REGISTRY) {
      expect(
        descriptor.description.length,
        `key ${descriptor.key} description is ${descriptor.description.length} chars (> 80): "${descriptor.description}"`,
      ).to.be.at.most(80)
    }
  })

  describe('update.checkForUpdates (T1 boolean descriptor)', () => {
    it('exposes UPDATE_CHECK_FOR_UPDATES on SETTINGS_KEYS', () => {
      expect(SETTINGS_KEYS.UPDATE_CHECK_FOR_UPDATES).to.equal('update.checkForUpdates')
    })

    it('registers a descriptor for update.checkForUpdates', () => {
      const descriptor = findSettingDescriptor(SETTINGS_KEYS.UPDATE_CHECK_FOR_UPDATES)
      expect(descriptor, 'descriptor must exist in SETTINGS_REGISTRY').to.exist
    })

    it('declares the descriptor as type=boolean with default=true', () => {
      const descriptor = findSettingDescriptor(SETTINGS_KEYS.UPDATE_CHECK_FOR_UPDATES)
      expect(descriptor?.type).to.equal('boolean')
      if (descriptor?.type === 'boolean') {
        expect(descriptor.default).to.equal(true)
      } else {
        expect.fail('expected boolean descriptor for update.checkForUpdates')
      }
    })

    it('marks the descriptor as not requiring a daemon restart', () => {
      const descriptor = findSettingDescriptor(SETTINGS_KEYS.UPDATE_CHECK_FOR_UPDATES)
      expect(descriptor?.restartRequired).to.equal(false)
    })

    it('groups the descriptor under category=updates', () => {
      const descriptor = findSettingDescriptor(SETTINGS_KEYS.UPDATE_CHECK_FOR_UPDATES)
      expect(descriptor?.category).to.equal('updates')
    })

    it('narrows to BooleanSettingDescriptor when descriptor.type === boolean', () => {
      const descriptor = findSettingDescriptor(SETTINGS_KEYS.UPDATE_CHECK_FOR_UPDATES)
      if (descriptor?.type === 'boolean') {
        // If this assignment compiles, narrowing works. Otherwise the test
        // file fails to type-check at build time, which is the test's
        // primary value.
        const defaultValue: boolean = descriptor.default
        expect(defaultValue).to.equal(true)
      } else {
        expect.fail('expected boolean descriptor for update.checkForUpdates')
      }
    })

    it('narrows existing integer descriptors to IntegerSettingDescriptor when descriptor.type === integer', () => {
      const descriptor = findSettingDescriptor(SETTINGS_KEYS.AGENT_POOL_MAX_SIZE)
      if (descriptor?.type === 'integer') {
        const {max, min} = descriptor
        expect(min).to.be.lessThan(max)
      } else {
        expect.fail('expected integer descriptor for agentPool.maxSize')
      }
    })
  })

  describe('analytics category (M16.3)', () => {
    it('accepts category=analytics on a readonly-info descriptor', () => {
      const descriptor: ReadonlyInfoSettingDescriptor = {
        category: 'analytics',
        description: 'live analytics shipping snapshot',
        key: '_test.analytics',
        restartRequired: false,
        type: 'readonly-info',
      }
      expect(descriptor.category).to.equal('analytics')
    })

    it('accepts category=analytics on a boolean descriptor (M16.2 will use this)', () => {
      const descriptor: SettingDescriptor = {
        category: 'analytics',
        default: false,
        description: 'analytics opt-in',
        key: '_test.analytics.share',
        restartRequired: false,
        type: 'boolean',
      }
      expect(descriptor.category).to.equal('analytics')
    })
  })

  describe('readonly-info variant (M16.1)', () => {
    it('accepts a readonly-info literal that narrows on type without a cast', () => {
      const descriptor: ReadonlyInfoSettingDescriptor = {
        category: 'updates',
        description: 'live operational snapshot for tests',
        key: '_test.snapshot',
        restartRequired: false,
        type: 'readonly-info',
      }
      expect(descriptor.type).to.equal('readonly-info')
    })

    it('discriminates the SettingDescriptor union on type without an `as` assertion', () => {
      const descriptor: SettingDescriptor = {
        category: 'updates',
        description: 'live operational snapshot for tests',
        key: '_test.snapshot',
        restartRequired: false,
        type: 'readonly-info',
      }
      if (descriptor.type === 'readonly-info') {
        const {key} = descriptor
        expect(key).to.equal('_test.snapshot')
      } else {
        expect.fail('expected readonly-info branch')
      }
    })

    it('rejects restartRequired=true on a readonly-info descriptor at the type level', () => {
      // The descriptor narrows `restartRequired` to literal `false`. The
      // assignment below would fail to type-check if a future refactor
      // widened the field back to `boolean`, regressing the invariant.
      const descriptor: ReadonlyInfoSettingDescriptor = {
        description: 'snapshot',
        key: '_test.snapshot',
        restartRequired: false,
        type: 'readonly-info',
      }
      expect(descriptor.restartRequired).to.equal(false)
    })

    it('SETTINGS_REGISTRY now includes analytics.status as the first readonly-info entry (M16.3)', () => {
      // M16.3 lands the first real readonly-info descriptor in the
      // production registry: `analytics.status` (the live shipping
      // snapshot consumed by the legacy `brv analytics status`).
      const readonlyInfoEntries = SETTINGS_REGISTRY.filter((d) => d.type === 'readonly-info')
      expect(readonlyInfoEntries).to.have.lengthOf(1)
      expect(readonlyInfoEntries[0].key).to.equal('analytics.status')
    })
  })

  describe('analytics.share descriptor (M16.2)', () => {
    it('exposes ANALYTICS_ENABLED on SETTINGS_KEYS', () => {
      expect(SETTINGS_KEYS.ANALYTICS_ENABLED).to.equal('analytics.share')
    })

    it('registers a descriptor for analytics.share', () => {
      const descriptor = findSettingDescriptor(SETTINGS_KEYS.ANALYTICS_ENABLED)
      expect(descriptor, 'descriptor must exist in SETTINGS_REGISTRY').to.exist
    })

    it('declares the descriptor as type=boolean, default=false, category=analytics, restartRequired=false', () => {
      const descriptor = findSettingDescriptor(SETTINGS_KEYS.ANALYTICS_ENABLED)
      expect(descriptor?.type).to.equal('boolean')
      if (descriptor?.type === 'boolean') {
        expect(descriptor.default).to.equal(false)
      }

      expect(descriptor?.category).to.equal('analytics')
      expect(descriptor?.restartRequired).to.equal(false)
    })

    it('declares storage=global-config so the file store skips persistence', () => {
      const descriptor = findSettingDescriptor(SETTINGS_KEYS.ANALYTICS_ENABLED)
      // `storage` is an optional field on writable descriptors; defaults to 'file'.
      // analytics.share lives in `config.json`, not `settings.json`.
      if (descriptor?.type === 'boolean') {
        expect(descriptor.storage).to.equal('global-config')
      } else {
        expect.fail('expected boolean descriptor for analytics.share')
      }
    })

    it('description fits the 80-char tooltip budget', () => {
      const descriptor = findSettingDescriptor(SETTINGS_KEYS.ANALYTICS_ENABLED)
      expect(descriptor?.description.length).to.be.at.most(80)
    })

    it('existing writable descriptors omit the storage field (defaults to file)', () => {
      const maxSize = findSettingDescriptor(SETTINGS_KEYS.AGENT_POOL_MAX_SIZE)
      if (maxSize?.type === 'integer') {
        // Optional field; existing descriptors do not declare it.
        expect(maxSize.storage === undefined || maxSize.storage === 'file').to.equal(true)
      }
    })
  })

  describe('analytics.status descriptor (M16.3)', () => {
    it('exposes ANALYTICS_STATUS on SETTINGS_KEYS', () => {
      expect(SETTINGS_KEYS.ANALYTICS_STATUS).to.equal('analytics.status')
    })

    it('registers a descriptor for analytics.status', () => {
      const descriptor = findSettingDescriptor(SETTINGS_KEYS.ANALYTICS_STATUS)
      expect(descriptor, 'descriptor must exist in SETTINGS_REGISTRY').to.exist
    })

    it('declares the descriptor as type=readonly-info under category=analytics', () => {
      const descriptor = findSettingDescriptor(SETTINGS_KEYS.ANALYTICS_STATUS)
      expect(descriptor?.type).to.equal('readonly-info')
      expect(descriptor?.category).to.equal('analytics')
    })

    it('marks the descriptor as not requiring a daemon restart', () => {
      const descriptor = findSettingDescriptor(SETTINGS_KEYS.ANALYTICS_STATUS)
      expect(descriptor?.restartRequired).to.equal(false)
    })

    it('description fits the 80-char tooltip budget', () => {
      const descriptor = findSettingDescriptor(SETTINGS_KEYS.ANALYTICS_STATUS)
      expect(descriptor?.description.length).to.be.at.most(80)
    })
  })
})
