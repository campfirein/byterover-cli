import {expect} from 'chai'
import {mkdir, readFile, rm, writeFile} from 'node:fs/promises'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import {restore, spy} from 'sinon'

import type {DreamState} from '../../../../src/server/infra/dream/dream-state-schema.js'

import {DreamStateService} from '../../../../src/server/infra/dream/dream-state-service.js'

function makeState(overrides: Partial<DreamState> = {}): DreamState {
  return {
    curationsSinceDream: 0,
    lastDreamAt: null,
    lastDreamLogId: null,
    pendingMerges: [],
    staleSummaryPaths: [],
    totalDreams: 0,
    version: 1,
    ...overrides,
  }
}

describe('DreamStateService', () => {
  let tempDir: string
  let service: DreamStateService

  beforeEach(async () => {
    tempDir = join(tmpdir(), `brv-dream-state-test-${Date.now()}-${Math.random().toString(36).slice(2)}`)
    await mkdir(tempDir, {recursive: true})
    service = new DreamStateService({baseDir: tempDir})
  })

  afterEach(async () => {
    restore()
    await rm(tempDir, {force: true, recursive: true})
  })

  // ==========================================================================
  // read
  // ==========================================================================

  describe('read', () => {
    it('should return EMPTY_DREAM_STATE when no file exists', async () => {
      const state = await service.read()
      expect(state).to.deep.equal(makeState())
    })

    it('should return persisted state', async () => {
      const expected = makeState({curationsSinceDream: 5, totalDreams: 2})
      await service.write(expected)

      const state = await service.read()
      expect(state).to.deep.equal(expected)
    })

    it('should return EMPTY_DREAM_STATE on corrupt JSON', async () => {
      await writeFile(join(tempDir, 'dream-state.json'), 'not valid json {{{', 'utf8')

      const state = await service.read()
      expect(state).to.deep.equal(makeState())
    })

    it('should return EMPTY_DREAM_STATE on valid JSON but wrong schema', async () => {
      await writeFile(join(tempDir, 'dream-state.json'), JSON.stringify({bad: true, version: 99}), 'utf8')

      const state = await service.read()
      expect(state).to.deep.equal(makeState())
    })
  })

  // ==========================================================================
  // write
  // ==========================================================================

  describe('write', () => {
    it('should persist state to disk', async () => {
      const state = makeState({lastDreamAt: '2026-04-10T12:00:00.000Z', totalDreams: 3})
      await service.write(state)

      const raw = await readFile(join(tempDir, 'dream-state.json'), 'utf8')
      const parsed = JSON.parse(raw)
      expect(parsed.totalDreams).to.equal(3)
      expect(parsed.lastDreamAt).to.equal('2026-04-10T12:00:00.000Z')
    })

    it('should create parent directory if missing', async () => {
      const nestedDir = join(tempDir, 'nested', 'deep')
      const nestedService = new DreamStateService({baseDir: nestedDir})

      await nestedService.write(makeState())
      const state = await nestedService.read()
      expect(state).to.deep.equal(makeState())
    })

    it('should use atomic write (no tmp files left)', async () => {
      await service.write(makeState())

      const {readdir} = await import('node:fs/promises')
      const files = await readdir(tempDir)
      const tmpFiles = files.filter(f => f.endsWith('.tmp'))
      expect(tmpFiles).to.have.lengthOf(0)
    })

    it('should reject invalid state', async () => {
      const badState = {...makeState(), version: 99} as unknown as DreamState
      try {
        await service.write(badState)
        expect.fail('should have thrown')
      } catch {
        // expected
      }
    })
  })

  // ==========================================================================
  // incrementCurationCount
  // ==========================================================================

  describe('incrementCurationCount', () => {
    it('should increment from 0 to 1', async () => {
      await service.incrementCurationCount()
      const state = await service.read()
      expect(state.curationsSinceDream).to.equal(1)
    })

    it('should increment 3 times to 3', async () => {
      await service.incrementCurationCount()
      await service.incrementCurationCount()
      await service.incrementCurationCount()
      const state = await service.read()
      expect(state.curationsSinceDream).to.equal(3)
    })

    it('should preserve other fields when incrementing', async () => {
      const initial = makeState({
        lastDreamAt: '2026-04-10T12:00:00.000Z',
        lastDreamLogId: 'drm-123',
        totalDreams: 5,
      })
      await service.write(initial)

      await service.incrementCurationCount()
      const state = await service.read()
      expect(state.curationsSinceDream).to.equal(1)
      expect(state.totalDreams).to.equal(5)
      expect(state.lastDreamLogId).to.equal('drm-123')
    })

    it('should count every increment even when 10 run concurrently (no lost updates)', async () => {
      const N = 10
      await Promise.all(Array.from({length: N}, () => service.incrementCurationCount()))
      const state = await service.read()
      expect(state.curationsSinceDream).to.equal(N)
    })

    it('should serialize concurrent increments per service instance (FIFO)', async () => {
      // Two services pointing at the SAME baseDir still share per-file serialization
      // when the mutex is keyed on the absolute state file path.
      const serviceB = new DreamStateService({baseDir: tempDir})
      const N = 20
      await Promise.all(
        Array.from({length: N}, (_, i) =>
          (i % 2 === 0 ? service : serviceB).incrementCurationCount(),
        ),
      )
      const state = await service.read()
      expect(state.curationsSinceDream).to.equal(N)
    })
  })

  // ==========================================================================
  // update — generic RMW under the same per-file mutex
  // ==========================================================================

  describe('update', () => {
    it('returns the updated state', async () => {
      const next = await service.update((state) => ({...state, totalDreams: 7}))
      expect(next.totalDreams).to.equal(7)

      const persisted = await service.read()
      expect(persisted.totalDreams).to.equal(7)
    })

    it('does not lose increments when interleaved with a concurrent reset writer', async () => {
      // Models a race that the per-file mutex must cover: one writer "resets"
      // curationsSinceDream to 0 while a curate's incrementCurationCount runs
      // concurrently. Without the mutex covering both writers, the increment
      // is lost.
      await service.update((state) => ({...state, curationsSinceDream: 5, totalDreams: 1}))

      // Fire a step-7-style reset and an increment in parallel.
      await Promise.all([
        service.update((state) => ({...state, curationsSinceDream: 0, totalDreams: state.totalDreams + 1})),
        service.incrementCurationCount(),
      ])

      const final = await service.read()

      // Either ordering is acceptable, but both writes must be visible:
      //   - reset-then-increment → curationsSinceDream=1 (reset to 0, then ++)
      //   - increment-then-reset → curationsSinceDream=0 (incremented to 6, then reset to 0)
      // The test asserts that increments are NEVER lost: if the reset runs FIRST
      // the increment must show; if the reset runs LAST the increment is consumed
      // (which is the design intent — the dream consumed it).
      expect(final.curationsSinceDream).to.be.oneOf([0, 1])
      expect(final.totalDreams, 'reset-side update must always commit').to.equal(2)
    })

    it('serializes mixed update + incrementCurationCount calls (no lost writes)', async () => {
      // 5 increments interleaved with 5 totalDreams bumps — neither side should drop a write.
      const ops = Array.from({length: 10}, (_, i) =>
        i % 2 === 0
          ? service.incrementCurationCount()
          : service.update((state) => ({...state, totalDreams: state.totalDreams + 1})),
      )
      await Promise.all(ops)

      const final = await service.read()
      expect(final.curationsSinceDream).to.equal(5)
      expect(final.totalDreams).to.equal(5)
    })
  })

  // ==========================================================================
  // enqueueStaleSummaryPaths — defer summary cascade
  // ==========================================================================

  describe('enqueueStaleSummaryPaths', () => {
    it('appends new paths to an empty queue', async () => {
      await service.enqueueStaleSummaryPaths(['auth/jwt/token.md', 'billing/webhooks/stripe.md'])
      const state = await service.read()
      expect(state.staleSummaryPaths.map((e) => e.path)).to.deep.equal([
        'auth/jwt/token.md',
        'billing/webhooks/stripe.md',
      ])
    })

    it('stamps each entry with enqueuedAt at the moment of the call', async () => {
      const before = Date.now()
      await service.enqueueStaleSummaryPaths(['auth/jwt/token.md'])
      const after = Date.now()

      const state = await service.read()
      expect(state.staleSummaryPaths).to.have.lengthOf(1)
      const [entry] = state.staleSummaryPaths
      expect(entry.enqueuedAt).to.be.at.least(before)
      expect(entry.enqueuedAt).to.be.at.most(after)
    })

    it('dedups entries by path (keeps oldest enqueuedAt)', async () => {
      await service.enqueueStaleSummaryPaths(['auth/jwt/token.md'])
      const firstState = await service.read()
      const firstStamp = firstState.staleSummaryPaths[0].enqueuedAt

      // ensure the second call's Date.now() is strictly later
      await new Promise<void>((resolve) => {
        setTimeout(resolve, 5)
      })

      await service.enqueueStaleSummaryPaths(['auth/jwt/token.md', 'billing/webhooks/stripe.md'])
      const secondState = await service.read()

      expect(secondState.staleSummaryPaths).to.have.lengthOf(2)
      const tokenEntry = secondState.staleSummaryPaths.find((e) => e.path === 'auth/jwt/token.md')
      expect(tokenEntry?.enqueuedAt, 'oldest enqueuedAt preserved on dedup').to.equal(firstStamp)
    })

    it('preserves other state fields when enqueuing', async () => {
      await service.write(makeState({
        curationsSinceDream: 7,
        totalDreams: 2,
      }))

      await service.enqueueStaleSummaryPaths(['auth/jwt/token.md'])

      const state = await service.read()
      expect(state.curationsSinceDream).to.equal(7)
      expect(state.totalDreams).to.equal(2)
      expect(state.staleSummaryPaths).to.have.lengthOf(1)
    })

    it('is a no-op for an empty input array', async () => {
      await service.enqueueStaleSummaryPaths([])
      const state = await service.read()
      expect(state.staleSummaryPaths).to.deep.equal([])
    })

    it('dedups within-batch duplicates so a single call cannot insert the same path twice', async () => {
      // The contract is "dedup by path". A caller passing a non-unique array
      // (e.g. multiple changedPaths within a single curate that round-trip
      // through the same parent dir) must NOT produce duplicate queue entries.
      await service.enqueueStaleSummaryPaths(['auth/jwt.md', 'auth/jwt.md', 'auth/jwt.md'])

      const state = await service.read()
      expect(state.staleSummaryPaths).to.have.lengthOf(1)
      expect(state.staleSummaryPaths[0].path).to.equal('auth/jwt.md')
    })

    it('does not lose entries when 10 enqueues run concurrently', async () => {
      const paths = Array.from({length: 10}, (_, i) => `domain/topic-${i}.md`)
      await Promise.all(paths.map((p) => service.enqueueStaleSummaryPaths([p])))
      const state = await service.read()
      const stored = state.staleSummaryPaths.map((e) => e.path).sort()
      expect(stored).to.deep.equal([...paths].sort())
    })
  })

  // ==========================================================================
  // drainStaleSummaryPaths — snapshot-and-clear pattern
  // ==========================================================================

  describe('drainStaleSummaryPaths', () => {
    it('returns the current snapshot of paths AND clears the queue atomically', async () => {
      await service.enqueueStaleSummaryPaths(['auth/jwt/token.md', 'billing/webhooks/stripe.md'])

      const snapshot = await service.drainStaleSummaryPaths()
      expect(snapshot.sort()).to.deep.equal([
        'auth/jwt/token.md',
        'billing/webhooks/stripe.md',
      ])

      // queue is empty after drain — the same RMW that read it cleared it
      const state = await service.read()
      expect(state.staleSummaryPaths).to.deep.equal([])
    })

    it('returns an empty snapshot when the queue is empty', async () => {
      const snapshot = await service.drainStaleSummaryPaths()
      expect(snapshot).to.deep.equal([])
    })

    it('does NOT issue a write when the queue is already empty', async () => {
      // The early-return guard in drainStaleSummaryPaths returns the same
      // state ref unchanged; update() then skips the disk write. Without
      // this contract, every empty drain would tmpfile + rename for nothing.
      const writeSpy = spy(service, 'write')

      await service.drainStaleSummaryPaths()

      expect(writeSpy.called).to.equal(false)
    })

    it('different-path enqueue during processing survives', async () => {
      await service.enqueueStaleSummaryPaths(['auth/jwt/token.md'])
      const snapshot = await service.drainStaleSummaryPaths()
      expect(snapshot).to.deep.equal(['auth/jwt/token.md'])

      // simulate a curate enqueue happening WHILE the dream is processing
      await service.enqueueStaleSummaryPaths(['billing/webhooks/stripe.md'])

      const state = await service.read()
      expect(state.staleSummaryPaths.map((e) => e.path)).to.deep.equal(['billing/webhooks/stripe.md'])
    })

    it('drain on an empty queue returns an empty snapshot and leaves enqueues untouched', async () => {
      const snapshot = await service.drainStaleSummaryPaths()
      expect(snapshot).to.deep.equal([])

      await service.enqueueStaleSummaryPaths(['auth/jwt/token.md'])

      const state = await service.read()
      expect(state.staleSummaryPaths.map((e) => e.path)).to.deep.equal(['auth/jwt/token.md'])
    })

    it('preserves other state fields when draining', async () => {
      await service.write(makeState({
        curationsSinceDream: 3,
        totalDreams: 1,
      }))
      await service.enqueueStaleSummaryPaths(['auth/jwt/token.md'])
      await service.drainStaleSummaryPaths()

      const state = await service.read()
      expect(state.curationsSinceDream).to.equal(3)
      expect(state.totalDreams).to.equal(1)
      expect(state.staleSummaryPaths).to.deep.equal([])
    })

    it('preserves a same-path enqueue made after the drain (no race loss)', async () => {
      // Repro of the race the reviewer flagged on PR #551:
      //   1. Dream drains queue containing X.
      //   2. Concurrent curate touches X again — enqueue should record it.
      //   3. Dream finishes propagation.
      //   4. The post-drain enqueue MUST survive so the next dream picks it up.
      // Atomic drain (queue cleared upfront) makes the post-drain enqueue see
      // an empty queue, so it always appends fresh.
      await service.enqueueStaleSummaryPaths(['auth/jwt/token.md'])

      // (1) Dream drains — entries removed atomically.
      const snapshot = await service.drainStaleSummaryPaths()
      expect(snapshot).to.deep.equal(['auth/jwt/token.md'])

      // (2) A curate touches the same path during dream propagation.
      await service.enqueueStaleSummaryPaths(['auth/jwt/token.md'])

      // (3) Dream finishes — no clear() to call; entries already removed at (1).

      // (4) The path enqueued at (2) survives.
      const state = await service.read()
      expect(state.staleSummaryPaths.map((e) => e.path)).to.deep.equal(['auth/jwt/token.md'])
    })
  })
})
