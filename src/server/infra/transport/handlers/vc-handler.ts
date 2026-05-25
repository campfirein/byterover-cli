import fs from 'node:fs'
import {join} from 'node:path'

import type {ITokenStore} from '../../../core/interfaces/auth/i-token-store.js'
import type {IContextTreeService} from '../../../core/interfaces/context-tree/i-context-tree-service.js'
import type {GitCommit, GitDiffSide, IGitService} from '../../../core/interfaces/services/i-git-service.js'
import type {ISpaceService} from '../../../core/interfaces/services/i-space-service.js'
import type {ITeamService} from '../../../core/interfaces/services/i-team-service.js'
import type {IProjectConfigStore} from '../../../core/interfaces/storage/i-project-config-store.js'
import type {ITransportServer} from '../../../core/interfaces/transport/i-transport-server.js'
import type {IVcGitConfig, IVcGitConfigStore} from '../../../core/interfaces/vc/i-vc-git-config-store.js'

import {
  type IVcAddRequest,
  type IVcAddResponse,
  type IVcBranchRequest,
  type IVcBranchResponse,
  type IVcCheckoutRequest,
  type IVcCheckoutResponse,
  type IVcCloneProgressEvent,
  type IVcCloneRequest,
  type IVcCloneResponse,
  type IVcCommitRequest,
  type IVcCommitResponse,
  type IVcConfigRequest,
  type IVcConfigResponse,
  type IVcDiffFile,
  type IVcDiffRequest,
  type IVcDiffResponse,
  type IVcDiffsRequest,
  type IVcDiffsResponse,
  type IVcDiscardRequest,
  type IVcDiscardResponse,
  type IVcFetchRequest,
  type IVcFetchResponse,
  type IVcInitResponse,
  type IVcLogRequest,
  type IVcLogResponse,
  type IVcMergeRequest,
  type IVcMergeResponse,
  type IVcPullRequest,
  type IVcPullResponse,
  type IVcPushRequest,
  type IVcPushResponse,
  type IVcRemoteRequest,
  type IVcRemoteResponse,
  type IVcResetRequest,
  type IVcResetResponse,
  type IVcStatusResponse,
  type VcDiffFileStatus,
  type VcDiffMode,
  type VcDiffSide,
  VcErrorCode,
  type VcErrorCodeType,
  VcEvents,
  type VcResetMode,
} from '../../../../shared/transport/events/vc-events.js'
import {BrvConfig} from '../../../core/domain/entities/brv-config.js'
import {Space} from '../../../core/domain/entities/space.js'
import {GitAuthError, GitError} from '../../../core/domain/errors/git-error.js'
import {NotAuthenticatedError} from '../../../core/domain/errors/task-error.js'
import {VcError} from '../../../core/domain/errors/vc-error.js'
import {ensureContextTreeGitignore, ensureGitignoreEntries} from '../../../utils/gitignore.js'
import {buildCogitRemoteUrl, isValidBranchName, parseUserFacingUrl} from '../../git/cogit-url.js'
import {type ProjectBroadcaster, type ProjectPathResolver, resolveRequiredProjectPath} from './handler-types.js'

/**
 * Classify a raw isomorphic-git error into a specific VcError by its `.code` property.
 * Returns undefined if the error is not a recognized isomorphic-git error.
 */
function classifyIsomorphicGitError(error: unknown, notFoundCode: VcErrorCodeType): undefined | VcError {
  if (!(error instanceof Error) || !('code' in error)) return undefined
  const {code} = error as {code: string}
  if (code === 'HttpError' || code === 'SmartHttpError') {
    return new VcError(error.message, VcErrorCode.NETWORK_ERROR)
  }

  if (code === 'NotFoundError') {
    return new VcError(error.message, notFoundCode)
  }

  if (code === 'UrlParseError') {
    return new VcError(error.message, VcErrorCode.INVALID_REMOTE_URL)
  }

  return undefined
}

const FIELD_MAP: Record<string, 'email' | 'name'> = {
  'user.email': 'email',
  'user.name': 'name',
}

function inferStatus(oldExists: boolean, newExists: boolean): VcDiffFileStatus {
  if (!oldExists && newExists) return 'added'
  if (oldExists && !newExists) return 'deleted'
  return 'modified'
}

function resolveDiffSides(mode: VcDiffMode): {from: GitDiffSide; to: GitDiffSide} {
  switch (mode.kind) {
    case 'range': {
      return {from: {commitish: mode.from}, to: {commitish: mode.to}}
    }

    case 'ref-vs-worktree': {
      return {from: {commitish: mode.ref}, to: 'WORKDIR'}
    }

    case 'staged': {
      return {from: {commitish: 'HEAD'}, to: 'STAGE'}
    }

    case 'unstaged': {
      return {from: 'STAGE', to: 'WORKDIR'}
    }
  }
}

export interface IVcHandlerDeps {
  broadcastToProject: ProjectBroadcaster
  contextTreeService: IContextTreeService
  gitRemoteBaseUrl: string
  gitService: IGitService
  projectConfigStore: IProjectConfigStore
  resolveProjectPath: ProjectPathResolver
  spaceService: ISpaceService
  teamService: ITeamService
  tokenStore: ITokenStore
  transport: ITransportServer
  vcGitConfigStore: IVcGitConfigStore
  webAppUrl: string
}

/**
 * Handles vc:* events (Version Control commands).
 */
export class VcHandler {
  private readonly broadcastToProject: ProjectBroadcaster
  private readonly contextTreeService: IContextTreeService
  private readonly gitRemoteBaseUrl: string
  private readonly gitService: IGitService
  private readonly projectConfigStore: IProjectConfigStore
  private readonly resolveProjectPath: ProjectPathResolver
  private readonly spaceService: ISpaceService
  private readonly teamService: ITeamService
  private readonly tokenStore: ITokenStore
  private readonly transport: ITransportServer
  private readonly vcGitConfigStore: IVcGitConfigStore
  private readonly webAppUrl: string

  constructor(deps: IVcHandlerDeps) {
    this.broadcastToProject = deps.broadcastToProject
    this.gitRemoteBaseUrl = deps.gitRemoteBaseUrl
    this.contextTreeService = deps.contextTreeService
    this.gitService = deps.gitService
    this.projectConfigStore = deps.projectConfigStore
    this.resolveProjectPath = deps.resolveProjectPath
    this.spaceService = deps.spaceService
    this.teamService = deps.teamService
    this.tokenStore = deps.tokenStore
    this.transport = deps.transport
    this.vcGitConfigStore = deps.vcGitConfigStore
    this.webAppUrl = deps.webAppUrl
  }

  setup(): void {
    this.transport.onRequest<IVcBranchRequest, IVcBranchResponse>(VcEvents.BRANCH, (data, clientId) =>
      this.handleBranch(data, clientId),
    )
    this.transport.onRequest<IVcCheckoutRequest, IVcCheckoutResponse>(VcEvents.CHECKOUT, (data, clientId) =>
      this.handleCheckout(data, clientId),
    )
    this.transport.onRequest<IVcCloneRequest, IVcCloneResponse>(VcEvents.CLONE, (data, clientId) =>
      this.handleClone(data, clientId),
    )
    this.transport.onRequest<IVcAddRequest, IVcAddResponse>(VcEvents.ADD, (data, clientId) =>
      this.handleAdd(data, clientId),
    )
    this.transport.onRequest<IVcCommitRequest, IVcCommitResponse>(VcEvents.COMMIT, (data, clientId) =>
      this.handleCommit(data, clientId),
    )
    this.transport.onRequest<IVcConfigRequest, IVcConfigResponse>(VcEvents.CONFIG, (data, clientId) =>
      this.handleConfig(data, clientId),
    )
    this.transport.onRequest<IVcDiffRequest, IVcDiffResponse>(VcEvents.DIFF, (data, clientId) =>
      this.handleDiff(data, clientId),
    )
    this.transport.onRequest<IVcDiffsRequest, IVcDiffsResponse>(VcEvents.DIFFS, (data, clientId) =>
      this.handleDiffs(data, clientId),
    )
    this.transport.onRequest<IVcDiscardRequest, IVcDiscardResponse>(VcEvents.DISCARD, (data, clientId) =>
      this.handleDiscard(data, clientId),
    )
    this.transport.onRequest<IVcFetchRequest, IVcFetchResponse>(VcEvents.FETCH, (data, clientId) =>
      this.handleFetch(data, clientId),
    )
    this.transport.onRequest<void, IVcInitResponse>(VcEvents.INIT, (_data, clientId) => this.handleInit(clientId))
    this.transport.onRequest<IVcLogRequest, IVcLogResponse>(VcEvents.LOG, (data, clientId) =>
      this.handleLog(data, clientId),
    )
    this.transport.onRequest<IVcMergeRequest, IVcMergeResponse>(VcEvents.MERGE, (data, clientId) =>
      this.handleMerge(data, clientId),
    )
    this.transport.onRequest<IVcPullRequest, IVcPullResponse>(VcEvents.PULL, (data, clientId) =>
      this.handlePull(data, clientId),
    )
    this.transport.onRequest<IVcPushRequest, IVcPushResponse>(VcEvents.PUSH, (data, clientId) =>
      this.handlePush(data, clientId),
    )
    this.transport.onRequest<IVcRemoteRequest, IVcRemoteResponse>(VcEvents.REMOTE, (data, clientId) =>
      this.handleRemote(data, clientId),
    )
    this.transport.onRequest<IVcResetRequest, IVcResetResponse>(VcEvents.RESET, (data, clientId) =>
      this.handleReset(data, clientId),
    )

    this.transport.onRequest<void, IVcStatusResponse>(VcEvents.STATUS, (_data, clientId) => this.handleStatus(clientId))
  }

  private async buildAuthorHint(existing?: IVcGitConfig): Promise<string> {
    try {
      const token = await this.tokenStore.load()
      if (token?.isValid()) {
        const email = existing?.email ?? token.userEmail
        const name = existing?.name ?? token.userName ?? token.userEmail
        return `Run: brv vc config user.name '${name}' and brv vc config user.email '${email}'.`
      }
    } catch {
      // not logged in
    }

    return 'Run: brv vc config user.name <value> and brv vc config user.email <value>.'
  }

  /**
   * Builds a single diff entry for a changed file, or `undefined` when either required side
   * is absent/binary (the caller filters these out to keep binaries out of diff output).
   */
  private async buildDiffFile(params: {
    directory: string
    from: GitDiffSide
    path: string
    status: VcDiffFileStatus
    to: GitDiffSide
  }): Promise<IVcDiffFile | undefined> {
    const {directory, from, path, status, to} = params
    const [oldSide, newSide] = await Promise.all([
      status === 'added' ? undefined : this.readSideEntry(directory, from, path),
      status === 'deleted' ? undefined : this.readSideEntry(directory, to, path),
    ])

    if (status !== 'added' && !oldSide) return undefined
    if (status !== 'deleted' && !newSide) return undefined

    const binary = (oldSide?.binary ?? false) || (newSide?.binary ?? false)
    const result: IVcDiffFile = {
      newContent: binary ? '' : (newSide?.content ?? ''),
      oldContent: binary ? '' : (oldSide?.content ?? ''),
      path,
      status,
    }
    if (oldSide) result.oldOid = oldSide.oid
    if (newSide) result.newOid = newSide.oid
    if (binary) result.binary = true
    return result
  }

  private buildNoRemoteMessage(nextStep: string): string {
    return (
      `No remote configured.\n\nTo connect to cloud:\n` +
      `  1. Go to ${this.webAppUrl} → create or open a Space\n` +
      `  2. Copy the remote URL\n` +
      `  3. Run: brv vc remote add origin <url>\n` +
      `  4. Then: ${nextStep}`
    )
  }

  private async computeDiff(directory: string, path: string, side: VcDiffSide): Promise<IVcDiffResponse> {
    if (side === 'staged') {
      const [head, stage] = await Promise.all([
        this.gitService.getBlobContent({directory, path, ref: {commitish: 'HEAD'}}),
        this.gitService.getBlobContent({directory, path, ref: 'STAGE'}),
      ])
      return {newContent: stage ?? '', oldContent: head ?? '', path}
    }

    // unstaged: compare index (old) against working tree (new)
    const [stage, workingTree] = await Promise.all([
      this.gitService.getBlobContent({directory, path, ref: 'STAGE'}),
      fs.promises.readFile(join(directory, path), 'utf8').catch(() => ''),
    ])
    return {newContent: workingTree, oldContent: stage ?? '', path}
  }

  /**
   * When force is NOT set, checks for uncommitted changes and throws
   * VcError(UNCOMMITTED_CHANGES) if the working tree is dirty.
   * When force IS set, skips the check entirely (changes will be discarded).
   */
  private async guardUncommittedChanges(force: boolean | undefined, directory: string): Promise<void> {
    if (force) return

    const status = await this.gitService.status({directory})
    const hasTrackedChanges = status.files.some((f) => f.status !== 'untracked')
    if (hasTrackedChanges) {
      throw new VcError(
        'You have uncommitted changes that would be overwritten. Commit your changes or use --force to discard them.',
        VcErrorCode.UNCOMMITTED_CHANGES,
      )
    }
  }

  /**
   * Block a commit when either:
   *  1. The index still has unmerged (multi-stage) entries — matches native git's commit guard.
   *  2. Any tracked file still contains `<<<<<<<` markers — extra strictness on top of native git,
   *     matching our existing push-time guard. Avoids accidentally publishing marker text.
   */
  private async guardUnmergedAndMarkers(directory: string): Promise<void> {
    const conflicts = await this.gitService.getConflicts({directory})
    if (conflicts.length > 0) {
      throw new VcError('Committing is not possible because you have unmerged files.', VcErrorCode.MERGE_CONFLICT)
    }

    const markerFiles = await this.gitService.getFilesWithConflictMarkers({directory})
    if (markerFiles.length > 0) {
      throw new VcError(
        `Conflict markers detected in: ${markerFiles.join(', ')}. Resolve them before committing.`,
        VcErrorCode.CONFLICT_MARKERS_PRESENT,
      )
    }
  }

  private async handleAdd(data: IVcAddRequest, clientId: string): Promise<IVcAddResponse> {
    const projectPath = resolveRequiredProjectPath(this.resolveProjectPath, clientId)
    const directory = this.contextTreeService.resolvePath(projectPath)

    const gitInitialized = await this.gitService.isInitialized({directory})
    if (!gitInitialized) {
      throw new VcError('ByteRover version control not initialized.', VcErrorCode.GIT_NOT_INITIALIZED)
    }

    await ensureContextTreeGitignore(directory)

    const statusBefore = await this.gitService.status({directory})
    const stagedBefore = new Set(statusBefore.files.filter((f) => f.staged).map((f) => f.path))
    const hadUnstagedBefore = new Set(statusBefore.files.filter((f) => !f.staged).map((f) => f.path))

    await this.gitService.add({directory, filePaths: data.filePaths ?? ['.']})

    const statusAfter = await this.gitService.status({directory})
    const count = statusAfter.files.filter(
      (f) => f.staged && (!stagedBefore.has(f.path) || hadUnstagedBefore.has(f.path)),
    ).length

    return {count}
  }

  private async handleBranch(data: IVcBranchRequest, clientId: string): Promise<IVcBranchResponse> {
    const projectPath = resolveRequiredProjectPath(this.resolveProjectPath, clientId)
    const directory = this.contextTreeService.resolvePath(projectPath)

    const gitInitialized = await this.gitService.isInitialized({directory})
    if (!gitInitialized) {
      throw new VcError('ByteRover version control not initialized.', VcErrorCode.GIT_NOT_INITIALIZED)
    }

    if (data.action === 'list') return this.handleBranchList(directory, data.all)

    // Runtime guard: `name` is guaranteed by the discriminated union at compile time,
    // but transport payloads are untrusted — validate at the boundary.
    if (data.action === 'create' || data.action === 'delete') {
      if (!data.name) throw new VcError('Branch name is required.', VcErrorCode.INVALID_BRANCH_NAME)
      if (data.action === 'create') return this.handleBranchCreate(directory, data.name, data.startPoint)
      return this.handleBranchDelete(directory, data.name)
    }

    if (data.action === 'set-upstream') {
      return this.handleBranchSetUpstream(directory, data.upstream)
    }

    throw new VcError(`Unknown branch action.`, VcErrorCode.INVALID_ACTION)
  }

  private async handleBranchCreate(directory: string, name: string, startPoint?: string): Promise<IVcBranchResponse> {
    if (!isValidBranchName(name)) {
      throw new VcError(`Invalid branch name: '${name}'.`, VcErrorCode.INVALID_BRANCH_NAME)
    }

    const existing = await this.gitService.listBranches({directory})
    if (existing.some((b) => b.name === name)) {
      throw new VcError(`Branch '${name}' already exists.`, VcErrorCode.BRANCH_ALREADY_EXISTS)
    }

    // Block branch creation on empty repo (no commits yet) — matches native git behavior
    const commits = await this.gitService.log({depth: 1, directory})
    if (commits.length === 0) {
      throw new VcError('You must make an initial commit before creating branches.', VcErrorCode.NO_COMMITS)
    }

    try {
      await this.gitService.createBranch({branch: name, directory, startPoint})
    } catch (error) {
      if (error instanceof Error && 'code' in error && error.code === 'NotFoundError') {
        throw new VcError(`Start point '${startPoint}' not found.`, VcErrorCode.BRANCH_NOT_FOUND)
      }

      throw error
    }

    return {action: 'create', created: name}
  }

  private async handleBranchDelete(directory: string, name: string): Promise<IVcBranchResponse> {
    const current = await this.gitService.getCurrentBranch({directory})
    if (name === current) {
      throw new VcError(`Cannot delete current branch '${name}'.`, VcErrorCode.CANNOT_DELETE_CURRENT_BRANCH)
    }

    const localBranches = await this.gitService.listBranches({directory})
    if (!localBranches.some((b) => b.name === name)) {
      throw new VcError(`Branch '${name}' not found.`, VcErrorCode.BRANCH_NOT_FOUND)
    }

    // Safe delete: verify branch is fully merged into current branch
    if (current) {
      const isMerged = await this.gitService.isAncestor({
        ancestor: `refs/heads/${name}`,
        commit: `refs/heads/${current}`,
        directory,
      })
      if (!isMerged) {
        throw new VcError(`The branch '${name}' is not fully merged.`, VcErrorCode.BRANCH_NOT_MERGED)
      }
    }

    await this.gitService.deleteBranch({branch: name, directory})
    return {action: 'delete', deleted: name}
  }

  private async handleBranchList(directory: string, all?: boolean): Promise<IVcBranchResponse> {
    const branches = await this.gitService.listBranches({
      directory,
      remote: all ? 'origin' : undefined,
    })
    return {
      action: 'list',
      branches: branches.map((b) => ({
        isCurrent: b.isCurrent,
        isRemote: b.isRemote,
        name: b.name,
      })),
    }
  }

  private async handleBranchSetUpstream(directory: string, upstream: string): Promise<IVcBranchResponse> {
    const slashIndex = upstream.indexOf('/')
    if (slashIndex <= 0) {
      throw new VcError(
        `Invalid upstream format '${upstream}'. Expected <remote>/<branch> (e.g. origin/main).`,
        VcErrorCode.INVALID_BRANCH_NAME,
      )
    }

    const remote = upstream.slice(0, slashIndex)
    const remoteBranch = upstream.slice(slashIndex + 1)
    if (!remoteBranch) {
      throw new VcError(
        `Invalid upstream format '${upstream}'. Expected <remote>/<branch> (e.g. origin/main).`,
        VcErrorCode.INVALID_BRANCH_NAME,
      )
    }

    const currentBranch = await this.gitService.getCurrentBranch({directory})
    if (!currentBranch) {
      throw new VcError('Cannot set upstream in detached HEAD state.', VcErrorCode.INVALID_BRANCH_NAME)
    }

    // Validate the remote exists
    const remotes = await this.gitService.listRemotes({directory})
    if (!remotes.some((r) => r.remote === remote)) {
      throw new VcError(`Remote '${remote}' not found.`, VcErrorCode.NO_REMOTE)
    }

    // Validate the remote-tracking branch exists
    const remoteBranches = await this.gitService.listBranches({directory, remote})
    if (!remoteBranches.some((b) => b.isRemote && b.name === `${remote}/${remoteBranch}`)) {
      throw new VcError(`The requested upstream branch '${upstream}' does not exist.`, VcErrorCode.BRANCH_NOT_FOUND)
    }

    await this.gitService.setTrackingBranch({branch: currentBranch, directory, remote, remoteBranch})
    return {action: 'set-upstream', branch: currentBranch, upstream}
  }

  private async handleCheckout(data: IVcCheckoutRequest, clientId: string): Promise<IVcCheckoutResponse> {
    // ── Phase 1: Resolve project and validate inputs ──
    const projectPath = resolveRequiredProjectPath(this.resolveProjectPath, clientId)
    const directory = this.contextTreeService.resolvePath(projectPath)

    const gitInitialized = await this.gitService.isInitialized({directory})
    if (!gitInitialized) {
      throw new VcError('ByteRover version control not initialized.', VcErrorCode.GIT_NOT_INITIALIZED)
    }

    this.validateBranchName(data.branch)

    if (data.startPoint !== undefined && !data.create) {
      throw new VcError(
        'Use New Branch to create a branch from a starting point. Checkout only switches to an existing branch.',
        VcErrorCode.INVALID_ACTION,
      )
    }

    // ── Phase 2: Resolve current branch ──
    const previousBranch = await this.gitService.getCurrentBranch({directory})

    // ── Phase 3: Create or switch ──
    if (data.create) {
      const branches = await this.gitService.listBranches({directory})
      if (branches.some((b) => b.name === data.branch)) {
        throw new VcError(`Branch '${data.branch}' already exists.`, VcErrorCode.BRANCH_ALREADY_EXISTS)
      }

      try {
        await this.gitService.createBranch({
          branch: data.branch,
          checkout: true,
          directory,
          startPoint: data.startPoint,
        })
      } catch (error) {
        if (error instanceof Error && 'code' in error && error.code === 'NotFoundError') {
          throw new VcError(`Start point '${data.startPoint}' not found.`, VcErrorCode.BRANCH_NOT_FOUND)
        }

        throw error
      }

      return {branch: data.branch, created: true, previousBranch}
    }

    try {
      await this.gitService.checkout({directory, force: data.force, ref: data.branch})

      // Clear merge state after force checkout (like git checkout --force)
      if (data.force) {
        const mergeHeadPath = join(directory, '.git', 'MERGE_HEAD')
        const mergeMsgPath = join(directory, '.git', 'MERGE_MSG')
        await fs.promises.rm(mergeHeadPath, {force: true}).catch(() => {})
        await fs.promises.rm(mergeMsgPath, {force: true}).catch(() => {})
      }
    } catch (error) {
      // Dirty files that conflict with target branch (matches native git behavior)
      if (error instanceof GitError && error.message.includes('would be overwritten')) {
        throw new VcError(error.message, VcErrorCode.UNCOMMITTED_CHANGES)
      }

      if (error instanceof Error && 'code' in error && error.code === 'NotFoundError') {
        // After ENG-2835 the gitService.checkout no longer throws NotFoundError on the
        // source ref's listFiles snapshot; the catch only sees target-ref-missing.
        // Two flavors of that: (a) user typoed the target name — emit BRANCH_NOT_FOUND;
        // (b) user asked to checkout the branch they are already on but the branch is
        // unborn (e.g. fresh `brv vc init && brv vc checkout main`) — emit NO_COMMITS
        // with the actionable message. The pre-ENG-2835 proxy used commit count, which
        // collapsed (a) and (b) into the same answer when HEAD was unborn; comparing
        // target name against the current branch separates them cleanly.
        if (data.branch === previousBranch) {
          throw new VcError(
            `Your current branch '${data.branch}' does not have any commits yet. Run 'brv vc add' and 'brv vc commit' first, or pull from a remote.`,
            VcErrorCode.NO_COMMITS,
          )
        }

        throw new VcError(
          `Branch '${data.branch}' not found. Use 'brv vc checkout -b ${data.branch}' to create it.`,
          VcErrorCode.BRANCH_NOT_FOUND,
        )
      }

      throw error
    }

    return {branch: data.branch, created: false, previousBranch}
  }

  private async handleClone(data: IVcCloneRequest, clientId: string): Promise<IVcCloneResponse> {
    const projectPath = resolveRequiredProjectPath(this.resolveProjectPath, clientId)
    const contextTreeDir = this.contextTreeService.resolvePath(projectPath)

    if (await this.gitService.isInitialized({directory: contextTreeDir})) {
      const isEmpty = await this.gitService.isEmptyRepository({directory: contextTreeDir})
      if (!isEmpty) {
        throw new VcError('Already initialized. Use brv vc pull to sync.', VcErrorCode.ALREADY_INITIALIZED)
      }

      // Fresh auto-init — remove .git and .gitignore so clone starts clean
      await fs.promises.rm(join(contextTreeDir, '.git'), {force: true, recursive: true})
      await fs.promises.rm(join(contextTreeDir, '.gitignore'), {force: true}).catch(() => {})
    }

    const {
      spaceId,
      spaceName,
      spaceSlug,
      teamId,
      teamName,
      teamSlug,
      url: cloneUrl,
    } = await this.resolveCloneInput(data)
    const label = teamName && spaceName ? `${teamName}/${spaceName}` : 'repository'

    try {
      await this.contextTreeService.initialize(projectPath)

      this.broadcastToProject<IVcCloneProgressEvent>(projectPath, VcEvents.CLONE_PROGRESS, {
        message: `Remote: ${data.url ?? label}`,
        step: 'cloning',
      })
      this.broadcastToProject<IVcCloneProgressEvent>(projectPath, VcEvents.CLONE_PROGRESS, {
        message: `Cloning from ${label}...`,
        step: 'cloning',
      })

      let lastPhase = ''
      await this.gitService.clone({
        directory: contextTreeDir,
        onProgress: ({phase, total}) => {
          if (phase !== lastPhase) {
            lastPhase = phase
            const totalStr = total === undefined ? '' : ` (${total})`
            this.broadcastToProject<IVcCloneProgressEvent>(projectPath, VcEvents.CLONE_PROGRESS, {
              message: `${phase}${totalStr}...`,
              step: 'cloning',
            })
          }
        },
        url: cloneUrl,
      })

      this.broadcastToProject<IVcCloneProgressEvent>(projectPath, VcEvents.CLONE_PROGRESS, {
        message: 'Saving configuration...',
        step: 'saving',
      })

      if (spaceId && spaceName && teamId && teamName) {
        const space = new Space({
          id: spaceId,
          isDefault: false,
          name: spaceName,
          slug: spaceSlug,
          teamId,
          teamName,
          teamSlug,
        })
        const existing = await this.projectConfigStore.read(projectPath)
        const updated = existing ? existing.withSpace(space) : BrvConfig.partialFromSpace({space})
        await this.projectConfigStore.write(updated, projectPath)
      }

      // Ensure .gitignore exists (remote may not have one)
      await ensureContextTreeGitignore(contextTreeDir)

      // Add .brv entries to project .gitignore (prevents `git add .` fatal error from nested .git)
      await ensureGitignoreEntries(projectPath)
    } catch (error) {
      // Rollback partial .git — keep context tree intact
      await fs.promises.rm(join(contextTreeDir, '.git'), {force: true, recursive: true}).catch(() => {})

      if (error instanceof GitAuthError) {
        throw new VcError('Authentication failed. Run brv login.', VcErrorCode.AUTH_FAILED)
      }

      const classified = classifyIsomorphicGitError(error, VcErrorCode.INVALID_REMOTE_URL)
      if (classified) throw classified

      const msg = error instanceof Error ? error.message : String(error)
      throw new VcError(`Clone failed: ${msg}`, VcErrorCode.CLONE_FAILED)
    }

    return {
      gitDir: join(contextTreeDir, '.git'),
      spaceName,
      teamName,
    }
  }

  private async handleCommit(data: IVcCommitRequest, clientId: string): Promise<IVcCommitResponse> {
    const projectPath = resolveRequiredProjectPath(this.resolveProjectPath, clientId)
    const directory = this.contextTreeService.resolvePath(projectPath)

    const gitInitialized = await this.gitService.isInitialized({directory})
    if (!gitInitialized) {
      throw new VcError('ByteRover version control not initialized.', VcErrorCode.GIT_NOT_INITIALIZED)
    }

    const status = await this.gitService.status({directory})
    const hasStagedFiles = status.files.some((f) => f.staged)
    if (!hasStagedFiles) {
      throw new VcError('Nothing staged.', VcErrorCode.NOTHING_STAGED)
    }

    await this.guardUnmergedAndMarkers(directory)

    const config = await this.vcGitConfigStore.get(projectPath)
    if (!config?.name || !config.email) {
      const hint = await this.buildAuthorHint(config)
      throw new VcError(`Commit author not configured. ${hint}`, VcErrorCode.USER_NOT_CONFIGURED)
    }

    const commit = await this.gitService.commit({
      author: {email: config.email, name: config.name},
      directory,
      message: data.message,
    })

    return {message: commit.message, sha: commit.sha}
  }

  private async handleConfig(data: IVcConfigRequest, clientId: string): Promise<IVcConfigResponse> {
    const projectPath = resolveRequiredProjectPath(this.resolveProjectPath, clientId)

    const field = FIELD_MAP[data.key]
    if (!field) {
      throw new VcError(`Unknown key '${data.key}'. Allowed: user.name, user.email.`, VcErrorCode.INVALID_CONFIG_KEY)
    }

    if (data.value !== undefined) {
      // SET: read existing → merge single field → write back
      const existing = (await this.vcGitConfigStore.get(projectPath)) ?? {}
      const merged = {...existing, [field]: data.value}
      await this.vcGitConfigStore.set(projectPath, merged)
      return {key: data.key, value: data.value}
    }

    // GET
    const config = await this.vcGitConfigStore.get(projectPath)
    const value = config?.[field]
    if (value === undefined) {
      throw new VcError(`'${data.key}' is not set.`, VcErrorCode.CONFIG_KEY_NOT_SET)
    }

    return {key: data.key, value}
  }

  private async handleDiff(data: IVcDiffRequest, clientId: string): Promise<IVcDiffResponse> {
    const projectPath = resolveRequiredProjectPath(this.resolveProjectPath, clientId)
    const directory = this.contextTreeService.resolvePath(projectPath)

    const gitInitialized = await this.gitService.isInitialized({directory})
    if (!gitInitialized) {
      throw new VcError('ByteRover version control not initialized.', VcErrorCode.GIT_NOT_INITIALIZED)
    }

    return this.computeDiff(directory, data.path, data.side)
  }

  private async handleDiffs(data: IVcDiffsRequest, clientId: string): Promise<IVcDiffsResponse> {
    const projectPath = resolveRequiredProjectPath(this.resolveProjectPath, clientId)
    const directory = this.contextTreeService.resolvePath(projectPath)

    const gitInitialized = await this.gitService.isInitialized({directory})
    if (!gitInitialized) {
      throw new VcError('ByteRover version control not initialized.', VcErrorCode.GIT_NOT_INITIALIZED)
    }

    // Mode-based call (CLI/TUI): auto-discover changed files + return full IVcDiffFile entries.
    // Binary or unreadable files are dropped by buildDiffFile (returns undefined).
    if ('mode' in data) {
      const {from, to} = resolveDiffSides(data.mode)
      try {
        const changed = await this.gitService.listChangedFiles({directory, from, to})
        const entries = await Promise.all(
          changed.map((change) => this.buildDiffFile({directory, from, path: change.path, status: change.status, to})),
        )
        const diffs = entries.filter((d): d is IVcDiffFile => d !== undefined)
        return {diffs, mode: data.mode}
      } catch (error) {
        const classified = classifyIsomorphicGitError(error, VcErrorCode.INVALID_REF)
        if (classified) throw classified
        throw error
      }
    }

    // WebUI call: caller-supplied paths + side. Status is derived from blob presence,
    // so an empty-blob edit is correctly reported as `modified`, not `added`.
    const {paths, side} = data

    if (side === 'staged') {
      const [head, stage] = await Promise.all([
        this.gitService.getBlobContents({directory, paths, ref: {commitish: 'HEAD'}}),
        this.gitService.getBlobContents({directory, paths, ref: 'STAGE'}),
      ])
      const diffs = paths.map((path) => {
        const oldBlob = head[path]
        const newBlob = stage[path]
        return {
          newContent: newBlob ?? '',
          oldContent: oldBlob ?? '',
          path,
          status: inferStatus(oldBlob !== undefined, newBlob !== undefined),
        }
      })
      return {diffs}
    }

    // unstaged: compare index (old) against working tree (new)
    const stage = await this.gitService.getBlobContents({directory, paths, ref: 'STAGE'})
    const workingTree = await Promise.all(
      paths.map(async (path): Promise<string | undefined> => {
        try {
          return await fs.promises.readFile(join(directory, path), 'utf8')
        } catch {
          return undefined
        }
      }),
    )
    const diffs = paths.map((path, i) => {
      const oldBlob = stage[path]
      const newFile = workingTree[i]
      return {
        newContent: newFile ?? '',
        oldContent: oldBlob ?? '',
        path,
        status: inferStatus(oldBlob !== undefined, newFile !== undefined),
      }
    })
    return {diffs}
  }

  private async handleDiscard(data: IVcDiscardRequest, clientId: string): Promise<IVcDiscardResponse> {
    const projectPath = resolveRequiredProjectPath(this.resolveProjectPath, clientId)
    const directory = this.contextTreeService.resolvePath(projectPath)

    const gitInitialized = await this.gitService.isInitialized({directory})
    if (!gitInitialized) {
      throw new VcError('ByteRover version control not initialized.', VcErrorCode.GIT_NOT_INITIALIZED)
    }

    const {filePaths} = data
    // Prefer index blob (preserves staged changes); fall back to HEAD; else delete (untracked).
    const [stage, head] = await Promise.all([
      this.gitService.getBlobContents({directory, paths: filePaths, ref: 'STAGE'}),
      this.gitService.getBlobContents({directory, paths: filePaths, ref: {commitish: 'HEAD'}}),
    ])

    const results = await Promise.all(
      filePaths.map(async (path) => {
        const target = stage[path] ?? head[path]
        const absolutePath = join(directory, path)
        try {
          await (target === undefined ? fs.promises.unlink(absolutePath) : fs.promises.writeFile(absolutePath, target))
          return true
        } catch {
          return false
        }
      }),
    )

    return {count: results.filter(Boolean).length}
  }

  private async handleFetch(data: IVcFetchRequest, clientId: string): Promise<IVcFetchResponse> {
    const token = await this.tokenStore.load()
    if (!token?.isValid()) throw new NotAuthenticatedError()

    const projectPath = resolveRequiredProjectPath(this.resolveProjectPath, clientId)
    const directory = this.contextTreeService.resolvePath(projectPath)

    const gitInitialized = await this.gitService.isInitialized({directory})
    if (!gitInitialized) {
      throw new VcError('ByteRover version control not initialized.', VcErrorCode.GIT_NOT_INITIALIZED)
    }

    const remotes = await this.gitService.listRemotes({directory})
    if (remotes.length === 0) {
      throw new VcError(this.buildNoRemoteMessage('brv vc fetch'), VcErrorCode.NO_REMOTE)
    }

    const remote = data.remote ?? 'origin'
    try {
      await this.gitService.fetch({directory, ref: data.ref, remote})
    } catch (error) {
      if (error instanceof GitAuthError) {
        throw new VcError('Authentication failed. Run brv login.', VcErrorCode.AUTH_FAILED)
      }

      const classified = classifyIsomorphicGitError(error, VcErrorCode.INVALID_REF)
      if (classified) throw classified

      const message = error instanceof Error ? error.message : 'Fetch failed.'
      throw new VcError(message, VcErrorCode.FETCH_FAILED)
    }

    return {remote}
  }

  private async handleInit(clientId: string): Promise<IVcInitResponse> {
    const projectPath = resolveRequiredProjectPath(this.resolveProjectPath, clientId)

    // 1. Ensure context tree directory exists
    const contextTreeDir = await this.contextTreeService.initialize(projectPath)

    // 2. Git init — always call (idempotent, like real `git init`).
    //    Check beforehand to determine whether this is a fresh init or a reinit.
    const reinitialized = await this.gitService.isInitialized({directory: contextTreeDir})
    await this.gitService.init({defaultBranch: 'main', directory: contextTreeDir})

    // 3. Ensure .gitignore exists with correct content (idempotent)
    await ensureContextTreeGitignore(contextTreeDir)

    // 4. Add .brv entries to project .gitignore (prevents `git add .` fatal error from nested .git)
    await ensureGitignoreEntries(projectPath)

    return {
      gitDir: join(contextTreeDir, '.git'),
      reinitialized,
    }
  }

  private async handleLog(data: IVcLogRequest, clientId: string): Promise<IVcLogResponse> {
    const projectPath = resolveRequiredProjectPath(this.resolveProjectPath, clientId)
    const contextTreeDir = this.contextTreeService.resolvePath(projectPath)

    const gitInitialized = await this.gitService.isInitialized({directory: contextTreeDir})
    if (!gitInitialized) {
      throw new VcError('ByteRover version control not initialized.', VcErrorCode.GIT_NOT_INITIALIZED)
    }

    const hasCommits = await this.gitService.log({depth: 1, directory: contextTreeDir}).then((c) => c.length > 0)
    if (!hasCommits) {
      const branch = await this.gitService.getCurrentBranch({directory: contextTreeDir})
      throw new VcError(
        `Your current branch '${branch ?? 'main'}' does not have any commits yet.`,
        VcErrorCode.NO_COMMITS,
      )
    }

    const {commits, displayBranch} = await this.resolveLogResult(data, contextTreeDir)

    return {
      commits: commits.map((c) => ({
        author: c.author,
        message: c.message,
        sha: c.sha,
        timestamp: c.timestamp.toISOString(),
      })),
      currentBranch: displayBranch,
    }
  }

  private async handleMerge(data: IVcMergeRequest, clientId: string): Promise<IVcMergeResponse> {
    const projectPath = resolveRequiredProjectPath(this.resolveProjectPath, clientId)
    const directory = this.contextTreeService.resolvePath(projectPath)

    const gitInitialized = await this.gitService.isInitialized({directory})
    if (!gitInitialized) {
      throw new VcError('ByteRover version control not initialized.', VcErrorCode.GIT_NOT_INITIALIZED)
    }

    const mergeHeadPath = join(directory, '.git', 'MERGE_HEAD')
    const mergeMsgPath = join(directory, '.git', 'MERGE_MSG')
    const hasMergeHead = await fs.promises
      .access(mergeHeadPath)
      .then(() => true)
      .catch(() => false)

    if (data.action === 'abort') {
      if (!hasMergeHead) {
        throw new VcError('There is no merge to abort (MERGE_HEAD missing).', VcErrorCode.NO_MERGE_IN_PROGRESS)
      }

      await this.gitService.abortMerge({directory})
      return {action: 'abort'}
    }

    if (data.action === 'continue') {
      if (!hasMergeHead) {
        throw new VcError('There is no merge in progress (MERGE_HEAD missing).', VcErrorCode.NO_MERGE_IN_PROGRESS)
      }

      if (!data.message) {
        // Return default message so oclif can open editor; TUI uses it directly
        const defaultMessage = await fs.promises
          .readFile(mergeMsgPath, 'utf8')
          .then((content) => content.trim())
          .catch(() => 'Merge commit')
        return {action: 'continue', defaultMessage}
      }

      await this.guardUnmergedAndMarkers(directory)

      const config = await this.vcGitConfigStore.get(projectPath)
      if (!config?.name || !config.email) {
        const hint = await this.buildAuthorHint(config)
        throw new VcError(`Commit author not configured. ${hint}`, VcErrorCode.USER_NOT_CONFIGURED)
      }

      await this.gitService.commit({
        author: {email: config.email, name: config.name},
        directory,
        message: data.message,
      })
      return {action: 'continue'}
    }

    // action: 'merge'
    if (!data.branch) {
      throw new VcError('Branch name is required for merge.', VcErrorCode.INVALID_BRANCH_NAME)
    }

    if (!isValidBranchName(data.branch)) {
      throw new VcError(`Invalid branch name: '${data.branch}'.`, VcErrorCode.INVALID_BRANCH_NAME)
    }

    if (hasMergeHead) {
      throw new VcError('You have not concluded your merge (MERGE_HEAD exists).', VcErrorCode.MERGE_IN_PROGRESS)
    }

    await this.guardUncommittedChanges(false, directory)

    // Self-merge check
    const currentBranch = await this.gitService.getCurrentBranch({directory})
    if (currentBranch && data.branch === currentBranch) {
      return {action: 'merge', alreadyUpToDate: true, branch: data.branch}
    }

    // Validate branch exists (check both local and remote-tracking branches)
    const branches = await this.gitService.listBranches({directory, remote: 'origin'})
    if (!branches.some((b) => b.name === data.branch)) {
      throw new VcError(`merge: ${data.branch} - not something we can merge`, VcErrorCode.BRANCH_NOT_FOUND)
    }

    const config = await this.vcGitConfigStore.get(projectPath)
    if (!config?.name || !config.email) {
      const hint = await this.buildAuthorHint(config)
      throw new VcError(`Commit author not configured. ${hint}`, VcErrorCode.USER_NOT_CONFIGURED)
    }

    const result = await this.gitService.merge({
      allowUnrelatedHistories: data.allowUnrelatedHistories,
      author: {email: config.email, name: config.name},
      branch: data.branch,
      directory,
      message: data.message,
    })

    if (!result.success) {
      return {
        action: 'merge',
        branch: data.branch,
        conflicts: result.conflicts.map((c) => ({path: c.path, type: c.type})),
      }
    }

    if (result.alreadyUpToDate) {
      return {action: 'merge', alreadyUpToDate: true, branch: data.branch}
    }

    return {action: 'merge', branch: data.branch}
  }

  private async handlePull(data: IVcPullRequest, clientId: string): Promise<IVcPullResponse> {
    const projectPath = resolveRequiredProjectPath(this.resolveProjectPath, clientId)
    const directory = this.contextTreeService.resolvePath(projectPath)

    const gitInitialized = await this.gitService.isInitialized({directory})
    if (!gitInitialized) {
      throw new VcError('ByteRover version control not initialized.', VcErrorCode.GIT_NOT_INITIALIZED)
    }

    const token = await this.tokenStore.load()
    if (!token?.isValid()) throw new NotAuthenticatedError()

    const remotes = await this.gitService.listRemotes({directory})
    if (remotes.length === 0) {
      throw new VcError(this.buildNoRemoteMessage('brv vc pull origin main'), VcErrorCode.NO_REMOTE)
    }

    // Soft resolve author: use vc config if available, otherwise let pull() fallback to getAuthor() from auth token.
    // Unlike commit/merge, pull only needs author when creating a merge commit (not for up-to-date or fast-forward).
    const config = await this.vcGitConfigStore.get(projectPath)
    const author = config?.name && config?.email ? {email: config.email, name: config.name} : undefined

    // If explicit branch provided, use it directly (skip tracking resolution)
    const remote = data?.remote ?? 'origin'
    const branch = data?.branch ?? (await this.resolvePullBranch(directory))

    let alreadyUpToDate = false
    let conflicts: Array<{path: string; type: string}> | undefined
    try {
      const result = await this.gitService.pull({
        allowUnrelatedHistories: data?.allowUnrelatedHistories,
        author,
        branch,
        directory,
        remote,
      })
      if (!result.success) {
        conflicts = result.conflicts.map((c) => ({path: c.path, type: c.type}))
        return {branch, conflicts}
      }

      alreadyUpToDate = result.alreadyUpToDate ?? false
    } catch (error) {
      if (error instanceof VcError) throw error
      if (error instanceof GitAuthError) {
        throw new VcError('Authentication failed. Run brv login.', VcErrorCode.AUTH_FAILED)
      }

      if (error instanceof GitError) {
        if (error.message.includes('unresolved merge conflicts')) {
          throw new VcError(error.message, VcErrorCode.MERGE_IN_PROGRESS)
        }

        if (error.message.includes('would be overwritten')) {
          throw new VcError(error.message, VcErrorCode.UNCOMMITTED_CHANGES)
        }

        if (error.message.includes('unrelated histories')) {
          throw new VcError(error.message, VcErrorCode.UNRELATED_HISTORIES)
        }
      }

      const classified = classifyIsomorphicGitError(error, VcErrorCode.INVALID_REF)
      if (classified) throw classified

      const message = error instanceof Error ? error.message : 'Pull failed. Check your connection and try again.'
      throw new VcError(message, VcErrorCode.PULL_FAILED)
    }

    return {alreadyUpToDate, branch}
  }

  private async handlePush(data: IVcPushRequest, clientId: string): Promise<IVcPushResponse> {
    const projectPath = resolveRequiredProjectPath(this.resolveProjectPath, clientId)
    const directory = this.contextTreeService.resolvePath(projectPath)

    const gitInitialized = await this.gitService.isInitialized({directory})
    if (!gitInitialized) {
      throw new VcError('ByteRover version control not initialized.', VcErrorCode.GIT_NOT_INITIALIZED)
    }

    const token = await this.tokenStore.load()
    if (!token?.isValid()) throw new NotAuthenticatedError()

    const remotes = await this.gitService.listRemotes({directory})
    if (remotes.length === 0) {
      throw new VcError(this.buildNoRemoteMessage('brv vc push -u origin main'), VcErrorCode.NO_REMOTE)
    }

    const commits = await this.gitService.log({depth: 1, directory})
    if (commits.length === 0) {
      throw new VcError('No commits to push. Run brv vc add and brv vc commit first.', VcErrorCode.NOTHING_TO_PUSH)
    }

    // Block push while conflict markers remain in tracked files
    const conflictFiles = await this.gitService.getFilesWithConflictMarkers({directory})
    if (conflictFiles.length > 0) {
      throw new VcError(
        `Conflict markers detected in: ${conflictFiles.join(', ')}. Resolve conflicts before pushing.`,
        VcErrorCode.CONFLICT_MARKERS_PRESENT,
      )
    }

    const branch = await this.resolveTargetBranch(data.branch, directory)

    // Block push when no upstream tracking and no explicit branch — like git:
    //   git push           → error if no tracking
    //   git push origin X  → OK without tracking (explicit target)
    //   git push -u        → OK (will set tracking)
    const explicitBranch = Boolean(data.branch?.trim())
    const existingTracking = await this.gitService.getTrackingBranch({branch, directory})
    if (!existingTracking && !explicitBranch && !data.setUpstream) {
      throw new VcError(
        `The current branch '${branch}' has no upstream branch.\n` +
          `To push the current branch and set the remote as upstream, use\n\n` +
          `    brv vc push -u origin ${branch}`,
        VcErrorCode.NO_UPSTREAM,
      )
    }

    // Set upstream tracking BEFORE push so pull works even if push fails with non_fast_forward
    let upstreamSet = false
    if (data.setUpstream) {
      await this.gitService.setTrackingBranch({branch, directory, remote: 'origin', remoteBranch: branch})
      upstreamSet = true
    }

    let alreadyUpToDate = false
    try {
      const result = await this.gitService.push({branch, directory, remote: 'origin'})
      if (!result.success && result.reason === 'non_fast_forward') {
        throw new VcError('Remote has changes. Pull first with brv vc pull.', VcErrorCode.NON_FAST_FORWARD)
      }

      if (result.success) alreadyUpToDate = result.alreadyUpToDate ?? false
    } catch (error) {
      if (error instanceof VcError) throw error
      if (error instanceof GitAuthError) {
        throw new VcError('Authentication failed. Run brv login.', VcErrorCode.AUTH_FAILED)
      }

      const classified = classifyIsomorphicGitError(error, VcErrorCode.INVALID_REF)
      if (classified) throw classified

      const message = error instanceof Error ? error.message : 'Push failed. Check your connection and try again.'
      throw new VcError(message, VcErrorCode.PUSH_FAILED)
    }

    return {alreadyUpToDate, branch, upstreamSet}
  }

  private async handleRemote(data: IVcRemoteRequest, clientId: string): Promise<IVcRemoteResponse> {
    const projectPath = resolveRequiredProjectPath(this.resolveProjectPath, clientId)
    const directory = this.contextTreeService.resolvePath(projectPath)

    const gitInitialized = await this.gitService.isInitialized({directory})
    if (!gitInitialized) {
      throw new VcError('ByteRover version control not initialized.', VcErrorCode.GIT_NOT_INITIALIZED)
    }

    if (data.subcommand === 'show') {
      const url = await this.gitService.getRemoteUrl({directory, remote: 'origin'})
      return {action: 'show', url: url ? maskCredentialsInUrl(url) : undefined}
    }

    if (data.subcommand === 'remove') {
      const existingUrl = await this.gitService.getRemoteUrl({directory, remote: 'origin'})
      if (!existingUrl) {
        throw new VcError("No remote 'origin' to remove.", VcErrorCode.NO_REMOTE)
      }

      // Clear config before removing the remote so a mid-way failure leaves a retry-friendly state:
      // if removeRemote throws, config is already cleared and remote is still present, so
      // re-running `remove` will retry removeRemote and succeed. The reverse order leaves the
      // remote gone but config stale, and the next `remove` fails with NO_REMOTE — unrecoverable.
      const existingConfig = await this.projectConfigStore.read(projectPath)
      if (existingConfig) {
        await this.projectConfigStore.write(existingConfig.withoutSpace(), projectPath)
      }

      await this.gitService.removeRemote({directory, remote: 'origin'})

      return {action: 'remove'}
    }

    if (data.subcommand !== 'add' && data.subcommand !== 'set-url') {
      throw new VcError('Unknown remote subcommand.', VcErrorCode.INVALID_ACTION)
    }

    if (!data.url) {
      throw new VcError('URL is required.', VcErrorCode.INVALID_REMOTE_URL)
    }

    // Check local state before hitting the server — fail fast for duplicate remote
    if (data.subcommand === 'add') {
      const existing = await this.gitService.getRemoteUrl({directory, remote: 'origin'})
      if (existing) {
        throw new VcError(
          "Remote 'origin' already exists. Use brv vc remote set-url <url> to update.",
          VcErrorCode.REMOTE_ALREADY_EXISTS,
        )
      }
    }

    const resolved = await this.resolveFullCogitUrl(data.url)

    if (data.subcommand === 'add') {
      await this.gitService.addRemote({directory, remote: 'origin', url: resolved.url})
    } else {
      // set-url
      await this.gitService.removeRemote({directory, remote: 'origin'}).catch(() => {
        // ignore if remote doesn't exist
      })
      await this.gitService.addRemote({directory, remote: 'origin', url: resolved.url})
    }

    // Persist space/team to config (same pattern as handleClone)
    if (resolved.spaceId && resolved.spaceName && resolved.teamId && resolved.teamName) {
      const space = new Space({
        id: resolved.spaceId,
        isDefault: false,
        name: resolved.spaceName,
        slug: resolved.spaceSlug,
        teamId: resolved.teamId,
        teamName: resolved.teamName,
        teamSlug: resolved.teamSlug,
      })
      const existing = await this.projectConfigStore.read(projectPath)
      const updated = existing ? existing.withSpace(space) : BrvConfig.partialFromSpace({space})
      await this.projectConfigStore.write(updated, projectPath)
    }

    return {action: data.subcommand === 'add' ? 'add' : 'set-url', url: resolved.url}
  }

  private async handleReset(data: IVcResetRequest, clientId: string): Promise<IVcResetResponse> {
    const projectPath = resolveRequiredProjectPath(this.resolveProjectPath, clientId)
    const directory = this.contextTreeService.resolvePath(projectPath)

    const gitInitialized = await this.gitService.isInitialized({directory})
    if (!gitInitialized) {
      throw new VcError('ByteRover version control not initialized.', VcErrorCode.GIT_NOT_INITIALIZED)
    }

    const mode: VcResetMode = data.filePaths ? 'mixed' : (data.mode ?? 'mixed')

    // Block soft/hard reset during active merge
    if (mode !== 'mixed' || (data.ref && data.ref !== 'HEAD')) {
      const hasMergeHead = await fs.promises
        .access(join(directory, '.git', 'MERGE_HEAD'))
        .then(() => true)
        .catch(() => false)

      if (hasMergeHead && mode !== 'hard') {
        throw new VcError(
          'Cannot reset while a merge is in progress. Abort or complete the merge first.',
          VcErrorCode.MERGE_IN_PROGRESS,
        )
      }
    }

    try {
      const result = await this.gitService.reset({
        directory,
        filePaths: data.filePaths,
        mode: data.filePaths ? undefined : mode,
        ref: data.ref,
      })

      const isUnstage = Boolean(data.filePaths) || (mode === 'mixed' && (!data.ref || data.ref === 'HEAD'))

      return {
        filesUnstaged: isUnstage ? result.filesChanged : undefined,
        headSha: isUnstage ? undefined : result.headSha,
        mode,
      }
    } catch (error) {
      if (error instanceof GitError) {
        if (error.message.includes('pathspec')) {
          throw new VcError(error.message, VcErrorCode.FILE_NOT_FOUND)
        }

        if (error.message.includes('Cannot resolve')) {
          throw new VcError(error.message, VcErrorCode.INVALID_REF)
        }

        if (error.message.includes('detached HEAD')) {
          throw new VcError(error.message, VcErrorCode.INVALID_ACTION)
        }

        if (error.message.includes('No commits')) {
          throw new VcError(error.message, VcErrorCode.NO_COMMITS)
        }
      }

      throw error
    }
  }

  private async handleStatus(clientId: string): Promise<IVcStatusResponse> {
    const projectPath = resolveRequiredProjectPath(this.resolveProjectPath, clientId)

    const contextTreeDir = this.contextTreeService.resolvePath(projectPath)
    const gitInitialized = await this.gitService.isInitialized({directory: contextTreeDir})
    if (!gitInitialized) {
      return {
        initialized: false,
        staged: {added: [], deleted: [], modified: []},
        unstaged: {deleted: [], modified: []},
        untracked: [],
      }
    }

    await ensureContextTreeGitignore(contextTreeDir)

    const branch = await this.gitService.getCurrentBranch({directory: contextTreeDir})
    const gitStatus = await this.gitService.status({directory: contextTreeDir})

    // Detect empty repo (no commits yet)
    const hasCommits = await this.gitService
      .log({depth: 1, directory: contextTreeDir})
      .then((commits) => commits.length > 0)

    // Check if a merge is in progress (MERGE_HEAD exists)
    const mergeInProgress = await fs.promises
      .access(join(contextTreeDir, '.git', 'MERGE_HEAD'))
      .then(() => true)
      .catch(() => false)

    // Detect unresolved conflicts during merge
    const unmerged = mergeInProgress
      ? (await this.gitService.getConflicts({directory: contextTreeDir})).map((c) => ({path: c.path, type: c.type}))
      : undefined

    // Detect files with conflict markers (regardless of merge state)
    const conflictMarkerFiles = await this.gitService.getFilesWithConflictMarkers({directory: contextTreeDir})

    // Filter out unmerged paths from staged/unstaged — git native only shows them in "Unmerged paths" section
    const unmergedPaths = unmerged ? new Set(unmerged.map((u) => u.path)) : new Set<string>()
    const staged = gitStatus.files.filter((f) => f.staged && !unmergedPaths.has(f.path))
    const unstaged = gitStatus.files.filter((f) => !f.staged && f.status !== 'untracked' && !unmergedPaths.has(f.path))

    // Resolve tracking branch and ahead/behind counts
    let trackingBranch: string | undefined
    let ahead: number | undefined
    let behind: number | undefined
    if (branch) {
      const tracking = await this.gitService.getTrackingBranch({branch, directory: contextTreeDir})
      if (tracking) {
        trackingBranch = `${tracking.remote}/${tracking.remoteBranch}`
        const counts = await this.gitService.getAheadBehind({
          directory: contextTreeDir,
          localRef: `refs/heads/${branch}`,
          remoteRef: `refs/remotes/${tracking.remote}/${tracking.remoteBranch}`,
        })
        ahead = counts.ahead
        behind = counts.behind
      }
    }

    return {
      ahead,
      behind,
      branch,
      conflictMarkerFiles: conflictMarkerFiles.length > 0 ? conflictMarkerFiles : undefined,
      hasCommits,
      initialized: true,
      mergeInProgress,
      staged: {
        added: staged.filter((f) => f.status === 'added').map((f) => f.path),
        deleted: staged.filter((f) => f.status === 'deleted').map((f) => f.path),
        modified: staged.filter((f) => f.status === 'modified').map((f) => f.path),
      },
      trackingBranch,
      unmerged,
      unstaged: {
        deleted: unstaged.filter((f) => f.status === 'deleted').map((f) => f.path),
        modified: unstaged.filter((f) => f.status === 'modified').map((f) => f.path),
      },
      untracked: gitStatus.files.filter((f) => f.status === 'untracked').map((f) => f.path),
    }
  }

  /**
   * Reads a diff side's content + short oid in a single pass. Returns `undefined`
   * only when the blob is absent on disk / at the ref. Binary content (NUL byte)
   * is marked via `binary: true` so the caller can emit `Binary files ... differ`.
   */
  private async readSideEntry(
    directory: string,
    side: GitDiffSide,
    path: string,
  ): Promise<undefined | {binary?: boolean; content: string; oid: string}> {
    if (side === 'WORKDIR') {
      let buf: Buffer
      try {
        buf = await fs.promises.readFile(join(directory, path))
      } catch {
        return undefined
      }

      const oid = await this.gitService.hashBlob(buf)
      if (buf.includes(0)) return {binary: true, content: '', oid}
      return {content: buf.toString('utf8'), oid}
    }

    return this.gitService.getTextBlob({directory, path, ref: side})
  }

  /**
   * Resolve clone request data into a clean cogit URL + team/space info.
   * Accepts either a URL or explicit teamName/spaceName.
   * Auth is handled by IsomorphicGitService via headers, not URL credentials.
   */
  private async resolveCloneInput(data: IVcCloneRequest): Promise<{
    spaceId?: string
    spaceName?: string
    spaceSlug?: string
    teamId?: string
    teamName?: string
    teamSlug?: string
    url: string
  }> {
    if (data.url) {
      const resolved = await this.resolveFullCogitUrl(data.url)
      return {
        spaceId: resolved.spaceId ?? data.spaceId,
        spaceName: resolved.spaceName ?? data.spaceName,
        spaceSlug: resolved.spaceSlug,
        teamId: resolved.teamId ?? data.teamId,
        teamName: resolved.teamName ?? data.teamName,
        teamSlug: resolved.teamSlug,
        url: resolved.url,
      }
    }

    if (data.teamName && data.spaceName) {
      return {
        spaceId: data.spaceId,
        spaceName: data.spaceName,
        teamId: data.teamId,
        teamName: data.teamName,
        url: buildCogitRemoteUrl(this.gitRemoteBaseUrl, data.teamName, data.spaceName),
      }
    }

    throw new VcError('URL or space selection is required.', VcErrorCode.INVALID_REMOTE_URL)
  }

  /**
   * Resolve a remote URL to a clean cogit URL + team/space info.
   * Expected format: {domain}/{teamName}/{spaceName}.git
   * Resolves names to IDs via API; rejects unknown formats.
   *
   * Auth is handled by IsomorphicGitService via headers, not URL credentials.
   */
  private async resolveFullCogitUrl(url: string): Promise<{
    spaceId?: string
    spaceName?: string
    spaceSlug?: string
    teamId?: string
    teamName?: string
    teamSlug?: string
    url: string
  }> {
    this.validateRemoteUrlDomain(url)

    const parsed = parseUserFacingUrl(url)
    if (parsed) {
      return this.resolveTeamSpaceNames(parsed.teamName, parsed.spaceName)
    }

    throw new VcError(
      `Invalid URL format. Use: ${this.gitRemoteBaseUrl}/<team>/<space>.git`,
      VcErrorCode.INVALID_REMOTE_URL,
    )
  }

  private async resolveLogResult(
    data: IVcLogRequest,
    contextTreeDir: string,
  ): Promise<{commits: GitCommit[]; displayBranch: string | undefined}> {
    const currentBranch = await this.gitService.getCurrentBranch({directory: contextTreeDir})

    const all = data.all ?? false
    const limit = data.limit ?? 10

    if (all) {
      const branches = await this.gitService.listBranches({directory: contextTreeDir})
      const commitsByBranch = await Promise.all(
        branches.map((branch) => this.gitService.log({directory: contextTreeDir, ref: branch.name})),
      )
      const seen = new Set<string>()
      const commits = commitsByBranch
        .flat()
        .filter((c) => {
          if (seen.has(c.sha)) return false
          seen.add(c.sha)
          return true
        })
        .sort((a, b) => b.timestamp.getTime() - a.timestamp.getTime())
        .slice(0, limit)
      return {commits, displayBranch: currentBranch}
    }

    if (data.ref !== undefined) {
      const branches = await this.gitService.listBranches({directory: contextTreeDir})
      const branchExists = branches.some((b) => b.name === data.ref)
      if (!branchExists) {
        throw new VcError(`Branch '${data.ref}' not found.`, VcErrorCode.BRANCH_NOT_FOUND)
      }
    }

    const commits = await this.gitService.log({depth: limit, directory: contextTreeDir, ref: data.ref})
    return {commits, displayBranch: data.ref ?? currentBranch}
  }

  /**
   * Resolves pull target branch: explicit → tracking config → error.
   * Mirrors native git: `git pull` without tracking config errors.
   */
  private async resolvePullBranch(directory: string): Promise<string> {
    const current = await this.gitService.getCurrentBranch({directory})
    const currentTrimmed = current?.trim()
    if (currentTrimmed) {
      const tracking = await this.gitService.getTrackingBranch({branch: currentTrimmed, directory})
      if (tracking) return tracking.remoteBranch

      // No tracking configured — error like native git
      throw new VcError(
        `There is no tracking information for the current branch '${currentTrimmed}'.\n` +
          `To pull from remote, use:\n\n` +
          `    brv vc pull origin ${currentTrimmed}\n\n` +
          `Or set upstream tracking with:\n\n` +
          `    brv vc branch --set-upstream-to origin/${currentTrimmed}`,
        VcErrorCode.NO_UPSTREAM,
      )
    }

    throw new VcError('Cannot determine branch for pull. Check out a branch first.', VcErrorCode.NO_BRANCH_RESOLVED)
  }

  private async resolveTargetBranch(requestedBranch: string | undefined, directory: string): Promise<string> {
    const trimmed = requestedBranch?.trim()

    if (trimmed) {
      if (!isValidBranchName(trimmed)) {
        throw new VcError(`Invalid branch name: '${trimmed}'.`, VcErrorCode.INVALID_BRANCH_NAME)
      }

      return trimmed
    }

    const current = await this.gitService.getCurrentBranch({directory})
    const currentTrimmed = current?.trim()
    if (currentTrimmed) return currentTrimmed

    return 'main'
  }

  /**
   * Resolve team/space names to IDs via API, build clean cogit URL.
   */
  private async resolveTeamSpaceNames(
    teamSlug: string,
    spaceSlug: string,
  ): Promise<{
    spaceId: string
    spaceName: string
    spaceSlug: string
    teamId: string
    teamName: string
    teamSlug: string
    url: string
  }> {
    const token = await this.tokenStore.load()
    if (!token?.isValid()) throw new NotAuthenticatedError()

    const {teams} = await this.teamService.getTeams(token.sessionKey, {fetchAll: true})
    const team = teams.find((t) => t.slug.toLowerCase() === teamSlug.toLowerCase())
    if (!team) {
      throw new VcError(
        `Team "${teamSlug}" not found. Check the URL and your access permissions.`,
        VcErrorCode.INVALID_REMOTE_URL,
      )
    }

    const {spaces} = await this.spaceService.getSpaces(token.sessionKey, team.id, {fetchAll: true})
    const space = spaces.find((s) => s.slug.toLowerCase() === spaceSlug.toLowerCase())
    if (!space) {
      throw new VcError(
        `Space "${spaceSlug}" not found in team "${team.name}". Check the URL and your access permissions.`,
        VcErrorCode.INVALID_REMOTE_URL,
      )
    }

    return {
      spaceId: space.id,
      spaceName: space.name,
      spaceSlug: space.slug,
      teamId: space.teamId,
      teamName: team.name,
      teamSlug: team.slug,
      url: buildCogitRemoteUrl(this.gitRemoteBaseUrl, team.slug, space.slug),
    }
  }

  private validateBranchName(branch: string): void {
    if (!branch) {
      throw new VcError('Branch name is required.', VcErrorCode.INVALID_BRANCH_NAME)
    }

    if (!isValidBranchName(branch)) {
      throw new VcError(`Invalid branch name: '${branch}'.`, VcErrorCode.INVALID_BRANCH_NAME)
    }
  }

  private validateRemoteUrlDomain(url: string): void {
    try {
      const parsed = new URL(url)
      const allowedHosts = [this.gitRemoteBaseUrl].map((u) => new URL(u).host)
      if (!allowedHosts.includes(parsed.host)) {
        throw new VcError(
          `Invalid remote URL. Use: ${this.gitRemoteBaseUrl}/<team>/<space>.git`,
          VcErrorCode.INVALID_REMOTE_URL,
        )
      }
    } catch (error) {
      if (error instanceof VcError) throw error
      throw new VcError(
        `Invalid remote URL. Use: ${this.gitRemoteBaseUrl}/<team>/<space>.git`,
        VcErrorCode.INVALID_REMOTE_URL,
      )
    }
  }
}

function maskCredentialsInUrl(url: string): string {
  try {
    const parsed = new URL(url)
    if (parsed.password) {
      parsed.password = '***'
    }

    return parsed.toString()
  } catch {
    return url
  }
}
