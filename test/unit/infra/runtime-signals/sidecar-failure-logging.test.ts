/**
 * Commit 6 — runtime-signals sidecar-failure logging.
 *
 * Post-commit-5 the sidecar is the canonical source for ranking signals.
 * Operational failures (disk error, permission denied, backend outage) on
 * sidecar writes continue to be swallowed at every mutation site — they are
 * documented as best-effort and the next bump self-heals. But swallow-only
 * leaves operators blind to outages in production. This suite proves that
 * each of the 11 sidecar-swallow sites now emits exactly one `warn` log
 * with the operation name and the affected path when the store throws.
 */

import {expect} from 'chai'
import * as fs from 'node:fs/promises'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import {restore} from 'sinon'

import type {ICipherAgent} from '../../../../src/agent/core/interfaces/i-cipher-agent.js'
import type {ILogger} from '../../../../src/agent/core/interfaces/i-logger.js'
import type {IRuntimeSignalStore} from '../../../../src/server/core/interfaces/storage/i-runtime-signal-store.js'

import {createCurateTool} from '../../../../src/agent/infra/tools/implementations/curate-tool.js'
import {createDefaultRuntimeSignals} from '../../../../src/server/core/domain/knowledge/runtime-signals-schema.js'
import {FileContextTreeArchiveService} from '../../../../src/server/infra/context-tree/file-context-tree-archive-service.js'
import {FileContextTreeManifestService} from '../../../../src/server/infra/context-tree/file-context-tree-manifest-service.js'
import {createMockRuntimeSignalStore} from '../../../helpers/mock-factories.js'

interface CurateOutput {
  applied: Array<{message?: string; path: string; status: 'failed' | 'success'; type: string}>
  summary: {added: number; deleted: number; failed: number; merged: number; updated: number}
}

interface CurateTool {
  execute(input: unknown): Promise<CurateOutput>
}

function createCapturingLogger(): {logger: ILogger; warnings: string[]} {
  const warnings: string[] = []
  const logger: ILogger = {
    debug() {},
    error() {},
    info() {},
    warn(message) {
      warnings.push(message)
    },
  }
  return {logger, warnings}
}

/**
 * Build a throwing-on-one-method wrapper around a healthy store. Lets us
 * target exactly the failure path a site exercises without replacing the
 * entire store (the healthy calls in other paths still succeed).
 */
function wrapThrowingMethod(
  store: IRuntimeSignalStore,
  method: keyof IRuntimeSignalStore,
  error = new Error('sidecar down'),
): IRuntimeSignalStore {
  return new Proxy(store, {
    get(target, prop, receiver) {
      if (prop === method) {
        return async () => {
          throw error
        }
      }

      return Reflect.get(target, prop, receiver)
    },
  })
}

async function runCurateWithFailingStore(
  tmpRoot: string,
  failingMethod: keyof IRuntimeSignalStore,
  operations: Array<Record<string, unknown>>,
): Promise<{warnings: string[]}> {
  const basePath = join(tmpRoot, '.brv/context-tree')
  await fs.mkdir(basePath, {recursive: true})
  const healthy = createMockRuntimeSignalStore()
  const failing = wrapThrowingMethod(healthy, failingMethod)
  const {logger, warnings} = createCapturingLogger()
  const tool = createCurateTool(undefined, undefined, failing, logger) as unknown as CurateTool
  await tool.execute({basePath, operations})
  return {warnings}
}

describe('Runtime-signals — sidecar-failure logging at swallow sites', () => {
  let tmpDir: string

  beforeEach(async () => {
    tmpDir = join(tmpdir(), `sidecar-log-${Date.now()}-${Math.random().toString(36).slice(2)}`)
    await fs.mkdir(tmpDir, {recursive: true})
  })

  afterEach(async () => {
    await fs.rm(tmpDir, {force: true, recursive: true})
    restore()
  })

  describe('curate-tool helpers', () => {
    it('seedSidecarDefaults — warns with operation name and path on set() failure', async () => {
      const {warnings} = await runCurateWithFailingStore(tmpDir, 'set', [
        {
          confidence: 'high',
          content: {snippets: ['x'], tags: ['t']},
          impact: 'low',
          path: 'domain/topic',
          reason: 'seed',
          title: 'My Note',
          type: 'ADD',
        },
      ])
      expect(warnings).to.have.lengthOf(1)
      expect(warnings[0]).to.include('sidecar seed failed')
      expect(warnings[0]).to.include('domain/topic/my_note.md')
    })

    it('mirrorCurateUpdate — warns on update() failure during UPDATE', async () => {
      const basePath = join(tmpDir, '.brv/context-tree')
      await fs.mkdir(basePath, {recursive: true})
      const healthy = createMockRuntimeSignalStore()
      const {logger, warnings} = createCapturingLogger()
      // Seed through a healthy store first so the file exists on disk.
      let tool = createCurateTool(undefined, undefined, healthy, logger) as unknown as CurateTool
      await tool.execute({
        basePath,
        operations: [
          {
            confidence: 'high',
            content: {snippets: ['x'], tags: ['t']},
            impact: 'low',
            path: 'domain/topic',
            reason: 'seed',
            title: 'My Note',
            type: 'ADD',
          },
        ],
      })
      warnings.length = 0

      const failing = wrapThrowingMethod(healthy, 'update')
      tool = createCurateTool(undefined, undefined, failing, logger) as unknown as CurateTool
      await tool.execute({
        basePath,
        operations: [
          {
            confidence: 'high',
            content: {snippets: ['y'], tags: ['t']},
            impact: 'low',
            path: 'domain/topic',
            reason: 'bump',
            title: 'My Note',
            type: 'UPDATE',
          },
        ],
      })
      expect(warnings).to.have.lengthOf(1)
      expect(warnings[0]).to.include('sidecar update failed')
      expect(warnings[0]).to.include('domain/topic/my_note.md')
    })

    it('dropSidecar — warns on delete() failure during DELETE', async () => {
      const basePath = join(tmpDir, '.brv/context-tree')
      await fs.mkdir(basePath, {recursive: true})
      const healthy = createMockRuntimeSignalStore()
      const {logger, warnings} = createCapturingLogger()
      let tool = createCurateTool(undefined, undefined, healthy, logger) as unknown as CurateTool
      await tool.execute({
        basePath,
        operations: [
          {
            confidence: 'high',
            content: {snippets: ['x'], tags: ['t']},
            impact: 'low',
            path: 'domain/topic',
            reason: 'seed',
            title: 'My Note',
            type: 'ADD',
          },
        ],
      })
      warnings.length = 0

      const failing = wrapThrowingMethod(healthy, 'delete')
      tool = createCurateTool(undefined, undefined, failing, logger) as unknown as CurateTool
      await tool.execute({
        basePath,
        operations: [
          {
            confidence: 'low',
            impact: 'low',
            path: 'domain/topic',
            reason: 'clean',
            title: 'My Note',
            type: 'DELETE',
          },
        ],
      })
      expect(warnings).to.have.lengthOf(1)
      expect(warnings[0]).to.include('sidecar drop failed')
      expect(warnings[0]).to.include('domain/topic/my_note.md')
    })

    it('executeMerge sidecar block — warns on update() failure during MERGE', async () => {
      const basePath = join(tmpDir, '.brv/context-tree')
      await fs.mkdir(basePath, {recursive: true})
      const healthy = createMockRuntimeSignalStore()
      const {logger, warnings} = createCapturingLogger()
      let tool = createCurateTool(undefined, undefined, healthy, logger) as unknown as CurateTool
      // Seed source + target.
      await tool.execute({
        basePath,
        operations: [
          {
            confidence: 'high',
            content: {snippets: ['a'], tags: ['t']},
            impact: 'low',
            path: 'auth/jwt',
            reason: 's1',
            title: 'Refresh',
            type: 'ADD',
          },
          {
            confidence: 'high',
            content: {snippets: ['b'], tags: ['t']},
            impact: 'low',
            path: 'auth/jwt',
            reason: 's2',
            title: 'Rotation',
            type: 'ADD',
          },
        ],
      })
      warnings.length = 0

      const failing = wrapThrowingMethod(healthy, 'update')
      tool = createCurateTool(undefined, undefined, failing, logger) as unknown as CurateTool
      await tool.execute({
        basePath,
        operations: [
          {
            confidence: 'high',
            impact: 'low',
            mergeTarget: 'auth/jwt',
            mergeTargetTitle: 'Rotation',
            path: 'auth/jwt',
            reason: 'dedupe',
            title: 'Refresh',
            type: 'MERGE',
          },
        ],
      })
      // Forcing `update` to throw triggers the merge-update warn and
      // short-circuits before the delete (targetUpdated stays false) so
      // exactly one warning fires.
      expect(warnings).to.have.lengthOf(1)
      expect(warnings[0]).to.include('sidecar merge-update failed')
      expect(warnings[0]).to.include('auth/jwt/refresh.md')
      expect(warnings[0]).to.include('auth/jwt/rotation.md')
    })

    it('executeMerge sidecar block — warns on delete() failure after successful update (orphan path)', async () => {
      const basePath = join(tmpDir, '.brv/context-tree')
      await fs.mkdir(basePath, {recursive: true})
      const healthy = createMockRuntimeSignalStore()
      const {logger, warnings} = createCapturingLogger()
      let tool = createCurateTool(undefined, undefined, healthy, logger) as unknown as CurateTool
      // Seed source + target — both sidecar entries exist.
      await tool.execute({
        basePath,
        operations: [
          {
            confidence: 'high',
            content: {snippets: ['a'], tags: ['t']},
            impact: 'low',
            path: 'auth/jwt',
            reason: 's1',
            title: 'Refresh',
            type: 'ADD',
          },
          {
            confidence: 'high',
            content: {snippets: ['b'], tags: ['t']},
            impact: 'low',
            path: 'auth/jwt',
            reason: 's2',
            title: 'Rotation',
            type: 'ADD',
          },
        ],
      })
      warnings.length = 0

      // `update` stays healthy so the merge-target sidecar is written;
      // `delete` throws so the source sidecar becomes a permanent orphan
      // (markdown is already removed upstream). Exactly one `merge-delete`
      // warn should fire, and no `merge-update` warn should appear.
      const failing = wrapThrowingMethod(healthy, 'delete')
      tool = createCurateTool(undefined, undefined, failing, logger) as unknown as CurateTool
      await tool.execute({
        basePath,
        operations: [
          {
            confidence: 'high',
            impact: 'low',
            mergeTarget: 'auth/jwt',
            mergeTargetTitle: 'Rotation',
            path: 'auth/jwt',
            reason: 'dedupe',
            title: 'Refresh',
            type: 'MERGE',
          },
        ],
      })

      expect(warnings).to.have.lengthOf(1)
      expect(warnings[0]).to.include('sidecar merge-delete failed')
      expect(warnings[0]).to.include('auth/jwt/refresh.md')
      expect(warnings[0]).to.not.include('merge-update')
    })
  })

  describe('FileContextTreeArchiveService', () => {
    it('archiveEntry — warns on delete() failure after markdown archive succeeds', async () => {
      const contextTreeDir = join(tmpDir, '.brv/context-tree')
      await fs.mkdir(join(contextTreeDir, 'auth'), {recursive: true})
      const relPath = 'auth/token.md'
      await fs.writeFile(join(contextTreeDir, relPath), '# Token\n', 'utf8')

      const healthy = createMockRuntimeSignalStore()
      const failing = wrapThrowingMethod(healthy, 'delete')
      const {logger, warnings} = createCapturingLogger()
      const svc = new FileContextTreeArchiveService(failing, logger)

      const fakeAgent = {
        createTaskSession: async () => 'sess',
        async deleteTaskSession() {},
        executeOnSession: async () => '```json\n{"title":"Ghost","summary":"g","tags":[]}\n```',
        async setSandboxVariableOnSession() {},
      } as unknown as ICipherAgent

      await svc.archiveEntry(relPath, fakeAgent, tmpDir)

      const match = warnings.find((w) => w.includes('archive-service: sidecar delete failed'))
      expect(match, `expected warn for archive delete, got: ${warnings.join(' | ')}`).to.not.be.undefined
      expect(match).to.include(relPath)
    })

    it('restoreEntry — warns on set() failure after markdown restore succeeds', async () => {
      const contextTreeDir = join(tmpDir, '.brv/context-tree')
      const archivedDir = join(contextTreeDir, '_archived/auth')
      await fs.mkdir(archivedDir, {recursive: true})
      const stubRel = '_archived/auth/token.stub.md'
      const fullRel = '_archived/auth/token.full.md'
      const stubContent = [
        '---',
        'type: archive_stub',
        'original_path: auth/token.md',
        'original_token_count: 10',
        'evicted_at: 2026-04-19T00:00:00.000Z',
        'evicted_importance: 20',
        'points_to: _archived/auth/token.full.md',
        '---',
        '# Ghost\n',
      ].join('\n')
      await fs.writeFile(join(contextTreeDir, stubRel), stubContent, 'utf8')
      await fs.writeFile(join(contextTreeDir, fullRel), '# Full\n', 'utf8')

      const healthy = createMockRuntimeSignalStore()
      const failing = wrapThrowingMethod(healthy, 'set')
      const {logger, warnings} = createCapturingLogger()
      const svc = new FileContextTreeArchiveService(failing, logger)

      await svc.restoreEntry(stubRel, tmpDir)

      const match = warnings.find((w) => w.includes('archive-service: sidecar seed failed'))
      expect(match, `expected warn for archive seed, got: ${warnings.join(' | ')}`).to.not.be.undefined
      expect(match).to.include('auth/token.md')
    })

    it('findArchiveCandidates — warns on list() failure during candidate scan', async () => {
      const contextTreeDir = join(tmpDir, '.brv/context-tree')
      await fs.mkdir(contextTreeDir, {recursive: true})

      const healthy = createMockRuntimeSignalStore()
      const failing = wrapThrowingMethod(healthy, 'list')
      const {logger, warnings} = createCapturingLogger()
      const svc = new FileContextTreeArchiveService(failing, logger)

      await svc.findArchiveCandidates(tmpDir)

      const match = warnings.find((w) => w.includes('archive-service: sidecar list failed'))
      expect(match, `expected warn for archive list, got: ${warnings.join(' | ')}`).to.not.be.undefined
    })

    it('readImportanceForArchiveMetadata — warns on get() failure during archive flow', async () => {
      const contextTreeDir = join(tmpDir, '.brv/context-tree')
      await fs.mkdir(join(contextTreeDir, 'auth'), {recursive: true})
      const relPath = 'auth/token.md'
      await fs.writeFile(join(contextTreeDir, relPath), '# Token\n', 'utf8')

      const healthy = createMockRuntimeSignalStore()
      // `archiveEntry` calls `readImportanceForArchiveMetadata` (get) and
      // later `delete`. Fail only `get` to isolate this site from the
      // archiveEntry-delete site already covered above.
      const failing = wrapThrowingMethod(healthy, 'get')
      const {logger, warnings} = createCapturingLogger()
      const svc = new FileContextTreeArchiveService(failing, logger)

      const fakeAgent = {
        async createTaskSession() {
          return 'sess'
        },
        async deleteTaskSession() {},
        async executeOnSession() {
          return '```json\n{"title":"Ghost","summary":"g","tags":[]}\n```'
        },
        async setSandboxVariableOnSession() {},
      } as unknown as ICipherAgent

      await svc.archiveEntry(relPath, fakeAgent, tmpDir)

      const match = warnings.find((w) =>
        w.includes('archive-service: sidecar get failed') && w.includes('archive metadata read'),
      )
      expect(match, `expected warn for archive get, got: ${warnings.join(' | ')}`).to.not.be.undefined
      expect(match).to.include(relPath)
    })
  })

  // The "dream operations" describe block (legacy consolidate / prune sidecar
  // warnings) was deleted with the operations themselves — see ENG-2884.

  describe('FileContextTreeManifestService', () => {
    it('buildManifest — warns on list() failure (fail-open to defaults)', async () => {
      const baseDirectory = tmpDir
      await fs.mkdir(join(baseDirectory, '.brv/context-tree'), {recursive: true})

      const failingList = {
        async batchUpdate() {},
        async delete() {},
        async get() {
          return createDefaultRuntimeSignals()
        },
        async getMany() {
          return new Map()
        },
        async list() {
          throw new Error('list broken')
        },
        async set() {},
        async update() {
          return createDefaultRuntimeSignals()
        },
      }

      const {logger, warnings} = createCapturingLogger()

      const svc = new FileContextTreeManifestService({
        baseDirectory,
        logger,
        runtimeSignalStore: failingList,
      })

      await svc.buildManifest()

      const match = warnings.find((w) => w.includes('manifest-service: sidecar list failed'))
      expect(match, `expected warn for manifest list, got: ${warnings.join(' | ')}`).to.not.be.undefined
    })
  })

  describe('SearchKnowledgeService.mirrorHitsToSignalStore', () => {
    it('warns on batchUpdate() failure during access-hit flush', async () => {
      const {createSearchKnowledgeService} = await import(
        '../../../../src/agent/infra/tools/implementations/search-knowledge-service.js'
      )
      const {FileSystemService} = await import(
        '../../../../src/agent/infra/file-system/file-system-service.js'
      )

      const contextTreeDir = join(tmpDir, '.brv/context-tree/auth')
      await fs.mkdir(contextTreeDir, {recursive: true})
      await fs.writeFile(join(contextTreeDir, 'a.md'), '# A\nBody.', 'utf8')

      const throwingStore = {
        async batchUpdate() {
          throw new Error('batchUpdate failed')
        },
        async delete() {},
        async get() {
          return createDefaultRuntimeSignals()
        },
        async getMany() {
          return new Map()
        },
        async list() {
          return new Map()
        },
        async set() {},
        async update() {
          return createDefaultRuntimeSignals()
        },
      }
      const {logger, warnings} = createCapturingLogger()
      const fsService = new FileSystemService({
        allowedPaths: [tmpDir],
        workingDirectory: tmpDir,
      })
      await fsService.initialize()
      const svc = createSearchKnowledgeService(fsService, {
        baseDirectory: tmpDir,
        logger,
        runtimeSignalStore: throwingStore,
      })

      // Prime pendingAccessHits so the flush has work to do. The ISearchKnowledgeService
      // surface doesn't expose flushAccessHits — cast to the concrete class.
      const concrete = svc as unknown as {
        flushAccessHits(path: string): Promise<boolean>
        pendingAccessHits: Map<string, number>
      }
      concrete.pendingAccessHits.set('auth/a.md', 3)

      const flushed = await concrete.flushAccessHits(contextTreeDir)
      expect(flushed).to.equal(true)
      const match = warnings.find((w) => w.includes('search-knowledge-flush: sidecar batchUpdate failed'))
      expect(match, `expected warn for flush batchUpdate, got: ${warnings.join(' | ')}`).to.not.be.undefined
    })
  })

  describe('commit 6 wiring', () => {
    it('buildUndoDeps (CLI dream-undo) threads the runtime-signal sidecar into archive + manifest services', async () => {
      const {buildUndoDeps} = await import('../../../../src/oclif/commands/dream.js')
      const root = await fs.mkdtemp(join(tmpdir(), 'undo-wiring-'))

      try {
        const deps = await buildUndoDeps(root)

        // The archive service receives the sidecar as its first (and only)
        // constructor arg. We assert on the instance shape via a private-field
        // cast because the public surface deliberately hides implementation.
        const archiveService = deps.archiveService as unknown as {runtimeSignalStore?: unknown}
        expect(archiveService.runtimeSignalStore, 'archiveService sidecar wiring').to.not.be.undefined

        // The manifest service takes its config via constructor; we inspect
        // the `config` field (the only property the implementation keeps).
        const manifestService = deps.manifestService as unknown as {config: {runtimeSignalStore?: unknown}}
        expect(manifestService.config.runtimeSignalStore, 'manifestService sidecar wiring').to.not.be.undefined
      } finally {
        await fs.rm(root, {force: true, recursive: true})
      }
    })

    it('service-initializer threads runtimeSignalStore into the swarm SearchKnowledgeService (source regression)', async () => {
      const sourcePath = join(
        process.cwd(),
        'src/agent/infra/agent/service-initializer.ts',
      )
      const source = await fs.readFile(sourcePath, 'utf8')

      // Locate the buildProvidersFromConfig block and slice the next few lines
      // so the assertion fails loudly if a refactor drops the store — without
      // mocking the entire agent bootstrap.
      const anchor = source.indexOf('buildProvidersFromConfig(swarmConfig')
      expect(anchor, 'buildProvidersFromConfig block missing').to.be.greaterThan(-1)
      const window = source.slice(anchor, anchor + 400)

      expect(window, 'swarm search service must receive runtimeSignalStore').to.match(/runtimeSignalStore/)
      expect(window, 'swarm search service call must use config object form').to.match(
        /createSearchKnowledgeService\(\s*fileSystemService\s*,/,
      )
    })
  })
})
