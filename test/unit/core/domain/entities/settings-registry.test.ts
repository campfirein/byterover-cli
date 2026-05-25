import {expect} from 'chai'

import {
  findSettingDescriptor,
  SETTINGS_KEYS,
  SETTINGS_REGISTRY,
} from '../../../../../src/server/core/domain/entities/settings.js'

describe('settings registry — M7 T2 shape', () => {
  it('declares category on every descriptor', () => {
    for (const descriptor of SETTINGS_REGISTRY) {
      expect(descriptor.category, `key ${descriptor.key} missing category`).to.be.oneOf([
        'concurrency',
        'llm',
        'task-history',
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
    expect(findSettingDescriptor(SETTINGS_KEYS.LLM_ITERATION_BUDGET_MS)?.unit).to.equal('ms')
    expect(findSettingDescriptor(SETTINGS_KEYS.LLM_REQUEST_TIMEOUT_MS)?.unit).to.equal('ms')
  })

  it('omits unit (or sets count) on non-ms keys', () => {
    const maxSize = findSettingDescriptor(SETTINGS_KEYS.AGENT_POOL_MAX_SIZE)?.unit
    expect(maxSize === undefined || maxSize === 'count').to.equal(true)
    const tasks = findSettingDescriptor(SETTINGS_KEYS.AGENT_POOL_MAX_CONCURRENT_TASKS)?.unit
    expect(tasks === undefined || tasks === 'count').to.equal(true)
    const history = findSettingDescriptor(SETTINGS_KEYS.TASK_HISTORY_MAX_ENTRIES)?.unit
    expect(history === undefined || history === 'count').to.equal(true)
  })

  it('tightens llm.iterationBudgetMs max to 3_600_000 (1h)', () => {
    expect(findSettingDescriptor(SETTINGS_KEYS.LLM_ITERATION_BUDGET_MS)?.max).to.equal(3_600_000)
  })

  it('tightens llm.requestTimeoutMs max to 3_600_000 (1h)', () => {
    expect(findSettingDescriptor(SETTINGS_KEYS.LLM_REQUEST_TIMEOUT_MS)?.max).to.equal(3_600_000)
  })

  it('tightens taskHistory.maxEntries max to 10_000', () => {
    expect(findSettingDescriptor(SETTINGS_KEYS.TASK_HISTORY_MAX_ENTRIES)?.max).to.equal(10_000)
  })

  it('keeps every description string at <= 80 chars (WebUI tooltip budget)', () => {
    for (const descriptor of SETTINGS_REGISTRY) {
      expect(
        descriptor.description.length,
        `key ${descriptor.key} description is ${descriptor.description.length} chars (> 80): "${descriptor.description}"`,
      ).to.be.at.most(80)
    }
  })
})
