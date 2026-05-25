import {expect} from 'chai'
import {mkdir, rm} from 'node:fs/promises'
import {tmpdir} from 'node:os'
import {join} from 'node:path'

import {
  configureTaskHistoryStoreCache,
  getStore,
  resetTaskHistoryStoreCache,
} from '../../../../src/server/infra/process/task-history-store-cache.js'

describe('configureTaskHistoryStoreCache', () => {
  let projectDir: string

  beforeEach(async () => {
    resetTaskHistoryStoreCache()
    projectDir = join(tmpdir(), `brv-thsc-test-${Date.now()}-${Math.random().toString(36).slice(2)}`)
    await mkdir(projectDir, {recursive: true})
  })

  afterEach(async () => {
    resetTaskHistoryStoreCache()
    await rm(projectDir, {force: true, recursive: true})
  })

  it('passes maxEntries to subsequently created FileTaskHistoryStore instances', () => {
    configureTaskHistoryStoreCache({maxEntries: 5000})
    const store = getStore(projectDir)
    expect(getMaxEntries(store)).to.equal(5000)
  })

  it('uses the FileTaskHistoryStore default when configureTaskHistoryStoreCache has not been called', () => {
    const store = getStore(projectDir)
    expect(getMaxEntries(store)).to.be.greaterThan(0)
  })

  it('does not retroactively reconfigure stores already cached', () => {
    const firstStore = getStore(projectDir)
    const firstMaxEntries = getMaxEntries(firstStore)
    configureTaskHistoryStoreCache({maxEntries: 9999})
    const secondStore = getStore(projectDir)
    expect(secondStore).to.equal(firstStore)
    expect(getMaxEntries(secondStore)).to.equal(firstMaxEntries)
  })

  it('resetTaskHistoryStoreCache clears the configured maxEntries', () => {
    configureTaskHistoryStoreCache({maxEntries: 7777})
    resetTaskHistoryStoreCache()
    const store = getStore(projectDir)
    expect(getMaxEntries(store)).to.not.equal(7777)
  })
})

function getMaxEntries(store: unknown): number {
  if (typeof store !== 'object' || store === null) throw new TypeError('expected store')
  const obj = store as Record<string, unknown>
  if (typeof obj.maxEntries !== 'number') throw new TypeError('expected store.maxEntries to be a number')
  return obj.maxEntries
}
