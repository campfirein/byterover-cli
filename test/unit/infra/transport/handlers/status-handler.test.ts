/**
 * StatusHandler tests
 *
 * Verifies that `currentDirectory` in the StatusDTO preserves the actual
 * client working directory (backward compatibility) rather than the resolved
 * project root.
 */

import type {SinonStub} from 'sinon'

import {expect} from 'chai'
import {mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync} from 'node:fs'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import {createSandbox, restore, stub} from 'sinon'

import type {CurateLogEntry} from '../../../../../src/server/core/domain/entities/curate-log-entry.js'
import type {IProviderConfigStore} from '../../../../../src/server/core/interfaces/i-provider-config-store.js'
import type {IBillingService} from '../../../../../src/server/core/interfaces/services/i-billing-service.js'
import type {IBillingConfigStore} from '../../../../../src/server/core/interfaces/storage/i-billing-config-store.js'
import type {StatusDTO} from '../../../../../src/shared/transport/types/dto.js'

import {StatusHandler} from '../../../../../src/server/infra/transport/handlers/status-handler.js'
import {encodeBase64Url} from '../../../../../src/server/utils/base64url.js'
import {StatusEvents} from '../../../../../src/shared/transport/events/status-events.js'
import {createMockAuthStateStore, createMockTransportServer, type MockTransportServer} from '../../../../helpers/mock-factories.js'

// ==================== Test Helpers ====================

type TestDeps = {
  billingConfigStore: {
    getPinnedTeamId: SinonStub
    setPinnedTeamId: SinonStub
  }
  billingService: {getFreeUserLimit: SinonStub; getTiers: SinonStub; getUsages: SinonStub}
  contextTreeService: {delete: SinonStub; exists: SinonStub; hasGitRepo: SinonStub; initialize: SinonStub; resolvePath: SinonStub}
  contextTreeSnapshotService: {
    getChanges: SinonStub
    getCurrentState: SinonStub
    getSnapshotState: SinonStub
    hasSnapshot: SinonStub
    initEmptySnapshot: SinonStub
    saveSnapshot: SinonStub
    saveSnapshotFromState: SinonStub
  }
  curateLogStore: {
    batchUpdateOperationReviewStatus: SinonStub
    getById: SinonStub
    getNextId: SinonStub
    list: SinonStub
    save: SinonStub
  }
  projectConfigStore: {exists: SinonStub; getModifiedTime: SinonStub; read: SinonStub; write: SinonStub}
  providerConfigStore: {getActiveProvider: SinonStub}
  tokenStore: {clear: SinonStub; load: SinonStub; save: SinonStub}
}

function makeStubs(): TestDeps {
  return {
    billingConfigStore: {
      getPinnedTeamId: stub().resolves(),
      setPinnedTeamId: stub().resolves(),
    },
    billingService: {
      getFreeUserLimit: stub().resolves(),
      getTiers: stub().resolves([]),
      getUsages: stub().resolves([]),
    },
    contextTreeService: {
      delete: stub(),
      exists: stub().resolves(false),
      hasGitRepo: stub().resolves(false),
      initialize: stub(),
      resolvePath: stub().callsFake((p: string) => p),
    },
    contextTreeSnapshotService: {
      getChanges: stub().resolves({added: [], deleted: [], modified: []}),
      getCurrentState: stub(),
      getSnapshotState: stub(),
      hasSnapshot: stub().resolves(true),
      initEmptySnapshot: stub(),
      saveSnapshot: stub(),
      saveSnapshotFromState: stub(),
    },
    curateLogStore: {
      batchUpdateOperationReviewStatus: stub().resolves(true),
      getById: stub().resolves(null),
      getNextId: stub().resolves('cur-1'),
      list: stub().resolves([]),
      save: stub().resolves(),
    },
    projectConfigStore: {
      exists: stub().resolves(false),
      getModifiedTime: stub().resolves(),
      read: stub().resolves(),
      write: stub().resolves(),
    },
    providerConfigStore: {
      getActiveProvider: stub().resolves(''),
    },
    tokenStore: {
      clear: stub(),
      load: stub().resolves(),
      save: stub(),
    },
  }
}

function authedToken() {
  return {isValid: () => true, sessionKey: 'session', userEmail: 'user@example.com'}
}

function makeCompletedEntry(ops: CurateLogEntry['operations']): CurateLogEntry {
  return {
    completedAt: Date.now(),
    id: 'cur-1',
    input: {},
    operations: ops,
    startedAt: Date.now() - 1000,
    status: 'completed' as const,
    summary: {added: 0, deleted: 0, failed: 0, merged: 0, updated: 0},
    taskId: 'task-1',
  } as CurateLogEntry
}

// ==================== Tests ====================

describe('StatusHandler', () => {
  let deps: TestDeps
  let resolveProjectPath: SinonStub
  let testDir: string
  let transport: MockTransportServer

  beforeEach(() => {
    deps = makeStubs()
    resolveProjectPath = stub().returns('/project/current')
    transport = createMockTransportServer()
    testDir = realpathSync(mkdtempSync(join(tmpdir(), 'brv-status-handler-')))
    stub(console, 'error')
  })

  afterEach(() => {
    restore()
    rmSync(testDir, {force: true, recursive: true})
  })

  function createHandler(opts: {billingAuthenticated?: boolean; projectPath?: string; webuiPort?: number} = {}): StatusHandler {
    if (opts.projectPath) {
      resolveProjectPath = stub().returns(opts.projectPath)
    }

    const sandbox = createSandbox()
    const handler = new StatusHandler({
      authStateStore: createMockAuthStateStore(sandbox, {isAuthenticated: opts.billingAuthenticated ?? true}),
      billingConfigStoreFactory: () => deps.billingConfigStore as unknown as IBillingConfigStore,
      billingService: deps.billingService as unknown as IBillingService,
      contextTreeService: deps.contextTreeService,
      contextTreeSnapshotService: deps.contextTreeSnapshotService,
      curateLogStoreFactory: () => deps.curateLogStore,
      projectConfigStore: deps.projectConfigStore,
      providerConfigStore: deps.providerConfigStore as unknown as IProviderConfigStore,
      resolveProjectPath,
      tokenStore: deps.tokenStore,
      transport,
      webuiPort: opts.webuiPort,
    })
    handler.setup()
    return handler
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  async function callGetHandler(data?: any, clientId = 'client-1'): Promise<{status: StatusDTO}> {
    const handler = transport._handlers.get(StatusEvents.GET)
    expect(handler, 'status:get handler should be registered').to.exist
    return handler!(data, clientId)
  }

  describe('setup', () => {
    it('should register status:get handler', () => {
      createHandler()
      expect(transport.onRequest.calledOnce).to.be.true
      expect(transport.onRequest.firstCall.args[0]).to.equal(StatusEvents.GET)
    })
  })

  describe('auth status', () => {
    it('should return not_logged_in when no token', async () => {
      deps.tokenStore.load.resolves()
      createHandler()
      const result = await callGetHandler()
      expect(result.status.authStatus).to.equal('not_logged_in')
    })

    it('should return logged_in with email when token is valid', async () => {
      deps.tokenStore.load.resolves({isValid: () => true, userEmail: 'user@test.com'})
      createHandler()
      const result = await callGetHandler()
      expect(result.status.authStatus).to.equal('logged_in')
      expect(result.status.userEmail).to.equal('user@test.com')
    })

    it('should return expired when token is invalid', async () => {
      deps.tokenStore.load.resolves({isValid: () => false, userEmail: 'user@test.com'})
      createHandler()
      const result = await callGetHandler()
      expect(result.status.authStatus).to.equal('expired')
    })

    it('should return unknown when tokenStore.load throws', async () => {
      deps.tokenStore.load.rejects(new Error('keychain error'))
      createHandler()
      const result = await callGetHandler()
      expect(result.status.authStatus).to.equal('unknown')
    })
  })

  describe('context tree status', () => {
    it('should return not_initialized when context tree does not exist', async () => {
      deps.contextTreeService.exists.resolves(false)
      createHandler()
      const result = await callGetHandler()
      expect(result.status.contextTreeStatus).to.equal('not_initialized')
    })

    it('should return no_changes when context tree exists with no changes', async () => {
      deps.contextTreeService.exists.resolves(true)
      deps.projectConfigStore.exists.resolves(true)
      deps.projectConfigStore.read.resolves({spaceId: 's1', spaceName: 'space-1', teamId: 't1', teamName: 'team-1'})
      deps.contextTreeSnapshotService.getChanges.resolves({added: [], deleted: [], modified: []})
      createHandler()
      const result = await callGetHandler()
      expect(result.status.contextTreeStatus).to.equal('no_changes')
    })

    it('should return has_changes when there are changes', async () => {
      deps.contextTreeService.exists.resolves(true)
      deps.projectConfigStore.exists.resolves(true)
      deps.projectConfigStore.read.resolves({spaceId: 's1', spaceName: 'space-1', teamId: 't1', teamName: 'team-1'})
      deps.contextTreeSnapshotService.getChanges.resolves({added: ['new.md'], deleted: [], modified: []})
      createHandler()
      const result = await callGetHandler()
      expect(result.status.contextTreeStatus).to.equal('has_changes')
    })

    describe('legacy sync config gating (ENG-2043)', () => {
      it('new user (no teamId/spaceId) should return no_vc and never touch snapshot', async () => {
        deps.contextTreeService.exists.resolves(true)
        deps.projectConfigStore.exists.resolves(true)
        deps.projectConfigStore.read.resolves({})
        createHandler()

        const result = await callGetHandler()
        expect(result.status.contextTreeStatus).to.equal('no_vc')
        expect(deps.contextTreeSnapshotService.hasSnapshot.called).to.be.false
        expect(deps.contextTreeSnapshotService.initEmptySnapshot.called).to.be.false
        expect(deps.contextTreeSnapshotService.getChanges.called).to.be.false
      })

      it('orphan user (stale snapshot, no legacy config) should return no_vc and leave file untouched', async () => {
        deps.contextTreeService.exists.resolves(true)
        deps.projectConfigStore.exists.resolves(true)
        deps.projectConfigStore.read.resolves({})
        deps.contextTreeSnapshotService.hasSnapshot.resolves(true)
        createHandler()

        const result = await callGetHandler()
        expect(result.status.contextTreeStatus).to.equal('no_vc')
        expect(deps.contextTreeSnapshotService.hasSnapshot.called).to.be.false
        expect(deps.contextTreeSnapshotService.initEmptySnapshot.called).to.be.false
        expect(deps.contextTreeSnapshotService.getChanges.called).to.be.false
      })

      it('partial config (teamId only) should return no_vc', async () => {
        deps.contextTreeService.exists.resolves(true)
        deps.projectConfigStore.exists.resolves(true)
        deps.projectConfigStore.read.resolves({teamId: 't1'})
        createHandler()

        const result = await callGetHandler()
        expect(result.status.contextTreeStatus).to.equal('no_vc')
        expect(deps.contextTreeSnapshotService.hasSnapshot.called).to.be.false
        expect(deps.contextTreeSnapshotService.initEmptySnapshot.called).to.be.false
        expect(deps.contextTreeSnapshotService.getChanges.called).to.be.false
      })

      it('partial config (spaceId only) should return no_vc', async () => {
        deps.contextTreeService.exists.resolves(true)
        deps.projectConfigStore.exists.resolves(true)
        deps.projectConfigStore.read.resolves({spaceId: 's1'})
        createHandler()

        const result = await callGetHandler()
        expect(result.status.contextTreeStatus).to.equal('no_vc')
        expect(deps.contextTreeSnapshotService.initEmptySnapshot.called).to.be.false
      })

      it('legacy user (teamId + spaceId) should create missing snapshot and compute diffs', async () => {
        deps.contextTreeService.exists.resolves(true)
        deps.projectConfigStore.exists.resolves(true)
        deps.projectConfigStore.read.resolves({spaceId: 's1', spaceName: 'space-1', teamId: 't1', teamName: 'team-1'})
        deps.contextTreeSnapshotService.hasSnapshot.resolves(false)
        deps.contextTreeSnapshotService.getChanges.resolves({added: [], deleted: [], modified: []})
        createHandler()

        const result = await callGetHandler()
        expect(result.status.contextTreeStatus).to.equal('no_changes')
        expect(deps.contextTreeSnapshotService.hasSnapshot.called).to.be.true
        expect(deps.contextTreeSnapshotService.initEmptySnapshot.called).to.be.true
        expect(deps.contextTreeSnapshotService.getChanges.called).to.be.true
      })

      it('no project config file at all should return no_vc', async () => {
        deps.contextTreeService.exists.resolves(true)
        deps.projectConfigStore.exists.resolves(false)
        createHandler()

        const result = await callGetHandler()
        expect(result.status.contextTreeStatus).to.equal('no_vc')
        expect(deps.contextTreeSnapshotService.initEmptySnapshot.called).to.be.false
      })
    })

    it('should return unknown when contextTreeService.exists throws', async () => {
      deps.contextTreeService.exists.rejects(new Error('FS error'))
      createHandler()
      const result = await callGetHandler()
      expect(result.status.contextTreeStatus).to.equal('unknown')
    })
  })

  describe('git vc mode', () => {
    it('should return git_vc context tree status when .git exists in context tree', async () => {
      deps.contextTreeService.exists.resolves(true)
      deps.contextTreeService.hasGitRepo.resolves(true)
      createHandler()

      const result = await callGetHandler()
      expect(result.status.contextTreeStatus).to.equal('git_vc')
      expect(deps.contextTreeSnapshotService.hasSnapshot.called).to.be.false
      expect(deps.contextTreeSnapshotService.getChanges.called).to.be.false
    })

    it('should still return auth and project info when git vc is active', async () => {
      deps.contextTreeService.exists.resolves(true)
      deps.contextTreeService.hasGitRepo.resolves(true)
      deps.tokenStore.load.resolves({isValid: () => true, userEmail: 'user@test.com'})
      deps.projectConfigStore.exists.resolves(true)
      deps.projectConfigStore.read.resolves({spaceName: 'space-1', teamName: 'team-1'})
      createHandler()

      const result = await callGetHandler()
      expect(result.status.authStatus).to.equal('logged_in')
      expect(result.status.userEmail).to.equal('user@test.com')
      expect(result.status.teamName).to.equal('team-1')
      expect(result.status.spaceName).to.equal('space-1')
      expect(result.status.contextTreeStatus).to.equal('git_vc')
    })

    it('should proceed normally when .git does not exist', async () => {
      deps.contextTreeService.exists.resolves(true)
      deps.contextTreeService.hasGitRepo.resolves(false)
      createHandler()

      const result = await callGetHandler()
      expect(result.status.contextTreeStatus).to.not.equal('git_vc')
    })
  })

  describe('pending review', () => {
    it('should include pendingReviewCount when curate log has pending ops', async () => {
      transport.getPort.returns(54_321)
      createHandler()

      deps.curateLogStore.list.resolves([
        makeCompletedEntry([
          {
            filePath: '/project/current/.brv/context-tree/auth/jwt.md',
            needsReview: true,
            path: 'auth/jwt',
            reviewStatus: 'pending',
            status: 'success',
            type: 'DELETE',
          },
          {
            filePath: '/project/current/.brv/context-tree/auth/oauth.md',
            needsReview: true,
            path: 'auth/oauth',
            reviewStatus: 'pending',
            status: 'success',
            type: 'DELETE',
          },
        ]),
      ])

      const result = await callGetHandler()
      expect(result.status.pendingReviewCount).to.equal(2)
    })

    it('should include reviewUrl when pending reviews exist', async () => {
      createHandler({webuiPort: 54_321})

      deps.curateLogStore.list.resolves([
        makeCompletedEntry([
          {
            filePath: '/project/current/.brv/context-tree/auth/jwt.md',
            needsReview: true,
            path: 'auth/jwt',
            reviewStatus: 'pending',
            status: 'success',
            type: 'DELETE',
          },
        ]),
      ])

      const result = await callGetHandler()
      expect(result.status.reviewUrl).to.be.a('string')
      expect(result.status.reviewUrl).to.equal(
        `http://localhost:54321/changes?project=${encodeBase64Url('/project/current')}`,
      )
    })

    it('should NOT include pendingReviewCount when no pending ops exist', async () => {
      createHandler()

      deps.curateLogStore.list.resolves([
        makeCompletedEntry([
          {
            filePath: '/project/current/.brv/context-tree/auth/jwt.md',
            needsReview: true,
            path: 'auth/jwt',
            reviewStatus: 'approved',
            status: 'success',
            type: 'DELETE',
          },
        ]),
      ])

      const result = await callGetHandler()
      expect(result.status.pendingReviewCount).to.be.undefined
      expect(result.status.reviewUrl).to.be.undefined
    })

    it('should NOT include pendingReviewCount when curate log is empty', async () => {
      createHandler()
      deps.curateLogStore.list.resolves([])

      const result = await callGetHandler()
      expect(result.status.pendingReviewCount).to.be.undefined
    })

    it('should count unique files, not operations', async () => {
      transport.getPort.returns(54_321)
      createHandler()

      // Same file appears in two entries
      deps.curateLogStore.list.resolves([
        makeCompletedEntry([
          {
            filePath: '/project/current/.brv/context-tree/auth/jwt.md',
            needsReview: true,
            path: 'auth/jwt',
            reviewStatus: 'pending',
            status: 'success',
            type: 'DELETE',
          },
        ]),
        makeCompletedEntry([
          {
            filePath: '/project/current/.brv/context-tree/auth/jwt.md',
            needsReview: true,
            path: 'auth/jwt',
            reviewStatus: 'pending',
            status: 'success',
            type: 'UPDATE',
          },
        ]),
      ])

      const result = await callGetHandler()
      expect(result.status.pendingReviewCount).to.equal(1)
    })

    it('should detect pending ops even when needsReview is undefined', async () => {
      createHandler({webuiPort: 54_321})

      deps.curateLogStore.list.resolves([
        makeCompletedEntry([
          {
            filePath: '/project/current/.brv/context-tree/auth/jwt.md',
            path: 'auth/jwt',
            reviewStatus: 'pending',
            status: 'success',
            type: 'DELETE',
          },
        ]),
      ])

      const result = await callGetHandler()
      expect(result.status.pendingReviewCount).to.equal(1)
      expect(result.status.reviewUrl).to.be.a('string')
    })

    it('should gracefully handle curate log errors', async () => {
      createHandler()
      deps.curateLogStore.list.rejects(new Error('disk error'))

      const result = await callGetHandler()
      // Should still return valid status without review fields
      expect(result.status.pendingReviewCount).to.be.undefined
      expect(result.status.reviewUrl).to.be.undefined
      expect(result.status.currentDirectory).to.equal('/project/current')
    })
  })

  describe('currentDirectory', () => {
    it('should equal projectPath when no cwd is provided', async () => {
      createHandler({projectPath: '/test/project'})

      const {status} = await callGetHandler()

      expect(status.currentDirectory).to.equal('/test/project')
    })

    it('should equal clientCwd when cwd is provided', async () => {
      // Create a real project so resolveProject() succeeds
      const projectRoot = join(testDir, 'project')
      const subDir = join(projectRoot, 'packages', 'api', 'src')
      mkdirSync(join(projectRoot, '.brv'), {recursive: true})
      writeFileSync(join(projectRoot, '.brv', 'config.json'), JSON.stringify({version: '0.0.1'}))
      mkdirSync(subDir, {recursive: true})

      createHandler({projectPath: projectRoot})

      const {status} = await callGetHandler({cwd: subDir})

      expect(status.currentDirectory).to.equal(subDir)
      expect(status.projectRoot).to.equal(projectRoot)
    })

    it('should preserve clientCwd even when resolver returns null', async () => {
      // Pass a cwd that has no .brv/ — resolveProject returns null
      const noProjectDir = join(testDir, 'no-project')
      mkdirSync(noProjectDir, {recursive: true})

      createHandler({projectPath: '/fallback/project'})

      const {status} = await callGetHandler({cwd: noProjectDir})

      expect(status.currentDirectory).to.equal(noProjectDir)
    })
  })

  describe('projectRootFlag', () => {
    it('should resolve to the explicit project root when projectRootFlag is provided', async () => {
      // Create a real project at an explicit path
      const explicitRoot = join(testDir, 'explicit-project')
      mkdirSync(join(explicitRoot, '.brv'), {recursive: true})
      writeFileSync(join(explicitRoot, '.brv', 'config.json'), JSON.stringify({version: '0.0.1'}))

      // Create a different project at a cwd location
      const cwdProject = join(testDir, 'cwd-project')
      mkdirSync(join(cwdProject, '.brv'), {recursive: true})
      writeFileSync(join(cwdProject, '.brv', 'config.json'), JSON.stringify({version: '0.0.1'}))

      createHandler({projectPath: cwdProject})

      const {status} = await callGetHandler({cwd: cwdProject, projectRootFlag: explicitRoot})

      // The explicit flag should override the cwd-based resolution
      expect(status.projectRoot).to.equal(explicitRoot)
      expect(status.resolutionSource).to.equal('flag')
    })

    it('should use projectRootFlag even without cwd', async () => {
      const explicitRoot = join(testDir, 'explicit-project')
      mkdirSync(join(explicitRoot, '.brv'), {recursive: true})
      writeFileSync(join(explicitRoot, '.brv', 'config.json'), JSON.stringify({version: '0.0.1'}))

      createHandler({projectPath: '/some/other/project'})

      const {status} = await callGetHandler({projectRootFlag: explicitRoot})

      expect(status.projectRoot).to.equal(explicitRoot)
      expect(status.resolutionSource).to.equal('flag')
    })
  })

  describe('billing source', () => {
    it('returns undefined billing when no token is loaded', async () => {
      deps.tokenStore.load.resolves()
      createHandler({billingAuthenticated: false})

      const {status} = await callGetHandler()

      expect(status.billing).to.equal(undefined)
    })

    it('returns other-provider when an authed user is on a non-byterover provider', async () => {
      deps.tokenStore.load.resolves(authedToken())
      deps.providerConfigStore.getActiveProvider.resolves('openai')
      createHandler()

      const {status} = await callGetHandler()

      expect(status.billing).to.deep.equal({activeProvider: 'openai', source: 'other-provider'})
      expect(deps.billingService.getUsages.called).to.be.false
    })

    it('builds the paid source when authed on byterover and a pin matches a paid usage', async () => {
      deps.tokenStore.load.resolves(authedToken())
      deps.providerConfigStore.getActiveProvider.resolves('byterover')
      deps.billingConfigStore.getPinnedTeamId.resolves('org-acme')
      deps.billingService.getUsages.resolves([
        {
          addOnRemaining: 0,
          isTrialing: false,
          limit: 100_000,
          limitExceeded: false,
          organizationId: 'org-acme',
          organizationName: 'Acme Corp',
          organizationStatus: 'ACTIVE',
          percentUsed: 12.4,
          remaining: 87_600,
          tier: 'PRO',
          totalLimit: 100_000,
          used: 12_400,
        },
      ])
      createHandler()

      const {status} = await callGetHandler()

      expect(status.billing).to.deep.equal({
        organizationId: 'org-acme',
        organizationName: 'Acme Corp',
        remaining: 87_600,
        source: 'paid',
        tier: 'PRO',
        total: 100_000,
      })
    })

    it('returns undefined billing when getUsages throws', async () => {
      deps.tokenStore.load.resolves(authedToken())
      deps.providerConfigStore.getActiveProvider.resolves('byterover')
      deps.billingService.getUsages.rejects(new Error('upstream offline'))
      createHandler()

      const {status} = await callGetHandler()

      expect(status.billing).to.equal(undefined)
    })
  })
})
