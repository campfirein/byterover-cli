/**
 * VcHandler Unit Tests
 *
 * Tests vc init, status, add, commit, config, push flows.
 */

import {expect} from 'chai'
import fs, {existsSync, mkdirSync, rmSync, writeFileSync} from 'node:fs'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import {createSandbox, type SinonSandbox, type SinonStub} from 'sinon'

import type {ITokenStore} from '../../../../../src/server/core/interfaces/auth/i-token-store.js'
import type {IContextTreeService} from '../../../../../src/server/core/interfaces/context-tree/i-context-tree-service.js'
import type {IGitService} from '../../../../../src/server/core/interfaces/services/i-git-service.js'
import type {ISpaceService} from '../../../../../src/server/core/interfaces/services/i-space-service.js'
import type {ITeamService} from '../../../../../src/server/core/interfaces/services/i-team-service.js'
import type {IProjectConfigStore} from '../../../../../src/server/core/interfaces/storage/i-project-config-store.js'
import type {
  ITransportServer,
  RequestHandler,
} from '../../../../../src/server/core/interfaces/transport/i-transport-server.js'
import type {IVcGitConfigStore} from '../../../../../src/server/core/interfaces/vc/i-vc-git-config-store.js'

import {BRV_DIR, CONTEXT_TREE_DIR} from '../../../../../src/server/constants.js'
import {AuthToken} from '../../../../../src/server/core/domain/entities/auth-token.js'
import {BrvConfig} from '../../../../../src/server/core/domain/entities/brv-config.js'
import {GitAuthError, GitError} from '../../../../../src/server/core/domain/errors/git-error.js'
import {NotAuthenticatedError} from '../../../../../src/server/core/domain/errors/task-error.js'
import {VcError} from '../../../../../src/server/core/domain/errors/vc-error.js'
import {VcHandler} from '../../../../../src/server/infra/transport/handlers/vc-handler.js'
import {
  type IVcBranchRequest,
  type IVcBranchResponse,
  type IVcCheckoutResponse,
  type IVcFetchResponse,
  type IVcMergeRequest,
  type IVcMergeResponse,
  type IVcPullResponse,
  type IVcResetResponse,
  type IVcStatusResponse,
  VcErrorCode,
  VcEvents,
} from '../../../../../src/shared/transport/events/vc-events.js'

/** Makes all methods of T typed as SinonStub while still satisfying the original interface. */
type Stubbed<T> = {[K in keyof T]: SinonStub & T[K]}

const CLIENT_ID = 'client-abc'

interface TestDeps {
  broadcastToProject: SinonStub
  contextTreeDirPath: string
  contextTreeService: Stubbed<IContextTreeService>
  gitService: Stubbed<IGitService>
  projectConfigStore: Stubbed<IProjectConfigStore>
  requestHandlers: Record<string, RequestHandler>
  resolveProjectPath: SinonStub
  spaceService: Stubbed<ISpaceService>
  teamService: Stubbed<ITeamService>
  tokenStore: Stubbed<ITokenStore>
  transport: Stubbed<ITransportServer>
  vcGitConfigStore: Stubbed<IVcGitConfigStore>
}

function makeDeps(sandbox: SinonSandbox, projectPath: string): TestDeps {
  const contextTreeDirPath = join(projectPath, BRV_DIR, CONTEXT_TREE_DIR)

  const contextTreeService: Stubbed<IContextTreeService> = {
    delete: sandbox.stub().resolves(),
    exists: sandbox.stub().resolves(false),
    hasGitRepo: sandbox.stub().resolves(false),
    initialize: sandbox.stub().resolves(contextTreeDirPath),
    resolvePath: sandbox.stub().returns(contextTreeDirPath),
  }

  const gitService: Stubbed<IGitService> = {
    abortMerge: sandbox.stub().resolves(),
    add: sandbox.stub().resolves(),
    addRemote: sandbox.stub().resolves(),
    checkout: sandbox.stub().resolves(),
    clone: sandbox.stub().resolves(),
    commit: sandbox.stub().resolves({
      author: {email: 'test@example.com', name: 'Test User'},
      message: 'test commit',
      sha: 'abc123def456',
      timestamp: new Date(),
    }),
    createBranch: sandbox.stub().resolves(),
    deleteBranch: sandbox.stub().resolves(),
    fetch: sandbox.stub().resolves(),
    getAheadBehind: sandbox.stub().resolves({ahead: 0, behind: 0}),
    getBlobContent: sandbox.stub().resolves(),
    getBlobContents: sandbox.stub().resolves({}),
    getConflicts: sandbox.stub().resolves([]),
    getCurrentBranch: sandbox.stub().resolves('main'),
    getFilesWithConflictMarkers: sandbox.stub().resolves([]),
    getRemoteUrl: sandbox.stub().resolves(),
    getTextBlob: sandbox.stub().resolves(),
    getTrackingBranch: sandbox.stub().resolves(),
    hashBlob: sandbox.stub().resolves('0000000'),
    init: sandbox.stub().resolves(),
    isAncestor: sandbox.stub().resolves(true),
    isEmptyRepository: sandbox.stub().resolves(false),
    isInitialized: sandbox.stub().resolves(true),
    listBranches: sandbox.stub().resolves([]),
    listChangedFiles: sandbox.stub().resolves([]),
    listRemotes: sandbox.stub().resolves([{remote: 'origin', url: 'https://example.com/repo.git'}]),
    log: sandbox.stub().resolves([]),
    merge: sandbox.stub().resolves({success: true}),
    pull: sandbox.stub().resolves({success: true}),
    push: sandbox.stub().resolves({success: true}),
    removeRemote: sandbox.stub().resolves(),
    reset: sandbox.stub().resolves({filesChanged: 0, headSha: 'abc123'}),
    setTrackingBranch: sandbox.stub().resolves(),
    status: sandbox.stub().resolves({files: [], isClean: true}),
  }

  const vcGitConfigStore: Stubbed<IVcGitConfigStore> = {
    get: sandbox.stub().resolves({email: 'test@example.com', name: 'Test User'}),
    set: sandbox.stub().resolves(),
  }

  const resolveProjectPath = sandbox.stub().returns(projectPath)

  const teamService: Stubbed<ITeamService> = {
    getTeams: sandbox.stub().resolves({teams: [], total: 0}),
  }

  const spaceService: Stubbed<ISpaceService> = {
    getSpaces: sandbox.stub().resolves({spaces: [], total: 0}),
  }

  const defaultToken = new AuthToken({
    accessToken: 'test-acc',
    expiresAt: new Date(Date.now() + 3_600_000),
    refreshToken: 'test-ref',
    sessionKey: 'sess-123',
    userEmail: 'test@example.com',
    userId: 'u1',
  })

  const tokenStore: Stubbed<ITokenStore> = {
    clear: sandbox.stub().resolves(),
    load: sandbox.stub().resolves(defaultToken),
    save: sandbox.stub().resolves(),
  }

  // Capture registered handlers keyed by event name
  const requestHandlers: Record<string, RequestHandler> = {}
  const transport: Stubbed<ITransportServer> = {
    addToRoom: sandbox.stub(),
    broadcast: sandbox.stub(),
    broadcastTo: sandbox.stub(),
    getPort: sandbox.stub(),
    isRunning: sandbox.stub(),
    onConnection: sandbox.stub(),
    onDisconnection: sandbox.stub(),
    onRequest: sandbox.stub().callsFake((event: string, handler: RequestHandler) => {
      requestHandlers[event] = handler
    }),
    removeFromRoom: sandbox.stub(),
    sendTo: sandbox.stub(),
    start: sandbox.stub().resolves(),
    stop: sandbox.stub().resolves(),
  }

  const broadcastToProject = sandbox.stub()

  const projectConfigStore: Stubbed<IProjectConfigStore> = {
    exists: sandbox.stub().resolves(false),
    getModifiedTime: sandbox.stub().resolves(),
    read: sandbox.stub().resolves(),
    write: sandbox.stub().resolves(),
  }

  return {
    broadcastToProject,
    contextTreeDirPath,
    contextTreeService,
    gitService,
    projectConfigStore,
    requestHandlers,
    resolveProjectPath,
    spaceService,
    teamService,
    tokenStore,
    transport,
    vcGitConfigStore,
  }
}

function makeVcHandler(deps: TestDeps): VcHandler {
  return new VcHandler({
    broadcastToProject: deps.broadcastToProject,
    contextTreeService: deps.contextTreeService,
    gitRemoteBaseUrl: 'https://byterover.dev',
    gitService: deps.gitService,
    projectConfigStore: deps.projectConfigStore,
    resolveProjectPath: deps.resolveProjectPath,
    spaceService: deps.spaceService,
    teamService: deps.teamService,
    tokenStore: deps.tokenStore,
    transport: deps.transport,
    vcGitConfigStore: deps.vcGitConfigStore,
    webAppUrl: 'https://test-app.byterover.dev',
  })
}

function stubDefaultTeamSpace(deps: TestDeps): void {
  deps.teamService.getTeams.resolves({
    teams: [
      {displayName: 'Teambao1', id: 'tid-1', isActive: true, isDefault: false, name: 'teambao1', slug: 'teambao1'},
    ],
    total: 1,
  })
  deps.spaceService.getSpaces.resolves({
    spaces: [
      {
        id: 'sid-1',
        isDefault: false,
        name: 'test-space',
        slug: 'test-space',
        teamId: 'tid-1',
        teamName: 'teambao1',
        teamSlug: 'teambao1',
      },
    ],
    total: 1,
  })
}

const projectPath = '/fake/brv/project'

/**
 * Creates a real temp dir with .git/ so fs.promises.access(MERGE_HEAD) works.
 * Returns a deps object whose contextTreeService.resolvePath points to that dir.
 */
function makeMergeDeps(
  sb: SinonSandbox,
  opts: {mergeHead?: boolean; mergeMsg?: string} = {},
): TestDeps & {tmpDir: string} {
  const tmpDir = join(tmpdir(), `brv-vc-merge-test-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`)
  mkdirSync(join(tmpDir, '.git'), {recursive: true})

  if (opts.mergeHead) {
    writeFileSync(join(tmpDir, '.git', 'MERGE_HEAD'), 'deadbeefdeadbeefdeadbeefdeadbeefdeadbeef\n')
  }

  if (opts.mergeMsg) {
    writeFileSync(join(tmpDir, '.git', 'MERGE_MSG'), `${opts.mergeMsg}\n`)
  }

  const deps = makeDeps(sb, projectPath)
  deps.contextTreeService.resolvePath.returns(tmpDir)
  return {...deps, tmpDir}
}

function cleanupDir(dir: string): void {
  if (existsSync(dir)) rmSync(dir, {force: true, recursive: true})
}

/** Typed invoke helper — consolidates the single unavoidable cast from RequestHandler's `Promise<unknown>`. */
function invoke<T>(deps: TestDeps, event: string, data: unknown, clientId = CLIENT_ID): Promise<T> {
  return deps.requestHandlers[event](data, clientId) as Promise<T>
}

describe('VcHandler', () => {
  let sandbox: SinonSandbox

  beforeEach(() => {
    sandbox = createSandbox()
    sandbox.stub(fs.promises, 'writeFile').resolves()
  })

  afterEach(() => {
    sandbox.restore()
  })

  describe('setup()', () => {
    it('should register vc:branch handler', () => {
      const deps = makeDeps(sandbox, projectPath)
      makeVcHandler(deps).setup()

      const registeredEvents = deps.transport.onRequest.args.map((args: unknown[]) => args[0])
      expect(registeredEvents).to.include(VcEvents.BRANCH)
    })

    it('should register handlers for all vc events', () => {
      const deps = makeDeps(sandbox, projectPath)
      makeVcHandler(deps).setup()

      const registeredEvents = deps.transport.onRequest.args.map((args: unknown[]) => args[0])
      expect(registeredEvents).to.include(VcEvents.BRANCH)
      expect(registeredEvents).to.include(VcEvents.CLONE)
      expect(registeredEvents).to.include(VcEvents.ADD)
      expect(registeredEvents).to.include(VcEvents.COMMIT)
      expect(registeredEvents).to.include(VcEvents.CONFIG)
      expect(registeredEvents).to.include(VcEvents.FETCH)
      expect(registeredEvents).to.include(VcEvents.INIT)
      expect(registeredEvents).to.include(VcEvents.LOG)
      expect(registeredEvents).to.include(VcEvents.PULL)
      expect(registeredEvents).to.include(VcEvents.PUSH)
      expect(registeredEvents).to.include(VcEvents.REMOTE)
      expect(registeredEvents).to.include(VcEvents.STATUS)
      expect(registeredEvents).to.include(VcEvents.CHECKOUT)
    })
  })

  describe('handleInit — fresh repo (isInitialized=false)', () => {
    it('should call contextTreeService.initialize with projectPath', async () => {
      const deps = makeDeps(sandbox, projectPath)
      deps.gitService.isInitialized.resolves(false)
      makeVcHandler(deps).setup()

      await deps.requestHandlers[VcEvents.INIT]({}, CLIENT_ID)

      expect(deps.contextTreeService.initialize.calledOnceWith(projectPath)).to.be.true
    })

    it('should call gitService.init with contextTreeDir and defaultBranch main', async () => {
      const deps = makeDeps(sandbox, projectPath)
      deps.gitService.isInitialized.resolves(false)
      makeVcHandler(deps).setup()

      await deps.requestHandlers[VcEvents.INIT]({}, CLIENT_ID)

      expect(deps.gitService.init.calledOnce).to.be.true
      expect(deps.gitService.init.firstCall.args[0]).to.deep.equal({
        defaultBranch: 'main',
        directory: deps.contextTreeDirPath,
      })
    })

    it('should return reinitialized=false when repo was not previously initialized', async () => {
      const deps = makeDeps(sandbox, projectPath)
      deps.gitService.isInitialized.resolves(false)
      makeVcHandler(deps).setup()

      const result = await deps.requestHandlers[VcEvents.INIT]({}, CLIENT_ID)

      expect(result).to.deep.equal({
        gitDir: join(deps.contextTreeDirPath, '.git'),
        reinitialized: false,
      })
    })

    it('should not call add, commit, or addRemote on fresh init', async () => {
      const deps = makeDeps(sandbox, projectPath)
      deps.gitService.isInitialized.resolves(false)
      makeVcHandler(deps).setup()

      await deps.requestHandlers[VcEvents.INIT]({}, CLIENT_ID)

      expect(deps.gitService.add.called).to.be.false
      expect(deps.gitService.commit.called).to.be.false
      expect(deps.gitService.addRemote.called).to.be.false
    })

    it('should complete init successfully', async () => {
      const deps = makeDeps(sandbox, projectPath)
      deps.gitService.isInitialized.resolves(false)
      makeVcHandler(deps).setup()

      const result = await deps.requestHandlers[VcEvents.INIT]({}, CLIENT_ID)

      expect(result).to.deep.equal({
        gitDir: join(deps.contextTreeDirPath, '.git'),
        reinitialized: false,
      })
    })
  })

  describe('handleInit — repo already exists (isInitialized=true)', () => {
    it('should still call gitService.init when repo already exists', async () => {
      const deps = makeDeps(sandbox, projectPath)
      deps.gitService.isInitialized.resolves(true)
      makeVcHandler(deps).setup()

      await deps.requestHandlers[VcEvents.INIT]({}, CLIENT_ID)

      expect(deps.gitService.init.calledOnce).to.be.true
    })

    it('should return reinitialized=true when repo already existed', async () => {
      const deps = makeDeps(sandbox, projectPath)
      deps.gitService.isInitialized.resolves(true)
      makeVcHandler(deps).setup()

      const result = await deps.requestHandlers[VcEvents.INIT]({}, CLIENT_ID)

      expect(result).to.deep.equal({
        gitDir: join(deps.contextTreeDirPath, '.git'),
        reinitialized: true,
      })
    })
  })

  describe('project path resolution', () => {
    it('should throw when project path cannot be resolved', async () => {
      const deps = makeDeps(sandbox, projectPath)
      deps.resolveProjectPath.callsFake(() => {})
      makeVcHandler(deps).setup()

      try {
        await deps.requestHandlers[VcEvents.INIT]({}, CLIENT_ID)
        expect.fail('Expected error for missing project path')
      } catch (error) {
        expect(error).to.be.instanceOf(Error)
        if (error instanceof Error) {
          expect(error.message).to.include('No project path found')
        }
      }
    })
  })

  describe('handleStatus — git not initialized', () => {
    it('should return empty response with initialized=false', async () => {
      const deps = makeDeps(sandbox, projectPath)
      deps.gitService.isInitialized.resolves(false)
      makeVcHandler(deps).setup()

      const result = await deps.requestHandlers[VcEvents.STATUS]({}, CLIENT_ID)

      expect(result).to.deep.equal({
        initialized: false,
        staged: {added: [], deleted: [], modified: []},
        unstaged: {deleted: [], modified: []},
        untracked: [],
      })
    })
  })

  describe('handleStatus — git initialized', () => {
    it('should return branch and file lists', async () => {
      const deps = makeDeps(sandbox, projectPath)
      deps.gitService.isInitialized.resolves(true)
      deps.gitService.getCurrentBranch.resolves('main')
      deps.gitService.status.resolves({
        files: [
          {path: 'a.md', staged: true, status: 'added'},
          {path: 'b.md', staged: false, status: 'modified'},
          {path: 'c.md', staged: false, status: 'untracked'},
        ],
        isClean: false,
      })
      makeVcHandler(deps).setup()

      const result = await deps.requestHandlers[VcEvents.STATUS]({}, CLIENT_ID)

      expect(result).to.deep.include({
        branch: 'main',
        initialized: true,
        staged: {added: ['a.md'], deleted: [], modified: []},
        unstaged: {deleted: [], modified: ['b.md']},
        untracked: ['c.md'],
      })
    })
  })

  describe('handleAdd', () => {
    it('should call gitService.add with ["."] by default', async () => {
      const deps = makeDeps(sandbox, projectPath)
      deps.gitService.isInitialized.resolves(true)
      // before add: nothing staged; after add: a.md staged → delta = 1
      deps.gitService.status.onFirstCall().resolves({files: [], isClean: true})
      deps.gitService.status
        .onSecondCall()
        .resolves({files: [{path: 'a.md', staged: true, status: 'added'}], isClean: false})
      makeVcHandler(deps).setup()

      const result = await deps.requestHandlers[VcEvents.ADD]({}, CLIENT_ID)

      expect(deps.gitService.add.calledOnce).to.be.true
      expect(deps.gitService.add.firstCall.args[0]).to.deep.include({filePaths: ['.']})
      expect(result).to.deep.equal({count: 1})
    })

    it('should call gitService.add with specific file paths when provided', async () => {
      const deps = makeDeps(sandbox, projectPath)
      deps.gitService.isInitialized.resolves(true)
      deps.gitService.status.resolves({
        files: [{path: 'src/a.ts', staged: true, status: 'added'}],
        isClean: false,
      })
      makeVcHandler(deps).setup()

      await deps.requestHandlers[VcEvents.ADD]({filePaths: ['src/a.ts']}, CLIENT_ID)

      expect(deps.gitService.add.firstCall.args[0]).to.deep.include({filePaths: ['src/a.ts']})
    })

    it('should return count=0 when nothing is staged after add', async () => {
      const deps = makeDeps(sandbox, projectPath)
      deps.gitService.isInitialized.resolves(true)
      deps.gitService.status.resolves({files: [], isClean: true})
      makeVcHandler(deps).setup()

      const result = await deps.requestHandlers[VcEvents.ADD]({}, CLIENT_ID)

      expect(result).to.deep.equal({count: 0})
    })

    it('should throw VcError GIT_NOT_INITIALIZED when git not initialized', async () => {
      const deps = makeDeps(sandbox, projectPath)
      deps.gitService.isInitialized.resolves(false)
      makeVcHandler(deps).setup()

      try {
        await deps.requestHandlers[VcEvents.ADD]({}, CLIENT_ID)
        expect.fail('Expected error')
      } catch (error) {
        expect(error).to.be.instanceOf(VcError)
        if (error instanceof VcError) {
          expect(error.code).to.equal(VcErrorCode.GIT_NOT_INITIALIZED)
        }
      }
    })

    it('should call gitService.add with directory pattern ["docs/"]', async () => {
      const deps = makeDeps(sandbox, projectPath)
      deps.gitService.isInitialized.resolves(true)
      deps.gitService.status.resolves({files: [], isClean: true})
      makeVcHandler(deps).setup()

      await deps.requestHandlers[VcEvents.ADD]({filePaths: ['docs/']}, CLIENT_ID)

      expect(deps.gitService.add.firstCall.args[0]).to.deep.include({filePaths: ['docs/']})
    })

    it('should call gitService.add with nested .md file path', async () => {
      const deps = makeDeps(sandbox, projectPath)
      deps.gitService.isInitialized.resolves(true)
      deps.gitService.status.resolves({files: [], isClean: true})
      makeVcHandler(deps).setup()

      await deps.requestHandlers[VcEvents.ADD]({filePaths: ['docs/architecture.md']}, CLIENT_ID)

      expect(deps.gitService.add.firstCall.args[0]).to.deep.include({filePaths: ['docs/architecture.md']})
    })

    it('should call gitService.add with mixed file and directory patterns', async () => {
      const deps = makeDeps(sandbox, projectPath)
      deps.gitService.isInitialized.resolves(true)
      deps.gitService.status.resolves({files: [], isClean: true})
      makeVcHandler(deps).setup()

      await deps.requestHandlers[VcEvents.ADD]({filePaths: ['notes.md', 'docs/']}, CLIENT_ID)

      expect(deps.gitService.add.firstCall.args[0]).to.deep.include({filePaths: ['notes.md', 'docs/']})
    })

    it('should call gitService.add with filename containing spaces', async () => {
      const deps = makeDeps(sandbox, projectPath)
      deps.gitService.isInitialized.resolves(true)
      deps.gitService.status.resolves({files: [], isClean: true})
      makeVcHandler(deps).setup()

      await deps.requestHandlers[VcEvents.ADD]({filePaths: ['Design Patterns.md']}, CLIENT_ID)

      expect(deps.gitService.add.firstCall.args[0]).to.deep.include({filePaths: ['Design Patterns.md']})
    })

    it('should call gitService.add with filename containing special characters', async () => {
      const deps = makeDeps(sandbox, projectPath)
      deps.gitService.isInitialized.resolves(true)
      deps.gitService.status.resolves({files: [], isClean: true})
      makeVcHandler(deps).setup()

      await deps.requestHandlers[VcEvents.ADD]({filePaths: ['file (1).md', 'résumé.md', 'file-name.md']}, CLIENT_ID)

      expect(deps.gitService.add.firstCall.args[0]).to.deep.include({
        filePaths: ['file (1).md', 'résumé.md', 'file-name.md'],
      })
    })

    it('should call gitService.add with uppercase path', async () => {
      const deps = makeDeps(sandbox, projectPath)
      deps.gitService.isInitialized.resolves(true)
      deps.gitService.status.resolves({files: [], isClean: true})
      makeVcHandler(deps).setup()

      await deps.requestHandlers[VcEvents.ADD]({filePaths: ['SRC/Notes.md', 'README.md']}, CLIENT_ID)

      expect(deps.gitService.add.firstCall.args[0]).to.deep.include({filePaths: ['SRC/Notes.md', 'README.md']})
    })

    it('should propagate error from gitService.add when staging fails', async () => {
      const deps = makeDeps(sandbox, projectPath)
      deps.gitService.isInitialized.resolves(true)
      deps.gitService.add.rejects(new Error('Failed to stage: missing.md'))
      makeVcHandler(deps).setup()

      try {
        await deps.requestHandlers[VcEvents.ADD]({filePaths: ['missing.md']}, CLIENT_ID)
        expect.fail('Expected error')
      } catch (error) {
        expect(error).to.be.instanceOf(Error)
        if (error instanceof Error) expect(error.message).to.include('missing.md')
      }
    })

    it('should return count=1 when staging an unstaged file deletion', async () => {
      const deps = makeDeps(sandbox, projectPath)
      deps.gitService.isInitialized.resolves(true)
      // before: file deleted but not yet staged [1,0,1] → {staged: false, status: 'deleted'}
      deps.gitService.status.onFirstCall().resolves({
        files: [{path: 'a.md', staged: false, status: 'deleted'}],
        isClean: false,
      })
      // after: deletion staged [1,0,0] → {staged: true, status: 'deleted'}
      deps.gitService.status.onSecondCall().resolves({
        files: [{path: 'a.md', staged: true, status: 'deleted'}],
        isClean: false,
      })
      makeVcHandler(deps).setup()

      const result = await deps.requestHandlers[VcEvents.ADD]({filePaths: ['a.md']}, CLIENT_ID)

      expect(result).to.deep.equal({count: 1})
    })

    it('should return count=0 when re-adding an already staged deletion (no-op)', async () => {
      const deps = makeDeps(sandbox, projectPath)
      deps.gitService.isInitialized.resolves(true)
      // already staged deletion [1,0,0] before and after — no change
      deps.gitService.status.resolves({files: [{path: 'a.md', staged: true, status: 'deleted'}], isClean: false})
      makeVcHandler(deps).setup()

      const result = await deps.requestHandlers[VcEvents.ADD]({filePaths: ['a.md']}, CLIENT_ID)

      expect(result).to.deep.equal({count: 0})
    })

    it('should return count=1 for partially staged deletion with same untracked path [1,1,0]', async () => {
      const deps = makeDeps(sandbox, projectPath)
      deps.gitService.isInitialized.resolves(true)
      // [1,1,0] = git rm --cached: staged deletion + file still in workdir (untracked)
      deps.gitService.status.onFirstCall().resolves({
        files: [
          {path: 'a.md', staged: true, status: 'deleted'},
          {path: 'a.md', staged: false, status: 'untracked'},
        ],
        isClean: false,
      })
      // after add: file is back in index as staged new file
      deps.gitService.status.onSecondCall().resolves({
        files: [{path: 'a.md', staged: true, status: 'added'}],
        isClean: false,
      })
      makeVcHandler(deps).setup()

      const result = await deps.requestHandlers[VcEvents.ADD]({filePaths: ['a.md']}, CLIENT_ID)

      // a.md was in stagedBefore AND in hadUnstagedBefore → counts as 1 (re-staged)
      expect(result).to.deep.equal({count: 1})
    })
  })

  describe('handleCommit', () => {
    it('should commit with author from vcGitConfigStore', async () => {
      const deps = makeDeps(sandbox, projectPath)
      deps.gitService.isInitialized.resolves(true)
      deps.gitService.status.resolves({
        files: [{path: 'a.md', staged: true, status: 'added'}],
        isClean: false,
      })
      deps.vcGitConfigStore.get.resolves({email: 'bao@b.dev', name: 'Bao'})
      makeVcHandler(deps).setup()

      const result = await deps.requestHandlers[VcEvents.COMMIT]({message: 'feat: test'}, CLIENT_ID)

      expect(deps.gitService.commit.calledOnce).to.be.true
      expect(deps.gitService.commit.firstCall.args[0]).to.deep.include({
        author: {email: 'bao@b.dev', name: 'Bao'},
        message: 'feat: test',
      })
      expect(result).to.deep.include({message: 'test commit', sha: 'abc123def456'})
    })

    it('should throw VcError NOTHING_STAGED when nothing is staged', async () => {
      const deps = makeDeps(sandbox, projectPath)
      deps.gitService.isInitialized.resolves(true)
      deps.gitService.status.resolves({files: [], isClean: true})
      makeVcHandler(deps).setup()

      try {
        await deps.requestHandlers[VcEvents.COMMIT]({message: 'test'}, CLIENT_ID)
        expect.fail('Expected error')
      } catch (error) {
        expect(error).to.be.instanceOf(VcError)
        if (error instanceof VcError) {
          expect(error.code).to.equal(VcErrorCode.NOTHING_STAGED)
        }
      }
    })

    it('should throw VcError USER_NOT_CONFIGURED with generic hint when not logged in', async () => {
      const deps = makeDeps(sandbox, projectPath)
      deps.gitService.isInitialized.resolves(true)
      deps.gitService.status.resolves({
        files: [{path: 'a.md', staged: true, status: 'added'}],
        isClean: false,
      })
      deps.vcGitConfigStore.get.resolves()
      deps.tokenStore.load.resolves()
      makeVcHandler(deps).setup()

      try {
        await deps.requestHandlers[VcEvents.COMMIT]({message: 'test'}, CLIENT_ID)
        expect.fail('Expected error')
      } catch (error) {
        expect(error).to.be.instanceOf(VcError)
        if (error instanceof VcError) {
          expect(error.code).to.equal(VcErrorCode.USER_NOT_CONFIGURED)
          expect(error.message).to.include('brv vc config user.name <value>')
        }
      }
    })

    it('should throw VcError USER_NOT_CONFIGURED with pre-filled hint when logged in', async () => {
      const deps = makeDeps(sandbox, projectPath)
      deps.gitService.isInitialized.resolves(true)
      deps.gitService.status.resolves({
        files: [{path: 'a.md', staged: true, status: 'added'}],
        isClean: false,
      })
      deps.vcGitConfigStore.get.resolves()

      const mockToken = new AuthToken({
        accessToken: 'test-acc',
        expiresAt: new Date(Date.now() + 3_600_000),
        refreshToken: 'test-ref',
        sessionKey: 'sess-123',
        userEmail: 'login@example.com',
        userId: 'u1',
      })
      deps.tokenStore.load.resolves(mockToken)
      makeVcHandler(deps).setup()

      try {
        await deps.requestHandlers[VcEvents.COMMIT]({message: 'test'}, CLIENT_ID)
        expect.fail('Expected error')
      } catch (error) {
        expect(error).to.be.instanceOf(VcError)
        if (error instanceof VcError) {
          expect(error.code).to.equal(VcErrorCode.USER_NOT_CONFIGURED)
          expect(error.message).to.include('login@example.com')
        }
      }
    })

    it('should throw VcError GIT_NOT_INITIALIZED when git not initialized', async () => {
      const deps = makeDeps(sandbox, projectPath)
      deps.gitService.isInitialized.resolves(false)
      makeVcHandler(deps).setup()

      try {
        await deps.requestHandlers[VcEvents.COMMIT]({message: 'test'}, CLIENT_ID)
        expect.fail('Expected error')
      } catch (error) {
        expect(error).to.be.instanceOf(VcError)
        if (error instanceof VcError) {
          expect(error.code).to.equal(VcErrorCode.GIT_NOT_INITIALIZED)
        }
      }
    })

    it('should throw VcError MERGE_CONFLICT when index has unmerged entries', async () => {
      const deps = makeDeps(sandbox, projectPath)
      deps.gitService.isInitialized.resolves(true)
      deps.gitService.status.resolves({
        files: [{path: 'a.md', staged: true, status: 'modified'}],
        isClean: false,
      })
      deps.gitService.getConflicts.resolves([{path: 'a.md', type: 'both_modified'}])
      makeVcHandler(deps).setup()

      try {
        await deps.requestHandlers[VcEvents.COMMIT]({message: 'test'}, CLIENT_ID)
        expect.fail('Expected error')
      } catch (error) {
        expect(error).to.be.instanceOf(VcError)
        if (error instanceof VcError) {
          expect(error.code).to.equal(VcErrorCode.MERGE_CONFLICT)
        }
      }

      expect(deps.gitService.commit.called).to.be.false
    })

    it('should throw VcError CONFLICT_MARKERS_PRESENT when staged file still has markers', async () => {
      const deps = makeDeps(sandbox, projectPath)
      deps.gitService.isInitialized.resolves(true)
      deps.gitService.status.resolves({
        files: [{path: 'a.md', staged: true, status: 'modified'}],
        isClean: false,
      })
      deps.gitService.getConflicts.resolves([])
      deps.gitService.getFilesWithConflictMarkers.resolves(['a.md'])
      makeVcHandler(deps).setup()

      try {
        await deps.requestHandlers[VcEvents.COMMIT]({message: 'test'}, CLIENT_ID)
        expect.fail('Expected error')
      } catch (error) {
        expect(error).to.be.instanceOf(VcError)
        if (error instanceof VcError) {
          expect(error.code).to.equal(VcErrorCode.CONFLICT_MARKERS_PRESENT)
          expect(error.message).to.include('a.md')
        }
      }

      expect(deps.gitService.commit.called).to.be.false
    })
  })

  describe('handleConfig', () => {
    it('should set user.name and return key+value', async () => {
      const deps = makeDeps(sandbox, projectPath)
      deps.vcGitConfigStore.get.resolves({})
      makeVcHandler(deps).setup()

      const result = await deps.requestHandlers[VcEvents.CONFIG]({key: 'user.name', value: 'Bao'}, CLIENT_ID)

      expect(deps.vcGitConfigStore.set.calledOnce).to.be.true
      expect(deps.vcGitConfigStore.set.firstCall.args[1]).to.deep.include({name: 'Bao'})
      expect(result).to.deep.equal({key: 'user.name', value: 'Bao'})
    })

    it('should set user.email and preserve existing user.name', async () => {
      const deps = makeDeps(sandbox, projectPath)
      deps.vcGitConfigStore.get.resolves({name: 'Bao'})
      makeVcHandler(deps).setup()

      await deps.requestHandlers[VcEvents.CONFIG]({key: 'user.email', value: 'bao@b.dev'}, CLIENT_ID)

      expect(deps.vcGitConfigStore.set.firstCall.args[1]).to.deep.equal({email: 'bao@b.dev', name: 'Bao'})
    })

    it('should get existing user.name', async () => {
      const deps = makeDeps(sandbox, projectPath)
      deps.vcGitConfigStore.get.resolves({email: 'bao@b.dev', name: 'Bao'})
      makeVcHandler(deps).setup()

      const result = await deps.requestHandlers[VcEvents.CONFIG]({key: 'user.name'}, CLIENT_ID)

      expect(result).to.deep.equal({key: 'user.name', value: 'Bao'})
      expect(deps.vcGitConfigStore.set.called).to.be.false
    })

    it('should throw VcError CONFIG_KEY_NOT_SET when getting unset key', async () => {
      const deps = makeDeps(sandbox, projectPath)
      deps.vcGitConfigStore.get.resolves()
      makeVcHandler(deps).setup()

      try {
        await deps.requestHandlers[VcEvents.CONFIG]({key: 'user.name'}, CLIENT_ID)
        expect.fail('Expected error')
      } catch (error) {
        expect(error).to.be.instanceOf(VcError)
        if (error instanceof VcError) {
          expect(error.code).to.equal(VcErrorCode.CONFIG_KEY_NOT_SET)
          expect(error.message).to.include('not set')
        }
      }
    })

    it('should throw VcError INVALID_CONFIG_KEY for unknown key', async () => {
      const deps = makeDeps(sandbox, projectPath)
      makeVcHandler(deps).setup()

      try {
        await deps.requestHandlers[VcEvents.CONFIG]({key: 'user.unknown' as never}, CLIENT_ID)
        expect.fail('Expected error')
      } catch (error) {
        expect(error).to.be.instanceOf(VcError)
        if (error instanceof VcError) {
          expect(error.code).to.equal(VcErrorCode.INVALID_CONFIG_KEY)
        }
      }
    })
  })

  describe('handlePush', () => {
    it('should push to origin/main when tracking is configured', async () => {
      const deps = makeDeps(sandbox, projectPath)
      deps.gitService.isInitialized.resolves(true)
      deps.gitService.listRemotes.resolves([{remote: 'origin', url: 'https://example.com/repo.git'}])
      deps.gitService.log.resolves([
        {author: {email: 'a@b.com', name: 'A'}, message: 'init', sha: 'abc', timestamp: new Date()},
      ])
      deps.gitService.push.resolves({success: true})
      deps.gitService.getTrackingBranch.resolves({remote: 'origin', remoteBranch: 'main'})
      makeVcHandler(deps).setup()

      const result = await deps.requestHandlers[VcEvents.PUSH]({}, CLIENT_ID)

      expect(deps.gitService.push.calledOnce).to.be.true
      expect(deps.gitService.push.firstCall.args[0]).to.deep.include({branch: 'main', remote: 'origin'})
      expect(result).to.deep.include({alreadyUpToDate: false, branch: 'main'})
    })

    it('should throw VcError NO_UPSTREAM when no tracking configured and no -u flag', async () => {
      const deps = makeDeps(sandbox, projectPath)
      deps.gitService.isInitialized.resolves(true)
      deps.gitService.listRemotes.resolves([{remote: 'origin', url: 'https://example.com/repo.git'}])
      deps.gitService.log.resolves([
        {author: {email: 'a@b.com', name: 'A'}, message: 'init', sha: 'abc', timestamp: new Date()},
      ])
      deps.gitService.getTrackingBranch.resolves()
      makeVcHandler(deps).setup()

      try {
        await deps.requestHandlers[VcEvents.PUSH]({}, CLIENT_ID)
        expect.fail('Expected error')
      } catch (error) {
        expect(error).to.be.instanceOf(VcError)
        if (error instanceof VcError) {
          expect(error.code).to.equal(VcErrorCode.NO_UPSTREAM)
          expect(error.message).to.include('brv vc push -u origin main')
        }
      }

      expect(deps.gitService.push.called).to.be.false
    })

    it('should allow push with explicit branch even without tracking', async () => {
      const deps = makeDeps(sandbox, projectPath)
      deps.gitService.isInitialized.resolves(true)
      deps.gitService.listRemotes.resolves([{remote: 'origin', url: 'https://example.com/repo.git'}])
      deps.gitService.log.resolves([
        {author: {email: 'a@b.com', name: 'A'}, message: 'init', sha: 'abc', timestamp: new Date()},
      ])
      deps.gitService.push.resolves({success: true})
      deps.gitService.getTrackingBranch.resolves()
      makeVcHandler(deps).setup()

      const result = await deps.requestHandlers[VcEvents.PUSH]({branch: 'feat/x'}, CLIENT_ID)

      expect(deps.gitService.push.calledOnce).to.be.true
      expect(result).to.deep.include({branch: 'feat/x'})
    })

    it('should push to custom branch when specified and tracking exists', async () => {
      const deps = makeDeps(sandbox, projectPath)
      deps.gitService.isInitialized.resolves(true)
      deps.gitService.listRemotes.resolves([{remote: 'origin', url: 'https://example.com/repo.git'}])
      deps.gitService.log.resolves([
        {author: {email: 'a@b.com', name: 'A'}, message: 'init', sha: 'abc', timestamp: new Date()},
      ])
      deps.gitService.push.resolves({success: true})
      deps.gitService.getTrackingBranch.resolves({remote: 'origin', remoteBranch: 'feat/x'})
      makeVcHandler(deps).setup()

      const result = await deps.requestHandlers[VcEvents.PUSH]({branch: 'feat/x'}, CLIENT_ID)

      expect(deps.gitService.push.firstCall.args[0]).to.deep.include({branch: 'feat/x'})
      expect(result).to.deep.include({alreadyUpToDate: false, branch: 'feat/x'})
    })

    it('should throw VcError NO_REMOTE when no remote configured', async () => {
      const deps = makeDeps(sandbox, projectPath)
      deps.gitService.isInitialized.resolves(true)
      deps.gitService.listRemotes.resolves([])
      makeVcHandler(deps).setup()

      try {
        await deps.requestHandlers[VcEvents.PUSH]({}, CLIENT_ID)
        expect.fail('Expected error')
      } catch (error) {
        expect(error).to.be.instanceOf(VcError)
        if (error instanceof VcError) {
          expect(error.code).to.equal(VcErrorCode.NO_REMOTE)
          expect(error.message).to.include('No remote configured.')
          expect(error.message).to.include('brv vc push -u origin main')
          expect(error.message).to.include('https://test-app.byterover.dev')
        }
      }
    })

    it('should throw VcError NOTHING_TO_PUSH when repo has no commits', async () => {
      const deps = makeDeps(sandbox, projectPath)
      deps.gitService.isInitialized.resolves(true)
      deps.gitService.listRemotes.resolves([{remote: 'origin', url: 'https://example.com/repo.git'}])
      deps.gitService.log.resolves([])
      makeVcHandler(deps).setup()

      try {
        await deps.requestHandlers[VcEvents.PUSH]({}, CLIENT_ID)
        expect.fail('Expected error')
      } catch (error) {
        expect(error).to.be.instanceOf(VcError)
        if (error instanceof VcError) {
          expect(error.code).to.equal(VcErrorCode.NOTHING_TO_PUSH)
        }
      }
    })

    it('should throw VcError NON_FAST_FORWARD on non-fast-forward rejection', async () => {
      const deps = makeDeps(sandbox, projectPath)
      deps.gitService.isInitialized.resolves(true)
      deps.gitService.listRemotes.resolves([{remote: 'origin', url: 'https://example.com/repo.git'}])
      deps.gitService.log.resolves([
        {author: {email: 'a@b.com', name: 'A'}, message: 'init', sha: 'abc', timestamp: new Date()},
      ])
      deps.gitService.push.resolves({reason: 'non_fast_forward', success: false})
      deps.gitService.getTrackingBranch.resolves({remote: 'origin', remoteBranch: 'main'})
      makeVcHandler(deps).setup()

      try {
        await deps.requestHandlers[VcEvents.PUSH]({}, CLIENT_ID)
        expect.fail('Expected error')
      } catch (error) {
        expect(error).to.be.instanceOf(VcError)
        if (error instanceof VcError) {
          expect(error.code).to.equal(VcErrorCode.NON_FAST_FORWARD)
        }
      }
    })

    it('should throw VcError GIT_NOT_INITIALIZED when git not initialized', async () => {
      const deps = makeDeps(sandbox, projectPath)
      deps.gitService.isInitialized.resolves(false)
      makeVcHandler(deps).setup()

      try {
        await deps.requestHandlers[VcEvents.PUSH]({}, CLIENT_ID)
        expect.fail('Expected error')
      } catch (error) {
        expect(error).to.be.instanceOf(VcError)
        if (error instanceof VcError) {
          expect(error.code).to.equal(VcErrorCode.GIT_NOT_INITIALIZED)
        }
      }
    })

    it('should throw NotAuthenticatedError when token is missing before checking remotes', async () => {
      const deps = makeDeps(sandbox, projectPath)
      deps.gitService.isInitialized.resolves(true)
      deps.gitService.listRemotes.resolves([{remote: 'origin', url: 'https://example.com/repo.git'}])
      deps.tokenStore.load.resolves()
      makeVcHandler(deps).setup()

      try {
        await deps.requestHandlers[VcEvents.PUSH]({}, CLIENT_ID)
        expect.fail('Expected error')
      } catch (error) {
        expect(error).to.be.instanceOf(NotAuthenticatedError)
        // listRemotes should NOT have been called — auth blocks first
        expect(deps.gitService.listRemotes.called).to.be.false
      }
    })

    it('should throw VcError AUTH_FAILED when gitService.push throws GitAuthError', async () => {
      const deps = makeDeps(sandbox, projectPath)
      deps.gitService.isInitialized.resolves(true)
      deps.gitService.listRemotes.resolves([{remote: 'origin', url: 'https://example.com/repo.git'}])
      deps.gitService.log.resolves([
        {author: {email: 'a@b.com', name: 'A'}, message: 'init', sha: 'abc', timestamp: new Date()},
      ])
      deps.gitService.push.rejects(new GitAuthError())
      deps.gitService.getTrackingBranch.resolves({remote: 'origin', remoteBranch: 'main'})
      makeVcHandler(deps).setup()

      try {
        await deps.requestHandlers[VcEvents.PUSH]({}, CLIENT_ID)
        expect.fail('Expected error')
      } catch (error) {
        expect(error).to.be.instanceOf(VcError)
        if (error instanceof VcError) {
          expect(error.code).to.equal(VcErrorCode.AUTH_FAILED)
        }
      }
    })

    it('should throw VcError PUSH_FAILED for unknown errors from gitService.push', async () => {
      const deps = makeDeps(sandbox, projectPath)
      deps.gitService.isInitialized.resolves(true)
      deps.gitService.listRemotes.resolves([{remote: 'origin', url: 'https://example.com/repo.git'}])
      deps.gitService.log.resolves([
        {author: {email: 'a@b.com', name: 'A'}, message: 'init', sha: 'abc', timestamp: new Date()},
      ])
      deps.gitService.push.rejects(new Error('Network timeout'))
      deps.gitService.getTrackingBranch.resolves({remote: 'origin', remoteBranch: 'main'})
      makeVcHandler(deps).setup()

      try {
        await deps.requestHandlers[VcEvents.PUSH]({}, CLIENT_ID)
        expect.fail('Expected error')
      } catch (error) {
        expect(error).to.be.instanceOf(VcError)
        if (error instanceof VcError) {
          expect(error.code).to.equal(VcErrorCode.PUSH_FAILED)
        }
      }
    })

    it('should throw VcError NETWORK_ERROR when push fails with HttpError', async () => {
      const deps = makeDeps(sandbox, projectPath)
      deps.gitService.isInitialized.resolves(true)
      deps.gitService.listRemotes.resolves([{remote: 'origin', url: 'https://example.com/repo.git'}])
      deps.gitService.log.resolves([
        {author: {email: 'a@b.com', name: 'A'}, message: 'init', sha: 'abc', timestamp: new Date()},
      ])
      const httpError = Object.assign(new Error('HTTP Error: 500 Internal Server Error'), {code: 'HttpError'})
      deps.gitService.push.rejects(httpError)
      deps.gitService.getTrackingBranch.resolves({remote: 'origin', remoteBranch: 'main'})
      makeVcHandler(deps).setup()

      try {
        await deps.requestHandlers[VcEvents.PUSH]({}, CLIENT_ID)
        expect.fail('Expected error')
      } catch (error) {
        expect(error).to.be.instanceOf(VcError)
        if (error instanceof VcError) {
          expect(error.code).to.equal(VcErrorCode.NETWORK_ERROR)
          expect(error.message).to.equal('HTTP Error: 500 Internal Server Error')
        }
      }
    })

    it('should throw VcError INVALID_REF when push fails with NotFoundError', async () => {
      const deps = makeDeps(sandbox, projectPath)
      deps.gitService.isInitialized.resolves(true)
      deps.gitService.listRemotes.resolves([{remote: 'origin', url: 'https://example.com/repo.git'}])
      deps.gitService.log.resolves([
        {author: {email: 'a@b.com', name: 'A'}, message: 'init', sha: 'abc', timestamp: new Date()},
      ])
      const notFoundError = Object.assign(new Error('Could not find ref "refs/heads/nonexistent"'), {
        code: 'NotFoundError',
      })
      deps.gitService.push.rejects(notFoundError)
      deps.gitService.getTrackingBranch.resolves({remote: 'origin', remoteBranch: 'main'})
      makeVcHandler(deps).setup()

      try {
        await deps.requestHandlers[VcEvents.PUSH]({}, CLIENT_ID)
        expect.fail('Expected error')
      } catch (error) {
        expect(error).to.be.instanceOf(VcError)
        if (error instanceof VcError) {
          expect(error.code).to.equal(VcErrorCode.INVALID_REF)
          expect(error.message).to.include('nonexistent')
        }
      }
    })

    it('should push to active branch from getCurrentBranch when tracking exists', async () => {
      const deps = makeDeps(sandbox, projectPath)
      deps.gitService.isInitialized.resolves(true)
      deps.gitService.listRemotes.resolves([{remote: 'origin', url: 'https://example.com/repo.git'}])
      deps.gitService.log.resolves([
        {author: {email: 'a@b.com', name: 'A'}, message: 'init', sha: 'abc', timestamp: new Date()},
      ])
      deps.gitService.getCurrentBranch.resolves('feat/my-feature')
      deps.gitService.getTrackingBranch.resolves({remote: 'origin', remoteBranch: 'feat/my-feature'})
      deps.gitService.push.resolves({success: true})
      makeVcHandler(deps).setup()

      const result = await deps.requestHandlers[VcEvents.PUSH]({}, CLIENT_ID)

      expect(deps.gitService.push.firstCall.args[0]).to.deep.include({branch: 'feat/my-feature'})
      expect(result).to.deep.include({alreadyUpToDate: false, branch: 'feat/my-feature'})
    })

    it('should throw VcError NO_UPSTREAM when getCurrentBranch returns undefined and no tracking', async () => {
      const deps = makeDeps(sandbox, projectPath)
      deps.gitService.isInitialized.resolves(true)
      deps.gitService.listRemotes.resolves([{remote: 'origin', url: 'https://example.com/repo.git'}])
      deps.gitService.log.resolves([
        {author: {email: 'a@b.com', name: 'A'}, message: 'init', sha: 'abc', timestamp: new Date()},
      ])
      deps.gitService.getCurrentBranch.resolves()
      deps.gitService.getTrackingBranch.resolves()
      makeVcHandler(deps).setup()

      try {
        await deps.requestHandlers[VcEvents.PUSH]({}, CLIENT_ID)
        expect.fail('Expected error')
      } catch (error) {
        expect(error).to.be.instanceOf(VcError)
        if (error instanceof VcError) {
          expect(error.code).to.equal(VcErrorCode.NO_UPSTREAM)
          expect(error.message).to.include('brv vc push -u origin main')
        }
      }

      expect(deps.gitService.push.called).to.be.false
    })

    it('should ignore empty/whitespace branch and use current branch instead', async () => {
      const deps = makeDeps(sandbox, projectPath)
      deps.gitService.isInitialized.resolves(true)
      deps.gitService.listRemotes.resolves([{remote: 'origin', url: 'https://example.com/repo.git'}])
      deps.gitService.log.resolves([
        {author: {email: 'a@b.com', name: 'A'}, message: 'init', sha: 'abc', timestamp: new Date()},
      ])
      deps.gitService.getCurrentBranch.resolves('develop')
      deps.gitService.getTrackingBranch.resolves({remote: 'origin', remoteBranch: 'develop'})
      deps.gitService.push.resolves({success: true})
      makeVcHandler(deps).setup()

      const result = await deps.requestHandlers[VcEvents.PUSH]({branch: '   '}, CLIENT_ID)

      expect(deps.gitService.push.firstCall.args[0]).to.deep.include({branch: 'develop'})
      expect(result).to.deep.include({alreadyUpToDate: false, branch: 'develop'})
    })

    it('should throw VcError INVALID_BRANCH_NAME for invalid branch names', async () => {
      const deps = makeDeps(sandbox, projectPath)
      deps.gitService.isInitialized.resolves(true)
      deps.gitService.listRemotes.resolves([{remote: 'origin', url: 'https://example.com/repo.git'}])
      deps.gitService.log.resolves([
        {author: {email: 'a@b.com', name: 'A'}, message: 'init', sha: 'abc', timestamp: new Date()},
      ])
      makeVcHandler(deps).setup()

      const invalidNames = ['-bad', 'feat..branch', 'has~tilde', 'has^caret', 'has:colon']
      await Promise.all(
        invalidNames.map(async (invalid) => {
          try {
            await deps.requestHandlers[VcEvents.PUSH]({branch: invalid}, CLIENT_ID)
            expect.fail(`Expected error for branch '${invalid}'`)
          } catch (error) {
            expect(error).to.be.instanceOf(VcError)
            if (error instanceof VcError) {
              expect(error.code).to.equal(VcErrorCode.INVALID_BRANCH_NAME)
              expect(error.message).to.include(invalid)
            }
          }
        }),
      )
    })

    it('should allow push -u without tracking (sets upstream after push)', async () => {
      const deps = makeDeps(sandbox, projectPath)
      deps.gitService.isInitialized.resolves(true)
      deps.gitService.listRemotes.resolves([{remote: 'origin', url: 'https://example.com/repo.git'}])
      deps.gitService.log.resolves([
        {author: {email: 'a@b.com', name: 'A'}, message: 'init', sha: 'abc', timestamp: new Date()},
      ])
      deps.gitService.push.resolves({success: true})
      deps.gitService.getTrackingBranch.resolves()
      makeVcHandler(deps).setup()

      const result = await deps.requestHandlers[VcEvents.PUSH]({setUpstream: true}, CLIENT_ID)

      expect(deps.gitService.push.calledOnce).to.be.true
      expect(deps.gitService.setTrackingBranch.calledOnce).to.be.true
      expect(result).to.deep.include({upstreamSet: true})
    })

    it('should not set upstream when tracking already exists', async () => {
      const deps = makeDeps(sandbox, projectPath)
      deps.gitService.isInitialized.resolves(true)
      deps.gitService.listRemotes.resolves([{remote: 'origin', url: 'https://example.com/repo.git'}])
      deps.gitService.log.resolves([
        {author: {email: 'a@b.com', name: 'A'}, message: 'init', sha: 'abc', timestamp: new Date()},
      ])
      deps.gitService.push.resolves({success: true})
      deps.gitService.getTrackingBranch.resolves({remote: 'origin', remoteBranch: 'main'})
      makeVcHandler(deps).setup()

      const result = await deps.requestHandlers[VcEvents.PUSH]({}, CLIENT_ID)

      expect(deps.gitService.setTrackingBranch.called).to.be.false
      expect(result).to.deep.include({upstreamSet: false})
    })

    it('should not call setTrackingBranch when setUpstream is not passed', async () => {
      const deps = makeDeps(sandbox, projectPath)
      deps.gitService.isInitialized.resolves(true)
      deps.gitService.listRemotes.resolves([{remote: 'origin', url: 'https://example.com/repo.git'}])
      deps.gitService.log.resolves([
        {author: {email: 'a@b.com', name: 'A'}, message: 'init', sha: 'abc', timestamp: new Date()},
      ])
      deps.gitService.push.resolves({success: true})
      deps.gitService.getTrackingBranch.resolves({remote: 'origin', remoteBranch: 'main'})
      makeVcHandler(deps).setup()

      await deps.requestHandlers[VcEvents.PUSH]({}, CLIENT_ID)

      expect(deps.gitService.setTrackingBranch.called).to.be.false
    })
  })

  describe('handlePull', () => {
    it('should pull from tracking branch when configured', async () => {
      const deps = makeDeps(sandbox, projectPath)
      deps.gitService.isInitialized.resolves(true)
      deps.gitService.listRemotes.resolves([{remote: 'origin', url: 'https://example.com/repo.git'}])
      deps.gitService.getTrackingBranch.resolves({remote: 'origin', remoteBranch: 'main'})
      deps.gitService.pull.resolves({alreadyUpToDate: false, success: true})
      makeVcHandler(deps).setup()

      const result = await deps.requestHandlers[VcEvents.PULL]({}, CLIENT_ID)

      expect(deps.gitService.pull.calledOnce).to.be.true
      expect(deps.gitService.pull.firstCall.args[0]).to.deep.include({branch: 'main', remote: 'origin'})
      expect(result).to.deep.include({alreadyUpToDate: false, branch: 'main'})
    })

    it('should throw NO_UPSTREAM when no tracking and no explicit branch', async () => {
      const deps = makeDeps(sandbox, projectPath)
      deps.gitService.isInitialized.resolves(true)
      deps.gitService.listRemotes.resolves([{remote: 'origin', url: 'https://example.com/repo.git'}])
      deps.gitService.getTrackingBranch.resolves()
      makeVcHandler(deps).setup()

      try {
        await deps.requestHandlers[VcEvents.PULL]({}, CLIENT_ID)
        expect.fail('Expected error')
      } catch (error) {
        expect(error).to.be.instanceOf(VcError)
        if (error instanceof VcError) {
          expect(error.code).to.equal(VcErrorCode.NO_UPSTREAM)
          expect(error.message).to.include('brv vc pull origin main')
          expect(error.message).to.include('brv vc branch --set-upstream-to origin/main')
          expect(error.message).to.not.include('pull -u')
        }
      }
    })

    it('should return alreadyUpToDate when no changes', async () => {
      const deps = makeDeps(sandbox, projectPath)
      deps.gitService.isInitialized.resolves(true)
      deps.gitService.listRemotes.resolves([{remote: 'origin', url: 'https://example.com/repo.git'}])
      deps.gitService.getTrackingBranch.resolves({remote: 'origin', remoteBranch: 'main'})
      deps.gitService.pull.resolves({alreadyUpToDate: true, success: true})
      makeVcHandler(deps).setup()

      const result = await deps.requestHandlers[VcEvents.PULL]({}, CLIENT_ID)

      expect(result).to.deep.include({alreadyUpToDate: true, branch: 'main'})
    })

    it('should return conflicts when pull has merge conflicts', async () => {
      const deps = makeDeps(sandbox, projectPath)
      deps.gitService.isInitialized.resolves(true)
      deps.gitService.listRemotes.resolves([{remote: 'origin', url: 'https://example.com/repo.git'}])
      deps.gitService.getTrackingBranch.resolves({remote: 'origin', remoteBranch: 'main'})
      deps.gitService.pull.resolves({conflicts: [{path: 'file.txt', type: 'both_modified'}], success: false})
      makeVcHandler(deps).setup()

      const result = (await deps.requestHandlers[VcEvents.PULL]({}, CLIENT_ID)) as IVcPullResponse
      expect(result.conflicts).to.deep.equal([{path: 'file.txt', type: 'both_modified'}])
      expect(result.branch).to.equal('main')
      expect(result.alreadyUpToDate).to.be.undefined
    })

    it('should throw VcError GIT_NOT_INITIALIZED when git not initialized', async () => {
      const deps = makeDeps(sandbox, projectPath)
      deps.gitService.isInitialized.resolves(false)
      makeVcHandler(deps).setup()

      try {
        await deps.requestHandlers[VcEvents.PULL]({}, CLIENT_ID)
        expect.fail('Expected error')
      } catch (error) {
        expect(error).to.be.instanceOf(VcError)
        if (error instanceof VcError) {
          expect(error.code).to.equal(VcErrorCode.GIT_NOT_INITIALIZED)
        }
      }
    })

    it('should throw NotAuthenticatedError when token is missing before checking remotes', async () => {
      const deps = makeDeps(sandbox, projectPath)
      deps.gitService.isInitialized.resolves(true)
      deps.gitService.listRemotes.resolves([{remote: 'origin', url: 'https://example.com/repo.git'}])
      deps.tokenStore.load.resolves()
      makeVcHandler(deps).setup()

      try {
        await deps.requestHandlers[VcEvents.PULL]({}, CLIENT_ID)
        expect.fail('Expected error')
      } catch (error) {
        expect(error).to.be.instanceOf(NotAuthenticatedError)
        expect(deps.gitService.listRemotes.called).to.be.false
      }
    })

    it('should throw VcError NO_REMOTE with pull hint when no remote configured', async () => {
      const deps = makeDeps(sandbox, projectPath)
      deps.gitService.isInitialized.resolves(true)
      deps.gitService.listRemotes.resolves([])
      makeVcHandler(deps).setup()

      try {
        await deps.requestHandlers[VcEvents.PULL]({}, CLIENT_ID)
        expect.fail('Expected error')
      } catch (error) {
        expect(error).to.be.instanceOf(VcError)
        if (error instanceof VcError) {
          expect(error.code).to.equal(VcErrorCode.NO_REMOTE)
          expect(error.message).to.include('No remote configured.')
          expect(error.message).to.include('brv vc pull origin main')
          expect(error.message).to.not.include('brv vc push')
        }
      }
    })

    it('should throw VcError AUTH_FAILED when gitService.pull throws GitAuthError', async () => {
      const deps = makeDeps(sandbox, projectPath)
      deps.gitService.isInitialized.resolves(true)
      deps.gitService.listRemotes.resolves([{remote: 'origin', url: 'https://example.com/repo.git'}])
      deps.gitService.pull.rejects(new GitAuthError())
      deps.gitService.getTrackingBranch.resolves({remote: 'origin', remoteBranch: 'main'})
      makeVcHandler(deps).setup()

      try {
        await deps.requestHandlers[VcEvents.PULL]({}, CLIENT_ID)
        expect.fail('Expected error')
      } catch (error) {
        expect(error).to.be.instanceOf(VcError)
        if (error instanceof VcError) {
          expect(error.code).to.equal(VcErrorCode.AUTH_FAILED)
        }
      }
    })

    it('should throw VcError MERGE_IN_PROGRESS when pull fails with unresolved merge conflicts GitError', async () => {
      const deps = makeDeps(sandbox, projectPath)
      deps.gitService.isInitialized.resolves(true)
      deps.gitService.listRemotes.resolves([{remote: 'origin', url: 'https://example.com/repo.git'}])
      deps.gitService.pull.rejects(new GitError('You have unresolved merge conflicts.'))
      deps.gitService.getTrackingBranch.resolves({remote: 'origin', remoteBranch: 'main'})
      makeVcHandler(deps).setup()

      try {
        await deps.requestHandlers[VcEvents.PULL]({}, CLIENT_ID)
        expect.fail('Expected error')
      } catch (error) {
        expect(error).to.be.instanceOf(VcError)
        if (error instanceof VcError) {
          expect(error.code).to.equal(VcErrorCode.MERGE_IN_PROGRESS)
          expect(error.message).to.equal('You have unresolved merge conflicts.')
        }
      }
    })

    it('should throw VcError UNCOMMITTED_CHANGES when pull fails with overwrite GitError', async () => {
      const deps = makeDeps(sandbox, projectPath)
      deps.gitService.isInitialized.resolves(true)
      deps.gitService.listRemotes.resolves([{remote: 'origin', url: 'https://example.com/repo.git'}])
      deps.gitService.pull.rejects(
        new GitError(
          'Your local changes would be overwritten by pull. Please commit or discard your changes before you pull.',
        ),
      )
      deps.gitService.getTrackingBranch.resolves({remote: 'origin', remoteBranch: 'main'})
      makeVcHandler(deps).setup()

      try {
        await deps.requestHandlers[VcEvents.PULL]({}, CLIENT_ID)
        expect.fail('Expected error')
      } catch (error) {
        expect(error).to.be.instanceOf(VcError)
        if (error instanceof VcError) {
          expect(error.code).to.equal(VcErrorCode.UNCOMMITTED_CHANGES)
          expect(error.message).to.include('would be overwritten')
        }
      }
    })

    it('should surface affected file paths in pull overwrite error', async () => {
      const deps = makeDeps(sandbox, projectPath)
      deps.gitService.isInitialized.resolves(true)
      deps.gitService.listRemotes.resolves([{remote: 'origin', url: 'https://example.com/repo.git'}])
      deps.gitService.pull.rejects(
        new GitError(
          'Your local changes to the following files would be overwritten by pull:\n' +
            '\ttracked.md\n' +
            '\tnotes/log.md\n' +
            'Please commit or discard your changes before you pull.',
        ),
      )
      deps.gitService.getTrackingBranch.resolves({remote: 'origin', remoteBranch: 'main'})
      makeVcHandler(deps).setup()

      try {
        await deps.requestHandlers[VcEvents.PULL]({}, CLIENT_ID)
        expect.fail('Expected error')
      } catch (error) {
        expect(error).to.be.instanceOf(VcError)
        if (error instanceof VcError) {
          expect(error.code).to.equal(VcErrorCode.UNCOMMITTED_CHANGES)
          expect(error.message).to.include('tracked.md')
          expect(error.message).to.include('notes/log.md')
        }
      }
    })

    it('should throw VcError UNRELATED_HISTORIES when pull fails with unrelated histories GitError', async () => {
      const deps = makeDeps(sandbox, projectPath)
      deps.gitService.isInitialized.resolves(true)
      deps.gitService.listRemotes.resolves([{remote: 'origin', url: 'https://example.com/repo.git'}])
      deps.gitService.pull.rejects(
        new GitError('Refusing to merge unrelated histories. Use --allow-unrelated-histories to force.'),
      )
      deps.gitService.getTrackingBranch.resolves({remote: 'origin', remoteBranch: 'main'})
      makeVcHandler(deps).setup()

      try {
        await deps.requestHandlers[VcEvents.PULL]({}, CLIENT_ID)
        expect.fail('Expected error')
      } catch (error) {
        expect(error).to.be.instanceOf(VcError)
        if (error instanceof VcError) {
          expect(error.code).to.equal(VcErrorCode.UNRELATED_HISTORIES)
          expect(error.message).to.include('unrelated histories')
        }
      }
    })

    it('should throw VcError NETWORK_ERROR when pull fails with HttpError', async () => {
      const deps = makeDeps(sandbox, projectPath)
      deps.gitService.isInitialized.resolves(true)
      deps.gitService.listRemotes.resolves([{remote: 'origin', url: 'https://example.com/repo.git'}])
      const httpError = Object.assign(new Error('HTTP Error: 502 Bad Gateway'), {code: 'HttpError'})
      deps.gitService.pull.rejects(httpError)
      deps.gitService.getTrackingBranch.resolves({remote: 'origin', remoteBranch: 'main'})
      makeVcHandler(deps).setup()

      try {
        await deps.requestHandlers[VcEvents.PULL]({}, CLIENT_ID)
        expect.fail('Expected error')
      } catch (error) {
        expect(error).to.be.instanceOf(VcError)
        if (error instanceof VcError) {
          expect(error.code).to.equal(VcErrorCode.NETWORK_ERROR)
          expect(error.message).to.equal('HTTP Error: 502 Bad Gateway')
        }
      }
    })

    it('should throw VcError PULL_FAILED with original message for unknown errors', async () => {
      const deps = makeDeps(sandbox, projectPath)
      deps.gitService.isInitialized.resolves(true)
      deps.gitService.listRemotes.resolves([{remote: 'origin', url: 'https://example.com/repo.git'}])
      deps.gitService.pull.rejects(new Error('HTTP Error: 500 Internal Server Error'))
      deps.gitService.getTrackingBranch.resolves({remote: 'origin', remoteBranch: 'main'})
      makeVcHandler(deps).setup()

      try {
        await deps.requestHandlers[VcEvents.PULL]({}, CLIENT_ID)
        expect.fail('Expected error')
      } catch (error) {
        expect(error).to.be.instanceOf(VcError)
        if (error instanceof VcError) {
          expect(error.code).to.equal(VcErrorCode.PULL_FAILED)
          expect(error.message).to.equal('HTTP Error: 500 Internal Server Error')
        }
      }
    })

    it('should pull from tracking branch when config exists', async () => {
      const deps = makeDeps(sandbox, projectPath)
      deps.gitService.isInitialized.resolves(true)
      deps.gitService.listRemotes.resolves([{remote: 'origin', url: 'https://example.com/repo.git'}])
      deps.gitService.getCurrentBranch.resolves('feat/x')
      deps.gitService.getTrackingBranch.resolves({remote: 'origin', remoteBranch: 'develop'})
      deps.gitService.pull.resolves({alreadyUpToDate: false, success: true})
      makeVcHandler(deps).setup()

      const result = await deps.requestHandlers[VcEvents.PULL]({}, CLIENT_ID)

      expect(deps.gitService.pull.firstCall.args[0]).to.deep.include({branch: 'develop', remote: 'origin'})
      expect(result).to.deep.include({branch: 'develop'})
    })

    it('should throw NO_UPSTREAM when no tracking config and no explicit branch', async () => {
      const deps = makeDeps(sandbox, projectPath)
      deps.gitService.isInitialized.resolves(true)
      deps.gitService.listRemotes.resolves([{remote: 'origin', url: 'https://example.com/repo.git'}])
      deps.gitService.getCurrentBranch.resolves('feat/x')
      deps.gitService.getTrackingBranch.resolves()
      makeVcHandler(deps).setup()

      try {
        await deps.requestHandlers[VcEvents.PULL]({}, CLIENT_ID)
        expect.fail('Expected error')
      } catch (error) {
        expect(error).to.be.instanceOf(VcError)
        if (error instanceof VcError) {
          expect(error.code).to.equal(VcErrorCode.NO_UPSTREAM)
          expect(error.message).to.include('brv vc pull origin feat/x')
          expect(error.message).to.include('brv vc branch --set-upstream-to origin/feat/x')
          expect(error.message).to.not.include('pull -u')
        }
      }
    })
  })

  describe('handleStatus — tracking branch', () => {
    it('should include ahead/behind when tracking branch exists', async () => {
      const deps = makeDeps(sandbox, projectPath)
      deps.gitService.isInitialized.resolves(true)
      deps.gitService.getCurrentBranch.resolves('main')
      deps.gitService.status.resolves({files: [], isClean: true})
      deps.gitService.getTrackingBranch.resolves({remote: 'origin', remoteBranch: 'main'})
      deps.gitService.getAheadBehind.resolves({ahead: 3, behind: 1})
      makeVcHandler(deps).setup()

      const result = await deps.requestHandlers[VcEvents.STATUS]({}, CLIENT_ID)

      expect(result).to.deep.include({
        ahead: 3,
        behind: 1,
        branch: 'main',
        trackingBranch: 'origin/main',
      })
    })

    it('should omit tracking info when no tracking config', async () => {
      const deps = makeDeps(sandbox, projectPath)
      deps.gitService.isInitialized.resolves(true)
      deps.gitService.getCurrentBranch.resolves('main')
      deps.gitService.status.resolves({files: [], isClean: true})
      deps.gitService.getTrackingBranch.resolves()
      makeVcHandler(deps).setup()

      const result = await deps.requestHandlers[VcEvents.STATUS]({}, CLIENT_ID)

      expect(result).to.have.property('branch', 'main')
      expect(result).to.have.property('trackingBranch', undefined)
      expect(result).to.have.property('ahead', undefined)
      expect(result).to.have.property('behind', undefined)
    })
  })

  describe('handleLog', () => {
    it('should return commits for current branch', async () => {
      const deps = makeDeps(sandbox, projectPath)
      deps.gitService.isInitialized.resolves(true)
      deps.gitService.getCurrentBranch.resolves('main')
      deps.gitService.log.resolves([
        {
          author: {email: 'test@example.com', name: 'Test User'},
          message: 'feat: something',
          sha: 'abc123',
          timestamp: new Date('2024-01-01'),
        },
      ])
      makeVcHandler(deps).setup()

      const result = await deps.requestHandlers[VcEvents.LOG]({all: false, limit: 10}, CLIENT_ID)

      expect(result).to.deep.equal({
        commits: [
          {
            author: {email: 'test@example.com', name: 'Test User'},
            message: 'feat: something',
            sha: 'abc123',
            timestamp: new Date('2024-01-01').toISOString(),
          },
        ],
        currentBranch: 'main',
      })
    })

    it('should throw VcError GIT_NOT_INITIALIZED when git not initialized', async () => {
      const deps = makeDeps(sandbox, projectPath)
      deps.gitService.isInitialized.resolves(false)
      makeVcHandler(deps).setup()

      try {
        await deps.requestHandlers[VcEvents.LOG]({all: false, limit: 10}, CLIENT_ID)
        expect.fail('Expected error')
      } catch (error) {
        expect(error).to.be.instanceOf(VcError)
        if (error instanceof VcError) {
          expect(error.code).to.equal(VcErrorCode.GIT_NOT_INITIALIZED)
        }
      }
    })

    it('should throw VcError NO_COMMITS when repo has no commits', async () => {
      const deps = makeDeps(sandbox, projectPath)
      deps.gitService.isInitialized.resolves(true)
      deps.gitService.log.resolves([])
      deps.gitService.getCurrentBranch.resolves('main')
      makeVcHandler(deps).setup()

      try {
        await deps.requestHandlers[VcEvents.LOG]({all: false, limit: 10}, CLIENT_ID)
        expect.fail('Expected error')
      } catch (error) {
        expect(error).to.be.instanceOf(VcError)
        if (error instanceof VcError) {
          expect(error.code).to.equal(VcErrorCode.NO_COMMITS)
        }
      }
    })

    it('should throw VcError BRANCH_NOT_FOUND when ref branch does not exist', async () => {
      const deps = makeDeps(sandbox, projectPath)
      deps.gitService.isInitialized.resolves(true)
      deps.gitService.getCurrentBranch.resolves('main')
      deps.gitService.log.resolves([
        {author: {email: 'a@b.com', name: 'A'}, message: 'init', sha: 'abc', timestamp: new Date()},
      ])
      deps.gitService.listBranches.resolves([{name: 'main'}])
      makeVcHandler(deps).setup()

      try {
        await deps.requestHandlers[VcEvents.LOG]({all: false, limit: 10, ref: 'nonexistent'}, CLIENT_ID)
        expect.fail('Expected error')
      } catch (error) {
        expect(error).to.be.instanceOf(VcError)
        if (error instanceof VcError) {
          expect(error.code).to.equal(VcErrorCode.BRANCH_NOT_FOUND)
        }
      }
    })

    it('should return deduplicated commits from all branches when all=true', async () => {
      const deps = makeDeps(sandbox, projectPath)
      deps.gitService.isInitialized.resolves(true)
      deps.gitService.getCurrentBranch.resolves('main')
      deps.gitService.listBranches.resolves([
        {isCurrent: true, name: 'main'},
        {isCurrent: false, name: 'feature'},
      ])

      const commit1 = {
        author: {email: 'a@example.com', name: 'A'},
        message: 'first',
        sha: 'sha1',
        timestamp: new Date('2024-01-02'),
      }
      const commit2 = {
        author: {email: 'b@example.com', name: 'B'},
        message: 'second',
        sha: 'sha2',
        timestamp: new Date('2024-01-01'),
      }
      // hasCommits check (depth: 1) must return at least one commit
      deps.gitService.log.resolves([commit1])
      // main returns both commits; feature returns commit1 (duplicate) + commit2
      deps.gitService.log.withArgs({directory: deps.contextTreeDirPath, ref: 'main'}).resolves([commit1, commit2])
      deps.gitService.log.withArgs({directory: deps.contextTreeDirPath, ref: 'feature'}).resolves([commit1])
      makeVcHandler(deps).setup()

      const result = (await deps.requestHandlers[VcEvents.LOG]({all: true, limit: 10}, CLIENT_ID)) as {
        commits: Array<{sha: string}>
        currentBranch: string
      }

      // Should deduplicate: sha1 appears in both branches, should appear only once
      expect(result.commits).to.have.length(2)
      expect(result.commits[0].sha).to.equal('sha1') // newer timestamp first
      expect(result.commits[1].sha).to.equal('sha2')
      expect(result.currentBranch).to.equal('main')
    })

    it('should respect limit when all=true', async () => {
      const deps = makeDeps(sandbox, projectPath)
      deps.gitService.isInitialized.resolves(true)
      deps.gitService.getCurrentBranch.resolves('main')
      deps.gitService.listBranches.resolves([{isCurrent: true, name: 'main'}])

      const commits = Array.from({length: 5}, (_, i) => ({
        author: {email: 'a@example.com', name: 'A'},
        message: `commit ${i}`,
        sha: `sha${i}`,
        timestamp: new Date(2024, 0, 5 - i),
      }))
      deps.gitService.log.resolves(commits)
      makeVcHandler(deps).setup()

      const result = (await deps.requestHandlers[VcEvents.LOG]({all: true, limit: 3}, CLIENT_ID)) as {
        commits: unknown[]
      }

      expect(result.commits).to.have.length(3)
    })
  })

  // ---- handleClone ----

  describe('handleClone', () => {
    const validToken = new AuthToken({
      accessToken: 'test-acc',
      expiresAt: new Date(Date.now() + 3_600_000),
      refreshToken: 'test-ref',
      sessionKey: 'sess-123',
      userEmail: 'test@example.com',
      userId: 'u1',
    })

    it('should clone with name-based URL', async () => {
      const deps = makeDeps(sandbox, projectPath)
      deps.gitService.isInitialized.resolves(false)
      deps.tokenStore.load.resolves(validToken)
      stubDefaultTeamSpace(deps)
      makeVcHandler(deps).setup()

      const result = await invoke<{gitDir: string}>(deps, VcEvents.CLONE, {
        url: 'https://byterover.dev/teambao1/test-space.git',
      })

      expect(result.gitDir).to.include('.git')
      expect(deps.gitService.clone.calledOnce).to.be.true
      const cloneArgs = deps.gitService.clone.firstCall.args[0]
      expect(cloneArgs.url).to.equal('https://byterover.dev/teambao1/test-space.git')
    })

    it('should strip credentials from URL when cloning', async () => {
      const deps = makeDeps(sandbox, projectPath)
      deps.gitService.isInitialized.resolves(false)
      deps.tokenStore.load.resolves(validToken)
      stubDefaultTeamSpace(deps)
      makeVcHandler(deps).setup()

      const fullUrl = 'https://uid:key@byterover.dev/teambao1/test-space.git'
      await invoke(deps, VcEvents.CLONE, {url: fullUrl})

      // Credentials stripped — clean URL used for clone (auth via headers)
      const cloneArgs = deps.gitService.clone.firstCall.args[0]
      expect(cloneArgs.url).to.equal('https://byterover.dev/teambao1/test-space.git')
    })

    it('should clone with names in URL by resolving team/space names', async () => {
      const deps = makeDeps(sandbox, projectPath)
      deps.gitService.isInitialized.resolves(false)
      deps.tokenStore.load.resolves(validToken)
      deps.teamService.getTeams.resolves({
        teams: [
          {displayName: 'Teambao1', id: 'tid-1', isActive: true, isDefault: false, name: 'Teambao1', slug: 'teambao1'},
        ],
        total: 1,
      })
      deps.spaceService.getSpaces.resolves({
        spaces: [
          {
            id: 'sid-1',
            isDefault: false,
            name: 'test-git',
            slug: 'test-git',
            teamId: 'tid-1',
            teamName: 'Teambao1',
            teamSlug: 'teambao1',
          },
        ],
        total: 1,
      })
      makeVcHandler(deps).setup()

      const result = await invoke<{gitDir: string; spaceName?: string; teamName?: string}>(deps, VcEvents.CLONE, {
        url: 'https://byterover.dev/Teambao1/test-git.git',
      })

      expect(result.gitDir).to.include('.git')
      expect(result.teamName).to.equal('Teambao1')
      expect(result.spaceName).to.equal('test-git')
      const cloneArgs = deps.gitService.clone.firstCall.args[0]
      expect(cloneArgs.url).to.equal('https://byterover.dev/teambao1/test-git.git')
    })

    it('should clone with user-facing .git URL by resolving team/space names', async () => {
      const deps = makeDeps(sandbox, projectPath)
      deps.gitService.isInitialized.resolves(false)
      deps.tokenStore.load.resolves(validToken)
      deps.teamService.getTeams.resolves({
        teams: [{displayName: 'Acme', id: 'tid-1', isActive: true, isDefault: false, name: 'acme', slug: 'acme'}],
        total: 1,
      })
      deps.spaceService.getSpaces.resolves({
        spaces: [
          {
            id: 'sid-1',
            isDefault: false,
            name: 'project',
            slug: 'project',
            teamId: 'tid-1',
            teamName: 'acme',
            teamSlug: 'acme',
          },
        ],
        total: 1,
      })
      makeVcHandler(deps).setup()

      const result = await invoke<{gitDir: string; spaceName?: string; teamName?: string}>(deps, VcEvents.CLONE, {
        url: 'https://byterover.dev/acme/project.git',
      })

      expect(result.gitDir).to.include('.git')
      expect(result.teamName).to.equal('acme')
      expect(result.spaceName).to.equal('project')
      const cloneArgs = deps.gitService.clone.firstCall.args[0]
      expect(cloneArgs.url).to.equal('https://byterover.dev/acme/project.git')
    })

    it('should resolve team name case-insensitively in cogit-style URL', async () => {
      const deps = makeDeps(sandbox, projectPath)
      deps.gitService.isInitialized.resolves(false)
      deps.tokenStore.load.resolves(validToken)
      deps.teamService.getTeams.resolves({
        teams: [
          {displayName: 'Teambao1', id: 'tid-1', isActive: true, isDefault: false, name: 'Teambao1', slug: 'teambao1'},
        ],
        total: 1,
      })
      deps.spaceService.getSpaces.resolves({
        spaces: [
          {
            id: 'sid-1',
            isDefault: false,
            name: 'test-git',
            slug: 'test-git',
            teamId: 'tid-1',
            teamName: 'Teambao1',
            teamSlug: 'teambao1',
          },
        ],
        total: 1,
      })
      makeVcHandler(deps).setup()

      const result = await invoke<{gitDir: string; spaceName?: string; teamName?: string}>(deps, VcEvents.CLONE, {
        url: 'https://byterover.dev/teambao1/TEST-GIT.git',
      })

      expect(result.teamName).to.equal('Teambao1')
      expect(result.spaceName).to.equal('test-git')
    })

    it('should resolve team/space name case-insensitively in user-facing .git URL', async () => {
      const deps = makeDeps(sandbox, projectPath)
      deps.gitService.isInitialized.resolves(false)
      deps.tokenStore.load.resolves(validToken)
      deps.teamService.getTeams.resolves({
        teams: [{displayName: 'Acme', id: 'tid-1', isActive: true, isDefault: false, name: 'acme', slug: 'acme'}],
        total: 1,
      })
      deps.spaceService.getSpaces.resolves({
        spaces: [
          {
            id: 'sid-1',
            isDefault: false,
            name: 'project',
            slug: 'project',
            teamId: 'tid-1',
            teamName: 'acme',
            teamSlug: 'acme',
          },
        ],
        total: 1,
      })
      makeVcHandler(deps).setup()

      const result = await invoke<{gitDir: string; spaceName?: string; teamName?: string}>(deps, VcEvents.CLONE, {
        url: 'https://byterover.dev/ACME/PROJECT.git',
      })

      expect(result.teamName).to.equal('acme')
      expect(result.spaceName).to.equal('project')
    })

    it('should throw when user-facing .git URL team not found', async () => {
      const deps = makeDeps(sandbox, projectPath)
      deps.gitService.isInitialized.resolves(false)
      deps.tokenStore.load.resolves(validToken)
      deps.teamService.getTeams.resolves({teams: [], total: 0})
      makeVcHandler(deps).setup()

      try {
        await invoke(deps, VcEvents.CLONE, {url: 'https://byterover.dev/unknown/project.git'})
        expect.fail('Expected error')
      } catch (error) {
        expect(error).to.be.instanceOf(VcError)
        if (error instanceof VcError) {
          expect(error.code).to.equal(VcErrorCode.INVALID_REMOTE_URL)
          expect(error.message).to.include('unknown')
        }
      }
    })

    it('should throw when user-facing .git URL space not found', async () => {
      const deps = makeDeps(sandbox, projectPath)
      deps.gitService.isInitialized.resolves(false)
      deps.tokenStore.load.resolves(validToken)
      deps.teamService.getTeams.resolves({
        teams: [{displayName: 'Acme', id: 'tid-1', isActive: true, isDefault: false, name: 'acme', slug: 'acme'}],
        total: 1,
      })
      deps.spaceService.getSpaces.resolves({spaces: [], total: 0})
      makeVcHandler(deps).setup()

      try {
        await invoke(deps, VcEvents.CLONE, {url: 'https://byterover.dev/acme/missing.git'})
        expect.fail('Expected error')
      } catch (error) {
        expect(error).to.be.instanceOf(VcError)
        if (error instanceof VcError) {
          expect(error.code).to.equal(VcErrorCode.INVALID_REMOTE_URL)
          expect(error.message).to.include('missing')
        }
      }
    })

    it('should match team by slug when name differs from URL segment', async () => {
      const deps = makeDeps(sandbox, projectPath)
      deps.gitService.isInitialized.resolves(false)
      deps.tokenStore.load.resolves(validToken)
      deps.teamService.getTeams.resolves({
        teams: [
          {
            displayName: 'Test Release 2.0.0',
            id: 'tid-1',
            isActive: true,
            isDefault: false,
            name: 'test-release-2.0.0',
            slug: 'test-release-2-0-0',
          },
        ],
        total: 1,
      })
      deps.spaceService.getSpaces.resolves({
        spaces: [
          {
            id: 'sid-1',
            isDefault: false,
            name: 'normal-space',
            slug: 'normal-space',
            teamId: 'tid-1',
            teamName: 'test-release-2.0.0',
            teamSlug: 'test-release-2-0-0',
          },
        ],
        total: 1,
      })
      makeVcHandler(deps).setup()

      const result = await invoke<{gitDir: string; spaceName?: string; teamName?: string}>(deps, VcEvents.CLONE, {
        url: 'https://byterover.dev/test-release-2-0-0/normal-space.git',
      })

      expect(result.teamName).to.equal('test-release-2.0.0')
      expect(result.spaceName).to.equal('normal-space')
      const cloneArgs = deps.gitService.clone.firstCall.args[0]
      expect(cloneArgs.url).to.equal('https://byterover.dev/test-release-2-0-0/normal-space.git')
    })

    it('should match space by slug when name differs from URL segment', async () => {
      const deps = makeDeps(sandbox, projectPath)
      deps.gitService.isInitialized.resolves(false)
      deps.tokenStore.load.resolves(validToken)
      deps.teamService.getTeams.resolves({
        teams: [{displayName: 'Acme', id: 'tid-1', isActive: true, isDefault: false, name: 'acme', slug: 'acme'}],
        total: 1,
      })
      deps.spaceService.getSpaces.resolves({
        spaces: [
          {
            id: 'sid-1',
            isDefault: false,
            name: 'my-space-v2.0',
            slug: 'my-space-v2-0',
            teamId: 'tid-1',
            teamName: 'acme',
            teamSlug: 'acme',
          },
        ],
        total: 1,
      })
      makeVcHandler(deps).setup()

      const result = await invoke<{gitDir: string; spaceName?: string; teamName?: string}>(deps, VcEvents.CLONE, {
        url: 'https://byterover.dev/acme/my-space-v2-0.git',
      })

      expect(result.spaceName).to.equal('my-space-v2.0')
      const cloneArgs = deps.gitService.clone.firstCall.args[0]
      expect(cloneArgs.url).to.equal('https://byterover.dev/acme/my-space-v2-0.git')
    })

    it('should throw NotAuthenticatedError when URL clone without auth (name resolution)', async () => {
      const deps = makeDeps(sandbox, projectPath)
      deps.gitService.isInitialized.resolves(false)
      deps.tokenStore.load.resolves()
      makeVcHandler(deps).setup()

      try {
        await invoke(deps, VcEvents.CLONE, {
          url: 'https://byterover.dev/TeamName/space-name.git',
        })
        expect.fail('Expected error')
      } catch (error) {
        expect(error).to.be.instanceOf(NotAuthenticatedError)
      }
    })

    it('should clone with spaceId/teamId (legacy space-picker flow)', async () => {
      const deps = makeDeps(sandbox, projectPath)
      deps.gitService.isInitialized.resolves(false)
      deps.tokenStore.load.resolves(validToken)
      makeVcHandler(deps).setup()

      const result = await invoke<{gitDir: string; spaceName?: string; teamName?: string}>(deps, VcEvents.CLONE, {
        spaceId: 'space-1',
        spaceName: 'my-space',
        teamId: 'team-1',
        teamName: 'my-team',
      })

      expect(result.gitDir).to.include('.git')
      expect(result.spaceName).to.equal('my-space')
      expect(result.teamName).to.equal('my-team')
      expect(deps.gitService.clone.calledOnce).to.be.true
    })

    it('should throw when neither URL nor spaceId provided', async () => {
      const deps = makeDeps(sandbox, projectPath)
      deps.gitService.isInitialized.resolves(false)
      makeVcHandler(deps).setup()

      try {
        await invoke(deps, VcEvents.CLONE, {})
        expect.fail('Expected error')
      } catch (error) {
        expect(error).to.be.instanceOf(VcError)
        if (error instanceof VcError) {
          expect(error.code).to.equal(VcErrorCode.INVALID_REMOTE_URL)
        }
      }
    })

    it('should throw ALREADY_INITIALIZED when repo is initialized and not empty', async () => {
      const deps = makeDeps(sandbox, projectPath)
      deps.gitService.isInitialized.resolves(true)
      deps.gitService.isEmptyRepository.resolves(false)
      makeVcHandler(deps).setup()

      try {
        await invoke(deps, VcEvents.CLONE, {
          url: 'https://byterover.dev/teambao1/test-space.git',
        })
        expect.fail('Expected error')
      } catch (error) {
        expect(error).to.be.instanceOf(VcError)
        if (error instanceof VcError) {
          expect(error.code).to.equal(VcErrorCode.ALREADY_INITIALIZED)
        }
      }
    })

    it('should allow clone when repo is empty (fresh auto-init)', async () => {
      const deps = makeDeps(sandbox, projectPath)
      deps.gitService.isInitialized.resolves(true)
      deps.gitService.isEmptyRepository.resolves(true)
      deps.tokenStore.load.resolves(validToken)
      stubDefaultTeamSpace(deps)
      const rmStub = sandbox.stub(fs.promises, 'rm').resolves()
      makeVcHandler(deps).setup()

      await invoke(deps, VcEvents.CLONE, {
        url: 'https://byterover.dev/teambao1/test-space.git',
      })

      expect(rmStub.calledWith(join(deps.contextTreeDirPath, '.git'))).to.be.true
      expect(deps.gitService.clone.calledOnce).to.be.true
    })

    it('should not check isEmptyRepository when not initialized', async () => {
      const deps = makeDeps(sandbox, projectPath)
      deps.gitService.isInitialized.resolves(false)
      deps.tokenStore.load.resolves(validToken)
      stubDefaultTeamSpace(deps)
      makeVcHandler(deps).setup()

      await invoke(deps, VcEvents.CLONE, {
        url: 'https://byterover.dev/teambao1/test-space.git',
      })

      expect(deps.gitService.isEmptyRepository.called).to.be.false
    })

    it('should complete clone successfully', async () => {
      const deps = makeDeps(sandbox, projectPath)
      deps.gitService.isInitialized.resolves(false)
      deps.tokenStore.load.resolves(validToken)
      stubDefaultTeamSpace(deps)
      makeVcHandler(deps).setup()

      const result = await invoke(deps, VcEvents.CLONE, {
        url: 'https://byterover.dev/teambao1/test-space.git',
      })

      expect(result).to.have.property('gitDir')
      expect(deps.gitService.clone.calledOnce).to.be.true
    })

    it('should throw VcError NETWORK_ERROR when clone fails with HttpError', async () => {
      const deps = makeDeps(sandbox, projectPath)
      deps.gitService.isInitialized.resolves(false)
      deps.tokenStore.load.resolves(validToken)
      stubDefaultTeamSpace(deps)
      const httpError = Object.assign(new Error('HTTP Error: 404 Not Found'), {code: 'HttpError'})
      deps.gitService.clone.rejects(httpError)
      makeVcHandler(deps).setup()

      try {
        await invoke(deps, VcEvents.CLONE, {
          url: 'https://byterover.dev/teambao1/test-space.git',
        })
        expect.fail('Expected error')
      } catch (error) {
        expect(error).to.be.instanceOf(VcError)
        if (error instanceof VcError) {
          expect(error.code).to.equal(VcErrorCode.NETWORK_ERROR)
          expect(error.message).to.equal('HTTP Error: 404 Not Found')
        }
      }
    })

    it('should throw VcError INVALID_REMOTE_URL when clone fails with NotFoundError', async () => {
      const deps = makeDeps(sandbox, projectPath)
      deps.gitService.isInitialized.resolves(false)
      deps.tokenStore.load.resolves(validToken)
      stubDefaultTeamSpace(deps)
      const notFoundError = Object.assign(new Error('Could not find repository'), {code: 'NotFoundError'})
      deps.gitService.clone.rejects(notFoundError)
      makeVcHandler(deps).setup()

      try {
        await invoke(deps, VcEvents.CLONE, {
          url: 'https://byterover.dev/teambao1/test-space.git',
        })
        expect.fail('Expected error')
      } catch (error) {
        expect(error).to.be.instanceOf(VcError)
        if (error instanceof VcError) {
          expect(error.code).to.equal(VcErrorCode.INVALID_REMOTE_URL)
          expect(error.message).to.include('Could not find repository')
        }
      }
    })
  })

  describe('vc:remote', () => {
    it('should register the vc:remote handler', () => {
      const deps = makeDeps(sandbox, projectPath)
      makeVcHandler(deps).setup()
      expect(deps.requestHandlers[VcEvents.REMOTE]).to.be.a('function')
    })

    it('should return undefined url when no remote configured (show)', async () => {
      const deps = makeDeps(sandbox, projectPath)
      deps.gitService.isInitialized.resolves(true)
      deps.gitService.getRemoteUrl.resolves()
      makeVcHandler(deps).setup()

      const result = await deps.requestHandlers[VcEvents.REMOTE]({subcommand: 'show'}, CLIENT_ID)
      expect(result).to.deep.equal({action: 'show', url: undefined})
    })

    it('should return masked url when remote is configured (show)', async () => {
      const deps = makeDeps(sandbox, projectPath)
      deps.gitService.isInitialized.resolves(true)
      deps.gitService.getRemoteUrl.resolves('https://user:secret@example.com/repo.git')
      makeVcHandler(deps).setup()

      const result = await deps.requestHandlers[VcEvents.REMOTE]({subcommand: 'show'}, CLIENT_ID)
      expect(result).to.deep.equal({action: 'show', url: 'https://user:***@example.com/repo.git'})
    })

    it('should strip credentials from URL and store clean URL on add', async () => {
      const deps = makeDeps(sandbox, projectPath)
      deps.gitService.isInitialized.resolves(true)
      deps.gitService.getRemoteUrl.resolves()
      const mockToken = new AuthToken({
        accessToken: 'test-acc',
        expiresAt: new Date(Date.now() + 3_600_000),
        refreshToken: 'test-ref',
        sessionKey: 'sess-123',
        userEmail: 'test@example.com',
        userId: 'u1',
      })
      deps.tokenStore.load.resolves(mockToken)
      stubDefaultTeamSpace(deps)
      makeVcHandler(deps).setup()

      const url = 'https://user:token@byterover.dev/teambao1/test-space.git'
      const expectedCleanUrl = 'https://byterover.dev/teambao1/test-space.git'
      const result = await deps.requestHandlers[VcEvents.REMOTE]({subcommand: 'add', url}, CLIENT_ID)
      expect(result).to.deep.equal({action: 'add', url: expectedCleanUrl})
      expect(deps.gitService.addRemote.calledOnce).to.be.true
      expect(deps.gitService.addRemote.firstCall.args[0]).to.include({remote: 'origin', url: expectedCleanUrl})
    })

    it('should resolve name-based URL and store clean URL on add', async () => {
      const deps = makeDeps(sandbox, projectPath)
      deps.gitService.isInitialized.resolves(true)
      deps.gitService.getRemoteUrl.resolves()
      const mockToken = new AuthToken({
        accessToken: 'test-acc',
        expiresAt: new Date(Date.now() + 3_600_000),
        refreshToken: 'test-ref',
        sessionKey: 'sess-123',
        userEmail: 'test@example.com',
        userId: 'u1',
      })
      deps.tokenStore.load.resolves(mockToken)
      stubDefaultTeamSpace(deps)
      makeVcHandler(deps).setup()

      const cleanUrl = 'https://byterover.dev/teambao1/test-space.git'
      const result = await invoke<{action: string; url: string}>(
        deps,
        VcEvents.REMOTE,
        {subcommand: 'add', url: cleanUrl},
        CLIENT_ID,
      )

      expect(result.action).to.equal('add')
      // Response URL is clean (no credentials)
      expect(result.url).to.equal(cleanUrl)
      // Stored URL is also clean
      const storedUrl = deps.gitService.addRemote.firstCall.args[0].url
      expect(storedUrl).to.equal(cleanUrl)
    })

    it('should resolve user-facing .git URL and store clean URL when adding remote', async () => {
      const deps = makeDeps(sandbox, projectPath)
      deps.gitService.isInitialized.resolves(true)
      deps.gitService.getRemoteUrl.resolves()
      const mockToken = new AuthToken({
        accessToken: 'test-acc',
        expiresAt: new Date(Date.now() + 3_600_000),
        refreshToken: 'test-ref',
        sessionKey: 'sess-123',
        userEmail: 'test@example.com',
        userId: 'u1',
      })
      deps.tokenStore.load.resolves(mockToken)
      deps.teamService.getTeams.resolves({
        teams: [{displayName: 'Acme', id: 'tid-1', isActive: true, isDefault: false, name: 'acme', slug: 'acme'}],
        total: 1,
      })
      deps.spaceService.getSpaces.resolves({
        spaces: [
          {
            id: 'sid-1',
            isDefault: false,
            name: 'project',
            slug: 'project',
            teamId: 'tid-1',
            teamName: 'acme',
            teamSlug: 'acme',
          },
        ],
        total: 1,
      })
      makeVcHandler(deps).setup()

      const result = await invoke<{action: string; url: string}>(
        deps,
        VcEvents.REMOTE,
        {subcommand: 'add', url: 'https://byterover.dev/acme/project.git'},
        CLIENT_ID,
      )

      expect(result.action).to.equal('add')
      const storedUrl = deps.gitService.addRemote.firstCall.args[0].url
      expect(storedUrl).to.equal('https://byterover.dev/acme/project.git')
    })

    it('should throw NotAuthenticatedError when adding remote without auth (name resolution)', async () => {
      const deps = makeDeps(sandbox, projectPath)
      deps.gitService.isInitialized.resolves(true)
      deps.gitService.getRemoteUrl.resolves()
      deps.tokenStore.load.resolves()
      makeVcHandler(deps).setup()

      try {
        await deps.requestHandlers[VcEvents.REMOTE](
          {subcommand: 'add', url: 'https://byterover.dev/TeamName/space-name.git'},
          CLIENT_ID,
        )
        expect.fail('Expected error')
      } catch (error) {
        expect(error).to.be.instanceOf(NotAuthenticatedError)
      }
    })

    it('should throw REMOTE_ALREADY_EXISTS when adding duplicate remote', async () => {
      const deps = makeDeps(sandbox, projectPath)
      deps.gitService.isInitialized.resolves(true)
      deps.gitService.getRemoteUrl.resolves('https://existing.com/repo.git')
      const mockToken = new AuthToken({
        accessToken: 'test-acc',
        expiresAt: new Date(Date.now() + 3_600_000),
        refreshToken: 'test-ref',
        sessionKey: 'sess-123',
        userEmail: 'test@example.com',
        userId: 'u1',
      })
      deps.tokenStore.load.resolves(mockToken)
      makeVcHandler(deps).setup()

      try {
        await deps.requestHandlers[VcEvents.REMOTE](
          {
            subcommand: 'add',
            url: 'https://byterover.dev/teambao1/test-space.git',
          },
          CLIENT_ID,
        )
        expect.fail('Expected error')
      } catch (error) {
        expect(error).to.be.instanceOf(VcError)
        if (error instanceof VcError) {
          expect(error.code).to.equal(VcErrorCode.REMOTE_ALREADY_EXISTS)
        }
      }
    })

    it('should call removeRemote + addRemote on set-url with clean URL', async () => {
      const deps = makeDeps(sandbox, projectPath)
      deps.gitService.isInitialized.resolves(true)
      const mockToken = new AuthToken({
        accessToken: 'test-acc',
        expiresAt: new Date(Date.now() + 3_600_000),
        refreshToken: 'test-ref',
        sessionKey: 'sess-123',
        userEmail: 'test@example.com',
        userId: 'u1',
      })
      deps.tokenStore.load.resolves(mockToken)
      stubDefaultTeamSpace(deps)
      makeVcHandler(deps).setup()

      const url = 'https://byterover.dev/teambao1/test-space.git'
      const result = await deps.requestHandlers[VcEvents.REMOTE]({subcommand: 'set-url', url}, CLIENT_ID)
      expect(result).to.deep.equal({action: 'set-url', url})
      expect(deps.gitService.removeRemote.calledOnce).to.be.true
      expect(deps.gitService.addRemote.calledOnce).to.be.true
      expect(deps.gitService.addRemote.firstCall.args[0]).to.include({remote: 'origin', url})
    })

    it('should throw GIT_NOT_INITIALIZED when git not initialized', async () => {
      const deps = makeDeps(sandbox, projectPath)
      deps.gitService.isInitialized.resolves(false)

      makeVcHandler(deps).setup()

      try {
        await deps.requestHandlers[VcEvents.REMOTE]({subcommand: 'show'}, CLIENT_ID)
        expect.fail('Expected error')
      } catch (error) {
        expect(error).to.be.instanceOf(VcError)
        if (error instanceof VcError) {
          expect(error.code).to.equal(VcErrorCode.GIT_NOT_INITIALIZED)
        }
      }
    })

    it('should throw INVALID_REMOTE_URL when url is missing for add', async () => {
      const deps = makeDeps(sandbox, projectPath)
      deps.gitService.isInitialized.resolves(true)
      makeVcHandler(deps).setup()

      try {
        await deps.requestHandlers[VcEvents.REMOTE]({subcommand: 'add'}, CLIENT_ID)
        expect.fail('Expected error')
      } catch (error) {
        expect(error).to.be.instanceOf(VcError)
        if (error instanceof VcError) {
          expect(error.code).to.equal(VcErrorCode.INVALID_REMOTE_URL)
        }
      }
    })

    it('should persist space/team to config on remote add with name-based URL', async () => {
      const deps = makeDeps(sandbox, projectPath)
      deps.gitService.isInitialized.resolves(true)
      deps.gitService.getRemoteUrl.resolves()
      const mockToken = new AuthToken({
        accessToken: 'test-acc',
        expiresAt: new Date(Date.now() + 3_600_000),
        refreshToken: 'test-ref',
        sessionKey: 'sess-123',
        userEmail: 'test@example.com',
        userId: 'u1',
      })
      deps.tokenStore.load.resolves(mockToken)
      deps.teamService.getTeams.resolves({
        teams: [{displayName: 'Acme', id: 'tid-1', isActive: true, isDefault: false, name: 'acme', slug: 'acme'}],
        total: 1,
      })
      deps.spaceService.getSpaces.resolves({
        spaces: [
          {
            id: 'sid-1',
            isDefault: false,
            name: 'project',
            slug: 'project',
            teamId: 'tid-1',
            teamName: 'acme',
            teamSlug: 'acme',
          },
        ],
        total: 1,
      })
      makeVcHandler(deps).setup()

      await deps.requestHandlers[VcEvents.REMOTE](
        {subcommand: 'add', url: 'https://byterover.dev/acme/project.git'},
        CLIENT_ID,
      )

      expect(deps.projectConfigStore.write.calledOnce).to.be.true
      const writtenConfig: BrvConfig = deps.projectConfigStore.write.firstCall.args[0]
      expect(writtenConfig.spaceId).to.equal('sid-1')
      expect(writtenConfig.teamId).to.equal('tid-1')
      expect(writtenConfig.spaceName).to.equal('project')
      expect(writtenConfig.teamName).to.equal('acme')
    })

    it('should persist space/team to config on remote set-url with name-based URL', async () => {
      const deps = makeDeps(sandbox, projectPath)
      deps.gitService.isInitialized.resolves(true)
      const mockToken = new AuthToken({
        accessToken: 'test-acc',
        expiresAt: new Date(Date.now() + 3_600_000),
        refreshToken: 'test-ref',
        sessionKey: 'sess-123',
        userEmail: 'test@example.com',
        userId: 'u1',
      })
      deps.tokenStore.load.resolves(mockToken)
      deps.teamService.getTeams.resolves({
        teams: [{displayName: 'Acme', id: 'tid-1', isActive: true, isDefault: false, name: 'acme', slug: 'acme'}],
        total: 1,
      })
      deps.spaceService.getSpaces.resolves({
        spaces: [
          {
            id: 'sid-1',
            isDefault: false,
            name: 'project',
            slug: 'project',
            teamId: 'tid-1',
            teamName: 'acme',
            teamSlug: 'acme',
          },
        ],
        total: 1,
      })
      makeVcHandler(deps).setup()

      await deps.requestHandlers[VcEvents.REMOTE](
        {subcommand: 'set-url', url: 'https://byterover.dev/acme/project.git'},
        CLIENT_ID,
      )

      expect(deps.projectConfigStore.write.calledOnce).to.be.true
      const writtenConfig: BrvConfig = deps.projectConfigStore.write.firstCall.args[0]
      expect(writtenConfig.spaceId).to.equal('sid-1')
      expect(writtenConfig.teamId).to.equal('tid-1')
      expect(writtenConfig.spaceName).to.equal('project')
      expect(writtenConfig.teamName).to.equal('acme')
    })

    it('should call gitService.removeRemote and return {action: remove} when remote exists', async () => {
      const deps = makeDeps(sandbox, projectPath)
      deps.gitService.isInitialized.resolves(true)
      deps.gitService.getRemoteUrl.resolves('https://byterover.dev/acme/project.git')
      makeVcHandler(deps).setup()

      const result = await deps.requestHandlers[VcEvents.REMOTE]({subcommand: 'remove'}, CLIENT_ID)
      expect(result).to.deep.equal({action: 'remove'})
      expect(deps.gitService.removeRemote.calledOnce).to.be.true
      expect(deps.gitService.removeRemote.firstCall.args[0]).to.include({remote: 'origin'})
    })

    it('should clear space fields from config.json via withoutSpace() on remove', async () => {
      const deps = makeDeps(sandbox, projectPath)
      deps.gitService.isInitialized.resolves(true)
      deps.gitService.getRemoteUrl.resolves('https://byterover.dev/acme/project.git')
      const boundConfig = new BrvConfig({
        createdAt: '2025-01-01T00:00:00.000Z',
        cwd: projectPath,
        spaceId: 'sid-1',
        spaceName: 'project',
        teamId: 'tid-1',
        teamName: 'acme',
        version: '1.0.0',
      })
      deps.projectConfigStore.read.resolves(boundConfig)
      makeVcHandler(deps).setup()

      await deps.requestHandlers[VcEvents.REMOTE]({subcommand: 'remove'}, CLIENT_ID)

      expect(deps.projectConfigStore.write.calledOnce).to.be.true
      const writtenConfig: BrvConfig = deps.projectConfigStore.write.firstCall.args[0]
      expect(writtenConfig.spaceId).to.be.undefined
      expect(writtenConfig.spaceName).to.be.undefined
      expect(writtenConfig.teamId).to.be.undefined
      expect(writtenConfig.teamName).to.be.undefined
      expect(writtenConfig.cwd).to.equal(projectPath)
    })

    it('should clear orphaned space fields even when config is not fully cloud-connected', async () => {
      const deps = makeDeps(sandbox, projectPath)
      deps.gitService.isInitialized.resolves(true)
      deps.gitService.getRemoteUrl.resolves('https://byterover.dev/acme/project.git')
      const partialConfig = new BrvConfig({
        createdAt: '2025-01-01T00:00:00.000Z',
        cwd: projectPath,
        spaceId: 'orphaned-sid',
        version: '1.0.0',
      })
      deps.projectConfigStore.read.resolves(partialConfig)
      makeVcHandler(deps).setup()

      await deps.requestHandlers[VcEvents.REMOTE]({subcommand: 'remove'}, CLIENT_ID)

      expect(deps.projectConfigStore.write.calledOnce).to.be.true
      const writtenConfig: BrvConfig = deps.projectConfigStore.write.firstCall.args[0]
      expect(writtenConfig.spaceId).to.be.undefined
      expect(writtenConfig.cwd).to.equal(projectPath)
    })

    it('should skip config-store write when config does not exist', async () => {
      const deps = makeDeps(sandbox, projectPath)
      deps.gitService.isInitialized.resolves(true)
      deps.gitService.getRemoteUrl.resolves('https://byterover.dev/acme/project.git')
      deps.projectConfigStore.read.resolves()
      makeVcHandler(deps).setup()

      await deps.requestHandlers[VcEvents.REMOTE]({subcommand: 'remove'}, CLIENT_ID)

      expect(deps.gitService.removeRemote.calledOnce).to.be.true
      expect(deps.projectConfigStore.write.called).to.be.false
    })

    it('should throw NO_REMOTE when remove is called with no remote configured', async () => {
      const deps = makeDeps(sandbox, projectPath)
      deps.gitService.isInitialized.resolves(true)
      deps.gitService.getRemoteUrl.resolves()
      makeVcHandler(deps).setup()

      try {
        await deps.requestHandlers[VcEvents.REMOTE]({subcommand: 'remove'}, CLIENT_ID)
        expect.fail('Expected error')
      } catch (error) {
        expect(error).to.be.instanceOf(VcError)
        if (error instanceof VcError) {
          expect(error.code).to.equal(VcErrorCode.NO_REMOTE)
        }
      }

      expect(deps.gitService.removeRemote.called).to.be.false
      expect(deps.projectConfigStore.write.called).to.be.false
    })

    it('should throw GIT_NOT_INITIALIZED when remove is called on uninitialized repo', async () => {
      const deps = makeDeps(sandbox, projectPath)
      deps.gitService.isInitialized.resolves(false)
      makeVcHandler(deps).setup()

      try {
        await deps.requestHandlers[VcEvents.REMOTE]({subcommand: 'remove'}, CLIENT_ID)
        expect.fail('Expected error')
      } catch (error) {
        expect(error).to.be.instanceOf(VcError)
        if (error instanceof VcError) {
          expect(error.code).to.equal(VcErrorCode.GIT_NOT_INITIALIZED)
        }
      }
    })

    it('should write cleared config before calling removeRemote (idempotent retry on partial failure)', async () => {
      const deps = makeDeps(sandbox, projectPath)
      deps.gitService.isInitialized.resolves(true)
      deps.gitService.getRemoteUrl.resolves('https://byterover.dev/acme/project.git')
      const boundConfig = new BrvConfig({
        createdAt: '2025-01-01T00:00:00.000Z',
        cwd: projectPath,
        spaceId: 'sid-1',
        spaceName: 'project',
        teamId: 'tid-1',
        teamName: 'acme',
        version: '1.0.0',
      })
      deps.projectConfigStore.read.resolves(boundConfig)
      makeVcHandler(deps).setup()

      await deps.requestHandlers[VcEvents.REMOTE]({subcommand: 'remove'}, CLIENT_ID)

      expect(deps.projectConfigStore.write.calledBefore(deps.gitService.removeRemote)).to.be.true
    })

    it('should leave config cleared when removeRemote fails after config write', async () => {
      const deps = makeDeps(sandbox, projectPath)
      deps.gitService.isInitialized.resolves(true)
      deps.gitService.getRemoteUrl.resolves('https://byterover.dev/acme/project.git')
      const boundConfig = new BrvConfig({
        createdAt: '2025-01-01T00:00:00.000Z',
        cwd: projectPath,
        spaceId: 'sid-1',
        spaceName: 'project',
        teamId: 'tid-1',
        teamName: 'acme',
        version: '1.0.0',
      })
      deps.projectConfigStore.read.resolves(boundConfig)
      deps.gitService.removeRemote.rejects(new Error('simulated git failure'))
      makeVcHandler(deps).setup()

      try {
        await deps.requestHandlers[VcEvents.REMOTE]({subcommand: 'remove'}, CLIENT_ID)
        expect.fail('Expected error')
      } catch (error) {
        expect(error).to.be.instanceOf(Error)
      }

      expect(deps.projectConfigStore.write.calledOnce).to.be.true
      const writtenConfig: BrvConfig = deps.projectConfigStore.write.firstCall.args[0]
      expect(writtenConfig.spaceId).to.be.undefined
      expect(writtenConfig.teamId).to.be.undefined
    })

    it('should throw INVALID_ACTION when subcommand is unknown', async () => {
      const deps = makeDeps(sandbox, projectPath)
      deps.gitService.isInitialized.resolves(true)
      makeVcHandler(deps).setup()

      try {
        await deps.requestHandlers[VcEvents.REMOTE]({subcommand: 'bogus'}, CLIENT_ID)
        expect.fail('Expected error')
      } catch (error) {
        expect(error).to.be.instanceOf(VcError)
        if (error instanceof VcError) {
          expect(error.code).to.equal(VcErrorCode.INVALID_ACTION)
        }
      }
    })
  })

  // ---- handleBranch ----

  describe('handleBranch', () => {
    // ---- list ----

    it('list should return branches from gitService', async () => {
      const deps = makeDeps(sandbox, projectPath)
      deps.gitService.listBranches.resolves([
        {isCurrent: true, isRemote: false, name: 'main'},
        {isCurrent: false, isRemote: false, name: 'feature'},
      ])
      makeVcHandler(deps).setup()
      const result = await invoke<Extract<IVcBranchResponse, {action: 'list'}>>(deps, VcEvents.BRANCH, {action: 'list'})
      expect(result.action).to.equal('list')
      expect(result.branches).to.have.length(2)
      expect(result.branches[0]).to.deep.equal({isCurrent: true, isRemote: false, name: 'main'})
      expect(result.branches[1]).to.deep.equal({isCurrent: false, isRemote: false, name: 'feature'})
    })

    it('list should pass remote=origin when all flag is true', async () => {
      const deps = makeDeps(sandbox, projectPath)
      deps.gitService.listBranches.resolves([])
      makeVcHandler(deps).setup()
      await deps.requestHandlers[VcEvents.BRANCH]({action: 'list', all: true}, CLIENT_ID)
      expect(deps.gitService.listBranches.firstCall.args[0]).to.deep.include({remote: 'origin'})
    })

    it('list should not pass remote when all flag is false', async () => {
      const deps = makeDeps(sandbox, projectPath)
      deps.gitService.listBranches.resolves([])
      makeVcHandler(deps).setup()
      await deps.requestHandlers[VcEvents.BRANCH]({action: 'list'}, CLIENT_ID)
      expect(deps.gitService.listBranches.firstCall.args[0].remote).to.be.undefined
    })

    it('list should return empty branches array when none exist', async () => {
      const deps = makeDeps(sandbox, projectPath)
      deps.gitService.listBranches.resolves([])
      makeVcHandler(deps).setup()
      const result = await invoke<Extract<IVcBranchResponse, {action: 'list'}>>(deps, VcEvents.BRANCH, {action: 'list'})
      expect(result.branches).to.deep.equal([])
    })

    it('should throw GIT_NOT_INITIALIZED when not initialized', async () => {
      const deps = makeDeps(sandbox, projectPath)
      deps.gitService.isInitialized.resolves(false)
      makeVcHandler(deps).setup()
      try {
        await deps.requestHandlers[VcEvents.BRANCH]({action: 'list'}, CLIENT_ID)
        expect.fail('Expected error')
      } catch (error) {
        expect(error).to.be.instanceOf(VcError)
        if (error instanceof VcError) expect(error.code).to.equal(VcErrorCode.GIT_NOT_INITIALIZED)
      }
    })

    // ---- create ----

    it('create should create a branch and return created name', async () => {
      const deps = makeDeps(sandbox, projectPath)
      deps.gitService.listBranches.resolves([{isCurrent: true, isRemote: false, name: 'main'}])
      deps.gitService.log.resolves([
        {author: {email: 'a@b.c', name: 'A'}, message: 'init', sha: 'abc', timestamp: new Date()},
      ])
      makeVcHandler(deps).setup()
      const result = await invoke<IVcBranchResponse>(deps, VcEvents.BRANCH, {action: 'create', name: 'feature'})
      expect(result).to.deep.equal({action: 'create', created: 'feature'})
      expect(deps.gitService.createBranch.firstCall.args[0]).to.deep.include({branch: 'feature'})
    })

    it('create with slash name (feature/test) should succeed', async () => {
      const deps = makeDeps(sandbox, projectPath)
      deps.gitService.listBranches.resolves([{isCurrent: true, isRemote: false, name: 'main'}])
      deps.gitService.log.resolves([
        {author: {email: 'a@b.c', name: 'A'}, message: 'init', sha: 'abc', timestamp: new Date()},
      ])
      makeVcHandler(deps).setup()
      const result = await invoke<Extract<IVcBranchResponse, {action: 'create'}>>(deps, VcEvents.BRANCH, {
        action: 'create',
        name: 'feature/test',
      })
      expect(result.created).to.equal('feature/test')
    })

    it('create should forward startPoint to gitService.createBranch', async () => {
      const deps = makeDeps(sandbox, projectPath)
      deps.gitService.listBranches.resolves([{isCurrent: true, isRemote: false, name: 'main'}])
      deps.gitService.log.resolves([
        {author: {email: 'a@b.c', name: 'A'}, message: 'init', sha: 'abc', timestamp: new Date()},
      ])
      makeVcHandler(deps).setup()

      await invoke<Extract<IVcBranchResponse, {action: 'create'}>>(deps, VcEvents.BRANCH, {
        action: 'create',
        name: 'feat/x',
        startPoint: 'origin/feat/x',
      })

      expect(deps.gitService.createBranch.firstCall.args[0]).to.deep.include({
        branch: 'feat/x',
        startPoint: 'origin/feat/x',
      })
    })

    it('create should throw BRANCH_ALREADY_EXISTS when branch exists', async () => {
      const deps = makeDeps(sandbox, projectPath)
      deps.gitService.listBranches.resolves([
        {isCurrent: true, isRemote: false, name: 'main'},
        {isCurrent: false, isRemote: false, name: 'feature'},
      ])
      makeVcHandler(deps).setup()
      try {
        await deps.requestHandlers[VcEvents.BRANCH]({action: 'create', name: 'feature'}, CLIENT_ID)
        expect.fail('Expected error')
      } catch (error) {
        expect(error).to.be.instanceOf(VcError)
        if (error instanceof VcError) expect(error.code).to.equal(VcErrorCode.BRANCH_ALREADY_EXISTS)
      }
    })

    it('create should throw INVALID_BRANCH_NAME for invalid names', async () => {
      const deps = makeDeps(sandbox, projectPath)
      makeVcHandler(deps).setup()
      const names = ['', '-bad', '/bad', 'bad name', 'bad~name', 'bad^name', 'bad:name', 'bad?name', 'bad*name']
      const results = await Promise.allSettled(
        names.map((name) => deps.requestHandlers[VcEvents.BRANCH]({action: 'create', name}, CLIENT_ID)),
      )
      for (const result of results) {
        expect(result.status).to.equal('rejected')
        if (result.status === 'rejected') {
          const error = result.reason
          expect(error).to.be.instanceOf(VcError)
          if (error instanceof VcError) expect(error.code).to.equal(VcErrorCode.INVALID_BRANCH_NAME)
        }
      }
    })

    // ---- delete ----

    it('delete should delete a branch and return deleted name', async () => {
      const deps = makeDeps(sandbox, projectPath)
      deps.gitService.getCurrentBranch.resolves('main')
      deps.gitService.listBranches.resolves([
        {isCurrent: true, isRemote: false, name: 'main'},
        {isCurrent: false, isRemote: false, name: 'feature'},
      ])
      makeVcHandler(deps).setup()
      const result = await invoke<IVcBranchResponse>(deps, VcEvents.BRANCH, {action: 'delete', name: 'feature'})
      expect(result).to.deep.equal({action: 'delete', deleted: 'feature'})
      expect(deps.gitService.deleteBranch.firstCall.args[0]).to.deep.include({branch: 'feature'})
    })

    it('delete should work for local branch with slash in name', async () => {
      const deps = makeDeps(sandbox, projectPath)
      deps.gitService.getCurrentBranch.resolves('main')
      deps.gitService.listBranches.resolves([
        {isCurrent: true, isRemote: false, name: 'main'},
        {isCurrent: false, isRemote: false, name: 'feature/test'},
      ])
      makeVcHandler(deps).setup()
      const result = await invoke<Extract<IVcBranchResponse, {action: 'delete'}>>(deps, VcEvents.BRANCH, {
        action: 'delete',
        name: 'feature/test',
      })
      expect(result.deleted).to.equal('feature/test')
      expect(deps.gitService.deleteBranch.calledOnce).to.be.true
    })

    it('delete should throw CANNOT_DELETE_CURRENT_BRANCH', async () => {
      const deps = makeDeps(sandbox, projectPath)
      deps.gitService.getCurrentBranch.resolves('main')
      makeVcHandler(deps).setup()
      try {
        await deps.requestHandlers[VcEvents.BRANCH]({action: 'delete', name: 'main'}, CLIENT_ID)
        expect.fail('Expected error')
      } catch (error) {
        expect(error).to.be.instanceOf(VcError)
        if (error instanceof VcError) expect(error.code).to.equal(VcErrorCode.CANNOT_DELETE_CURRENT_BRANCH)
      }
    })

    it('delete should throw BRANCH_NOT_FOUND when branch does not exist', async () => {
      const deps = makeDeps(sandbox, projectPath)
      deps.gitService.getCurrentBranch.resolves('main')
      deps.gitService.listBranches.resolves([{isCurrent: true, isRemote: false, name: 'main'}])
      makeVcHandler(deps).setup()
      try {
        await deps.requestHandlers[VcEvents.BRANCH]({action: 'delete', name: 'nonexistent'}, CLIENT_ID)
        expect.fail('Expected error')
      } catch (error) {
        expect(error).to.be.instanceOf(VcError)
        if (error instanceof VcError) expect(error.code).to.equal(VcErrorCode.BRANCH_NOT_FOUND)
      }
    })

    it('delete should throw BRANCH_NOT_FOUND for remote-tracking name not in local list', async () => {
      const deps = makeDeps(sandbox, projectPath)
      deps.gitService.getCurrentBranch.resolves('main')
      deps.gitService.listBranches.resolves([{isCurrent: true, isRemote: false, name: 'main'}])
      makeVcHandler(deps).setup()
      try {
        await deps.requestHandlers[VcEvents.BRANCH]({action: 'delete', name: 'origin/main'}, CLIENT_ID)
        expect.fail('Expected error')
      } catch (error) {
        expect(error).to.be.instanceOf(VcError)
        if (error instanceof VcError) expect(error.code).to.equal(VcErrorCode.BRANCH_NOT_FOUND)
      }
    })

    it('delete should throw BRANCH_NOT_MERGED when branch is not fully merged', async () => {
      const deps = makeDeps(sandbox, projectPath)
      deps.gitService.getCurrentBranch.resolves('main')
      deps.gitService.listBranches.resolves([
        {isCurrent: true, isRemote: false, name: 'main'},
        {isCurrent: false, isRemote: false, name: 'unmerged-feat'},
      ])
      deps.gitService.isAncestor.resolves(false)
      makeVcHandler(deps).setup()
      try {
        await deps.requestHandlers[VcEvents.BRANCH]({action: 'delete', name: 'unmerged-feat'}, CLIENT_ID)
        expect.fail('Expected error')
      } catch (error) {
        expect(error).to.be.instanceOf(VcError)
        if (error instanceof VcError) expect(error.code).to.equal(VcErrorCode.BRANCH_NOT_MERGED)
      }
    })

    it('delete should throw INVALID_BRANCH_NAME when name is missing at runtime', async () => {
      const deps = makeDeps(sandbox, projectPath)
      makeVcHandler(deps).setup()
      try {
        // Simulate malformed transport payload (no name despite type requiring it)
        await deps.requestHandlers[VcEvents.BRANCH]({action: 'delete'} as unknown as IVcBranchRequest, CLIENT_ID)
        expect.fail('Expected error')
      } catch (error) {
        expect(error).to.be.instanceOf(VcError)
        if (error instanceof VcError) expect(error.code).to.equal(VcErrorCode.INVALID_BRANCH_NAME)
      }
    })

    it('create should throw INVALID_BRANCH_NAME when name is missing at runtime', async () => {
      const deps = makeDeps(sandbox, projectPath)
      makeVcHandler(deps).setup()
      try {
        await deps.requestHandlers[VcEvents.BRANCH]({action: 'create'} as unknown as IVcBranchRequest, CLIENT_ID)
        expect.fail('Expected error')
      } catch (error) {
        expect(error).to.be.instanceOf(VcError)
        if (error instanceof VcError) expect(error.code).to.equal(VcErrorCode.INVALID_BRANCH_NAME)
      }
    })
  })

  describe('handleCheckout', () => {
    it('should switch to an existing branch', async () => {
      const deps = makeDeps(sandbox, projectPath)
      deps.gitService.getCurrentBranch.resolves('main')
      makeVcHandler(deps).setup()

      const result = await invoke<IVcCheckoutResponse>(deps, VcEvents.CHECKOUT, {branch: 'feature'})

      expect(result).to.deep.equal({branch: 'feature', created: false, previousBranch: 'main'})
      expect(deps.gitService.checkout.firstCall.args[0]).to.deep.include({ref: 'feature'})
      expect(deps.gitService.listBranches.called).to.be.false
    })

    it('should throw GIT_NOT_INITIALIZED when not initialized', async () => {
      const deps = makeDeps(sandbox, projectPath)
      deps.gitService.isInitialized.resolves(false)
      makeVcHandler(deps).setup()

      try {
        await deps.requestHandlers[VcEvents.CHECKOUT]({branch: 'feature'}, CLIENT_ID)
        expect.fail('Expected error')
      } catch (error) {
        expect(error).to.be.instanceOf(VcError)
        if (error instanceof VcError) expect(error.code).to.equal(VcErrorCode.GIT_NOT_INITIALIZED)
      }
    })

    it('should throw BRANCH_NOT_FOUND when branch does not exist', async () => {
      const deps = makeDeps(sandbox, projectPath)
      deps.gitService.getCurrentBranch.resolves('main')
      deps.gitService.log.resolves([
        {author: {email: 'a@b.c', name: 'A'}, message: 'init', sha: 'abc', timestamp: new Date()},
      ])
      const notFoundError = Object.assign(new Error('Could not find origin/nonexistent.'), {code: 'NotFoundError'})
      deps.gitService.checkout.rejects(notFoundError)
      makeVcHandler(deps).setup()

      try {
        await deps.requestHandlers[VcEvents.CHECKOUT]({branch: 'nonexistent'}, CLIENT_ID)
        expect.fail('Expected error')
      } catch (error) {
        expect(error).to.be.instanceOf(VcError)
        if (error instanceof VcError) {
          expect(error.code).to.equal(VcErrorCode.BRANCH_NOT_FOUND)
          expect(error.message).to.include('brv vc checkout -b')
        }
      }
    })

    it('should throw BRANCH_NOT_FOUND (not NO_COMMITS) when target ref missing from unborn HEAD', async () => {
      // Typo case: target name differs from the current branch, so the catch is
      // unambiguously "user gave a name we cannot resolve". Must surface as
      // BRANCH_NOT_FOUND even when the local repo has zero commits.
      const deps = makeDeps(sandbox, projectPath)
      deps.gitService.getCurrentBranch.resolves('main')
      deps.gitService.log.resolves([])
      const notFoundError = Object.assign(new Error('Could not find origin/zorqplex_nonexistent_4242.'), {
        code: 'NotFoundError',
      })
      deps.gitService.checkout.rejects(notFoundError)
      makeVcHandler(deps).setup()

      try {
        await deps.requestHandlers[VcEvents.CHECKOUT]({branch: 'zorqplex_nonexistent_4242'}, CLIENT_ID)
        expect.fail('Expected error')
      } catch (error) {
        expect(error).to.be.instanceOf(VcError)
        if (error instanceof VcError) {
          expect(error.code).to.equal(VcErrorCode.BRANCH_NOT_FOUND)
          expect(error.message).to.include('zorqplex_nonexistent_4242')
          expect(error.message).to.not.include('does not have any commits yet')
        }
      }
    })

    it('should throw NO_COMMITS when checking out the current unborn branch by name', async () => {
      // Same-branch case: user is on `main` but `main` is unborn (e.g. fresh
      // `brv vc init` with no commits, no fetched ref). `brv vc checkout main`
      // throws NotFoundError because the target does not resolve, but the user
      // is already on that branch — telling them "use checkout -b" is wrong.
      // Surface as NO_COMMITS with the actionable message.
      const deps = makeDeps(sandbox, projectPath)
      deps.gitService.getCurrentBranch.resolves('main')
      const notFoundError = Object.assign(new Error('Could not find main.'), {code: 'NotFoundError'})
      deps.gitService.checkout.rejects(notFoundError)
      makeVcHandler(deps).setup()

      try {
        await deps.requestHandlers[VcEvents.CHECKOUT]({branch: 'main'}, CLIENT_ID)
        expect.fail('Expected error')
      } catch (error) {
        expect(error).to.be.instanceOf(VcError)
        if (error instanceof VcError) {
          expect(error.code).to.equal(VcErrorCode.NO_COMMITS)
          expect(error.message).to.include('main')
          expect(error.message).to.include('does not have any commits yet')
          expect(error.message).to.not.include('checkout -b')
        }
      }
    })

    it('should throw UNCOMMITTED_CHANGES when checkout would overwrite dirty files', async () => {
      const deps = makeDeps(sandbox, projectPath)
      deps.gitService.getCurrentBranch.resolves('main')
      deps.gitService.checkout.rejects(
        new GitError(
          'Your local changes would be overwritten by checkout. ' +
            'Please commit or discard your changes before you switch branches.',
        ),
      )
      makeVcHandler(deps).setup()

      try {
        await deps.requestHandlers[VcEvents.CHECKOUT]({branch: 'feature'}, CLIENT_ID)
        expect.fail('Expected error')
      } catch (error) {
        expect(error).to.be.instanceOf(VcError)
        if (error instanceof VcError) expect(error.code).to.equal(VcErrorCode.UNCOMMITTED_CHANGES)
      }
    })

    it('should allow checkout when dirty files do not conflict with target branch', async () => {
      const deps = makeDeps(sandbox, projectPath)
      deps.gitService.getCurrentBranch.resolves('main')
      makeVcHandler(deps).setup()

      const result = await invoke<IVcCheckoutResponse>(deps, VcEvents.CHECKOUT, {branch: 'feature'})

      expect(result).to.deep.equal({branch: 'feature', created: false, previousBranch: 'main'})
      expect(deps.gitService.checkout.firstCall.args[0]).to.deep.include({ref: 'feature'})
    })

    it('should switch with force when working tree is dirty', async () => {
      const deps = makeDeps(sandbox, projectPath)
      deps.gitService.getCurrentBranch.resolves('main')
      makeVcHandler(deps).setup()

      const result = await invoke<IVcCheckoutResponse>(deps, VcEvents.CHECKOUT, {branch: 'feature', force: true})

      expect(result).to.deep.equal({branch: 'feature', created: false, previousBranch: 'main'})
      expect(deps.gitService.checkout.firstCall.args[0]).to.deep.include({force: true, ref: 'feature'})
    })

    it('should clear merge state when force checkout during merge conflict', async () => {
      const deps = makeMergeDeps(sandbox, {mergeHead: true, mergeMsg: 'Merge branch feat'})
      deps.gitService.getCurrentBranch.resolves('main')
      makeVcHandler(deps).setup()

      try {
        await invoke<IVcCheckoutResponse>(deps, VcEvents.CHECKOUT, {branch: 'safe', force: true})

        expect(existsSync(join(deps.tmpDir, '.git', 'MERGE_HEAD'))).to.be.false
        expect(existsSync(join(deps.tmpDir, '.git', 'MERGE_MSG'))).to.be.false
      } finally {
        cleanupDir(deps.tmpDir)
      }
    })

    it('should create and switch with create flag', async () => {
      const deps = makeDeps(sandbox, projectPath)
      deps.gitService.getCurrentBranch.resolves('main')
      deps.gitService.listBranches.resolves([{isCurrent: true, isRemote: false, name: 'main'}])
      makeVcHandler(deps).setup()

      const result = await invoke<IVcCheckoutResponse>(deps, VcEvents.CHECKOUT, {branch: 'new-branch', create: true})

      expect(result).to.deep.equal({branch: 'new-branch', created: true, previousBranch: 'main'})
      expect(deps.gitService.createBranch.firstCall.args[0]).to.deep.include({branch: 'new-branch', checkout: true})
      expect(deps.gitService.checkout.called).to.be.false
    })

    it('should forward startPoint to createBranch when create flag is set', async () => {
      const deps = makeDeps(sandbox, projectPath)
      deps.gitService.getCurrentBranch.resolves('main')
      deps.gitService.listBranches.resolves([{isCurrent: true, isRemote: false, name: 'main'}])
      makeVcHandler(deps).setup()

      await invoke<IVcCheckoutResponse>(deps, VcEvents.CHECKOUT, {
        branch: 'feat/x',
        create: true,
        startPoint: 'origin/feat/x',
      })

      expect(deps.gitService.createBranch.firstCall.args[0]).to.deep.include({
        branch: 'feat/x',
        checkout: true,
        startPoint: 'origin/feat/x',
      })
    })

    it('should throw INVALID_ACTION when startPoint is passed without create flag', async () => {
      const deps = makeDeps(sandbox, projectPath)
      makeVcHandler(deps).setup()

      try {
        await deps.requestHandlers[VcEvents.CHECKOUT]({branch: 'feat/x', startPoint: 'origin/feat/x'}, CLIENT_ID)
        expect.fail('Expected error')
      } catch (error) {
        expect(error).to.be.instanceOf(VcError)
        if (error instanceof VcError) expect(error.code).to.equal(VcErrorCode.INVALID_ACTION)
      }
    })

    it('should throw BRANCH_ALREADY_EXISTS when create flag used on existing branch', async () => {
      const deps = makeDeps(sandbox, projectPath)
      deps.gitService.listBranches.resolves([
        {isCurrent: true, isRemote: false, name: 'main'},
        {isCurrent: false, isRemote: false, name: 'existing'},
      ])
      makeVcHandler(deps).setup()

      try {
        await deps.requestHandlers[VcEvents.CHECKOUT]({branch: 'existing', create: true}, CLIENT_ID)
        expect.fail('Expected error')
      } catch (error) {
        expect(error).to.be.instanceOf(VcError)
        if (error instanceof VcError) expect(error.code).to.equal(VcErrorCode.BRANCH_ALREADY_EXISTS)
      }
    })

    it('should throw INVALID_BRANCH_NAME for invalid names', async () => {
      const deps = makeDeps(sandbox, projectPath)
      deps.gitService.status.resolves({files: [], isClean: true})
      makeVcHandler(deps).setup()

      try {
        await deps.requestHandlers[VcEvents.CHECKOUT]({branch: '-bad'}, CLIENT_ID)
        expect.fail('Expected error')
      } catch (error) {
        expect(error).to.be.instanceOf(VcError)
        if (error instanceof VcError) expect(error.code).to.equal(VcErrorCode.INVALID_BRANCH_NAME)
      }
    })

    it('should throw INVALID_BRANCH_NAME for empty branch name', async () => {
      const deps = makeDeps(sandbox, projectPath)
      makeVcHandler(deps).setup()

      try {
        await deps.requestHandlers[VcEvents.CHECKOUT]({branch: ''}, CLIENT_ID)
        expect.fail('Expected error')
      } catch (error) {
        expect(error).to.be.instanceOf(VcError)
        if (error instanceof VcError) expect(error.code).to.equal(VcErrorCode.INVALID_BRANCH_NAME)
      }
    })
  })

  // ── handleMerge ──

  describe('handleMerge', () => {
    it('should register vc:merge handler', () => {
      const deps = makeDeps(sandbox, projectPath)
      makeVcHandler(deps).setup()
      expect(deps.requestHandlers[VcEvents.MERGE]).to.be.a('function')
    })

    // ── action: 'merge' ──

    it('should merge successfully and checkout working tree', async () => {
      const deps = makeMergeDeps(sandbox)
      try {
        deps.gitService.listBranches.resolves([{isCurrent: false, isRemote: false, name: 'feature'}])
        deps.gitService.merge.resolves({success: true})

        makeVcHandler(deps).setup()
        const result = await invoke<IVcMergeResponse>(deps, VcEvents.MERGE, {
          action: 'merge',
          branch: 'feature',
        } satisfies IVcMergeRequest)

        expect(result.action).to.equal('merge')
        expect(result.branch).to.equal('feature')
        expect(result.conflicts).to.be.undefined
        expect(deps.gitService.merge.calledOnce).to.be.true
      } finally {
        cleanupDir(deps.tmpDir)
      }
    })

    it('should return conflicts when merge has conflicts', async () => {
      const deps = makeMergeDeps(sandbox)
      try {
        deps.gitService.listBranches.resolves([{isCurrent: false, isRemote: false, name: 'feature'}])
        deps.gitService.merge.resolves({
          conflicts: [{path: 'file.md', type: 'both_modified'}],
          success: false,
        })

        makeVcHandler(deps).setup()
        const result = await invoke<IVcMergeResponse>(deps, VcEvents.MERGE, {
          action: 'merge',
          branch: 'feature',
        } satisfies IVcMergeRequest)

        expect(result.conflicts).to.have.length(1)
        expect(result.conflicts![0].path).to.equal('file.md')
        expect(deps.gitService.checkout.called).to.be.false
      } finally {
        cleanupDir(deps.tmpDir)
      }
    })

    it('should return alreadyUpToDate when merging branch into itself', async () => {
      const deps = makeMergeDeps(sandbox)
      try {
        deps.gitService.getCurrentBranch.resolves('main')

        makeVcHandler(deps).setup()
        const result = await invoke<IVcMergeResponse>(deps, VcEvents.MERGE, {
          action: 'merge',
          branch: 'main',
        } satisfies IVcMergeRequest)

        expect(result.alreadyUpToDate).to.be.true
        expect(deps.gitService.merge.called).to.be.false
      } finally {
        cleanupDir(deps.tmpDir)
      }
    })

    it('should return alreadyUpToDate when target branch is already merged', async () => {
      const deps = makeMergeDeps(sandbox)
      try {
        deps.gitService.listBranches.resolves([{isCurrent: false, isRemote: false, name: 'feature'}])
        deps.gitService.merge.resolves({alreadyUpToDate: true, success: true})

        makeVcHandler(deps).setup()
        const result = await invoke<IVcMergeResponse>(deps, VcEvents.MERGE, {
          action: 'merge',
          branch: 'feature',
        } satisfies IVcMergeRequest)

        expect(result.alreadyUpToDate).to.be.true
      } finally {
        cleanupDir(deps.tmpDir)
      }
    })

    it('should pass custom message to merge', async () => {
      const deps = makeMergeDeps(sandbox)
      try {
        deps.gitService.listBranches.resolves([{isCurrent: false, isRemote: false, name: 'feature'}])
        deps.gitService.merge.resolves({success: true})
        deps.gitService.getCurrentBranch.resolves('main')

        makeVcHandler(deps).setup()
        await deps.requestHandlers[VcEvents.MERGE](
          {action: 'merge', branch: 'feature', message: 'custom msg'} satisfies IVcMergeRequest,
          CLIENT_ID,
        )

        expect(deps.gitService.merge.firstCall.args[0].message).to.equal('custom msg')
      } finally {
        cleanupDir(deps.tmpDir)
      }
    })

    it('should throw MERGE_IN_PROGRESS when MERGE_HEAD exists', async () => {
      const deps = makeMergeDeps(sandbox, {mergeHead: true})
      try {
        deps.gitService.listBranches.resolves([{isCurrent: false, isRemote: false, name: 'feature'}])
        makeVcHandler(deps).setup()

        try {
          await deps.requestHandlers[VcEvents.MERGE](
            {action: 'merge', branch: 'feature'} satisfies IVcMergeRequest,
            CLIENT_ID,
          )
          expect.fail('Expected error')
        } catch (error) {
          expect(error).to.be.instanceOf(VcError)
          if (error instanceof VcError) expect(error.code).to.equal(VcErrorCode.MERGE_IN_PROGRESS)
        }
      } finally {
        cleanupDir(deps.tmpDir)
      }
    })

    it('should throw UNCOMMITTED_CHANGES when working tree is dirty', async () => {
      const deps = makeMergeDeps(sandbox)
      try {
        deps.gitService.listBranches.resolves([{isCurrent: false, isRemote: false, name: 'feature'}])
        deps.gitService.status.resolves({
          files: [{path: 'dirty.md', staged: false, status: 'modified'}],
          isClean: false,
        })

        makeVcHandler(deps).setup()
        try {
          await deps.requestHandlers[VcEvents.MERGE](
            {action: 'merge', branch: 'feature'} satisfies IVcMergeRequest,
            CLIENT_ID,
          )
          expect.fail('Expected error')
        } catch (error) {
          expect(error).to.be.instanceOf(VcError)
          if (error instanceof VcError) expect(error.code).to.equal(VcErrorCode.UNCOMMITTED_CHANGES)
        }
      } finally {
        cleanupDir(deps.tmpDir)
      }
    })

    it('should throw BRANCH_NOT_FOUND when branch does not exist', async () => {
      const deps = makeMergeDeps(sandbox)
      try {
        deps.gitService.listBranches.resolves([{isCurrent: true, isRemote: false, name: 'main'}])

        makeVcHandler(deps).setup()
        try {
          await deps.requestHandlers[VcEvents.MERGE](
            {action: 'merge', branch: 'nonexistent'} satisfies IVcMergeRequest,
            CLIENT_ID,
          )
          expect.fail('Expected error')
        } catch (error) {
          expect(error).to.be.instanceOf(VcError)
          if (error instanceof VcError) expect(error.code).to.equal(VcErrorCode.BRANCH_NOT_FOUND)
        }
      } finally {
        cleanupDir(deps.tmpDir)
      }
    })

    it('should throw GIT_NOT_INITIALIZED when git is not initialized', async () => {
      const deps = makeMergeDeps(sandbox)
      try {
        deps.gitService.isInitialized.resolves(false)

        makeVcHandler(deps).setup()
        try {
          await deps.requestHandlers[VcEvents.MERGE](
            {action: 'merge', branch: 'feature'} satisfies IVcMergeRequest,
            CLIENT_ID,
          )
          expect.fail('Expected error')
        } catch (error) {
          expect(error).to.be.instanceOf(VcError)
          if (error instanceof VcError) expect(error.code).to.equal(VcErrorCode.GIT_NOT_INITIALIZED)
        }
      } finally {
        cleanupDir(deps.tmpDir)
      }
    })

    it('should throw INVALID_BRANCH_NAME when branch name is invalid', async () => {
      const deps = makeMergeDeps(sandbox)
      try {
        makeVcHandler(deps).setup()
        try {
          await deps.requestHandlers[VcEvents.MERGE](
            {action: 'merge', branch: '..invalid'} satisfies IVcMergeRequest,
            CLIENT_ID,
          )
          expect.fail('Expected error')
        } catch (error) {
          expect(error).to.be.instanceOf(VcError)
          if (error instanceof VcError) expect(error.code).to.equal(VcErrorCode.INVALID_BRANCH_NAME)
        }
      } finally {
        cleanupDir(deps.tmpDir)
      }
    })

    it('should throw INVALID_BRANCH_NAME when branch name is missing', async () => {
      const deps = makeMergeDeps(sandbox)
      try {
        makeVcHandler(deps).setup()
        try {
          await deps.requestHandlers[VcEvents.MERGE]({action: 'merge'} satisfies IVcMergeRequest, CLIENT_ID)
          expect.fail('Expected error')
        } catch (error) {
          expect(error).to.be.instanceOf(VcError)
          if (error instanceof VcError) expect(error.code).to.equal(VcErrorCode.INVALID_BRANCH_NAME)
        }
      } finally {
        cleanupDir(deps.tmpDir)
      }
    })

    it('should throw USER_NOT_CONFIGURED when author config is missing', async () => {
      const deps = makeMergeDeps(sandbox)
      try {
        deps.gitService.listBranches.resolves([{isCurrent: false, isRemote: false, name: 'feature'}])
        deps.vcGitConfigStore.get.resolves()

        makeVcHandler(deps).setup()
        try {
          await deps.requestHandlers[VcEvents.MERGE](
            {action: 'merge', branch: 'feature'} satisfies IVcMergeRequest,
            CLIENT_ID,
          )
          expect.fail('Expected error')
        } catch (error) {
          expect(error).to.be.instanceOf(VcError)
          if (error instanceof VcError) expect(error.code).to.equal(VcErrorCode.USER_NOT_CONFIGURED)
        }
      } finally {
        cleanupDir(deps.tmpDir)
      }
    })

    it('should throw BRANCH_NOT_FOUND before USER_NOT_CONFIGURED on empty repo', async () => {
      const deps = makeMergeDeps(sandbox)
      try {
        deps.gitService.listBranches.resolves([])
        deps.vcGitConfigStore.get.resolves()

        makeVcHandler(deps).setup()
        try {
          await deps.requestHandlers[VcEvents.MERGE](
            {action: 'merge', branch: 'feat'} satisfies IVcMergeRequest,
            CLIENT_ID,
          )
          expect.fail('Expected error')
        } catch (error) {
          expect(error).to.be.instanceOf(VcError)
          if (error instanceof VcError) {
            expect(error.code).to.equal(VcErrorCode.BRANCH_NOT_FOUND)
            expect(error.message).to.include('feat')
          }
        }
      } finally {
        cleanupDir(deps.tmpDir)
      }
    })

    it('should pass author from vcGitConfigStore to merge', async () => {
      const deps = makeMergeDeps(sandbox)
      try {
        deps.gitService.listBranches.resolves([{isCurrent: false, isRemote: false, name: 'feature'}])
        deps.gitService.merge.resolves({success: true})
        deps.gitService.getCurrentBranch.resolves('main')
        deps.vcGitConfigStore.get.resolves({email: 'alice@example.com', name: 'Alice'})

        makeVcHandler(deps).setup()
        await deps.requestHandlers[VcEvents.MERGE](
          {action: 'merge', branch: 'feature'} satisfies IVcMergeRequest,
          CLIENT_ID,
        )

        expect(deps.gitService.merge.firstCall.args[0].author).to.deep.equal({
          email: 'alice@example.com',
          name: 'Alice',
        })
      } finally {
        cleanupDir(deps.tmpDir)
      }
    })

    // ── action: 'abort' ──

    it('should abort merge successfully', async () => {
      const deps = makeMergeDeps(sandbox, {mergeHead: true})
      try {
        makeVcHandler(deps).setup()
        const result = await invoke<IVcMergeResponse>(deps, VcEvents.MERGE, {action: 'abort'} satisfies IVcMergeRequest)

        expect(result.action).to.equal('abort')
        expect(deps.gitService.abortMerge.calledOnce).to.be.true
      } finally {
        cleanupDir(deps.tmpDir)
      }
    })

    it('should throw NO_MERGE_IN_PROGRESS when aborting without MERGE_HEAD', async () => {
      const deps = makeMergeDeps(sandbox)
      try {
        makeVcHandler(deps).setup()
        try {
          await deps.requestHandlers[VcEvents.MERGE]({action: 'abort'} satisfies IVcMergeRequest, CLIENT_ID)
          expect.fail('Expected error')
        } catch (error) {
          expect(error).to.be.instanceOf(VcError)
          if (error instanceof VcError) expect(error.code).to.equal(VcErrorCode.NO_MERGE_IN_PROGRESS)
        }
      } finally {
        cleanupDir(deps.tmpDir)
      }
    })

    // ── action: 'continue' ──

    it('should return defaultMessage when continuing without message', async () => {
      const deps = makeMergeDeps(sandbox, {mergeHead: true, mergeMsg: "Merge branch 'feature'"})
      try {
        makeVcHandler(deps).setup()
        const result = await invoke<IVcMergeResponse>(deps, VcEvents.MERGE, {
          action: 'continue',
        } satisfies IVcMergeRequest)

        expect(result.action).to.equal('continue')
        expect(result.defaultMessage).to.equal("Merge branch 'feature'")
        expect(deps.gitService.commit.called).to.be.false
      } finally {
        cleanupDir(deps.tmpDir)
      }
    })

    it('should commit when continuing with message', async () => {
      const deps = makeMergeDeps(sandbox, {mergeHead: true})
      try {
        deps.gitService.getConflicts.resolves([])
        makeVcHandler(deps).setup()
        const result = await invoke<IVcMergeResponse>(deps, VcEvents.MERGE, {
          action: 'continue',
          message: 'Resolved merge',
        } satisfies IVcMergeRequest)

        expect(result.action).to.equal('continue')
        expect(deps.gitService.commit.calledOnce).to.be.true
        expect(deps.gitService.commit.firstCall.args[0].message).to.equal('Resolved merge')
      } finally {
        cleanupDir(deps.tmpDir)
      }
    })

    it('should throw MERGE_CONFLICT when continuing with unresolved conflicts', async () => {
      const deps = makeMergeDeps(sandbox, {mergeHead: true})
      try {
        deps.gitService.getConflicts.resolves([{path: 'file.md', type: 'both_modified'}])

        makeVcHandler(deps).setup()
        try {
          await deps.requestHandlers[VcEvents.MERGE](
            {action: 'continue', message: 'try commit'} satisfies IVcMergeRequest,
            CLIENT_ID,
          )
          expect.fail('Expected error')
        } catch (error) {
          expect(error).to.be.instanceOf(VcError)
          if (error instanceof VcError) expect(error.code).to.equal(VcErrorCode.MERGE_CONFLICT)
        }
      } finally {
        cleanupDir(deps.tmpDir)
      }
    })

    it('should throw CONFLICT_MARKERS_PRESENT when continuing with marker text remaining', async () => {
      const deps = makeMergeDeps(sandbox, {mergeHead: true})
      try {
        deps.gitService.getConflicts.resolves([])
        deps.gitService.getFilesWithConflictMarkers.resolves(['file.md'])

        makeVcHandler(deps).setup()
        try {
          await deps.requestHandlers[VcEvents.MERGE](
            {action: 'continue', message: 'try commit'} satisfies IVcMergeRequest,
            CLIENT_ID,
          )
          expect.fail('Expected error')
        } catch (error) {
          expect(error).to.be.instanceOf(VcError)
          if (error instanceof VcError) {
            expect(error.code).to.equal(VcErrorCode.CONFLICT_MARKERS_PRESENT)
            expect(error.message).to.include('file.md')
          }
        }

        expect(deps.gitService.commit.called).to.be.false
      } finally {
        cleanupDir(deps.tmpDir)
      }
    })

    it('should throw NO_MERGE_IN_PROGRESS when continuing without MERGE_HEAD', async () => {
      const deps = makeMergeDeps(sandbox)
      try {
        makeVcHandler(deps).setup()
        try {
          await deps.requestHandlers[VcEvents.MERGE]({action: 'continue'} satisfies IVcMergeRequest, CLIENT_ID)
          expect.fail('Expected error')
        } catch (error) {
          expect(error).to.be.instanceOf(VcError)
          if (error instanceof VcError) expect(error.code).to.equal(VcErrorCode.NO_MERGE_IN_PROGRESS)
        }
      } finally {
        cleanupDir(deps.tmpDir)
      }
    })
  })

  describe('handleFetch', () => {
    it('should fetch from origin when authenticated', async () => {
      const deps = makeDeps(sandbox, projectPath)
      const mockToken = new AuthToken({
        accessToken: 'test-acc',
        expiresAt: new Date(Date.now() + 3_600_000),
        refreshToken: 'test-ref',
        sessionKey: 'sess-123',
        userEmail: 'test@example.com',
        userId: 'u1',
      })
      deps.tokenStore.load.resolves(mockToken)
      deps.gitService.isInitialized.resolves(true)
      deps.gitService.listRemotes.resolves([{remote: 'origin', url: 'https://example.com/repo.git'}])
      deps.gitService.fetch.resolves()
      makeVcHandler(deps).setup()

      const result = await invoke<IVcFetchResponse>(deps, VcEvents.FETCH, {})

      expect(result.remote).to.equal('origin')
      expect(deps.gitService.fetch.calledOnce).to.be.true
      expect(deps.gitService.fetch.firstCall.args[0]).to.deep.include({remote: 'origin'})
    })

    it('should pass ref when provided', async () => {
      const deps = makeDeps(sandbox, projectPath)
      const mockToken = new AuthToken({
        accessToken: 'test-acc',
        expiresAt: new Date(Date.now() + 3_600_000),
        refreshToken: 'test-ref',
        sessionKey: 'sess-123',
        userEmail: 'test@example.com',
        userId: 'u1',
      })
      deps.tokenStore.load.resolves(mockToken)
      deps.gitService.isInitialized.resolves(true)
      deps.gitService.listRemotes.resolves([{remote: 'origin', url: 'https://example.com/repo.git'}])
      deps.gitService.fetch.resolves()
      makeVcHandler(deps).setup()

      await invoke<IVcFetchResponse>(deps, VcEvents.FETCH, {ref: 'main', remote: 'origin'})

      expect(deps.gitService.fetch.firstCall.args[0]).to.deep.include({ref: 'main', remote: 'origin'})
    })

    it('should throw NotAuthenticatedError when no token', async () => {
      const deps = makeDeps(sandbox, projectPath)
      deps.tokenStore.load.resolves()
      makeVcHandler(deps).setup()

      try {
        await invoke<IVcFetchResponse>(deps, VcEvents.FETCH, {})
        expect.fail('Expected error')
      } catch (error) {
        expect(error).to.be.instanceOf(NotAuthenticatedError)
      }
    })

    it('should throw VcError NO_REMOTE with fetch hint when no remote configured', async () => {
      const deps = makeDeps(sandbox, projectPath)
      const mockToken = new AuthToken({
        accessToken: 'test-acc',
        expiresAt: new Date(Date.now() + 3_600_000),
        refreshToken: 'test-ref',
        sessionKey: 'sess-123',
        userEmail: 'test@example.com',
        userId: 'u1',
      })
      deps.tokenStore.load.resolves(mockToken)
      deps.gitService.isInitialized.resolves(true)
      deps.gitService.listRemotes.resolves([])
      makeVcHandler(deps).setup()

      try {
        await invoke<IVcFetchResponse>(deps, VcEvents.FETCH, {})
        expect.fail('Expected error')
      } catch (error) {
        expect(error).to.be.instanceOf(VcError)
        if (error instanceof VcError) {
          expect(error.code).to.equal(VcErrorCode.NO_REMOTE)
          expect(error.message).to.include('No remote configured.')
          expect(error.message).to.include('brv vc fetch')
          expect(error.message).to.not.include('brv vc push')
        }
      }
    })

    it('should throw VcError NETWORK_ERROR when fetch fails with HttpError', async () => {
      const deps = makeDeps(sandbox, projectPath)
      const mockToken = new AuthToken({
        accessToken: 'test-acc',
        expiresAt: new Date(Date.now() + 3_600_000),
        refreshToken: 'test-ref',
        sessionKey: 'sess-123',
        userEmail: 'test@example.com',
        userId: 'u1',
      })
      deps.tokenStore.load.resolves(mockToken)
      deps.gitService.isInitialized.resolves(true)
      deps.gitService.listRemotes.resolves([{remote: 'origin', url: 'https://example.com/repo.git'}])
      const httpError = Object.assign(new Error('HTTP Error: 503 Service Unavailable'), {code: 'HttpError'})
      deps.gitService.fetch.rejects(httpError)
      makeVcHandler(deps).setup()

      try {
        await invoke<IVcFetchResponse>(deps, VcEvents.FETCH, {})
        expect.fail('Expected error')
      } catch (error) {
        expect(error).to.be.instanceOf(VcError)
        if (error instanceof VcError) {
          expect(error.code).to.equal(VcErrorCode.NETWORK_ERROR)
          expect(error.message).to.equal('HTTP Error: 503 Service Unavailable')
        }
      }
    })

    it('should throw VcError INVALID_REF when fetch fails with NotFoundError', async () => {
      const deps = makeDeps(sandbox, projectPath)
      const mockToken = new AuthToken({
        accessToken: 'test-acc',
        expiresAt: new Date(Date.now() + 3_600_000),
        refreshToken: 'test-ref',
        sessionKey: 'sess-123',
        userEmail: 'test@example.com',
        userId: 'u1',
      })
      deps.tokenStore.load.resolves(mockToken)
      deps.gitService.isInitialized.resolves(true)
      deps.gitService.listRemotes.resolves([{remote: 'origin', url: 'https://example.com/repo.git'}])
      const notFoundError = Object.assign(new Error('Could not find ref "refs/heads/missing"'), {code: 'NotFoundError'})
      deps.gitService.fetch.rejects(notFoundError)
      makeVcHandler(deps).setup()

      try {
        await invoke<IVcFetchResponse>(deps, VcEvents.FETCH, {})
        expect.fail('Expected error')
      } catch (error) {
        expect(error).to.be.instanceOf(VcError)
        if (error instanceof VcError) {
          expect(error.code).to.equal(VcErrorCode.INVALID_REF)
          expect(error.message).to.include('missing')
        }
      }
    })
  })

  describe('handlePull with explicit args', () => {
    it('should pull with explicit branch and remote', async () => {
      const deps = makeDeps(sandbox, projectPath)
      deps.gitService.isInitialized.resolves(true)
      deps.gitService.listRemotes.resolves([{remote: 'origin', url: 'https://example.com/repo.git'}])
      deps.gitService.pull.resolves({alreadyUpToDate: false, success: true})
      makeVcHandler(deps).setup()

      const result = await invoke<IVcPullResponse>(deps, VcEvents.PULL, {branch: 'main', remote: 'origin'})

      expect(result.branch).to.equal('main')
      expect(deps.gitService.pull.calledOnce).to.be.true
      expect(deps.gitService.pull.firstCall.args[0]).to.deep.include({branch: 'main', remote: 'origin'})
    })

    it('should skip tracking resolution when explicit branch is given', async () => {
      const deps = makeDeps(sandbox, projectPath)
      deps.gitService.isInitialized.resolves(true)
      deps.gitService.listRemotes.resolves([{remote: 'origin', url: 'https://example.com/repo.git'}])
      deps.gitService.pull.resolves({alreadyUpToDate: false, success: true})
      // No tracking configured — would error without explicit branch
      deps.gitService.getTrackingBranch.resolves()
      makeVcHandler(deps).setup()

      const result = await invoke<IVcPullResponse>(deps, VcEvents.PULL, {branch: 'main', remote: 'origin'})

      expect(result.branch).to.equal('main')
      // getTrackingBranch should NOT have been called
      expect(deps.gitService.getTrackingBranch.called).to.be.false
    })

    it('should throw NO_BRANCH_RESOLVED when empty repo has no current branch and no explicit branch', async () => {
      const deps = makeDeps(sandbox, projectPath)
      deps.gitService.isInitialized.resolves(true)
      deps.gitService.listRemotes.resolves([{remote: 'origin', url: 'https://example.com/repo.git'}])
      // Empty repo: getCurrentBranch returns undefined (no HEAD target)
      deps.gitService.getCurrentBranch.resolves()
      makeVcHandler(deps).setup()

      try {
        await invoke<IVcPullResponse>(deps, VcEvents.PULL, {})
        expect.fail('Expected error')
      } catch (error) {
        expect(error).to.be.instanceOf(VcError)
        if (error instanceof VcError) {
          expect(error.code).to.equal(VcErrorCode.NO_BRANCH_RESOLVED)
        }
      }
    })

    it('should succeed on empty repo when explicit branch is provided', async () => {
      const deps = makeDeps(sandbox, projectPath)
      deps.gitService.isInitialized.resolves(true)
      deps.gitService.listRemotes.resolves([{remote: 'origin', url: 'https://example.com/repo.git'}])
      // Empty repo: no current branch, no tracking — but explicit branch bypasses resolution
      deps.gitService.getCurrentBranch.resolves()
      deps.gitService.pull.resolves({alreadyUpToDate: false, success: true})
      makeVcHandler(deps).setup()

      const result = await invoke<IVcPullResponse>(deps, VcEvents.PULL, {branch: 'main', remote: 'origin'})

      expect(result.branch).to.equal('main')
      expect(result.alreadyUpToDate).to.be.false
      // Handler should NOT have attempted branch resolution
      expect(deps.gitService.getTrackingBranch.called).to.be.false
    })
  })

  describe('handleBranch set-upstream', () => {
    it('should set upstream tracking for current branch', async () => {
      const deps = makeDeps(sandbox, projectPath)
      deps.gitService.isInitialized.resolves(true)
      deps.gitService.getCurrentBranch.resolves('main')
      deps.gitService.listBranches.resolves([{isCurrent: false, isRemote: true, name: 'origin/main'}])
      deps.gitService.setTrackingBranch.resolves()
      makeVcHandler(deps).setup()

      const result = await invoke<IVcBranchResponse>(deps, VcEvents.BRANCH, {
        action: 'set-upstream',
        upstream: 'origin/main',
      } satisfies IVcBranchRequest)

      expect(result).to.deep.include({action: 'set-upstream', branch: 'main', upstream: 'origin/main'})
      expect(deps.gitService.setTrackingBranch.calledOnce).to.be.true
      expect(deps.gitService.setTrackingBranch.firstCall.args[0]).to.deep.include({
        branch: 'main',
        remote: 'origin',
        remoteBranch: 'main',
      })
    })

    it('should reject invalid upstream format without slash', async () => {
      const deps = makeDeps(sandbox, projectPath)
      deps.gitService.isInitialized.resolves(true)
      makeVcHandler(deps).setup()

      try {
        await invoke<IVcBranchResponse>(deps, VcEvents.BRANCH, {
          action: 'set-upstream',
          upstream: 'main',
        } satisfies IVcBranchRequest)
        expect.fail('Expected error')
      } catch (error) {
        expect(error).to.be.instanceOf(VcError)
        if (error instanceof VcError) expect(error.code).to.equal(VcErrorCode.INVALID_BRANCH_NAME)
      }
    })

    it('should throw NO_REMOTE when remote does not exist', async () => {
      const deps = makeDeps(sandbox, projectPath)
      deps.gitService.isInitialized.resolves(true)
      deps.gitService.getCurrentBranch.resolves('main')
      deps.gitService.listRemotes.resolves([])
      makeVcHandler(deps).setup()

      try {
        await invoke<IVcBranchResponse>(deps, VcEvents.BRANCH, {
          action: 'set-upstream',
          upstream: 'origin/main',
        } satisfies IVcBranchRequest)
        expect.fail('Expected error')
      } catch (error) {
        expect(error).to.be.instanceOf(VcError)
        if (error instanceof VcError) expect(error.code).to.equal(VcErrorCode.NO_REMOTE)
      }
    })

    it('should throw BRANCH_NOT_FOUND when remote-tracking branch does not exist', async () => {
      const deps = makeDeps(sandbox, projectPath)
      deps.gitService.isInitialized.resolves(true)
      deps.gitService.getCurrentBranch.resolves('main')
      deps.gitService.listRemotes.resolves([{remote: 'origin', url: 'https://example.com/repo.git'}])
      deps.gitService.listBranches.resolves([])
      makeVcHandler(deps).setup()

      try {
        await invoke<IVcBranchResponse>(deps, VcEvents.BRANCH, {
          action: 'set-upstream',
          upstream: 'origin/nonexistent',
        } satisfies IVcBranchRequest)
        expect.fail('Expected error')
      } catch (error) {
        expect(error).to.be.instanceOf(VcError)
        if (error instanceof VcError) expect(error.code).to.equal(VcErrorCode.BRANCH_NOT_FOUND)
      }
    })
  })

  describe('handlePush — set upstream before push', () => {
    it('should set tracking even when push fails with non_fast_forward', async () => {
      const deps = makeDeps(sandbox, projectPath)
      deps.gitService.isInitialized.resolves(true)
      deps.gitService.listRemotes.resolves([{remote: 'origin', url: 'https://example.com/repo.git'}])
      deps.gitService.log.resolves([
        {author: {email: 'a@b.com', name: 'A'}, message: 'init', sha: 'abc', timestamp: new Date()},
      ])
      deps.gitService.push.resolves({reason: 'non_fast_forward', success: false})
      deps.gitService.getTrackingBranch.resolves()
      deps.gitService.setTrackingBranch.resolves()
      makeVcHandler(deps).setup()

      try {
        await deps.requestHandlers[VcEvents.PUSH]({branch: 'main', setUpstream: true}, CLIENT_ID)
        expect.fail('Expected error')
      } catch (error) {
        expect(error).to.be.instanceOf(VcError)
        if (error instanceof VcError) expect(error.code).to.equal(VcErrorCode.NON_FAST_FORWARD)
      }

      // Tracking should have been set BEFORE push failed
      expect(deps.gitService.setTrackingBranch.calledOnce).to.be.true
      expect(deps.gitService.setTrackingBranch.firstCall.args[0]).to.deep.include({
        branch: 'main',
        remote: 'origin',
        remoteBranch: 'main',
      })
    })
  })

  describe('handleStatus — conflict marker files', () => {
    it('should include conflictMarkerFiles when files have conflict markers', async () => {
      const deps = makeDeps(sandbox, projectPath)
      deps.gitService.isInitialized.resolves(true)
      deps.gitService.getCurrentBranch.resolves('main')
      deps.gitService.status.resolves({files: [], isClean: true})
      deps.gitService.getFilesWithConflictMarkers.resolves(['code_style/context.md'])
      makeVcHandler(deps).setup()

      const result = await deps.requestHandlers[VcEvents.STATUS]({}, CLIENT_ID)

      expect(result).to.have.property('conflictMarkerFiles').that.deep.equals(['code_style/context.md'])
    })

    it('should set conflictMarkerFiles to undefined when no conflict markers found', async () => {
      const deps = makeDeps(sandbox, projectPath)
      deps.gitService.isInitialized.resolves(true)
      deps.gitService.getCurrentBranch.resolves('main')
      deps.gitService.status.resolves({files: [], isClean: true})
      deps.gitService.getFilesWithConflictMarkers.resolves([])
      makeVcHandler(deps).setup()

      const result = await invoke<IVcStatusResponse>(deps, VcEvents.STATUS, {})

      expect(result.conflictMarkerFiles).to.be.undefined
    })
  })

  describe('handlePush — conflict marker blocking', () => {
    it('should throw CONFLICT_MARKERS_PRESENT when conflict markers exist', async () => {
      const deps = makeDeps(sandbox, projectPath)
      deps.gitService.isInitialized.resolves(true)
      deps.gitService.listRemotes.resolves([{remote: 'origin', url: 'https://example.com/repo.git'}])
      deps.gitService.log.resolves([
        {author: {email: 'a@b.com', name: 'A'}, message: 'init', sha: 'abc', timestamp: new Date()},
      ])
      deps.gitService.getFilesWithConflictMarkers.resolves(['code_style/context.md'])
      deps.gitService.getTrackingBranch.resolves({remote: 'origin', remoteBranch: 'main'})
      makeVcHandler(deps).setup()

      try {
        await deps.requestHandlers[VcEvents.PUSH]({}, CLIENT_ID)
        expect.fail('Expected error')
      } catch (error) {
        expect(error).to.be.instanceOf(VcError)
        if (error instanceof VcError) {
          expect(error.code).to.equal(VcErrorCode.CONFLICT_MARKERS_PRESENT)
          expect(error.message).to.include('code_style/context.md')
        }
      }

      expect(deps.gitService.push.called).to.be.false
    })

    it('should allow push when no conflict markers exist', async () => {
      const deps = makeDeps(sandbox, projectPath)
      deps.gitService.isInitialized.resolves(true)
      deps.gitService.listRemotes.resolves([{remote: 'origin', url: 'https://example.com/repo.git'}])
      deps.gitService.log.resolves([
        {author: {email: 'a@b.com', name: 'A'}, message: 'init', sha: 'abc', timestamp: new Date()},
      ])
      deps.gitService.getFilesWithConflictMarkers.resolves([])
      deps.gitService.push.resolves({success: true})
      deps.gitService.getTrackingBranch.resolves({remote: 'origin', remoteBranch: 'main'})
      makeVcHandler(deps).setup()

      const result = await deps.requestHandlers[VcEvents.PUSH]({}, CLIENT_ID)

      expect(deps.gitService.push.calledOnce).to.be.true
      expect(result).to.deep.include({branch: 'main'})
    })
  })

  describe('handleReset', () => {
    it('should throw GIT_NOT_INITIALIZED when git not initialized', async () => {
      const deps = makeDeps(sandbox, projectPath)
      deps.gitService.isInitialized.resolves(false)
      makeVcHandler(deps).setup()

      try {
        await invoke<IVcResetResponse>(deps, VcEvents.RESET, {})
        expect.fail('Expected error')
      } catch (error) {
        expect(error).to.be.instanceOf(VcError)
        if (error instanceof VcError) {
          expect(error.code).to.equal(VcErrorCode.GIT_NOT_INITIALIZED)
        }
      }
    })

    it('should delegate unstage all to gitService.reset with no mode/ref', async () => {
      const deps = makeDeps(sandbox, projectPath)
      deps.gitService.isInitialized.resolves(true)
      deps.gitService.reset.resolves({filesChanged: 3, headSha: 'abc123'})
      makeVcHandler(deps).setup()

      const result = await invoke<IVcResetResponse>(deps, VcEvents.RESET, {})

      expect(deps.gitService.reset.calledOnce).to.be.true
      expect(result).to.deep.equal({filesUnstaged: 3, headSha: undefined, mode: 'mixed'})
    })

    it('should delegate unstage specific files to gitService.reset with filePaths', async () => {
      const deps = makeDeps(sandbox, projectPath)
      deps.gitService.isInitialized.resolves(true)
      deps.gitService.reset.resolves({filesChanged: 1, headSha: 'abc123'})
      makeVcHandler(deps).setup()

      const result = await invoke<IVcResetResponse>(deps, VcEvents.RESET, {filePaths: ['notes.md']})

      expect(deps.gitService.reset.calledOnce).to.be.true
      const callArgs = deps.gitService.reset.firstCall.args[0]
      expect(callArgs.filePaths).to.deep.equal(['notes.md'])
      expect(result).to.deep.equal({filesUnstaged: 1, headSha: undefined, mode: 'mixed'})
    })

    it('should delegate soft reset to gitService.reset with mode and ref', async () => {
      const deps = makeDeps(sandbox, projectPath)
      deps.gitService.isInitialized.resolves(true)
      deps.gitService.reset.resolves({filesChanged: 0, headSha: 'def456'})
      makeVcHandler(deps).setup()

      const result = await invoke<IVcResetResponse>(deps, VcEvents.RESET, {mode: 'soft', ref: 'HEAD~1'})

      expect(deps.gitService.reset.calledOnce).to.be.true
      const callArgs = deps.gitService.reset.firstCall.args[0]
      expect(callArgs.mode).to.equal('soft')
      expect(callArgs.ref).to.equal('HEAD~1')
      expect(result).to.deep.equal({filesUnstaged: undefined, headSha: 'def456', mode: 'soft'})
    })

    it('should delegate soft reset without ref (defaults to HEAD)', async () => {
      const deps = makeDeps(sandbox, projectPath)
      deps.gitService.isInitialized.resolves(true)
      deps.gitService.reset.resolves({filesChanged: 0, headSha: 'abc123'})
      makeVcHandler(deps).setup()

      const result = await invoke<IVcResetResponse>(deps, VcEvents.RESET, {mode: 'soft'})

      expect(deps.gitService.reset.calledOnce).to.be.true
      const callArgs = deps.gitService.reset.firstCall.args[0]
      expect(callArgs.mode).to.equal('soft')
      expect(callArgs.ref).to.be.undefined
      expect(result).to.deep.equal({filesUnstaged: undefined, headSha: 'abc123', mode: 'soft'})
    })

    it('should delegate hard reset to gitService.reset with mode and ref', async () => {
      const deps = makeDeps(sandbox, projectPath)
      deps.gitService.isInitialized.resolves(true)
      deps.gitService.reset.resolves({filesChanged: 2, headSha: 'def456'})
      makeVcHandler(deps).setup()

      const result = await invoke<IVcResetResponse>(deps, VcEvents.RESET, {mode: 'hard', ref: 'HEAD~1'})

      expect(deps.gitService.reset.calledOnce).to.be.true
      const callArgs = deps.gitService.reset.firstCall.args[0]
      expect(callArgs.mode).to.equal('hard')
      expect(callArgs.ref).to.equal('HEAD~1')
      expect(result).to.deep.equal({filesUnstaged: undefined, headSha: 'def456', mode: 'hard'})
    })

    it('should delegate hard reset without ref (defaults to HEAD)', async () => {
      const deps = makeDeps(sandbox, projectPath)
      deps.gitService.isInitialized.resolves(true)
      deps.gitService.reset.resolves({filesChanged: 2, headSha: 'abc123'})
      makeVcHandler(deps).setup()

      const result = await invoke<IVcResetResponse>(deps, VcEvents.RESET, {mode: 'hard'})

      expect(deps.gitService.reset.calledOnce).to.be.true
      const callArgs = deps.gitService.reset.firstCall.args[0]
      expect(callArgs.mode).to.equal('hard')
      expect(callArgs.ref).to.be.undefined
      expect(result).to.deep.equal({filesUnstaged: undefined, headSha: 'abc123', mode: 'hard'})
    })

    it('should map INVALID_REF error from gitService', async () => {
      const deps = makeDeps(sandbox, projectPath)
      deps.gitService.isInitialized.resolves(true)
      deps.gitService.reset.rejects(new GitError("Cannot resolve 'HEAD~5': not enough ancestors."))
      makeVcHandler(deps).setup()

      try {
        await invoke<IVcResetResponse>(deps, VcEvents.RESET, {mode: 'soft', ref: 'HEAD~5'})
        expect.fail('Expected error')
      } catch (error) {
        expect(error).to.be.instanceOf(VcError)
        if (error instanceof VcError) {
          expect(error.code).to.equal(VcErrorCode.INVALID_REF)
        }
      }
    })

    it('should map detached HEAD error from gitService', async () => {
      const deps = makeDeps(sandbox, projectPath)
      deps.gitService.isInitialized.resolves(true)
      deps.gitService.reset.rejects(new GitError('Cannot reset in detached HEAD state.'))
      makeVcHandler(deps).setup()

      try {
        await invoke<IVcResetResponse>(deps, VcEvents.RESET, {mode: 'soft', ref: 'HEAD~1'})
        expect.fail('Expected error')
      } catch (error) {
        expect(error).to.be.instanceOf(VcError)
        if (error instanceof VcError) {
          expect(error.code).to.equal(VcErrorCode.INVALID_ACTION)
        }
      }
    })

    it('should map FILE_NOT_FOUND error when resetting non-existent file', async () => {
      const deps = makeDeps(sandbox, projectPath)
      deps.gitService.isInitialized.resolves(true)
      deps.gitService.reset.rejects(new GitError("pathspec 'ghost.txt' did not match any file(s) known to git"))
      makeVcHandler(deps).setup()

      try {
        await invoke<IVcResetResponse>(deps, VcEvents.RESET, {filePaths: ['ghost.txt']})
        expect.fail('Expected error')
      } catch (error) {
        expect(error).to.be.instanceOf(VcError)
        if (error instanceof VcError) {
          expect(error.code).to.equal(VcErrorCode.FILE_NOT_FOUND)
        }
      }
    })

    it('should block soft reset during active merge', async () => {
      const deps = makeMergeDeps(sandbox, {mergeHead: true})
      deps.gitService.isInitialized.resolves(true)
      makeVcHandler(deps).setup()

      try {
        await invoke<IVcResetResponse>(deps, VcEvents.RESET, {mode: 'soft', ref: 'HEAD~1'})
        expect.fail('Expected error')
      } catch (error) {
        expect(error).to.be.instanceOf(VcError)
        if (error instanceof VcError) {
          expect(error.code).to.equal(VcErrorCode.MERGE_IN_PROGRESS)
        }
      } finally {
        cleanupDir(deps.tmpDir)
      }
    })

    it('should allow hard reset during active merge', async () => {
      const deps = makeMergeDeps(sandbox, {mergeHead: true})
      deps.gitService.isInitialized.resolves(true)
      deps.gitService.reset.resolves({filesChanged: 1, headSha: 'abc123'})
      makeVcHandler(deps).setup()

      try {
        const result = await invoke<IVcResetResponse>(deps, VcEvents.RESET, {mode: 'hard', ref: 'HEAD~1'})
        expect(result.mode).to.equal('hard')
        expect(result.headSha).to.equal('abc123')
      } finally {
        cleanupDir(deps.tmpDir)
      }
    })

    it('should allow unstage during active merge', async () => {
      const deps = makeMergeDeps(sandbox, {mergeHead: true})
      deps.gitService.isInitialized.resolves(true)
      deps.gitService.reset.resolves({filesChanged: 2, headSha: ''})
      makeVcHandler(deps).setup()

      try {
        const result = await invoke<IVcResetResponse>(deps, VcEvents.RESET, {})
        expect(result.mode).to.equal('mixed')
        expect(result.filesUnstaged).to.equal(2)
      } finally {
        cleanupDir(deps.tmpDir)
      }
    })
  })

  describe('handleDiff', () => {
    // eslint-disable-next-line unicorn/consistent-function-scoping
    function makeDiffDeps(sb: SinonSandbox): TestDeps & {tmpDir: string} {
      const tmpDir = join(tmpdir(), `brv-vc-diff-test-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`)
      mkdirSync(tmpDir, {recursive: true})
      const deps = makeDeps(sb, projectPath)
      deps.contextTreeService.resolvePath.returns(tmpDir)
      return {...deps, tmpDir}
    }

    it('should register vc:diff handler', () => {
      const deps = makeDeps(sandbox, projectPath)
      makeVcHandler(deps).setup()

      const registeredEvents = deps.transport.onRequest.args.map((args: unknown[]) => args[0])
      expect(registeredEvents).to.include(VcEvents.DIFF)
    })

    it('should throw GIT_NOT_INITIALIZED when git repo is missing', async () => {
      const deps = makeDeps(sandbox, projectPath)
      deps.gitService.isInitialized.resolves(false)
      makeVcHandler(deps).setup()

      let caught: unknown
      try {
        await invoke(deps, VcEvents.DIFF, {path: 'foo.md', side: 'staged'})
      } catch (error) {
        caught = error
      }

      expect(caught).to.be.instanceOf(VcError)
      expect((caught as VcError).code).to.equal(VcErrorCode.GIT_NOT_INITIALIZED)
    })

    it('staged: should compare HEAD blob (old) against index blob (new)', async () => {
      const deps = makeDiffDeps(sandbox)
      try {
        deps.gitService.getBlobContent
          .withArgs({directory: deps.tmpDir, path: 'foo.md', ref: {commitish: 'HEAD'}})
          .resolves('old content')
        deps.gitService.getBlobContent
          .withArgs({directory: deps.tmpDir, path: 'foo.md', ref: 'STAGE'})
          .resolves('new content')
        makeVcHandler(deps).setup()

        const result = await invoke<{newContent: string; oldContent: string; path: string}>(deps, VcEvents.DIFF, {
          path: 'foo.md',
          side: 'staged',
        })

        expect(result.path).to.equal('foo.md')
        expect(result.oldContent).to.equal('old content')
        expect(result.newContent).to.equal('new content')
      } finally {
        cleanupDir(deps.tmpDir)
      }
    })

    it('unstaged: should compare index blob (old) against working tree (new)', async () => {
      const deps = makeDiffDeps(sandbox)
      try {
        writeFileSync(join(deps.tmpDir, 'foo.md'), 'working tree content')
        deps.gitService.getBlobContent
          .withArgs({directory: deps.tmpDir, path: 'foo.md', ref: 'STAGE'})
          .resolves('staged content')
        makeVcHandler(deps).setup()

        const result = await invoke<{newContent: string; oldContent: string; path: string}>(deps, VcEvents.DIFF, {
          path: 'foo.md',
          side: 'unstaged',
        })

        expect(result.oldContent).to.equal('staged content')
        expect(result.newContent).to.equal('working tree content')
      } finally {
        cleanupDir(deps.tmpDir)
      }
    })

    it('unstaged untracked: old is empty, new is file on disk', async () => {
      const deps = makeDiffDeps(sandbox)
      try {
        writeFileSync(join(deps.tmpDir, 'new-file.md'), 'brand new')
        // File not in index → getBlobContent returns undefined
        deps.gitService.getBlobContent.resolves()
        makeVcHandler(deps).setup()

        const result = await invoke<{newContent: string; oldContent: string; path: string}>(deps, VcEvents.DIFF, {
          path: 'new-file.md',
          side: 'unstaged',
        })

        expect(result.oldContent).to.equal('')
        expect(result.newContent).to.equal('brand new')
      } finally {
        cleanupDir(deps.tmpDir)
      }
    })

    it('unstaged deleted: old is index content, new is empty (file missing)', async () => {
      const deps = makeDiffDeps(sandbox)
      try {
        // No file on disk, but index has the blob
        deps.gitService.getBlobContent
          .withArgs({directory: deps.tmpDir, path: 'gone.md', ref: 'STAGE'})
          .resolves('old content')
        makeVcHandler(deps).setup()

        const result = await invoke<{newContent: string; oldContent: string; path: string}>(deps, VcEvents.DIFF, {
          path: 'gone.md',
          side: 'unstaged',
        })

        expect(result.oldContent).to.equal('old content')
        expect(result.newContent).to.equal('')
      } finally {
        cleanupDir(deps.tmpDir)
      }
    })

    it('staged added: HEAD has no blob → old is empty', async () => {
      const deps = makeDiffDeps(sandbox)
      try {
        deps.gitService.getBlobContent
          .withArgs({directory: deps.tmpDir, path: 'new.md', ref: {commitish: 'HEAD'}})
          .resolves()
        deps.gitService.getBlobContent
          .withArgs({directory: deps.tmpDir, path: 'new.md', ref: 'STAGE'})
          .resolves('new staged content')
        makeVcHandler(deps).setup()

        const result = await invoke<{newContent: string; oldContent: string; path: string}>(deps, VcEvents.DIFF, {
          path: 'new.md',
          side: 'staged',
        })

        expect(result.oldContent).to.equal('')
        expect(result.newContent).to.equal('new staged content')
      } finally {
        cleanupDir(deps.tmpDir)
      }
    })
  })

  describe('handleDiscard', () => {
    // eslint-disable-next-line unicorn/consistent-function-scoping
    function makeDiscardDeps(
      sb: SinonSandbox,
    ): TestDeps & {tmpDir: string; unlinkStub: SinonStub; writeFileStub: SinonStub} {
      const tmpDir = join(tmpdir(), `brv-vc-discard-test-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`)
      mkdirSync(tmpDir, {recursive: true})
      const deps = makeDeps(sb, projectPath)
      deps.contextTreeService.resolvePath.returns(tmpDir)

      // `fs.promises.writeFile` is already stubbed in the outer beforeEach.
      const writeFileStub = fs.promises.writeFile as unknown as SinonStub
      const unlinkStub = sb.stub(fs.promises, 'unlink').resolves()

      return {...deps, tmpDir, unlinkStub, writeFileStub}
    }

    it('should register vc:discard handler', () => {
      const deps = makeDeps(sandbox, projectPath)
      makeVcHandler(deps).setup()

      const registeredEvents = deps.transport.onRequest.args.map((args: unknown[]) => args[0])
      expect(registeredEvents).to.include(VcEvents.DISCARD)
    })

    it('should throw GIT_NOT_INITIALIZED when git repo is missing', async () => {
      const deps = makeDeps(sandbox, projectPath)
      deps.gitService.isInitialized.resolves(false)
      makeVcHandler(deps).setup()

      let caught: unknown
      try {
        await invoke(deps, VcEvents.DISCARD, {filePaths: ['foo.md']})
      } catch (error) {
        caught = error
      }

      expect(caught).to.be.instanceOf(VcError)
      expect((caught as VcError).code).to.equal(VcErrorCode.GIT_NOT_INITIALIZED)
    })

    it('should restore tracked file from index blob', async () => {
      const deps = makeDiscardDeps(sandbox)
      try {
        deps.gitService.getBlobContents
          .withArgs({directory: deps.tmpDir, paths: ['foo.md'], ref: 'STAGE'})
          .resolves({'foo.md': 'index content'})
        makeVcHandler(deps).setup()

        const result = await invoke<{count: number}>(deps, VcEvents.DISCARD, {filePaths: ['foo.md']})

        expect(result.count).to.equal(1)
        expect(deps.writeFileStub.calledOnce).to.be.true
        expect(deps.writeFileStub.firstCall.args[0]).to.equal(join(deps.tmpDir, 'foo.md'))
        expect(deps.writeFileStub.firstCall.args[1]).to.equal('index content')
        expect(deps.unlinkStub.called).to.be.false
      } finally {
        cleanupDir(deps.tmpDir)
      }
    })

    it('should restore tracked file from HEAD when index has no blob', async () => {
      const deps = makeDiscardDeps(sandbox)
      try {
        deps.gitService.getBlobContents
          .withArgs({directory: deps.tmpDir, paths: ['foo.md'], ref: 'STAGE'})
          .resolves({'foo.md': undefined})
        deps.gitService.getBlobContents
          .withArgs({directory: deps.tmpDir, paths: ['foo.md'], ref: {commitish: 'HEAD'}})
          .resolves({'foo.md': 'head content'})
        makeVcHandler(deps).setup()

        const result = await invoke<{count: number}>(deps, VcEvents.DISCARD, {filePaths: ['foo.md']})

        expect(result.count).to.equal(1)
        expect(deps.writeFileStub.calledOnceWith(join(deps.tmpDir, 'foo.md'), 'head content')).to.be.true
        expect(deps.unlinkStub.called).to.be.false
      } finally {
        cleanupDir(deps.tmpDir)
      }
    })

    it('should delete untracked file (no blob in index or HEAD)', async () => {
      const deps = makeDiscardDeps(sandbox)
      try {
        writeFileSync(join(deps.tmpDir, 'untracked.md'), 'new content')
        deps.gitService.getBlobContents.resolves({'untracked.md': undefined})
        makeVcHandler(deps).setup()

        const result = await invoke<{count: number}>(deps, VcEvents.DISCARD, {filePaths: ['untracked.md']})

        expect(result.count).to.equal(1)
        expect(deps.unlinkStub.calledOnce).to.be.true
        expect(deps.unlinkStub.firstCall.args[0]).to.equal(join(deps.tmpDir, 'untracked.md'))
        expect(deps.writeFileStub.called).to.be.false
      } finally {
        cleanupDir(deps.tmpDir)
      }
    })

    it('should discard multiple files in a single request', async () => {
      const deps = makeDiscardDeps(sandbox)
      try {
        deps.gitService.getBlobContents
          .withArgs({directory: deps.tmpDir, paths: ['a.md', 'b.md'], ref: 'STAGE'})
          .resolves({'a.md': 'a index', 'b.md': 'b index'})
        makeVcHandler(deps).setup()

        const result = await invoke<{count: number}>(deps, VcEvents.DISCARD, {filePaths: ['a.md', 'b.md']})

        expect(result.count).to.equal(2)
        expect(deps.writeFileStub.callCount).to.equal(2)
      } finally {
        cleanupDir(deps.tmpDir)
      }
    })

    it('count reflects only successful operations (writeFile failure → not counted)', async () => {
      const deps = makeDiscardDeps(sandbox)
      try {
        deps.gitService.getBlobContents
          .withArgs({directory: deps.tmpDir, paths: ['ok.md', 'fail.md'], ref: 'STAGE'})
          .resolves({'fail.md': 'will fail', 'ok.md': 'will succeed'})
        deps.writeFileStub.withArgs(join(deps.tmpDir, 'fail.md'), 'will fail').rejects(new Error('disk full'))
        deps.writeFileStub.withArgs(join(deps.tmpDir, 'ok.md'), 'will succeed').resolves()
        makeVcHandler(deps).setup()

        const result = await invoke<{count: number}>(deps, VcEvents.DISCARD, {filePaths: ['ok.md', 'fail.md']})

        expect(result.count).to.equal(1)
      } finally {
        cleanupDir(deps.tmpDir)
      }
    })

    it('count reflects only successful operations (unlink failure → not counted)', async () => {
      const deps = makeDiscardDeps(sandbox)
      try {
        deps.gitService.getBlobContents.resolves({'absent.md': undefined, 'present.md': undefined})
        deps.unlinkStub.withArgs(join(deps.tmpDir, 'absent.md')).rejects(new Error('ENOENT'))
        deps.unlinkStub.withArgs(join(deps.tmpDir, 'present.md')).resolves()
        makeVcHandler(deps).setup()

        const result = await invoke<{count: number}>(deps, VcEvents.DISCARD, {filePaths: ['present.md', 'absent.md']})

        expect(result.count).to.equal(1)
      } finally {
        cleanupDir(deps.tmpDir)
      }
    })

    it('should return count=0 and do nothing for empty filePaths', async () => {
      const deps = makeDiscardDeps(sandbox)
      try {
        makeVcHandler(deps).setup()

        const result = await invoke<{count: number}>(deps, VcEvents.DISCARD, {filePaths: []})

        expect(result.count).to.equal(0)
        expect(deps.writeFileStub.called).to.be.false
        expect(deps.unlinkStub.called).to.be.false
      } finally {
        cleanupDir(deps.tmpDir)
      }
    })
  })

  describe('handleDiffs', () => {
    // eslint-disable-next-line unicorn/consistent-function-scoping
    function makeDiffsDeps(sb: SinonSandbox): TestDeps & {tmpDir: string} {
      const tmpDir = join(tmpdir(), `brv-vc-diffs-test-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`)
      mkdirSync(tmpDir, {recursive: true})
      const deps = makeDeps(sb, projectPath)
      deps.contextTreeService.resolvePath.returns(tmpDir)
      return {...deps, tmpDir}
    }

    it('should register vc:diffs handler', () => {
      const deps = makeDeps(sandbox, projectPath)
      makeVcHandler(deps).setup()

      const registeredEvents = deps.transport.onRequest.args.map((args: unknown[]) => args[0])
      expect(registeredEvents).to.include(VcEvents.DIFFS)
    })

    it('should throw GIT_NOT_INITIALIZED when git repo is missing', async () => {
      const deps = makeDeps(sandbox, projectPath)
      deps.gitService.isInitialized.resolves(false)
      makeVcHandler(deps).setup()

      let caught: unknown
      try {
        await invoke(deps, VcEvents.DIFFS, {paths: ['foo.md'], side: 'staged'})
      } catch (error) {
        caught = error
      }

      expect(caught).to.be.instanceOf(VcError)
      expect((caught as VcError).code).to.equal(VcErrorCode.GIT_NOT_INITIALIZED)
    })

    it('should return empty array when paths is empty', async () => {
      const deps = makeDiffsDeps(sandbox)
      try {
        makeVcHandler(deps).setup()

        const result = await invoke<{diffs: Array<{newContent: string; oldContent: string; path: string}>}>(
          deps,
          VcEvents.DIFFS,
          {paths: [], side: 'staged'},
        )

        expect(result.diffs).to.deep.equal([])
      } finally {
        cleanupDir(deps.tmpDir)
      }
    })

    it('staged: returns HEAD vs STAGE for every path, preserving order', async () => {
      const deps = makeDiffsDeps(sandbox)
      try {
        deps.gitService.getBlobContents
          .withArgs({directory: deps.tmpDir, paths: ['a.md', 'b.md'], ref: {commitish: 'HEAD'}})
          .resolves({'a.md': 'a head', 'b.md': 'b head'})
        deps.gitService.getBlobContents
          .withArgs({directory: deps.tmpDir, paths: ['a.md', 'b.md'], ref: 'STAGE'})
          .resolves({'a.md': 'a stage', 'b.md': 'b stage'})
        makeVcHandler(deps).setup()

        const result = await invoke<{diffs: Array<{newContent: string; oldContent: string; path: string}>}>(
          deps,
          VcEvents.DIFFS,
          {paths: ['a.md', 'b.md'], side: 'staged'},
        )

        expect(result.diffs).to.have.length(2)
        expect(result.diffs[0]).to.deep.equal({
          newContent: 'a stage',
          oldContent: 'a head',
          path: 'a.md',
          status: 'modified',
        })
        expect(result.diffs[1]).to.deep.equal({
          newContent: 'b stage',
          oldContent: 'b head',
          path: 'b.md',
          status: 'modified',
        })
      } finally {
        cleanupDir(deps.tmpDir)
      }
    })

    it('staged: reports `modified` (not `added`) when HEAD blob is empty but STAGE has content', async () => {
      const deps = makeDiffsDeps(sandbox)
      try {
        deps.gitService.getBlobContents
          .withArgs({directory: deps.tmpDir, paths: ['empty.md'], ref: {commitish: 'HEAD'}})
          .resolves({'empty.md': ''})
        deps.gitService.getBlobContents
          .withArgs({directory: deps.tmpDir, paths: ['empty.md'], ref: 'STAGE'})
          .resolves({'empty.md': 'now has content\n'})
        makeVcHandler(deps).setup()

        const result = await invoke<{
          diffs: Array<{newContent: string; oldContent: string; path: string; status: string}>
        }>(deps, VcEvents.DIFFS, {paths: ['empty.md'], side: 'staged'})

        expect(result.diffs).to.have.length(1)
        expect(result.diffs[0].status).to.equal('modified')
        expect(result.diffs[0].oldContent).to.equal('')
        expect(result.diffs[0].newContent).to.equal('now has content\n')
      } finally {
        cleanupDir(deps.tmpDir)
      }
    })

    it('unstaged: returns STAGE vs working tree for every path', async () => {
      const deps = makeDiffsDeps(sandbox)
      try {
        writeFileSync(join(deps.tmpDir, 'foo.md'), 'foo working')
        writeFileSync(join(deps.tmpDir, 'bar.md'), 'bar working')
        deps.gitService.getBlobContents
          .withArgs({directory: deps.tmpDir, paths: ['foo.md', 'bar.md'], ref: 'STAGE'})
          .resolves({'bar.md': 'bar stage', 'foo.md': 'foo stage'})
        makeVcHandler(deps).setup()

        const result = await invoke<{diffs: Array<{newContent: string; oldContent: string; path: string}>}>(
          deps,
          VcEvents.DIFFS,
          {paths: ['foo.md', 'bar.md'], side: 'unstaged'},
        )

        expect(result.diffs).to.have.length(2)
        expect(result.diffs[0]).to.deep.equal({
          newContent: 'foo working',
          oldContent: 'foo stage',
          path: 'foo.md',
          status: 'modified',
        })
        expect(result.diffs[1]).to.deep.equal({
          newContent: 'bar working',
          oldContent: 'bar stage',
          path: 'bar.md',
          status: 'modified',
        })
      } finally {
        cleanupDir(deps.tmpDir)
      }
    })
  })
})
