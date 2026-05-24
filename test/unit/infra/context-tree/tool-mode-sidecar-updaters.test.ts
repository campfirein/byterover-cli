import {expect} from 'chai'

import {createDefaultRuntimeSignals} from '../../../../src/server/core/domain/knowledge/runtime-signals-schema.js'
import {bumpSidecarOnCurateWrite} from '../../../../src/server/infra/context-tree/tool-mode-sidecar-updaters.js'
import {createMockRuntimeSignalStore} from '../../../helpers/mock-factories.js'

describe('tool-mode-sidecar-updaters', () => {
  describe('bumpSidecarOnCurateWrite', () => {
    it('seeds default signals when topic is new (existedBefore=false)', async () => {
      const store = createMockRuntimeSignalStore()
      await bumpSidecarOnCurateWrite({
        existedBefore: false,
        relPath: 'security/jwt.html',
        store,
      })

      const stored = await store.get('security/jwt.html')
      expect(stored).to.deep.equal(createDefaultRuntimeSignals())
    })

    it('bumps importance, updateCount, recency, and maturity when topic existed', async () => {
      const store = createMockRuntimeSignalStore()
      // Seed an existing entry
      await store.set('security/jwt.html', {
        ...createDefaultRuntimeSignals(),
        importance: 40,
        updateCount: 3,
      })

      await bumpSidecarOnCurateWrite({
        existedBefore: true,
        relPath: 'security/jwt.html',
        store,
      })

      const stored = await store.get('security/jwt.html')
      // recordCurateUpdate adds UPDATE_IMPORTANCE_BONUS (+5), bumps updateCount, sets recency=1
      expect(stored.importance).to.be.greaterThan(40)
      expect(stored.updateCount).to.equal(4)
      expect(stored.recency).to.equal(1)
    })

    it('is a no-op when store is undefined', async () => {
      // Must not throw
      await bumpSidecarOnCurateWrite({
        existedBefore: false,
        relPath: 'foo.html',
        store: undefined,
      })
    })

    it('swallows store errors (best-effort, never throws)', async () => {
      const throwingStore = {
        async batchUpdate() { throw new Error('disk full') },
        async delete() { throw new Error('disk full') },
        async get() { return createDefaultRuntimeSignals() },
        async getMany() { return new Map() },
        async has() { return false },
        async list() { return new Map() },
        async set() { throw new Error('disk full') },
        async update() { throw new Error('disk full') },
      }

      // Must not throw despite store errors
      await bumpSidecarOnCurateWrite({
        existedBefore: false,
        relPath: 'foo.html',
        store: throwingStore,
      })
      await bumpSidecarOnCurateWrite({
        existedBefore: true,
        relPath: 'foo.html',
        store: throwingStore,
      })
    })
  })
})
