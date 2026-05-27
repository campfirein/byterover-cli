import {expect} from 'chai'

import {useRestartBannerStore} from '../../../../../../src/webui/features/settings/stores/restart-banner-store.js'

describe('useRestartBannerStore', () => {
  beforeEach(() => {
    useRestartBannerStore.getState().clear()
  })

  it('starts with an empty dirty set', () => {
    expect(useRestartBannerStore.getState().dirtyKeys.size).to.equal(0)
  })

  it('markDirty adds the key to the dirty set when restartRequired is true', () => {
    useRestartBannerStore.getState().markDirty('agentPool.maxSize', true)
    expect(useRestartBannerStore.getState().dirtyKeys.has('agentPool.maxSize')).to.equal(true)
  })

  it('markDirty is idempotent — same key twice yields size 1', () => {
    useRestartBannerStore.getState().markDirty('agentPool.maxSize', true)
    useRestartBannerStore.getState().markDirty('agentPool.maxSize', true)
    expect(useRestartBannerStore.getState().dirtyKeys.size).to.equal(1)
  })

  it('markDirty tracks multiple distinct keys', () => {
    useRestartBannerStore.getState().markDirty('agentPool.maxSize', true)
    useRestartBannerStore.getState().markDirty('llm.iterationBudgetMs', true)
    expect(useRestartBannerStore.getState().dirtyKeys.size).to.equal(2)
  })

  it('clear empties the dirty set', () => {
    useRestartBannerStore.getState().markDirty('agentPool.maxSize', true)
    useRestartBannerStore.getState().markDirty('llm.iterationBudgetMs', true)
    useRestartBannerStore.getState().clear()
    expect(useRestartBannerStore.getState().dirtyKeys.size).to.equal(0)
  })

  it('produces a new Set instance on each restart-required mutation so React selectors detect the change', () => {
    const before = useRestartBannerStore.getState().dirtyKeys
    useRestartBannerStore.getState().markDirty('agentPool.maxSize', true)
    const after = useRestartBannerStore.getState().dirtyKeys
    expect(after).to.not.equal(before)
  })

  it('markDirty with restartRequired false does not add the key to the dirty set', () => {
    useRestartBannerStore.getState().markDirty('update.checkForUpdates', false)
    expect(useRestartBannerStore.getState().dirtyKeys.size).to.equal(0)
  })

  it('markDirty with restartRequired false preserves Set identity so React selectors do not re-fire', () => {
    const before = useRestartBannerStore.getState().dirtyKeys
    useRestartBannerStore.getState().markDirty('update.checkForUpdates', false)
    const after = useRestartBannerStore.getState().dirtyKeys
    expect(after).to.equal(before)
  })

  it('mixed sequence: only restart-required keys land in the dirty set', () => {
    useRestartBannerStore.getState().markDirty('agentPool.maxSize', true)
    useRestartBannerStore.getState().markDirty('update.checkForUpdates', false)
    const {dirtyKeys} = useRestartBannerStore.getState()
    expect(dirtyKeys.size).to.equal(1)
    expect(dirtyKeys.has('agentPool.maxSize')).to.equal(true)
    expect(dirtyKeys.has('update.checkForUpdates')).to.equal(false)
  })

  it('a later non-restart change for the same key does not unset its dirty marker', () => {
    useRestartBannerStore.getState().markDirty('agentPool.maxSize', true)
    useRestartBannerStore.getState().markDirty('agentPool.maxSize', false)
    expect(useRestartBannerStore.getState().dirtyKeys.has('agentPool.maxSize')).to.equal(true)
  })
})
