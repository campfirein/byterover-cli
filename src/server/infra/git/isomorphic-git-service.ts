import type {StatusRow} from 'isomorphic-git'

import * as git from 'isomorphic-git'
import fs from 'node:fs'
import {join} from 'node:path'

import type {
  AbortMergeGitParams,
  AddGitParams,
  AddRemoteGitParams,
  AheadBehind,
  BaseGitParams,
  BlobContents,
  ChangedFile,
  CheckoutGitParams,
  CloneGitParams,
  CommitGitParams,
  CreateBranchGitParams,
  DeleteBranchGitParams,
  FetchGitParams,
  GetAheadBehindParams,
  GetBlobContentParams,
  GetBlobContentsParams,
  GetRemoteUrlGitParams,
  GetTrackingBranchParams,
  GitBlobRef,
  GitBranch,
  GitCommit,
  GitConflict,
  GitDiffSide,
  GitRemote,
  GitStatus,
  GitStatusFile,
  IGitService,
  InitGitParams,
  ListBranchesGitParams,
  ListChangedFilesParams,
  LogGitParams,
  MergeGitParams,
  MergeResult,
  PullGitParams,
  PullResult,
  PushGitParams,
  PushResult,
  RemoveRemoteGitParams,
  ResetGitParams,
  ResetResult,
  SetTrackingBranchParams,
  TextBlob,
  TrackingBranch,
} from '../../core/interfaces/services/i-git-service.js'
import type {IAuthStateStore} from '../../core/interfaces/state/i-auth-state-store.js'

import {hasConflictMarkers} from '../../../shared/utils/conflict-markers.js'
import {GitAuthError, GitError} from '../../core/domain/errors/git-error.js'
import {formatOverwriteMessage} from './git-error-messages.js'
import {gitHttpWrapper as http} from './git-http-wrapper.js'
import {classifyTuple} from './status-row-classifier.js'

/** Max commit depth for ahead/behind calculation. Counts beyond this are truncated. */
const MAX_AHEAD_BEHIND_DEPTH = 500

/** Shape of isomorphic-git's MergeConflictError.data property. */
type IsomorphicGitConflictData = {
  bothModified: string[]
  deleteByTheirs: string[]
  deleteByUs: string[]
  filepaths: string[]
}

/** isomorphic-git's MergeConflictError — extends Error with a typed `data` property. */
type IsomorphicGitMergeConflictError = Error & {data?: IsomorphicGitConflictData}

export class IsomorphicGitService implements IGitService {
  public constructor(private readonly authStateStore: IAuthStateStore) {}

  private static isConflictError(error: Error): error is IsomorphicGitMergeConflictError {
    return error.name === 'MergeConflictError' && 'data' in error
  }

  private static isMergeConflictData(data: unknown): data is IsomorphicGitConflictData {
    if (typeof data !== 'object' || data === null) return false
    return 'filepaths' in data && Array.isArray(data.filepaths)
  }

  async abortMerge(params: AbortMergeGitParams): Promise<void> {
    const dir = this.requireDirectory(params)
    const mergeHeadPath = join(dir, '.git', 'MERGE_HEAD')
    const mergeMsgPath = join(dir, '.git', 'MERGE_MSG')

    // Identify files introduced by the merge source (in MERGE_HEAD tree but not in HEAD tree).
    // These files appeared on disk during merge and must be removed on abort.
    // We compare tree contents (not statusMatrix) because merge-introduced files and
    // pre-existing untracked files both show as [0,2,0] in the status matrix.
    // Get current branch BEFORE checkout to avoid detached HEAD
    const branch = await this.getCurrentBranch(params)

    let mergeIntroducedFiles: string[] = []
    const mergeHeadOid = await fs.promises
      .readFile(mergeHeadPath, 'utf8')
      .then((s) => s.trim())
      .catch(() => null)
    if (mergeHeadOid) {
      const headFiles = new Set(await git.listFiles({dir, fs, ref: branch ?? 'HEAD'}))
      const mergeFiles = await git.listFiles({dir, fs, ref: mergeHeadOid})
      mergeIntroducedFiles = mergeFiles.filter((f) => !headFiles.has(f))
    }

    await git.checkout({dir, force: true, fs, ref: branch ?? 'HEAD'})

    // Clean up files that the merge brought in (exist in MERGE_HEAD but not in HEAD)
    for (const filepath of mergeIntroducedFiles) {
      // eslint-disable-next-line no-await-in-loop
      await fs.promises.unlink(join(dir, filepath)).catch(() => {})
    }

    await fs.promises.unlink(mergeHeadPath).catch(() => {})
    await fs.promises.unlink(mergeMsgPath).catch(() => {})
  }

  async add(params: AddGitParams): Promise<void> {
    const dir = this.requireDirectory(params)

    // Identify deleted files (exist in HEAD + index but not on disk: [1,0,1])
    // git.add() silently ignores missing files; git.remove() is required to stage deletions
    const matrix = await git.statusMatrix({dir, fs})
    // Covers [1,0,1] (unstaged deletion) and [1,0,2] (post-merge-conflict absent file).
    // stage !== 0 excludes [1,0,0] which is already staged as deletion — no git.remove() needed.
    const deletedInIndex = new Set(
      matrix
        .filter(([, head, workdir, stage]) => head === 1 && workdir === 0 && stage !== 0)
        .map(([filepath]) => String(filepath)),
    )

    // Files not present on disk at all (workdir=0): covers both [1,0,1] (unstaged deletion)
    // and [1,0,0] (already staged deletion). git.add() on these exact paths throws; skip toAdd.
    const notOnDisk = new Set(matrix.filter((row) => row[2] === 0).map((row) => String(row[0])))

    const toRemove: string[] = []
    const toAdd: string[] = []

    for (const rp of params.filePaths) {
      const matchesDelete = (filepath: string) => {
        if (rp === '.') return true
        if (filepath === rp) return true
        const prefix = rp.endsWith('/') ? rp : `${rp}/`
        return filepath.startsWith(prefix)
      }

      for (const deleted of deletedInIndex) {
        if (matchesDelete(deleted)) toRemove.push(deleted)
      }

      // Don't call git.add() for exact paths not on disk — git.remove() handles [1,0,1] above,
      // and [1,0,0] (already staged deletion) needs no further action.
      // git.add('.') and directory patterns are fine (silently skip missing files).
      if (!notOnDisk.has(rp)) {
        toAdd.push(rp)
      }
    }

    // isomorphic-git's `git.add` only inserts stage 0 and leaves stages 1/2/3 in place,
    // so conflicted files stay "unmerged" after staging. Pre-remove explicit paths to wipe
    // all stages; the follow-up `git.add` then produces a clean stage-0 entry.
    const explicitFilePaths = toAdd.filter((p) => p !== '.' && !p.endsWith('/'))
    await Promise.allSettled(explicitFilePaths.map((filepath) => git.remove({dir, filepath, fs})))

    const results = await Promise.allSettled([
      ...toRemove.map((filepath) => git.remove({dir, filepath, fs})),
      ...toAdd.map((filepath) => git.add({dir, filepath, fs})),
    ])

    const allPaths = [...toRemove, ...toAdd]
    const failed = results
      .map((r, i) => ({path: allPaths[i], result: r}))
      .filter((x): x is {path: string; result: PromiseRejectedResult} => x.result.status === 'rejected')

    if (failed.length > 0) {
      const paths = failed.map((f) => f.path).join(', ')
      throw new GitError(`Failed to stage: ${paths}`)
    }
  }

  async addRemote(params: AddRemoteGitParams): Promise<void> {
    const dir = this.requireDirectory(params)
    await git.addRemote({dir, fs, remote: params.remote, url: params.url})
  }

  async checkout(params: CheckoutGitParams): Promise<void> {
    const dir = this.requireDirectory(params)

    // Snapshot tracked files in current branch BEFORE checkout.
    // isomorphic-git's checkout only restores target files but does NOT remove
    // files that are tracked in the source branch but absent in the target.
    // Native git removes them, so we do it manually after checkout.
    // When HEAD points at an unborn branch (post-init, pre-commit), the ref does
    // not resolve — treat as no tracked files and skip the staged-conflict guard.
    const sourceBranch = await this.getCurrentBranch(params)
    const sourceOid = sourceBranch ? await this.tryResolveRef(dir, sourceBranch) : undefined
    const sourceFiles =
      sourceBranch && sourceOid
        ? new Set(await git.listFiles({dir, fs, ref: sourceBranch}))
        : new Set<string>()

    // isomorphic-git's checkout detects unstaged conflicts (CheckoutConflictError)
    // but silently overwrites staged changes — a data-loss bug. Guard staged
    // conflicts here to match native git behavior. The guard also covers unborn
    // HEAD and detached HEAD (sourceOid undefined): every staged blob is treated
    // as new content, so a conflicting target blob still trips.
    if (!params.force) {
      await this.guardStagedConflicts(dir, sourceOid, params.ref)
    }

    try {
      await git.checkout({dir, force: params.force, fs, ref: params.ref})
    } catch (error) {
      if (error instanceof git.Errors.CheckoutConflictError) {
        throw new GitError(formatOverwriteMessage('checkout', []))
      }

      throw error
    }

    // Remove files tracked in source but not in target (matches native git behavior).
    // Untracked files are not in either set, so they are preserved.
    if (sourceFiles.size > 0) {
      const targetFiles = new Set(await git.listFiles({dir, fs, ref: params.ref}))
      for (const filepath of sourceFiles) {
        if (!targetFiles.has(filepath)) {
          // eslint-disable-next-line no-await-in-loop
          await fs.promises.unlink(join(dir, filepath)).catch(() => {})
        }
      }
    }
  }

  async clone(params: CloneGitParams): Promise<void> {
    const dir = this.requireDirectory(params)
    const token = this.requireToken()
    await git.clone({
      dir,
      fs,
      headers: this.buildBasicAuthHeaders(token.userId, token.sessionKey),
      http,
      onAuth: this.getOnAuth(),
      onAuthFailure: this.getOnAuthFailure(),
      onProgress: params.onProgress,
      url: params.url,
    })
  }

  async commit(params: CommitGitParams): Promise<GitCommit> {
    const dir = this.requireDirectory(params)
    const author = params.author ?? this.getAuthor()

    // If MERGE_HEAD exists, create a proper merge commit with two parents
    const mergeHeadPath = join(dir, '.git', 'MERGE_HEAD')
    const mergeMsgPath = join(dir, '.git', 'MERGE_MSG')
    const mergeHeadContent = await fs.promises.readFile(mergeHeadPath, 'utf8').catch(() => null)
    const mergeHead = mergeHeadContent?.trim() ?? null

    let parent: string[] | undefined
    if (mergeHead) {
      const headSha = await git.resolveRef({dir, fs, ref: 'HEAD'})
      parent = [headSha, mergeHead]
    }

    let sha: string
    try {
      sha = await git.commit({author, dir, fs, message: params.message, ...(parent ? {parent} : {})})
    } catch (error) {
      if (error instanceof git.Errors.UnmergedPathsError) {
        const paths = error.data.filepaths.join(', ')
        throw new GitError(`Unmerged files must be resolved before committing: ${paths}`)
      }

      throw error
    }

    const {commit: commitObj} = await git.readCommit({dir, fs, oid: sha})

    // Clean up MERGE_HEAD and MERGE_MSG (isomorphic-git does not remove them automatically)
    await fs.promises.unlink(mergeHeadPath).catch(() => {})
    await fs.promises.unlink(mergeMsgPath).catch(() => {})

    return {
      author,
      message: params.message,
      sha,
      timestamp: new Date(commitObj.author.timestamp * 1000),
    }
  }

  async createBranch(params: CreateBranchGitParams): Promise<void> {
    const dir = this.requireDirectory(params)
    await git.branch({
      checkout: params.checkout,
      dir,
      fs,
      object: params.startPoint,
      ref: params.branch,
    })
  }

  async deleteBranch(params: DeleteBranchGitParams): Promise<void> {
    const dir = this.requireDirectory(params)
    await git.deleteBranch({dir, fs, ref: params.branch})
  }

  async fetch(params: FetchGitParams): Promise<void> {
    const dir = this.requireDirectory(params)
    const token = this.requireToken()
    await git.fetch({
      dir,
      fs,
      headers: this.buildBasicAuthHeaders(token.userId, token.sessionKey),
      http,
      onAuth: this.getOnAuth(),
      onAuthFailure: this.getOnAuthFailure(),
      ref: params.ref,
      remote: params.remote ?? 'origin',
    })
  }

  async getAheadBehind(params: GetAheadBehindParams): Promise<AheadBehind> {
    const dir = this.requireDirectory(params)

    const localSha = await git.resolveRef({dir, fs, ref: params.localRef}).catch(() => null)
    const remoteSha = await git.resolveRef({dir, fs, ref: params.remoteRef}).catch(() => null)
    if (!localSha || !remoteSha) return {ahead: 0, behind: 0}
    if (localSha === remoteSha) return {ahead: 0, behind: 0}

    const [localLog, remoteLog] = await Promise.all([
      git.log({depth: MAX_AHEAD_BEHIND_DEPTH, dir, fs, ref: params.localRef}).catch(() => []),
      git.log({depth: MAX_AHEAD_BEHIND_DEPTH, dir, fs, ref: params.remoteRef}).catch(() => []),
    ])

    const localShas = new Set(localLog.map((c) => c.oid))
    const remoteShas = new Set(remoteLog.map((c) => c.oid))

    const ahead = localLog.filter((c) => !remoteShas.has(c.oid)).length
    const behind = remoteLog.filter((c) => !localShas.has(c.oid)).length
    return {ahead, behind}
  }

  async getBlobContent(params: GetBlobContentParams): Promise<string | undefined> {
    const contents = await this.getBlobContents({directory: params.directory, paths: [params.path], ref: params.ref})
    return contents[params.path]
  }

  async getBlobContents(params: GetBlobContentsParams): Promise<BlobContents> {
    const dir = this.requireDirectory(params)
    const {paths, ref} = params
    const result: BlobContents = Object.fromEntries(paths.map((p) => [p, undefined]))
    if (paths.length === 0) return result

    if (ref !== 'STAGE') {
      const commitOid = await this.resolveRefExpression(dir, ref.commitish).catch(() => null)
      if (!commitOid) return result

      await Promise.all(
        paths.map(async (path) => {
          try {
            const {blob} = await git.readBlob({dir, filepath: path, fs, oid: commitOid})
            result[path] = Buffer.from(blob).toString('utf8')
          } catch {
            // leave as undefined
          }
        }),
      )
      return result
    }

    // STAGE — walk the index once, reading only the blobs we care about.
    const pathSet = new Set(paths)
    await git
      .walk({
        dir,
        fs,
        async map(filepath, [entry]) {
          if (!pathSet.has(filepath) || !entry) return
          if ((await entry.type()) !== 'blob') return
          const oid = await entry.oid()
          try {
            const {blob} = await git.readBlob({dir, fs, oid})
            result[filepath] = Buffer.from(blob).toString('utf8')
          } catch {
            // leave as undefined
          }
        },
        // eslint-disable-next-line new-cap
        trees: [git.STAGE()],
      })
      .catch(() => {
        // walk failed → every entry stays undefined
      })

    return result
  }

  async getConflicts(params: BaseGitParams): Promise<GitConflict[]> {
    const dir = this.requireDirectory(params)

    // Only report conflicts when a merge is actually in progress
    const mergeInProgress = await fs.promises
      .access(join(dir, '.git', 'MERGE_HEAD'))
      .then(() => true)
      .catch(() => false)

    if (!mergeInProgress) return []

    // Index-based detection: `stage === 3` marks multi-stage entries from a merge.
    // Once `git.add` collapses them into stage 0, the file leaves the conflict set.
    // Workdir markers are checked separately via `getFilesWithConflictMarkers`.
    const matrix = await git.statusMatrix({dir, fs})
    const conflicts: GitConflict[] = []

    for (const [filepath, head, workdir, stage] of matrix) {
      const path = String(filepath)

      // deleted_modified: file in HEAD, removed from workdir, with multi-stage index entry.
      // `stage !== 0` filters out clean staged deletions (`[1,0,0]`).
      if (head === 1 && workdir === 0 && stage !== 0) {
        conflicts.push({path, type: 'deleted_modified'})
        continue
      }

      // deleted_modified (isomorphic-git variant): file in HEAD, on disk unchanged,
      // but index differs from both (stage=3). Other branch deleted a file we modified —
      // isomorphic-git keeps our version on disk while leaving multi-stage index entries.
      if (head === 1 && workdir === 1 && stage === 3) {
        conflicts.push({path, type: 'deleted_modified'})
        continue
      }

      // both_modified: file in HEAD, modified in workdir, multi-stage index.
      if (head === 1 && workdir === 2 && stage === 3) {
        conflicts.push({path, type: 'both_modified'})
        continue
      }

      // both_added: file not in HEAD, present in workdir, multi-stage index.
      if (head === 0 && workdir === 2 && stage === 3) {
        conflicts.push({path, type: 'both_added'})
      }
    }

    return conflicts.sort((a, b) => a.path.localeCompare(b.path))
  }

  async getCurrentBranch(params: BaseGitParams): Promise<string | undefined> {
    const dir = this.requireDirectory(params)
    const branch = await git.currentBranch({dir, fs})
    return branch ?? undefined
  }

  async getFilesWithConflictMarkers(params: BaseGitParams): Promise<string[]> {
    const dir = this.requireDirectory(params)
    const matrix = await git.statusMatrix({dir, fs})
    const conflicted: string[] = []

    await Promise.all(
      matrix.map(async ([filepath, , workdir]) => {
        const path = String(filepath)
        // Only check files that exist in the working directory
        if (workdir === 0) return
        try {
          const content = await fs.promises.readFile(join(dir, path), 'utf8')
          if (hasConflictMarkers(content)) {
            conflicted.push(path)
          }
        } catch {
          // skip binary or unreadable files
        }
      }),
    )

    return conflicted.sort()
  }

  async getRemoteUrl(params: GetRemoteUrlGitParams): Promise<string | undefined> {
    const dir = this.requireDirectory(params)
    const result = await git.getConfig({dir, fs, path: `remote.${params.remote}.url`})
    return result === undefined || result === null ? undefined : String(result)
  }

  async getTextBlob(params: GetBlobContentParams): Promise<TextBlob | undefined> {
    const dir = this.requireDirectory(params)
    const {path, ref} = params
    const raw = await this.readRawBlob(dir, path, ref)
    if (!raw) return undefined
    if (raw.bytes.includes(0)) return {binary: true, content: '', oid: raw.oid.slice(0, 7)}
    return {content: Buffer.from(raw.bytes).toString('utf8'), oid: raw.oid.slice(0, 7)}
  }

  async getTrackingBranch(params: GetTrackingBranchParams): Promise<TrackingBranch | undefined> {
    const dir = this.requireDirectory(params)
    const remote = await git.getConfig({dir, fs, path: `branch.${params.branch}.remote`})
    if (remote === undefined || remote === null) return undefined

    const merge = await git.getConfig({dir, fs, path: `branch.${params.branch}.merge`})
    if (merge === undefined || merge === null) return undefined

    // merge is stored as refs/heads/<branch> — extract the branch name
    const mergeStr = String(merge)
    const remoteBranch = mergeStr.startsWith('refs/heads/') ? mergeStr.slice('refs/heads/'.length) : mergeStr
    return {remote: String(remote), remoteBranch}
  }

  async hashBlob(content: Buffer): Promise<string> {
    const {oid} = await git.hashBlob({object: content})
    return oid.slice(0, 7)
  }

  async init(params: InitGitParams): Promise<void> {
    const dir = this.requireDirectory(params)
    await git.init({defaultBranch: params.defaultBranch ?? 'main', dir, fs})
  }

  async isAncestor(params: BaseGitParams & {ancestor: string; commit: string}): Promise<boolean> {
    const dir = this.requireDirectory(params)
    const commitOid = await git.resolveRef({dir, fs, ref: params.commit})
    const ancestorOid = await git.resolveRef({dir, fs, ref: params.ancestor})
    if (commitOid === ancestorOid) return true
    return git.isDescendent({ancestor: ancestorOid, depth: -1, dir, fs, oid: commitOid})
  }

  async isEmptyRepository(params: BaseGitParams): Promise<boolean> {
    const dir = this.requireDirectory(params)

    const commits = await this.log({depth: 1, directory: dir})
    if (commits.length > 0) return false

    const remotes = await this.listRemotes({directory: dir})
    if (remotes.length > 0) return false

    const branches = await git.listBranches({dir, fs})
    if (branches.length > 0) return false

    const tags = await git.listTags({dir, fs})
    if (tags.length > 0) return false

    const {isClean} = await this.status({directory: dir})
    return isClean
  }

  async isInitialized(params: BaseGitParams): Promise<boolean> {
    const dir = this.requireDirectory(params)
    return fs.promises
      .access(join(dir, '.git'))
      .then(() => true)
      .catch(() => false)
  }

  async listBranches(params: ListBranchesGitParams): Promise<GitBranch[]> {
    const dir = this.requireDirectory(params)
    const current = await this.getCurrentBranch(params)
    const branches = await git.listBranches({dir, fs})
    const result: GitBranch[] = branches.map((name) => ({isCurrent: name === current, isRemote: false, name}))

    if (params.remote) {
      try {
        const remoteBranches = await git.listBranches({dir, fs, remote: params.remote})
        for (const name of remoteBranches) {
          if (name === 'HEAD') continue
          result.push({isCurrent: false, isRemote: true, name: `${params.remote}/${name}`})
        }
      } catch {
        // No remote configured or no refs fetched yet — return local-only.
        // Mirrors `git branch -a`: never auto-fetches, reads cached refs only.
      }
    }

    return result
  }

  async listChangedFiles(params: ListChangedFilesParams): Promise<ChangedFile[]> {
    const dir = this.requireDirectory(params)
    const {from, to} = params

    // Commit-vs-commit: walk both trees, compare oids
    if (from !== 'STAGE' && from !== 'WORKDIR' && to !== 'STAGE' && to !== 'WORKDIR') {
      return this.listChangedBetweenCommits(dir, from.commitish, to.commitish)
    }

    return this.listChangedFromMatrix(dir, from, to)
  }

  async listRemotes(params: BaseGitParams): Promise<GitRemote[]> {
    const dir = this.requireDirectory(params)
    const remotes = await git.listRemotes({dir, fs})
    return remotes.map((r) => ({remote: r.remote, url: r.url}))
  }

  async log(params: LogGitParams): Promise<GitCommit[]> {
    const dir = this.requireDirectory(params)
    try {
      const commits = await git.log({depth: params.depth, dir, filepath: params.filepath, fs, ref: params.ref})
      return commits.map((c) => ({
        author: {email: c.commit.author.email, name: c.commit.author.name},
        message: c.commit.message.trim(),
        sha: c.oid,
        timestamp: new Date(c.commit.author.timestamp * 1000),
      }))
    } catch (error) {
      // No commits yet — HEAD ref does not exist
      if (error instanceof git.Errors.NotFoundError) return []
      throw error
    }
  }

  async merge(params: MergeGitParams): Promise<MergeResult> {
    const dir = this.requireDirectory(params)
    const mergeHeadPath = join(dir, '.git', 'MERGE_HEAD')
    const mergeMsgPath = join(dir, '.git', 'MERGE_MSG')
    const author = params.author ?? this.getAuthor()
    const message = params.message ?? `Merge branch '${params.branch}'`
    const currentBranch = await git.currentBranch({dir, fs})
    const localSha = currentBranch
      ? await git.resolveRef({dir, fs, ref: `refs/heads/${currentBranch}`}).catch(() => null)
      : null

    try {
      const mergeResult = await git.merge({
        abortOnConflict: false,
        author,
        committer: author,
        dir,
        fs,
        message,
        theirs: params.branch,
      })

      if (mergeResult.alreadyMerged) {
        return {alreadyUpToDate: true, success: true}
      }

      // isomorphic-git merge only updates refs — checkout to apply changes to working tree
      if (currentBranch) {
        await git.checkout({dir, fs, ref: currentBranch})
      }

      return {success: true}
    } catch (error) {
      if (error instanceof git.Errors.CheckoutConflictError) {
        // Undo the merge commit — restore HEAD to pre-merge state so repo is left clean
        if (localSha && currentBranch) {
          await git.writeRef({dir, force: true, fs, ref: `refs/heads/${currentBranch}`, value: localSha})
        }

        throw new GitError(formatOverwriteMessage('merge', []))
      }

      if (error instanceof git.Errors.MergeConflictError) {
        // isomorphic-git does not write MERGE_HEAD/MERGE_MSG — write them so
        // getConflicts() and --continue work post-restart
        const theirsOid = await git.resolveRef({dir, fs, ref: params.branch})
        await fs.promises.writeFile(mergeHeadPath, `${theirsOid}\n`)
        await fs.promises.writeFile(mergeMsgPath, `${message}\n`)

        // isomorphic-git uses the branch name as marker label (<<<<<<< main);
        // native git uses HEAD — rewrite markers to match git convention
        if (currentBranch) {
          await this.rewriteConflictMarkers(dir, currentBranch, this.conflictsFromError(error))
        }

        return {conflicts: this.conflictsFromError(error), success: false}
      }

      if (error instanceof git.Errors.MergeNotSupportedError) {
        if (!params.allowUnrelatedHistories) {
          throw new GitError('Refusing to merge unrelated histories. Use --allow-unrelated-histories to force.')
        }

        const oursRef = (await git.currentBranch({dir, fs})) ?? 'HEAD'
        return this.mergeUnrelatedHistories({author, dir, message, oursRef, theirsRef: params.branch})
      }

      throw error
    }
  }

  async pull(params: PullGitParams): Promise<PullResult> {
    const dir = this.requireDirectory(params)
    const token = this.requireToken()
    const remote = params.remote ?? 'origin'

    // Guard: if MERGE_HEAD exists, a previous merge is unresolved — refuse to pull
    const hasPendingMerge = await fs.promises
      .readFile(join(dir, '.git', 'MERGE_HEAD'), 'utf8')
      .then(() => true)
      .catch(() => false)
    if (hasPendingMerge) {
      throw new GitError(
        'You have unresolved merge conflicts. Resolve them, stage the files, and commit before pulling again.',
      )
    }

    // Fetch from remote
    await git.fetch({
      dir,
      fs,
      headers: this.buildBasicAuthHeaders(token.userId, token.sessionKey),
      http,
      onAuth: this.getOnAuth(),
      onAuthFailure: this.getOnAuthFailure(),
      remote,
      ...(params.branch ? {remoteRef: params.branch} : {}),
    })

    // Determine which remote-tracking branch to merge
    const localBranch = params.branch ?? (await this.getCurrentBranch(params))
    if (!localBranch) throw new GitError('Cannot determine branch for pull')

    // After fetch, check if already up to date
    const localSha = await git.resolveRef({dir, fs, ref: `refs/heads/${localBranch}`}).catch(() => null)
    const remoteSha = await git.resolveRef({dir, fs, ref: `refs/remotes/${remote}/${localBranch}`}).catch(() => null)
    if (localSha && remoteSha && localSha === remoteSha) {
      return {alreadyUpToDate: true, success: true}
    }

    // Empty local repo — fast-forward HEAD to remote tip (like native git pull on empty repo)
    if (!localSha && remoteSha) {
      await git.writeRef({dir, force: true, fs, ref: `refs/heads/${localBranch}`, value: remoteSha})
      await git.checkout({dir, fs, ref: localBranch})
      return {alreadyUpToDate: false, success: true}
    }

    // Step 2: working tree safety check (isomorphic-git does not do this automatically)
    // Abort if any dirty local file would be overwritten by the incoming changes
    if (localSha && remoteSha) {
      const matrix = await git.statusMatrix({dir, fs})
      const dirtyFiles = matrix
        .filter(([, head, workdir, stage]) => classifyTuple(head, workdir, stage).dirty)
        .map((row) => String(row[0]))

      const localRef = localSha
      const remoteRef = remoteSha
      const wouldBeOverwritten = await Promise.all(
        dirtyFiles.map(async (filepath) => {
          const [localFileOid, remoteFileOid] = await Promise.all([
            git
              .readBlob({dir, filepath, fs, oid: localRef})
              .then((r) => r.oid)
              .catch(() => null),
            git
              .readBlob({dir, filepath, fs, oid: remoteRef})
              .then((r) => r.oid)
              .catch(() => null),
          ])
          return localFileOid !== remoteFileOid
        }),
      )
      const overwrittenFiles = dirtyFiles.filter((_, i) => wouldBeOverwritten[i])
      if (overwrittenFiles.length > 0) {
        throw new GitError(formatOverwriteMessage('pull', overwrittenFiles))
      }
    }

    const author = params.author ?? this.getAuthor()
    try {
      const mergeResult = await git.merge({
        abortOnConflict: false,
        author,
        committer: author,
        dir,
        fs,
        theirs: `${remote}/${localBranch}`,
      })
      // isomorphic-git merge only updates refs/commits — checkout to apply file changes to workdir.
      await git.checkout({dir, fs, ref: localBranch})
      return {alreadyUpToDate: mergeResult.alreadyMerged, success: true}
    } catch (error) {
      if (error instanceof git.Errors.MergeConflictError) {
        // isomorphic-git does not write MERGE_HEAD/MERGE_MSG — write them so
        // getConflicts() and --continue work post-restart
        const theirsOid = await git.resolveRef({dir, fs, ref: `refs/remotes/${remote}/${localBranch}`})
        await fs.promises.writeFile(join(dir, '.git', 'MERGE_HEAD'), `${theirsOid}\n`)
        await fs.promises.writeFile(
          join(dir, '.git', 'MERGE_MSG'),
          `Merge remote-tracking branch '${remote}/${localBranch}'\n`,
        )

        // Rewrite conflict markers: isomorphic-git uses branch name, git uses HEAD
        await this.rewriteConflictMarkers(dir, localBranch, this.conflictsFromError(error))

        return {conflicts: this.conflictsFromError(error), success: false}
      }

      if (error instanceof git.Errors.MergeNotSupportedError) {
        if (!params.allowUnrelatedHistories) {
          throw new GitError('Refusing to merge unrelated histories. Use --allow-unrelated-histories to force.')
        }

        const result = await this.mergeUnrelatedHistories({
          author,
          dir,
          message: `Merge remote-tracking branch '${remote}/${localBranch}'`,
          oursRef: localBranch,
          theirsRef: `${remote}/${localBranch}`,
        })
        if (result.success) {
          await git.checkout({dir, fs, ref: localBranch})
        }

        return result
      }

      if (error instanceof git.Errors.CheckoutConflictError) {
        // Undo the merge commit — restore HEAD to pre-merge state so repo is left clean
        if (localSha) {
          await git.writeRef({dir, force: true, fs, ref: `refs/heads/${localBranch}`, value: localSha})
        }

        throw new GitError(formatOverwriteMessage('pull', []))
      }

      throw error
    }
  }

  async push(params: PushGitParams): Promise<PushResult> {
    const dir = this.requireDirectory(params)
    const token = this.requireToken()
    try {
      const branch = params.branch ?? (await git.currentBranch({dir, fs})) ?? 'main'
      const remote = params.remote ?? 'origin'

      const localSha = await git.resolveRef({dir, fs, ref: `refs/heads/${branch}`}).catch(() => null)
      const remoteSha = await git.resolveRef({dir, fs, ref: `refs/remotes/${remote}/${branch}`}).catch(() => null)
      if (localSha && remoteSha && localSha === remoteSha) {
        return {alreadyUpToDate: true, success: true}
      }

      await git.push({
        dir,
        fs,
        headers: this.buildBasicAuthHeaders(token.userId, token.sessionKey),
        http,
        onAuth: this.getOnAuth(),
        onAuthFailure: this.getOnAuthFailure(),
        ref: branch,
        remote,
      })
      return {alreadyUpToDate: false, success: true}
    } catch (error) {
      if (error instanceof git.Errors.PushRejectedError) {
        return {message: error.message, reason: 'non_fast_forward', success: false}
      }

      throw error
    }
  }

  async removeRemote(params: RemoveRemoteGitParams): Promise<void> {
    const dir = this.requireDirectory(params)
    await git.deleteRemote({dir, fs, remote: params.remote})
  }

  async reset(params: ResetGitParams): Promise<ResetResult> {
    const dir = this.requireDirectory(params)
    const mode = params.mode ?? 'mixed'
    const ref = params.ref ?? 'HEAD'

    // Case 1: Path-scoped unstage — always mixed, ignores mode/ref
    if (params.filePaths && params.filePaths.length > 0) {
      return this.resetUnstage(dir, params.filePaths)
    }

    // Case 2: Whole-tree unstage (mixed mode, ref=HEAD, no filePaths)
    if (mode === 'mixed' && ref === 'HEAD') {
      return this.resetUnstage(dir)
    }

    // Cases 3-5: Reset to a specific ref (soft/mixed/hard)
    // Empty repo (no commits) — HEAD doesn't exist. Git treats this as a silent no-op.
    const headExists = await git.resolveRef({dir, fs, ref: 'HEAD'}).then(
      () => true,
      () => false,
    )
    if (!headExists) {
      return {filesChanged: 0, headSha: ''}
    }

    const targetSha = await this.resolveRefExpression(dir, ref)
    const branch = await this.getCurrentBranch(params)
    if (!branch) {
      throw new GitError('Cannot reset in detached HEAD state.')
    }

    const previousSha = await git.resolveRef({dir, fs, ref: 'HEAD'})

    if (mode === 'soft') {
      await git.writeRef({dir, force: true, fs, ref: `refs/heads/${branch}`, value: targetSha})
      return {filesChanged: 0, headSha: targetSha}
    }

    if (mode === 'hard') {
      // Snapshot files in current HEAD to detect orphans after reset
      const currentFiles = new Set(await git.listFiles({dir, fs, ref: previousSha}))
      const targetFiles = new Set(await git.listFiles({dir, fs, ref: targetSha}))

      // Move branch pointer
      await git.writeRef({dir, force: true, fs, ref: `refs/heads/${branch}`, value: targetSha})

      // Restore working tree + index
      await git.checkout({dir, force: true, fs, ref: branch})

      // Delete orphaned files (tracked in old HEAD but not in target)
      for (const filepath of currentFiles) {
        if (!targetFiles.has(filepath)) {
          // eslint-disable-next-line no-await-in-loop
          await fs.promises.unlink(join(dir, filepath)).catch(() => {})
        }
      }

      // Clean up merge state if present
      await fs.promises.unlink(join(dir, '.git', 'MERGE_HEAD')).catch(() => {})
      await fs.promises.unlink(join(dir, '.git', 'MERGE_MSG')).catch(() => {})

      const filesChanged =
        [...currentFiles].filter((f) => !targetFiles.has(f)).length +
        [...targetFiles].filter((f) => !currentFiles.has(f)).length

      return {filesChanged, headSha: targetSha}
    }

    // mode === 'mixed' with ref !== HEAD
    // Move branch pointer, then reset index to match new HEAD (working tree untouched)
    await git.writeRef({dir, force: true, fs, ref: `refs/heads/${branch}`, value: targetSha})

    // Reset every file in the index to match the target
    const targetFiles = await git.listFiles({dir, fs, ref: targetSha})
    const matrix = await git.statusMatrix({dir, fs})
    const allPaths = new Set<string>([...matrix.map((row) => String(row[0])), ...targetFiles])

    await Promise.all([...allPaths].map((filepath) => git.resetIndex({dir, filepath, fs, ref: targetSha})))

    return {filesChanged: allPaths.size, headSha: targetSha}
  }

  async setTrackingBranch(params: SetTrackingBranchParams): Promise<void> {
    const dir = this.requireDirectory(params)
    await git.setConfig({dir, fs, path: `branch.${params.branch}.remote`, value: params.remote})
    await git.setConfig({dir, fs, path: `branch.${params.branch}.merge`, value: `refs/heads/${params.remoteBranch}`})
  }

  async status(params: BaseGitParams): Promise<GitStatus> {
    const dir = this.requireDirectory(params)
    const matrix = await git.statusMatrix({dir, fs})
    const files = this.parseMatrix(matrix)
    return {files, isClean: files.length === 0}
  }

  private buildBasicAuthHeaders(userId: string, sessionKey: string): Record<string, string> {
    const credentials = Buffer.from(`${userId}:${sessionKey}`).toString('base64')
    return {Authorization: `Basic ${credentials}`}
  }

  private async classifyRefVsWorkdir(
    dir: string,
    fromOid: string,
    refSet: Set<string>,
    matrix: StatusRow[],
  ): Promise<ChangedFile[]> {
    // "Tracked in workdir" = present on disk (workdir != 0) AND tracked (HEAD or stage has it).
    // This excludes untracked files (matches `git diff <commit>` which does not show untracked).
    const trackedOnDisk = new Set<string>()
    for (const [filepath, head, workdir, stage] of matrix) {
      if (workdir !== 0 && (head !== 0 || stage !== 0)) trackedOnDisk.add(String(filepath))
    }

    const candidates = new Set<string>([...refSet, ...trackedOnDisk])

    const results = await Promise.all(
      [...candidates].map(async (path): Promise<ChangedFile | undefined> => {
        const inRef = refSet.has(path)
        const inWork = trackedOnDisk.has(path)
        if (inRef && !inWork) return {path, status: 'deleted'}
        if (!inRef && inWork) return {path, status: 'added'}
        if (inRef && inWork) {
          const [fromBlobOid, workOid] = await Promise.all([
            this.readBlobOid(dir, fromOid, path),
            this.hashWorkdirFile(dir, path),
          ])
          if (fromBlobOid && workOid && fromBlobOid !== workOid) return {path, status: 'modified'}
        }

        return undefined
      }),
    )

    return results.filter((r): r is ChangedFile => r !== undefined).sort((a, b) => a.path.localeCompare(b.path))
  }

  private classifyStagedRow(row: StatusRow): ChangedFile | undefined {
    const [filepath, head, workdir, stage] = row
    const status = classifyTuple(head, workdir, stage).stagedDiff
    return status ? {path: String(filepath), status} : undefined
  }

  private classifyUnstagedRow(row: StatusRow): ChangedFile | undefined {
    const [filepath, head, workdir, stage] = row
    const status = classifyTuple(head, workdir, stage).unstagedDiff
    return status ? {path: String(filepath), status} : undefined
  }

  private conflictsFromError(error: Error): GitConflict[] {
    if (!IsomorphicGitService.isConflictError(error)) return []
    const conflictData = error.data
    if (!IsomorphicGitService.isMergeConflictData(conflictData)) return []

    const deletedPaths = new Set([...(conflictData.deleteByTheirs ?? []), ...(conflictData.deleteByUs ?? [])])
    const bothModifiedPaths = new Set(conflictData.bothModified ?? [])

    return conflictData.filepaths
      .map(
        (path): GitConflict => ({
          path,
          type: deletedPaths.has(path)
            ? 'deleted_modified'
            : bothModifiedPaths.has(path)
              ? 'both_modified'
              : 'both_added',
        }),
      )
      .sort((a, b) => a.path.localeCompare(b.path))
  }

  private describeSide(side: GitDiffSide): string {
    if (side === 'STAGE') return 'STAGE'
    if (side === 'WORKDIR') return 'WORKDIR'
    return `commitish(${side.commitish})`
  }

  private getAuthor(): {email: string; name: string} {
    const token = this.authStateStore.getToken()
    if (!token) throw new GitAuthError()
    return {
      email: token.userEmail,
      name: token.userName ?? token.userEmail,
    }
  }

  private getOnAuth() {
    return () => {
      const token = this.authStateStore.getToken()
      if (!token) throw new GitAuthError()
      return {
        password: token.sessionKey,
        username: token.userId,
      }
    }
  }

  private getOnAuthFailure() {
    return () => {
      throw new GitAuthError('Authentication failed. Try /login again.')
    }
  }

  /**
   * Guard against staged changes that would be overwritten by checkout.
   * isomorphic-git's checkout only detects unstaged conflicts — it silently
   * overwrites staged changes, causing data loss. This method fills that gap
   * to match native git behavior. Accepts `undefined` for the source OID when
   * HEAD is unborn (or detached without a resolvable ref); in that case every
   * staged blob is treated as new (sourceBlobOid undefined) so a target blob
   * with content still triggers a conflict.
   */
  private async guardStagedConflicts(
    dir: string,
    sourceOid: string | undefined,
    targetRef: string,
  ): Promise<void> {
    const matrix = await git.statusMatrix({dir, fs})

    const stagedFiles = matrix
      .filter(([, head, workdir, stage]) => classifyTuple(head, workdir, stage).staged)
      .map(([filepath]) => String(filepath))

    if (stagedFiles.length === 0) return

    // If our resolver cannot pin the target OID (no direct ref + no unambiguous
    // remote DWIM match), skip the guard and let `git.checkout` surface the
    // missing-ref error itself. The trade-off: when isomorphic-git's internal
    // resolution finds a path we missed, the guard will not have read against
    // the same tree git.checkout writes — acceptable for single-remote setups.
    const targetOid = await this.resolveCheckoutRef(dir, targetRef)
    if (!targetOid) return

    const conflicting: string[] = []
    /* eslint-disable no-await-in-loop -- sequential file I/O is intentional here */
    for (const filepath of stagedFiles) {
      const sourceBlobOid = sourceOid ? await this.readBlobOid(dir, sourceOid, filepath) : undefined
      const targetBlobOid = await this.readBlobOid(dir, targetOid, filepath)
      if (sourceBlobOid !== targetBlobOid) {
        conflicting.push(filepath)
      }
    }
    /* eslint-enable no-await-in-loop */

    if (conflicting.length > 0) {
      throw new GitError(formatOverwriteMessage('checkout', conflicting))
    }
  }

  private async hashWorkdirFile(dir: string, path: string): Promise<null | string> {
    try {
      const buf = await fs.promises.readFile(join(dir, path))
      const {oid} = await git.hashBlob({object: buf})
      return oid
    } catch {
      return null
    }
  }

  private isCommitishSide(side: GitDiffSide): side is {commitish: string} {
    return side !== 'STAGE' && side !== 'WORKDIR'
  }

  private async listChangedBetweenCommits(dir: string, fromRef: string, toRef: string): Promise<ChangedFile[]> {
    const [fromOid, toOid] = await Promise.all([
      this.resolveRefExpression(dir, fromRef),
      this.resolveRefExpression(dir, toRef),
    ])

    const changes: ChangedFile[] = []
    await git.walk({
      dir,
      fs,
      async map(filepath, [a, b]) {
        if (filepath === '.') return
        const [aType, bType] = await Promise.all([a?.type(), b?.type()])
        if (aType === 'tree' || bType === 'tree') return
        if (!a && b && bType === 'blob') {
          changes.push({path: filepath, status: 'added'})
          return
        }

        if (a && !b && aType === 'blob') {
          changes.push({path: filepath, status: 'deleted'})
          return
        }

        if (a && b && aType === 'blob' && bType === 'blob') {
          const [aOid, bOid] = await Promise.all([a.oid(), b.oid()])
          if (aOid !== bOid) changes.push({path: filepath, status: 'modified'})
        }
      },
      // eslint-disable-next-line new-cap
      trees: [git.TREE({ref: fromOid}), git.TREE({ref: toOid})],
    })

    return changes
  }

  private async listChangedFromMatrix(dir: string, from: GitDiffSide, to: GitDiffSide): Promise<ChangedFile[]> {
    const matrix = await git.statusMatrix({dir, fs})

    if (from === 'STAGE' && to === 'WORKDIR') {
      return matrix.map((row) => this.classifyUnstagedRow(row)).filter((c): c is ChangedFile => c !== undefined)
    }

    if (this.isCommitishSide(from) && to === 'STAGE') {
      return matrix.map((row) => this.classifyStagedRow(row)).filter((c): c is ChangedFile => c !== undefined)
    }

    if (this.isCommitishSide(from) && to === 'WORKDIR') {
      const fromOid = await this.resolveRefExpression(dir, from.commitish)
      const tracked = await git.listFiles({dir, fs, ref: fromOid})
      const trackedSet = new Set(tracked)
      return this.classifyRefVsWorkdir(dir, fromOid, trackedSet, matrix)
    }

    throw new GitError(`unsupported diff side combination: from=${this.describeSide(from)} to=${this.describeSide(to)}`)
  }

  /**
   * Manual merge for unrelated histories (no common ancestor).
   * isomorphic-git throws MergeNotSupportedError because it can't handle
   * base=null at the root tree level. We bypass by combining both trees directly.
   */
  private async mergeUnrelatedHistories(params: {
    author: {email: string; name: string}
    dir: string
    message: string
    oursRef: string
    theirsRef: string
  }): Promise<MergeResult> {
    const {author, dir, message, oursRef, theirsRef} = params
    const mergeHeadPath = join(dir, '.git', 'MERGE_HEAD')
    const mergeMsgPath = join(dir, '.git', 'MERGE_MSG')

    const oursSha = await git.resolveRef({dir, fs, ref: oursRef})
    const theirsSha = await git.resolveRef({dir, fs, ref: theirsRef})

    // List all files from both sides
    const oursFiles = await git.listFiles({dir, fs, ref: oursSha})
    const theirsFiles = await git.listFiles({dir, fs, ref: theirsSha})
    const theirsSet = new Set(theirsFiles)

    // Detect conflicts: same filepath on both sides with different content
    const conflicts: GitConflict[] = []
    /* eslint-disable no-await-in-loop -- sequential file I/O is intentional here */
    for (const filepath of oursFiles) {
      if (!theirsSet.has(filepath)) continue

      const oursBlob = await git.readBlob({dir, filepath, fs, oid: oursSha})
      const theirsBlob = await git.readBlob({dir, filepath, fs, oid: theirsSha})
      if (oursBlob.oid !== theirsBlob.oid) {
        conflicts.push({path: filepath, type: 'both_added'})
      }
    }
    /* eslint-enable no-await-in-loop */

    if (conflicts.length > 0) {
      // Write MERGE_HEAD/MERGE_MSG so --continue works
      await fs.promises.writeFile(mergeHeadPath, `${theirsSha}\n`)
      await fs.promises.writeFile(mergeMsgPath, `${message}\n`)

      // Write conflict markers to working tree for each conflicted file
      /* eslint-disable no-await-in-loop -- sequential per-file conflict marker writes */
      for (const conflict of conflicts) {
        const oursBlob = await git.readBlob({dir, filepath: conflict.path, fs, oid: oursSha})
        const theirsBlob = await git.readBlob({dir, filepath: conflict.path, fs, oid: theirsSha})
        const oursContent = Buffer.from(oursBlob.blob).toString('utf8')
        const theirsContent = Buffer.from(theirsBlob.blob).toString('utf8')

        const conflictContent =
          `<<<<<<< HEAD\n` +
          oursContent +
          (oursContent.endsWith('\n') ? '' : '\n') +
          `=======\n` +
          theirsContent +
          (theirsContent.endsWith('\n') ? '' : '\n') +
          `>>>>>>> ${theirsRef}\n`

        await fs.promises.writeFile(join(dir, conflict.path), conflictContent)
      }
      /* eslint-enable no-await-in-loop */

      return {conflicts, success: false}
    }

    // No conflicts — write all remote files to working tree and stage them
    const oursSet = new Set(oursFiles)
    /* eslint-disable no-await-in-loop -- sequential file writes + git add */
    for (const filepath of theirsFiles) {
      if (oursSet.has(filepath)) continue // same content, already present
      const blob = await git.readBlob({dir, filepath, fs, oid: theirsSha})
      const filePath = join(dir, filepath)
      const fileDir = join(filePath, '..')
      await fs.promises.mkdir(fileDir, {recursive: true})
      await fs.promises.writeFile(filePath, Buffer.from(blob.blob))
      await git.add({dir, filepath, fs})
    }
    /* eslint-enable no-await-in-loop */

    // Create merge commit with both parents
    await git.commit({
      author,
      committer: author,
      dir,
      fs,
      message,
      parent: [oursSha, theirsSha],
    })

    return {success: true}
  }

  private parseMatrix(matrix: StatusRow[]): GitStatusFile[] {
    const files: GitStatusFile[] = []
    for (const [filepath, head, workdir, stage] of matrix) {
      const path = String(filepath)
      const classification = classifyTuple(head, workdir, stage)
      for (const entry of classification.files) {
        files.push({path, staged: entry.staged, status: entry.status})
      }
    }

    return files
  }

  private async readBlobOid(dir: string, commitOid: string, filepath: string): Promise<null | string> {
    try {
      const result = await git.readBlob({dir, filepath, fs, oid: commitOid})
      return result.oid
    } catch {
      return null
    }
  }

  /**
   * Reads the raw blob bytes + full oid at the given ref in a single pass.
   * Returns `undefined` when the blob is absent (path missing, ref unresolved, etc.).
   * Used by {@link getTextBlob}; callers downstream decide binary vs text.
   */
  private async readRawBlob(
    dir: string,
    path: string,
    ref: GitBlobRef,
  ): Promise<undefined | {bytes: Uint8Array; oid: string}> {
    if (ref === 'STAGE') {
      let found: undefined | {bytes: Uint8Array; oid: string}
      await git
        .walk({
          dir,
          fs,
          async map(filepath, [entry]) {
            if (filepath !== path || !entry) return
            if ((await entry.type()) !== 'blob') return
            const oid = await entry.oid()
            const {blob} = await git.readBlob({dir, fs, oid})
            found = {bytes: blob, oid}
          },
          // eslint-disable-next-line new-cap
          trees: [git.STAGE()],
        })
        .catch(() => {
          // leave found undefined
        })
      return found
    }

    const commitOid = await this.resolveRefExpression(dir, ref.commitish).catch(() => null)
    if (!commitOid) return undefined
    try {
      const {blob, oid} = await git.readBlob({dir, filepath: path, fs, oid: commitOid})
      return {bytes: blob, oid}
    } catch {
      return undefined
    }
  }

  private requireDirectory(params: BaseGitParams): string {
    // Guard against empty string — undefined/null are caught by TypeScript at compile time
    if (!params.directory) throw new GitError('directory is required for git operations')
    return params.directory
  }

  private requireToken(): NonNullable<ReturnType<IAuthStateStore['getToken']>> {
    const token = this.authStateStore.getToken()
    if (!token) throw new GitAuthError()
    return token
  }

  /**
   * Unstage files by resetting their index entries to match HEAD.
   * When filePaths is omitted, unstages all staged files.
   */
  private async resetUnstage(dir: string, filePaths?: string[]): Promise<ResetResult> {
    const headSha = await git.resolveRef({dir, fs, ref: 'HEAD'}).catch(() => null)
    const matrix = await git.statusMatrix({dir, fs})

    // Identify staged rows — any file where the index differs from HEAD
    const stagedRows = matrix.filter(([, head, workdir, stage]) => classifyTuple(head, workdir, stage).staged)

    const toUnstage =
      filePaths && filePaths.length > 0
        ? stagedRows
            .filter(([filepath]) => {
              const path = String(filepath)
              return filePaths.some((fp) => {
                if (path === fp) return true
                const prefix = fp.endsWith('/') ? fp : `${fp}/`
                return path.startsWith(prefix)
              })
            })
            .map(([filepath]) => String(filepath))
        : stagedRows.map(([filepath]) => String(filepath))

    // Validate that every requested path is known to the repository
    if (filePaths && filePaths.length > 0) {
      const allKnownPaths = new Set(matrix.map(([filepath]) => String(filepath)))
      for (const fp of filePaths) {
        const isKnown = fp.endsWith('/') ? [...allKnownPaths].some((p) => p.startsWith(fp)) : allKnownPaths.has(fp)
        if (!isKnown) {
          throw new GitError(`pathspec '${fp}' did not match any file(s) known to git`)
        }
      }
    }

    await Promise.all(
      headSha
        ? toUnstage.map((filepath) => git.resetIndex({dir, filepath, fs, ref: 'HEAD'}))
        : toUnstage.map((filepath) => git.remove({dir, filepath, fs})),
    )

    return {filesChanged: toUnstage.length, headSha: headSha ?? ''}
  }

  /**
   * Resolve a checkout target's OID, mirroring `git.checkout`'s DWIM for
   * remote-only branches. Returns undefined if the ref cannot be resolved
   * anywhere, OR if multiple remotes match the same short name (matches native
   * git's refuse-on-ambiguity, lets the caller defer to `git.checkout`'s own
   * error). Caller decides whether to surface or skip.
   */
  private async resolveCheckoutRef(dir: string, ref: string): Promise<string | undefined> {
    const direct = await this.tryResolveRef(dir, ref)
    if (direct) return direct

    const remotes = await git.listRemotes({dir, fs}).catch(() => [])
    const matches: string[] = []
    for (const {remote} of remotes) {
      // eslint-disable-next-line no-await-in-loop
      const remoteOid = await this.tryResolveRef(dir, `refs/remotes/${remote}/${ref}`)
      if (remoteOid) matches.push(remoteOid)
    }

    if (matches.length === 1) return matches[0]
    return undefined
  }

  /**
   * Resolves a ref expression that may include ~N ancestry syntax (e.g. HEAD~2).
   * Falls back to git.resolveRef for plain refs.
   */
  private async resolveRefExpression(dir: string, ref: string): Promise<string> {
    const tildeMatch = /^(.+)~(\d+)$/.exec(ref)
    if (!tildeMatch) {
      return this.resolveSingleRef(dir, ref)
    }

    const baseRef = tildeMatch[1]
    const count = Number.parseInt(tildeMatch[2], 10)
    if (count === 0) {
      return this.resolveSingleRef(dir, baseRef)
    }

    let oid = await this.resolveSingleRef(dir, baseRef)
    for (let i = 0; i < count; i++) {
      // eslint-disable-next-line no-await-in-loop
      const commit = await git.readCommit({dir, fs, oid})
      if (commit.commit.parent.length === 0) {
        throw new GitError(`Cannot resolve '${ref}': not enough ancestors.`)
      }

      oid = commit.commit.parent[0]
    }

    return oid
  }

  /**
   * Resolve a single ref (branch name, tag, full SHA, or short SHA).
   * Falls back to `git.expandOid` for short SHAs since `git.resolveRef`
   * only accepts full OIDs and symbolic refs.
   */
  private async resolveSingleRef(dir: string, ref: string): Promise<string> {
    try {
      return await git.resolveRef({dir, fs, ref})
    } catch (error) {
      // Short SHA: 4-39 hex chars. Try expandOid which disambiguates against the object DB.
      if (/^[\da-f]{4,39}$/i.test(ref)) {
        return git.expandOid({dir, fs, oid: ref})
      }

      throw error
    }
  }

  /**
   * Fixes conflict markers written by isomorphic-git to match native git:
   * 1. Replaces `<<<<<<< <branchName>` with `<<<<<<< HEAD`
   * 2. Ensures `\n` before `=======` and `>>>>>>>` (isomorphic-git omits it when content has no trailing newline)
   */
  private async rewriteConflictMarkers(dir: string, branchName: string, conflicts: GitConflict[]): Promise<void> {
    const marker = `<<<<<<< ${branchName}`
    await Promise.all(
      conflicts
        .filter((c) => c.type !== 'deleted_modified')
        .map(async (c) => {
          const filePath = join(dir, c.path)
          let content = await fs.promises.readFile(filePath, 'utf8').catch(() => null)
          if (!content) return

          content = content.replaceAll(marker, '<<<<<<< HEAD')
          // isomorphic-git omits \n before ======= and >>>>>>> when file content has no trailing newline
          content = content.replaceAll(/([^\n])=======/g, '$1\n=======')
          content = content.replaceAll(/([^\n])>>>>>>>/g, '$1\n>>>>>>>')
          await fs.promises.writeFile(filePath, content)
        }),
    )
  }

  /** Resolve a ref to its OID, returning undefined instead of throwing on missing/unborn refs. */
  private async tryResolveRef(dir: string, ref: string): Promise<string | undefined> {
    try {
      return await git.resolveRef({dir, fs, ref})
    } catch {
      return undefined
    }
  }
}
