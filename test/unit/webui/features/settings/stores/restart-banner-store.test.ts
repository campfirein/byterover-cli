import {expect} from 'chai'

import {useRestartBannerStore} from '../../../../../../src/webui/features/settings/stores/restart-banner-store.js'

describe('useRestartBannerStore', () => {
  beforeEach(() => {
    useRestartBannerStore.getState().clear()
  })

  it('starts with an empty dirty set', () => {
    expect(useRestartBannerStore.getState().dirtyKeys.size).to.equal(0)
  })

  it('markDirty adds the key to the dirty set', () => {
    useRestartBannerStore.getState().markDirty('agentPool.maxSize')
    expect(useRestartBannerStore.getState().dirtyKeys.has('agentPool.maxSize')).to.equal(true)
  })

  it('markDirty is idempotent — same key twice yields size 1', () => {
    useRestartBannerStore.getState().markDirty('agentPool.maxSize')
    useRestartBannerStore.getState().markDirty('agentPool.maxSize')
    expect(useRestartBannerStore.getState().dirtyKeys.size).to.equal(1)
  })

  it('markDirty tracks multiple distinct keys', () => {
    useRestartBannerStore.getState().markDirty('agentPool.maxSize')
    useRestartBannerStore.getState().markDirty('llm.iterationBudgetMs')
    expect(useRestartBannerStore.getState().dirtyKeys.size).to.equal(2)
  })

  it('clear empties the dirty set', () => {
    useRestartBannerStore.getState().markDirty('agentPool.maxSize')
    useRestartBannerStore.getState().markDirty('llm.iterationBudgetMs')
    useRestartBannerStore.getState().clear()
    expect(useRestartBannerStore.getState().dirtyKeys.size).to.equal(0)
  })

  it('produces a new Set instance on each mutation so React selectors detect the change', () => {
    const before = useRestartBannerStore.getState().dirtyKeys
    useRestartBannerStore.getState().markDirty('agentPool.maxSize')
    const after = useRestartBannerStore.getState().dirtyKeys
    expect(after).to.not.equal(before)
  })
})
