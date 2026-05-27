
import {expect} from 'chai'
import {createSandbox, type SinonSandbox, type SinonStub} from 'sinon'

import type {IAnalyticsClient} from '../../../../../src/server/core/interfaces/analytics/i-analytics-client.js'
import type {ITokenStore} from '../../../../../src/server/core/interfaces/auth/i-token-store.js'
import type {IContextTreeService} from '../../../../../src/server/core/interfaces/context-tree/i-context-tree-service.js'
import type {IGitService} from '../../../../../src/server/core/interfaces/services/i-git-service.js'
import type {ISpaceService} from '../../../../../src/server/core/interfaces/services/i-space-service.js'
import type {ITeamService} from '../../../../../src/server/core/interfaces/services/i-team-service.js'
import type {IProjectConfigStore} from '../../../../../src/server/core/interfaces/storage/i-project-config-store.js'
import type {ITransportServer, RequestHandler} from '../../../../../src/server/core/interfaces/transport/i-transport-server.js'
import type {IVcGitConfigStore} from '../../../../../src/server/core/interfaces/vc/i-vc-git-config-store.js'

import {AuthToken} from '../../../../../src/server/core/domain/entities/auth-token.js'
import {VcHandler} from '../../../../../src/server/infra/transport/handlers/vc-handler.js'
import {AnalyticsEventNames} from '../../../../../src/shared/analytics/event-names.js'
import {VcEvents} from '../../../../../src/shared/transport/events/vc-events.js'

type Stubbed<T> = {[K in keyof T]: SinonStub & T[K]}

const PROJECT_PATH = '/fake/proj'
const CLIENT_ID = 'client-1'
const sha256HexRegex = /^[0-9a-f]{64}$/

function makeFakeAnalyticsClient(): IAnalyticsClient & {trackSpy: SinonStub} {
  const trackSpy = createSandbox().stub() as SinonStub
  return {
    abort: createSandbox().stub(),
    flush: createSandbox().stub().resolves({events: []}),
    getRuntimeState: createSandbox().stub().resolves({droppedCount: 0, lastSuccessfulFlushAt: undefined, queueDepth: 0}),
    onAuthTransition: createSandbox().stub().resolves(),
    track: trackSpy,
    trackSpy,
  } as unknown as IAnalyticsClient & {trackSpy: SinonStub}
}

interface VcDeps {
  analyticsClient: IAnalyticsClient & {trackSpy: SinonStub}
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

function makeDeps(sandbox: SinonSandbox): VcDeps {
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

  const gitService: Stubbed<IGitService> = {
    abortMerge: sandbox.stub().resolves(),
    add: sandbox.stub().resolves(),
    addRemote: sandbox.stub().resolves(),
    checkout: sandbox.stub().resolves(),
    clone: sandbox.stub().resolves(),
    commit: sandbox.stub().resolves({
      author: {email: 'test@example.com', name: 'Test User'},
      message: 'test',
      sha: 'abc123',
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
    getTrackingBranch: sandbox.stub().resolves({remote: 'origin', remoteBranch: 'main'}),
    hashBlob: sandbox.stub().resolves('0000'),
    init: sandbox.stub().resolves(),
    isAncestor: sandbox.stub().resolves(true),
    isEmptyRepository: sandbox.stub().resolves(false),
    isInitialized: sandbox.stub().resolves(true),
    listBranches: sandbox.stub().resolves([{isCurrent: true, isRemote: false, name: 'main'}]),
    listChangedFiles: sandbox.stub().resolves([]),
    listRemotes: sandbox.stub().resolves([{remote: 'origin', url: 'https://byterover.dev/team/space.git'}]),
    log: sandbox.stub().resolves([{sha: 'abc', timestamp: new Date()} as never]),
    merge: sandbox.stub().resolves({success: true}),
    pull: sandbox.stub().resolves({success: true}),
    push: sandbox.stub().resolves({success: true}),
    removeRemote: sandbox.stub().resolves(),
    reset: sandbox.stub().resolves({filesChanged: 0, headSha: 'abc'}),
    setTrackingBranch: sandbox.stub().resolves(),
    status: sandbox.stub().resolves({files: [{path: 'a.md', staged: true, status: 'modified'}], isClean: false}),
  }

  const contextTreeService: Stubbed<IContextTreeService> = {
    delete: sandbox.stub().resolves(),
    exists: sandbox.stub().resolves(false),
    hasGitRepo: sandbox.stub().resolves(false),
    initialize: sandbox.stub().resolves(`${PROJECT_PATH}/.brv/context-tree`),
    resolvePath: sandbox.stub().returns(`${PROJECT_PATH}/.brv/context-tree`),
  }

  const vcGitConfigStore: Stubbed<IVcGitConfigStore> = {
    get: sandbox.stub().resolves({email: 'a@b.dev', name: 'A B'}),
    set: sandbox.stub().resolves(),
  }

  const token = new AuthToken({
    accessToken: 'a',
    expiresAt: new Date(Date.now() + 3_600_000),
    refreshToken: 'r',
    sessionKey: 's',
    userEmail: 'a@b.dev',
    userId: 'u1',
  })

  const tokenStore: Stubbed<ITokenStore> = {
    clear: sandbox.stub().resolves(),
    load: sandbox.stub().resolves(token),
    save: sandbox.stub().resolves(),
  }

  return {
    analyticsClient: makeFakeAnalyticsClient(),
    contextTreeService,
    gitService,
    projectConfigStore: {
      exists: sandbox.stub().resolves(false),
      getModifiedTime: sandbox.stub().resolves(),
      read: sandbox.stub().resolves(),
      write: sandbox.stub().resolves(),
    },
    requestHandlers,
    resolveProjectPath: sandbox.stub().returns(PROJECT_PATH),
    spaceService: {getSpaces: sandbox.stub().resolves({spaces: [], total: 0})},
    teamService: {getTeams: sandbox.stub().resolves({teams: [], total: 0})},
    tokenStore,
    transport,
    vcGitConfigStore,
  }
}

function makeHandler(deps: VcDeps): VcHandler {
  const handler = new VcHandler({
    analyticsClient: deps.analyticsClient,
    broadcastToProject: createSandbox().stub() as never,
    contextTreeService: deps.contextTreeService,
    gitRemoteBaseUrl: 'https://byterover.dev',
    gitService: deps.gitService,
    projectConfigStore: deps.projectConfigStore,
    resolveProjectPath: deps.resolveProjectPath as never,
    spaceService: deps.spaceService,
    teamService: deps.teamService,
    tokenStore: deps.tokenStore,
    transport: deps.transport,
    vcGitConfigStore: deps.vcGitConfigStore,
    webAppUrl: 'https://app.byterover.dev',
  })
  handler.setup()
  return handler
}

function invoke<T>(deps: VcDeps, event: string, data: unknown): Promise<T> {
  return deps.requestHandlers[event](data, CLIENT_ID) as Promise<T>
}

function emitsOf(deps: VcDeps, name: string): Array<{args: unknown[]}> {
  return deps.analyticsClient.trackSpy.getCalls().filter((c) => c.args[0] === name)
}

describe('VcHandler analytics emits', () => {
  let sandbox: SinonSandbox
  let deps: VcDeps

  beforeEach(() => {
    sandbox = createSandbox()
    deps = makeDeps(sandbox)
    deps.gitService.isInitialized.resolves(false)
    makeHandler(deps)
  })

  afterEach(() => sandbox.restore())

  it('emits vc_init outcome=success with had_existing_git_dir=false on fresh init', async () => {
    await invoke(deps, VcEvents.INIT, {})
    const calls = emitsOf(deps, AnalyticsEventNames.VC_INIT)
    expect(calls.length).to.equal(1)
    const props = calls[0].args[1] as {had_existing_git_dir: boolean; outcome: string; project_path_hash: string}
    expect(props.outcome).to.equal('success')
    expect(props.had_existing_git_dir).to.equal(false)
    expect(props.project_path_hash).to.match(sha256HexRegex)
  })

  it('emits vc_init had_existing_git_dir=true when repo already exists', async () => {
    deps.gitService.isInitialized.resolves(true)
    await invoke(deps, VcEvents.INIT, {})
    const calls = emitsOf(deps, AnalyticsEventNames.VC_INIT)
    expect(calls.length).to.equal(1)
    const props = calls[0].args[1] as {had_existing_git_dir: boolean; outcome: string}
    expect(props.had_existing_git_dir).to.equal(true)
  })

  it('emits vc_commit on commit success with had_message=true', async () => {
    deps.gitService.isInitialized.resolves(true)
    await invoke(deps, VcEvents.COMMIT, {message: 'feat: x'})
    const calls = emitsOf(deps, AnalyticsEventNames.VC_COMMIT)
    expect(calls.length).to.equal(1)
    const props = calls[0].args[1] as {had_message: boolean; outcome: string; project_path_hash: string}
    expect(props.outcome).to.equal('success')
    expect(props.had_message).to.equal(true)
    expect(props.project_path_hash).to.match(sha256HexRegex)
  })

  it('emits vc_fetched with remote_kind=byterover when remote points at the configured base', async () => {
    deps.gitService.isInitialized.resolves(true)
    await invoke(deps, VcEvents.FETCH, {})
    const calls = emitsOf(deps, AnalyticsEventNames.VC_FETCHED)
    expect(calls.length).to.equal(1)
    const props = calls[0].args[1] as {outcome: string; remote_kind: string}
    expect(props.outcome).to.equal('success')
    expect(props.remote_kind).to.equal('byterover')
  })

  it('emits vc_fetched with remote_kind=external when remote is unknown', async () => {
    deps.gitService.isInitialized.resolves(true)
    deps.gitService.listRemotes.resolves([{remote: 'origin', url: 'https://github.com/foo/bar.git'}])
    await invoke(deps, VcEvents.FETCH, {})
    const calls = emitsOf(deps, AnalyticsEventNames.VC_FETCHED)
    const props = calls[0].args[1] as {remote_kind: string}
    expect(props.remote_kind).to.equal('external')
  })

  it('emits vc_pushed with branch_name_hash + remote_kind on push success', async () => {
    deps.gitService.isInitialized.resolves(true)
    await invoke(deps, VcEvents.PUSH, {branch: 'feat/x'})
    const calls = emitsOf(deps, AnalyticsEventNames.VC_PUSHED)
    expect(calls.length).to.equal(1)
    const props = calls[0].args[1] as {branch_name_hash: string; outcome: string; remote_kind: string}
    expect(props.outcome).to.equal('success')
    expect(props.branch_name_hash).to.match(sha256HexRegex)
    expect(props.remote_kind).to.equal('byterover')
  })

  it('emits vc_pulled with branch_name_hash + remote_kind on pull success', async () => {
    deps.gitService.isInitialized.resolves(true)
    await invoke(deps, VcEvents.PULL, {})
    const calls = emitsOf(deps, AnalyticsEventNames.VC_PULLED)
    expect(calls.length).to.equal(1)
    const props = calls[0].args[1] as {branch_name_hash: string; remote_kind: string}
    expect(props.branch_name_hash).to.match(sha256HexRegex)
    expect(props.remote_kind).to.equal('byterover')
  })

  it('emits vc_reset_executed with reset_mode echoed from request', async () => {
    deps.gitService.isInitialized.resolves(true)
    await invoke(deps, VcEvents.RESET, {mode: 'hard'})
    const calls = emitsOf(deps, AnalyticsEventNames.VC_RESET_EXECUTED)
    const props = calls[0].args[1] as {outcome: string; reset_mode: string}
    expect(props.outcome).to.equal('success')
    expect(props.reset_mode).to.equal('hard')
  })

  it('emits vc_discarded with discard_scope=file on single-path discard', async () => {
    deps.gitService.isInitialized.resolves(true)
    await invoke(deps, VcEvents.DISCARD, {filePaths: ['a.md']})
    const calls = emitsOf(deps, AnalyticsEventNames.VC_DISCARDED)
    const props = calls[0].args[1] as {discard_scope: string; outcome: string}
    expect(props.discard_scope).to.equal('file')
    expect(props.outcome).to.equal('success')
  })

  it('emits vc_discarded with discard_scope=all on multi-path discard', async () => {
    deps.gitService.isInitialized.resolves(true)
    await invoke(deps, VcEvents.DISCARD, {filePaths: ['a.md', 'b.md']})
    const calls = emitsOf(deps, AnalyticsEventNames.VC_DISCARDED)
    const props = calls[0].args[1] as {discard_scope: string}
    expect(props.discard_scope).to.equal('all')
  })

  it('emits vc_branched on create-branch dispatcher path', async () => {
    deps.gitService.isInitialized.resolves(true)
    await invoke(deps, VcEvents.BRANCH, {action: 'create', name: 'feat/x'})
    const calls = emitsOf(deps, AnalyticsEventNames.VC_BRANCHED)
    expect(calls.length).to.equal(1)
    const props = calls[0].args[1] as {from_default_branch: boolean; outcome: string}
    expect(props.outcome).to.equal('success')
    expect(props.from_default_branch).to.equal(true)
  })

  it('does NOT emit vc_branched on list/delete branch actions', async () => {
    deps.gitService.isInitialized.resolves(true)
    deps.gitService.listBranches.resolves([
      {isCurrent: false, isRemote: false, name: 'feat/x'},
      {isCurrent: true, isRemote: false, name: 'main'},
    ])
    await invoke(deps, VcEvents.BRANCH, {action: 'list'})
    await invoke(deps, VcEvents.BRANCH, {action: 'delete', name: 'feat/x'})
    expect(emitsOf(deps, AnalyticsEventNames.VC_BRANCHED).length).to.equal(0)
  })

  it('emits vc_checked_out with branch_kind=existing on plain checkout', async () => {
    deps.gitService.isInitialized.resolves(true)
    await invoke(deps, VcEvents.CHECKOUT, {branch: 'main'})
    const calls = emitsOf(deps, AnalyticsEventNames.VC_CHECKED_OUT)
    const props = calls[0].args[1] as {branch_kind: string}
    expect(props.branch_kind).to.equal('existing')
  })

  it('emits vc_checked_out with branch_kind=created on -b checkout', async () => {
    deps.gitService.isInitialized.resolves(true)
    deps.gitService.listBranches.resolves([])
    await invoke(deps, VcEvents.CHECKOUT, {branch: 'feat/x', create: true})
    const calls = emitsOf(deps, AnalyticsEventNames.VC_CHECKED_OUT)
    const props = calls[0].args[1] as {branch_kind: string}
    expect(props.branch_kind).to.equal('created')
  })

  it('emits vc_cloned outcome=success with project_path_hash + remote_kind', async () => {
    // Fresh repo so clone runs (not "already initialized" early return)
    deps.gitService.isInitialized.resolves(false)
    deps.teamService.getTeams.resolves({
      teams: [{displayName: 'T', id: 'tid', isActive: true, isDefault: false, name: 'teambao', slug: 'teambao'}],
      total: 1,
    })
    deps.spaceService.getSpaces.resolves({
      spaces: [{
        id: 'sid',
        isDefault: false,
        name: 'space1',
        slug: 'space1',
        teamId: 'tid',
        teamName: 'teambao',
        teamSlug: 'teambao',
      }],
      total: 1,
    })
    await invoke(deps, VcEvents.CLONE, {url: 'https://byterover.dev/teambao/space1.git'})
    const calls = emitsOf(deps, AnalyticsEventNames.VC_CLONED)
    expect(calls.length).to.equal(1)
    const props = calls[0].args[1] as {outcome: string; project_path_hash: string; remote_kind: string}
    expect(props.outcome).to.equal('success')
    expect(props.project_path_hash).to.match(sha256HexRegex)
    expect(props.remote_kind).to.equal('byterover')
  })

  it('emits vc_merged on successful merge (fall-through path)', async () => {
    deps.gitService.isInitialized.resolves(true)
    deps.gitService.status.resolves({files: [], isClean: true})
    deps.gitService.getCurrentBranch.resolves('main')
    deps.gitService.listBranches.resolves([
      {isCurrent: true, isRemote: false, name: 'main'},
      {isCurrent: false, isRemote: false, name: 'feat/x'},
    ])
    deps.gitService.merge.resolves({alreadyUpToDate: false, success: true})
    await invoke(deps, VcEvents.MERGE, {action: 'merge', branch: 'feat/x'})
    const calls = emitsOf(deps, AnalyticsEventNames.VC_MERGED)
    expect(calls.length).to.equal(1)
    const props = calls[0].args[1] as {had_fast_forward?: boolean; outcome: string; project_path_hash: string}
    expect(props.outcome).to.equal('success')
    expect(props.had_fast_forward).to.equal(false)
    expect(props.project_path_hash).to.match(sha256HexRegex)
  })

  it('emits vc_merged had_fast_forward=true on self-merge no-op', async () => {
    deps.gitService.isInitialized.resolves(true)
    deps.gitService.status.resolves({files: [], isClean: true})
    deps.gitService.getCurrentBranch.resolves('main')
    await invoke(deps, VcEvents.MERGE, {action: 'merge', branch: 'main'})
    const calls = emitsOf(deps, AnalyticsEventNames.VC_MERGED)
    expect(calls.length).to.equal(1)
    const props = calls[0].args[1] as {had_fast_forward?: boolean; outcome: string}
    expect(props.had_fast_forward).to.equal(true)
  })

  it('emits vc_remote_changed change_kind=added on remote add', async () => {
    deps.gitService.isInitialized.resolves(true)
    deps.gitService.getRemoteUrl.resolves()
    deps.teamService.getTeams.resolves({
      teams: [{displayName: 'T', id: 'tid', isActive: true, isDefault: false, name: 'teambao', slug: 'teambao'}],
      total: 1,
    })
    deps.spaceService.getSpaces.resolves({
      spaces: [{
        id: 'sid',
        isDefault: false,
        name: 'space1',
        slug: 'space1',
        teamId: 'tid',
        teamName: 'teambao',
        teamSlug: 'teambao',
      }],
      total: 1,
    })
    await invoke(deps, VcEvents.REMOTE, {subcommand: 'add', url: 'https://byterover.dev/teambao/space1.git'})
    const calls = emitsOf(deps, AnalyticsEventNames.VC_REMOTE_CHANGED)
    expect(calls.length).to.equal(1)
    const props = calls[0].args[1] as {change_kind: string; remote_kind: string}
    expect(props.change_kind).to.equal('added')
    expect(props.remote_kind).to.equal('byterover')
  })

  it('emits vc_remote_changed with change_kind=removed on remove subcommand', async () => {
    deps.gitService.isInitialized.resolves(true)
    deps.gitService.getRemoteUrl.resolves('https://github.com/foo/bar.git')
    await invoke(deps, VcEvents.REMOTE, {subcommand: 'remove'})
    const calls = emitsOf(deps, AnalyticsEventNames.VC_REMOTE_CHANGED)
    const props = calls[0].args[1] as {change_kind: string; remote_kind: string}
    expect(props.change_kind).to.equal('removed')
    expect(props.remote_kind).to.equal('external')
  })

  it('does NOT emit vc_remote_changed on remote show', async () => {
    deps.gitService.isInitialized.resolves(true)
    await invoke(deps, VcEvents.REMOTE, {subcommand: 'show'})
    expect(emitsOf(deps, AnalyticsEventNames.VC_REMOTE_CHANGED).length).to.equal(0)
  })

  it('is a no-op when analyticsClient is not injected', async () => {
    sandbox.restore()
    sandbox = createSandbox()
    deps = makeDeps(sandbox)
    deps.gitService.isInitialized.resolves(false)
    const handler = new VcHandler({
      broadcastToProject: sandbox.stub() as never,
      contextTreeService: deps.contextTreeService,
      gitRemoteBaseUrl: 'https://byterover.dev',
      gitService: deps.gitService,
      projectConfigStore: deps.projectConfigStore,
      resolveProjectPath: deps.resolveProjectPath as never,
      spaceService: deps.spaceService,
      teamService: deps.teamService,
      tokenStore: deps.tokenStore,
      transport: deps.transport,
      vcGitConfigStore: deps.vcGitConfigStore,
      webAppUrl: 'https://app.byterover.dev',
    })
    handler.setup()
    await invoke(deps, VcEvents.INIT, {})
    // No analytics client injected → trackSpy never called
    expect(deps.analyticsClient.trackSpy.called).to.equal(false)
  })
})
