import {expect} from 'chai'

import type {ISettingsStore, SettingsStartupSnapshot} from '../../../../src/server/core/interfaces/storage/i-settings-store.js'

import {
  AGENT_MAX_CONCURRENT_TASKS,
  AGENT_POOL_MAX_SIZE,
  TASK_HISTORY_DEFAULT_MAX_ENTRIES,
} from '../../../../src/server/constants.js'
import {bootstrapSettings} from '../../../../src/server/infra/daemon/settings-bootstrap.js'

class StubSettingsStore implements ISettingsStore {
  public constructor(private readonly snapshot: SettingsStartupSnapshot) {}

  public async get(): Promise<never> {
    throw new Error('not used')
  }

  public async list(): Promise<never> {
    throw new Error('not used')
  }

  public async readStartupSnapshot(): Promise<SettingsStartupSnapshot> {
    return this.snapshot
  }

  public async reset(): Promise<void> {
    throw new Error('not used')
  }

  public async set(): Promise<void> {
    throw new Error('not used')
  }
}

describe('bootstrapSettings', () => {
  it('returns all defaults and emits no log when the file is missing', async () => {
    const store = new StubSettingsStore({invalid: [], values: {}})
    const log = newLogger()
    const result = await bootstrapSettings({log: log.write, store})

    expect(result.agentPoolMaxSize).to.equal(AGENT_POOL_MAX_SIZE)
    expect(result.agentMaxConcurrentTasks).to.equal(AGENT_MAX_CONCURRENT_TASKS)
    expect(result.taskHistoryMaxEntries).to.equal(TASK_HISTORY_DEFAULT_MAX_ENTRIES)
    expect(log.messages).to.deep.equal([])
  })

  it('returns all defaults and logs a parse-error message when the file is corrupt', async () => {
    const store = new StubSettingsStore({invalid: [], parseError: 'invalid JSON: Unexpected token', values: {}})
    const log = newLogger()
    const result = await bootstrapSettings({log: log.write, store})

    expect(result.agentPoolMaxSize).to.equal(AGENT_POOL_MAX_SIZE)
    expect(result.agentMaxConcurrentTasks).to.equal(AGENT_MAX_CONCURRENT_TASKS)
    expect(result.taskHistoryMaxEntries).to.equal(TASK_HISTORY_DEFAULT_MAX_ENTRIES)
    expect(log.messages).to.have.lengthOf(1)
    expect(log.messages[0]).to.include('settings file')
    expect(log.messages[0]).to.include('invalid JSON')
  })

  it('applies valid overrides and logs once per invalid entry', async () => {
    const store = new StubSettingsStore({
      invalid: [
        {key: 'agentPool.maxSize', reason: 'value 0 is outside allowed range', value: 0},
        {key: 'not.a.key', reason: 'unknown settings key', value: 7},
      ],
      values: {'taskHistory.maxEntries': 5000},
    })
    const log = newLogger()
    const result = await bootstrapSettings({log: log.write, store})

    expect(result.agentPoolMaxSize).to.equal(AGENT_POOL_MAX_SIZE)
    expect(result.agentMaxConcurrentTasks).to.equal(AGENT_MAX_CONCURRENT_TASKS)
    expect(result.taskHistoryMaxEntries).to.equal(5000)

    expect(log.messages).to.have.lengthOf(2)
    expect(log.messages.find((m) => m.includes('agentPool.maxSize'))).to.exist
    expect(log.messages.find((m) => m.includes('not.a.key'))).to.exist
  })

  it('falls back to defaults for BOTH coupled keys when the file violates llm.requestTimeoutMs <= llm.iterationBudgetMs', async () => {
    const store = new StubSettingsStore({
      invalid: [
        {
          key: 'llm.requestTimeoutMs',
          reason: 'llm.requestTimeoutMs (900000) must be <= llm.iterationBudgetMs (300000)',
          value: 900_000,
        },
        {
          key: 'llm.iterationBudgetMs',
          reason: 'llm.requestTimeoutMs (900000) must be <= llm.iterationBudgetMs (300000)',
          value: 300_000,
        },
      ],
      values: {},
    })
    const log = newLogger()

    await bootstrapSettings({log: log.write, store})

    const requestTimeoutWarn = log.messages.find((m) => m.includes('llm.requestTimeoutMs'))
    const budgetWarn = log.messages.find((m) => m.includes('llm.iterationBudgetMs'))
    expect(requestTimeoutWarn, 'warning for llm.requestTimeoutMs').to.exist
    expect(budgetWarn, 'warning for llm.iterationBudgetMs').to.exist
  })

  it('applies all overrides and emits no log when the file is fully valid', async () => {
    const store = new StubSettingsStore({
      invalid: [],
      values: {
        'agentPool.maxConcurrentTasksPerProject': 8,
        'agentPool.maxSize': 25,
        'taskHistory.maxEntries': 5000,
      },
    })
    const log = newLogger()
    const result = await bootstrapSettings({log: log.write, store})

    expect(result.agentPoolMaxSize).to.equal(25)
    expect(result.agentMaxConcurrentTasks).to.equal(8)
    expect(result.taskHistoryMaxEntries).to.equal(5000)
    expect(log.messages).to.deep.equal([])
  })
})

function newLogger(): {messages: string[]; write: (message: string) => void} {
  const messages: string[] = []
  return {
    messages,
    write(message: string) {
      messages.push(message)
    },
  }
}
