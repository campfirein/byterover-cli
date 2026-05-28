import {expect} from 'chai'

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
      expect(descriptor?.default).to.equal(true)
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
})
