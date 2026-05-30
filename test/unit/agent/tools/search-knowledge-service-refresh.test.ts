/**
 * Refresh-index race semantics.
 *
 * Without awaiting an in-flight build, `refreshIndex()` clears
 * `state.cachedIndex` and `state.buildingPromise` while the prior
 * `acquireIndex()` build is still running. When that orphan build
 * later resolves it writes back to `state.cachedIndex` (search-
 * knowledge-service.ts ~line 1016), defeating the invalidation: a
 * concurrent dream-scan that triggered the refresh can end up serving
 * the older index a subsequent call publishes.
 *
 * The fix is to await any current build BEFORE clearing, so by the
 * time `refreshIndex()` returns no in-flight builder can still write
 * to the state. This test pins that contract.
 */

import {expect} from 'chai'

import type {IFileSystem} from '../../../../src/agent/core/interfaces/i-file-system.js'

import {SearchKnowledgeService} from '../../../../src/agent/infra/tools/implementations/search-knowledge-service.js'

function makeStubFileSystem(): IFileSystem {
  // The race test only injects state.buildingPromise directly; the
  // file system is never actually called. Cast through unknown so we
  // don't need to satisfy the full IFileSystem surface.
  return {} as unknown as IFileSystem
}

describe('SearchKnowledgeService.refreshIndex — race semantics', () => {
  let service: SearchKnowledgeService
  let stateProxy: {buildingPromise: Promise<unknown> | undefined; cachedIndex: unknown}

  beforeEach(() => {
    service = new SearchKnowledgeService(makeStubFileSystem())
    // Private state access for a contract test — the contract under
    // test is exactly about how refreshIndex interacts with that state.
    stateProxy = (service as unknown as {state: {buildingPromise: Promise<unknown> | undefined; cachedIndex: unknown}}).state
  })

  it('awaits an in-flight build before clearing cached state', async () => {
    let resolveInFlight!: () => void
    const inFlight = new Promise<void>((resolve) => {
      resolveInFlight = resolve
    })

    // Simulate a build already in progress from an earlier search() call.
    stateProxy.buildingPromise = inFlight
    stateProxy.cachedIndex = {placeholder: true}

    let refreshSettled = false
    const refresh = service.refreshIndex().then(() => {
      refreshSettled = true
    })

    // Give microtasks a chance to drain. refreshIndex must NOT have
    // resolved yet — the in-flight build is still pending.
    await new Promise<void>((resolve) => {
      setImmediate(resolve)
    })
    await new Promise<void>((resolve) => {
      setImmediate(resolve)
    })
    expect(
      refreshSettled,
      'refreshIndex must not resolve while a build is in flight (otherwise the orphan build can write back after invalidation)',
    ).to.equal(false)

    // Let the in-flight build finish. refreshIndex should now proceed.
    resolveInFlight()
    await refresh
    expect(refreshSettled).to.equal(true)

    // Post-condition: state cleared after the await.
    expect(stateProxy.cachedIndex).to.equal(undefined)
    expect(stateProxy.buildingPromise).to.equal(undefined)
  })

  it('still clears state when no build is in flight (idempotent on cold state)', async () => {
    stateProxy.buildingPromise = undefined
    stateProxy.cachedIndex = {placeholder: true}

    await service.refreshIndex()

    expect(stateProxy.cachedIndex).to.equal(undefined)
    expect(stateProxy.buildingPromise).to.equal(undefined)
  })

  it('clears state even if the in-flight build rejects', async () => {
    let rejectInFlight!: (err: Error) => void
    const inFlight = new Promise<void>((_resolve, reject) => {
      rejectInFlight = reject
    })

    stateProxy.buildingPromise = inFlight
    stateProxy.cachedIndex = {placeholder: true}

    const refresh = service.refreshIndex()

    rejectInFlight(new Error('build blew up'))

    // refreshIndex must swallow the rejection (callers don't care about
    // the in-flight build's failure — they just want a clean slate).
    await refresh

    expect(stateProxy.cachedIndex).to.equal(undefined)
    expect(stateProxy.buildingPromise).to.equal(undefined)
  })
})
