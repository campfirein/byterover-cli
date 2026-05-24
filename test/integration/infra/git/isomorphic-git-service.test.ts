import {expect} from 'chai'
import * as git from 'isomorphic-git'
import fs, {existsSync} from 'node:fs'
import {mkdir, readFile, rm, unlink, utimes, writeFile} from 'node:fs/promises'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import {stub} from 'sinon'

import type {IAuthStateStore} from '../../../../src/server/core/interfaces/state/i-auth-state-store.js'

import {AuthToken} from '../../../../src/server/core/domain/entities/auth-token.js'
import {GitAuthError, GitError} from '../../../../src/server/core/domain/errors/git-error.js'
import {IsomorphicGitService} from '../../../../src/server/infra/git/isomorphic-git-service.js'
import {classifyTuple} from '../../../../src/server/infra/git/status-row-classifier.js'

const COGIT_BASE = 'https://fake-cgit.example.com'

function makeTestDir(): string {
  return join(tmpdir(), `brv-git-test-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`)
}

function makeAuth(options?: {noAuth: true}): IAuthStateStore {
  const defaultToken = new AuthToken({
    accessToken: 'test-access-token',
    expiresAt: new Date(Date.now() + 3_600_000),
    refreshToken: 'test-refresh-token',
    sessionKey: 'test-session-key',
    userEmail: 'test@example.com',
    userId: 'test-user-uuid',
  })
  return {
    getToken: stub<[], AuthToken | undefined>().returns(options?.noAuth ? undefined : defaultToken),
    loadToken: stub<[], Promise<AuthToken | undefined>>().resolves(),
    onAuthChanged: stub(),
    onAuthExpired: stub(),
    startPolling: stub(),
    stopPolling: stub(),
  }
}

async function initWithCommit(
  svc: IsomorphicGitService,
  dir: string,
  filename: string,
  content: string,
  message: string,
): Promise<string> {
  await writeFile(join(dir, filename), content)
  await svc.add({directory: dir, filePaths: [filename]})
  const commit = await svc.commit({directory: dir, message})
  return commit.sha
}

describe('IsomorphicGitService', () => {
  let testDir: string
  let service: IsomorphicGitService
  /** Auxiliary tmp dirs created per-test; cleaned in afterEach even on assertion failure. */
  let extraTmpDirs: string[]

  beforeEach(async () => {
    testDir = makeTestDir()
    await mkdir(testDir, {recursive: true})
    service = new IsomorphicGitService(makeAuth())
    extraTmpDirs = []
  })

  afterEach(async () => {
    if (existsSync(testDir)) {
      await rm(testDir, {force: true, recursive: true})
    }

    await Promise.all(
      extraTmpDirs.filter((d) => existsSync(d)).map((d) => rm(d, {force: true, recursive: true})),
    )
  })

  // ---- init() ----

  describe('init()', () => {
    it('creates a .git directory', async () => {
      await service.init({directory: testDir})
      expect(existsSync(join(testDir, '.git'))).to.be.true
    })

    it('defaults to main branch', async () => {
      await service.init({directory: testDir})
      const branch = await service.getCurrentBranch({directory: testDir})
      expect(branch).to.equal('main')
    })

    it('respects defaultBranch param', async () => {
      await service.init({defaultBranch: 'trunk', directory: testDir})
      const branch = await service.getCurrentBranch({directory: testDir})
      expect(branch).to.equal('trunk')
    })
  })

  // ---- isInitialized() ----

  describe('isInitialized()', () => {
    it('returns false when no .git directory exists', async () => {
      expect(await service.isInitialized({directory: testDir})).to.be.false
    })

    it('returns true after init()', async () => {
      await service.init({directory: testDir})
      expect(await service.isInitialized({directory: testDir})).to.be.true
    })
  })

  // ---- isEmptyRepository() ----

  describe('isEmptyRepository()', () => {
    it('returns true for freshly initialized repo', async () => {
      await service.init({directory: testDir})
      expect(await service.isEmptyRepository({directory: testDir})).to.be.true
    })

    it('returns false when repo has commits', async () => {
      await service.init({directory: testDir})
      await initWithCommit(service, testDir, 'hello.md', 'content', 'first commit')
      expect(await service.isEmptyRepository({directory: testDir})).to.be.false
    })

    it('returns false when repo has remotes', async () => {
      await service.init({directory: testDir})
      await service.addRemote({directory: testDir, remote: 'origin', url: 'https://example.com/repo.git'})
      expect(await service.isEmptyRepository({directory: testDir})).to.be.false
    })

    it('returns false when repo has untracked files', async () => {
      await service.init({directory: testDir})
      await writeFile(join(testDir, 'notes.md'), 'some content')
      expect(await service.isEmptyRepository({directory: testDir})).to.be.false
    })
  })

  // ---- add() + commit() ----

  describe('add() and commit()', () => {
    beforeEach(async () => {
      await service.init({directory: testDir})
    })

    it('creates a commit and returns GitCommit shape', async () => {
      await writeFile(join(testDir, 'hello.md'), 'world')
      await service.add({directory: testDir, filePaths: ['hello.md']})
      const commit = await service.commit({directory: testDir, message: 'initial commit'})

      expect(commit.sha).to.be.a('string').with.length(40)
      expect(commit.message).to.equal('initial commit')
      expect(commit.author.email).to.equal('test@example.com')
      expect(commit.timestamp).to.be.instanceOf(Date)
    })

    it('uses explicit author when provided', async () => {
      await writeFile(join(testDir, 'a.md'), 'a')
      await service.add({directory: testDir, filePaths: ['a.md']})
      const commit = await service.commit({
        author: {email: 'custom@example.com', name: 'Custom'},
        directory: testDir,
        message: 'custom author',
      })

      expect(commit.author.email).to.equal('custom@example.com')
      expect(commit.author.name).to.equal('Custom')
    })

    it('stages multiple files', async () => {
      await writeFile(join(testDir, 'a.md'), 'a')
      await writeFile(join(testDir, 'b.md'), 'b')
      await service.add({directory: testDir, filePaths: ['a.md', 'b.md']})
      const commit = await service.commit({directory: testDir, message: 'two files'})
      expect(commit.sha).to.be.a('string')
    })

    it('stages a deleted file (rm + add) and commits the deletion', async () => {
      // Setup: commit file-a.md
      await writeFile(join(testDir, 'file-a.md'), 'content')
      await service.add({directory: testDir, filePaths: ['file-a.md']})
      await service.commit({directory: testDir, message: 'initial'})

      // Delete from disk (not git rm) → [1,0,1] = unstaged deletion
      await unlink(join(testDir, 'file-a.md'))

      // add should stage the deletion without throwing
      await service.add({directory: testDir, filePaths: ['file-a.md']})

      const status = await service.status({directory: testDir})
      const fileEntry = status.files.find((f) => f.path === 'file-a.md')
      expect(fileEntry).to.deep.equal({path: 'file-a.md', staged: true, status: 'deleted'})

      // Commit the deletion
      const commit = await service.commit({directory: testDir, message: 'delete file-a.md'})
      expect(commit.message).to.equal('delete file-a.md')

      // After commit: status should be clean
      const statusAfter = await service.status({directory: testDir})
      expect(statusAfter.isClean).to.be.true
    })

    it('re-adding an already staged deletion is a no-op (does not throw)', async () => {
      // Setup: commit file-a.md
      await writeFile(join(testDir, 'file-a.md'), 'content')
      await service.add({directory: testDir, filePaths: ['file-a.md']})
      await service.commit({directory: testDir, message: 'initial'})

      // Delete and stage deletion → [1,0,0]
      await unlink(join(testDir, 'file-a.md'))
      await service.add({directory: testDir, filePaths: ['file-a.md']})

      // Re-add the already staged deletion — should not throw
      await service.add({directory: testDir, filePaths: ['file-a.md']})

      // Status should still show staged deletion
      const status = await service.status({directory: testDir})
      const fileEntry = status.files.find((f) => f.path === 'file-a.md')
      expect(fileEntry).to.deep.equal({path: 'file-a.md', staged: true, status: 'deleted'})
    })
  })

  // ---- status() ----

  describe('status()', () => {
    beforeEach(async () => {
      await service.init({directory: testDir})
    })

    it('returns isClean: true on empty repo', async () => {
      const result = await service.status({directory: testDir})
      expect(result.isClean).to.be.true
      expect(result.files).to.be.empty
    })

    it('reports new untracked file as untracked with staged: false', async () => {
      await writeFile(join(testDir, 'new.md'), 'content')
      const result = await service.status({directory: testDir})

      expect(result.isClean).to.be.false
      expect(result.files).to.have.length(1)
      expect(result.files[0]).to.deep.equal({path: 'new.md', staged: false, status: 'untracked'})
    })

    it('reports staged new file as added with staged: true', async () => {
      await writeFile(join(testDir, 'new.md'), 'content')
      await service.add({directory: testDir, filePaths: ['new.md']})
      const result = await service.status({directory: testDir})

      expect(result.isClean).to.be.false
      expect(result.files).to.have.length(1)
      expect(result.files[0]).to.deep.equal({path: 'new.md', staged: true, status: 'added'})
    })

    it('reports unstaged modification as modified with staged: false', async () => {
      await writeFile(join(testDir, 'tracked.md'), 'original')
      await service.add({directory: testDir, filePaths: ['tracked.md']})
      await service.commit({directory: testDir, message: 'initial'})

      await writeFile(join(testDir, 'tracked.md'), 'changed')
      const result = await service.status({directory: testDir})

      expect(result.isClean).to.be.false
      const file = result.files.find((f) => f.path === 'tracked.md')
      expect(file).to.deep.equal({path: 'tracked.md', staged: false, status: 'modified'})
    })

    it('reports staged modification as modified with staged: true', async () => {
      await writeFile(join(testDir, 'tracked.md'), 'original')
      await service.add({directory: testDir, filePaths: ['tracked.md']})
      await service.commit({directory: testDir, message: 'initial'})

      await writeFile(join(testDir, 'tracked.md'), 'changed')
      await service.add({directory: testDir, filePaths: ['tracked.md']})
      const result = await service.status({directory: testDir})

      expect(result.isClean).to.be.false
      const file = result.files.find((f) => f.path === 'tracked.md')
      expect(file).to.deep.equal({path: 'tracked.md', staged: true, status: 'modified'})
    })

    it('reports modified committed file (not staged) as modified with staged: false', async () => {
      await writeFile(join(testDir, 'tracked.md'), 'original')
      await service.add({directory: testDir, filePaths: ['tracked.md']})
      await service.commit({directory: testDir, message: 'initial'})

      await writeFile(join(testDir, 'tracked.md'), 'changed')
      const result = await service.status({directory: testDir})

      expect(result.isClean).to.be.false
      const file = result.files.find((f) => f.path === 'tracked.md')
      expect(file?.status).to.equal('modified')
      expect(file?.staged).to.be.false
    })

    it('returns isClean: true after commit with no further changes', async () => {
      await writeFile(join(testDir, 'tracked.md'), 'content')
      await service.add({directory: testDir, filePaths: ['tracked.md']})
      await service.commit({directory: testDir, message: 'initial'})

      const result = await service.status({directory: testDir})
      expect(result.isClean).to.be.true
      expect(result.files).to.be.empty
    })

    it('[1,0,1] reports unstaged deletion (rm without git rm) as deleted with staged: false', async () => {
      await writeFile(join(testDir, 'tracked.md'), 'content')
      await service.add({directory: testDir, filePaths: ['tracked.md']})
      await service.commit({directory: testDir, message: 'initial'})

      await unlink(join(testDir, 'tracked.md')) // delete from disk only, not from index
      const result = await service.status({directory: testDir})

      expect(result.isClean).to.be.false
      const file = result.files.find((f) => f.path === 'tracked.md')
      expect(file).to.deep.equal({path: 'tracked.md', staged: false, status: 'deleted'})
    })

    it('[1,2,3] reports partially staged modification as both staged and unstaged modified', async () => {
      await writeFile(join(testDir, 'tracked.md'), 'original')
      await service.add({directory: testDir, filePaths: ['tracked.md']})
      await service.commit({directory: testDir, message: 'initial'})

      await writeFile(join(testDir, 'tracked.md'), 'change A')
      await service.add({directory: testDir, filePaths: ['tracked.md']}) // stage change A
      await writeFile(join(testDir, 'tracked.md'), 'change A + change B') // unstaged change B
      const result = await service.status({directory: testDir})

      expect(result.isClean).to.be.false
      const entries = result.files.filter((f) => f.path === 'tracked.md')
      expect(entries).to.have.length(2)
      expect(entries).to.deep.include({path: 'tracked.md', staged: true, status: 'modified'})
      expect(entries).to.deep.include({path: 'tracked.md', staged: false, status: 'modified'})
    })

    it('[1,0,0] reports staged deletion (git rm) as deleted with staged: true', async () => {
      await writeFile(join(testDir, 'tracked.md'), 'content')
      await service.add({directory: testDir, filePaths: ['tracked.md']})
      await service.commit({directory: testDir, message: 'initial'})

      // git rm: remove from both index and workdir → staged deletion [1,0,0]
      await git.remove({dir: testDir, filepath: 'tracked.md', fs})
      await unlink(join(testDir, 'tracked.md'))
      const result = await service.status({directory: testDir})

      expect(result.isClean).to.be.false
      const file = result.files.find((f) => f.path === 'tracked.md')
      expect(file).to.deep.equal({path: 'tracked.md', staged: true, status: 'deleted'})
    })

    it('[1,1,0] git rm --cached reports staged deletion and file as untracked', async () => {
      await writeFile(join(testDir, 'tracked.md'), 'content')
      await service.add({directory: testDir, filePaths: ['tracked.md']})
      await service.commit({directory: testDir, message: 'initial'})

      // git rm --cached: remove from index but keep file on disk
      await git.remove({dir: testDir, filepath: 'tracked.md', fs})
      const result = await service.status({directory: testDir})

      expect(result.isClean).to.be.false
      const entries = result.files.filter((f) => f.path === 'tracked.md')
      expect(entries).to.have.length(2)
      expect(entries).to.deep.include({path: 'tracked.md', staged: true, status: 'deleted'})
      expect(entries).to.deep.include({path: 'tracked.md', staged: false, status: 'untracked'})
    })

    it('[1,2,0] git rm --cached then edit reports staged deletion + untracked', async () => {
      await writeFile(join(testDir, 'tracked.md'), 'original')
      await service.add({directory: testDir, filePaths: ['tracked.md']})
      await service.commit({directory: testDir, message: 'initial'})

      await git.remove({dir: testDir, filepath: 'tracked.md', fs})
      await writeFile(join(testDir, 'tracked.md'), 'edited after rm --cached')

      const matrix = await git.statusMatrix({dir: testDir, fs})
      expect(matrix).to.deep.equal([['tracked.md', 1, 2, 0]])

      const result = await service.status({directory: testDir})
      expect(result.isClean).to.be.false
      const entries = result.files.filter((f) => f.path === 'tracked.md')
      expect(entries).to.have.length(2)
      expect(entries).to.deep.include({path: 'tracked.md', staged: true, status: 'deleted'})
      expect(entries).to.deep.include({path: 'tracked.md', staged: false, status: 'untracked'})
    })

    it('[0,0,3] staged new file then deleted from disk reports add + delete', async () => {
      // Need an existing commit so git.statusMatrix has a HEAD to compare against.
      await writeFile(join(testDir, 'seed.md'), 'seed')
      await service.add({directory: testDir, filePaths: ['seed.md']})
      await service.commit({directory: testDir, message: 'seed'})

      await writeFile(join(testDir, 'fresh.md'), 'staged content')
      await service.add({directory: testDir, filePaths: ['fresh.md']})
      await unlink(join(testDir, 'fresh.md'))

      const matrix = await git.statusMatrix({dir: testDir, fs})
      const freshRow = matrix.find((row) => row[0] === 'fresh.md')
      expect(freshRow).to.deep.equal(['fresh.md', 0, 0, 3])

      const result = await service.status({directory: testDir})
      const entries = result.files.filter((f) => f.path === 'fresh.md')
      expect(entries).to.deep.include({path: 'fresh.md', staged: true, status: 'added'})
      expect(entries).to.deep.include({path: 'fresh.md', staged: false, status: 'deleted'})
    })

    it('[0,2,3] reports partially staged new file as staged added + unstaged modified', async () => {
      // new file: add to index (staged added), then modify on disk without re-staging
      await writeFile(join(testDir, 'new.md'), 'original')
      await service.add({directory: testDir, filePaths: ['new.md']})
      await writeFile(join(testDir, 'new.md'), 'changed after staging') // unstaged change
      const result = await service.status({directory: testDir})

      expect(result.isClean).to.be.false
      const entries = result.files.filter((f) => f.path === 'new.md')
      expect(entries).to.have.length(2)
      expect(entries).to.deep.include({path: 'new.md', staged: true, status: 'added'})
      expect(entries).to.deep.include({path: 'new.md', staged: false, status: 'modified'})
    })

    it('[1,1,3] reports both staged + unstaged modifications when workdir is restored to HEAD after add', async () => {
      // Reachable in the wild via editor undo+autosave, AI agent revert, or sync-tool rollback
      // after `brv vc add`: workdir matches HEAD, but the index still holds the staged blob.
      // Native git reports BOTH a staged modification (HEAD->INDEX) AND an unstaged
      // modification (INDEX->WORKDIR), since INDEX differs from both.
      const tracked = join(testDir, 'tracked.md')
      await writeFile(tracked, 'v1\n')
      await service.add({directory: testDir, filePaths: ['tracked.md']})
      await service.commit({directory: testDir, message: 'initial'})

      await writeFile(tracked, 'v2\n')
      await service.add({directory: testDir, filePaths: ['tracked.md']})

      // Filesystem-only restore to HEAD content; index untouched.
      // Force a distinct mtime so isomorphic-git re-reads the workdir blob instead of
      // trusting the index's stat cache (which would yield [1,2,2] otherwise).
      await writeFile(tracked, 'v1\n')
      const future = new Date(Date.now() + 2000)
      await utimes(tracked, future, future)

      const matrix = await git.statusMatrix({dir: testDir, fs})
      expect(matrix).to.deep.equal([['tracked.md', 1, 1, 3]])

      const result = await service.status({directory: testDir})

      expect(result.isClean).to.be.false
      const entries = result.files.filter((f) => f.path === 'tracked.md')
      expect(entries).to.have.length(2)
      expect(entries).to.deep.include({path: 'tracked.md', staged: true, status: 'modified'})
      expect(entries).to.deep.include({path: 'tracked.md', staged: false, status: 'modified'})
    })

    it('status.isClean implies pull dirty-filter sees no rows (cross-property invariant)', async () => {
      // Engineer the [1,1,3] tuple. status() and pull() must agree on cleanliness:
      // both project the matrix through classifyTuple, so the dirty set computed
      // here must mirror what pull() actually inspects internally.
      const path = join(testDir, 'a.md')
      await writeFile(path, 'v1\n')
      await service.add({directory: testDir, filePaths: ['a.md']})
      await service.commit({directory: testDir, message: 'initial'})

      await writeFile(path, 'v2\n')
      await service.add({directory: testDir, filePaths: ['a.md']})
      await writeFile(path, 'v1\n')
      const future = new Date(Date.now() + 2000)
      await utimes(path, future, future)

      const status = await service.status({directory: testDir})
      const matrix = await git.statusMatrix({dir: testDir, fs})
      const pullDirty = matrix
        .filter(([, head, workdir, stage]) => classifyTuple(head, workdir, stage).dirty)
        .map((row) => String(row[0]))

      if (status.isClean) {
        expect(pullDirty, 'pull would consider files dirty while status reports clean').to.deep.equal([])
      } else {
        expect(status.files.map((f) => f.path)).to.include.members(pullDirty)
      }
    })

    it('reports correct statuses for multiple files with mixed states', async () => {
      // Setup: one committed file (becomes base for HEAD entries)
      await writeFile(join(testDir, 'committed.md'), 'content')
      await service.add({directory: testDir, filePaths: ['committed.md']})
      await service.commit({directory: testDir, message: 'initial'})

      // staged deletion [1,0,0]
      await git.remove({dir: testDir, filepath: 'committed.md', fs})
      await unlink(join(testDir, 'committed.md'))

      // staged new file [0,2,2]
      await writeFile(join(testDir, 'added.md'), 'new')
      await service.add({directory: testDir, filePaths: ['added.md']})

      // untracked [0,2,0]
      await writeFile(join(testDir, 'untracked.md'), 'raw')

      const result = await service.status({directory: testDir})

      expect(result.isClean).to.be.false
      expect(result.files).to.deep.include({path: 'committed.md', staged: true, status: 'deleted'})
      expect(result.files).to.deep.include({path: 'added.md', staged: true, status: 'added'})
      expect(result.files).to.deep.include({path: 'untracked.md', staged: false, status: 'untracked'})
    })
  })

  // ---- log() ----

  describe('log()', () => {
    beforeEach(async () => {
      await service.init({directory: testDir})
    })

    it('returns empty array when no commits exist', async () => {
      const commits = await service.log({directory: testDir})
      expect(commits).to.be.an('array').that.is.empty
    })

    it('returns commits with correct shape', async () => {
      await writeFile(join(testDir, 'f.md'), 'x')
      await service.add({directory: testDir, filePaths: ['f.md']})
      await service.commit({directory: testDir, message: 'first'})

      const commits = await service.log({directory: testDir})
      expect(commits).to.have.length(1)
      expect(commits[0].sha).to.be.a('string').with.length(40)
      expect(commits[0].message).to.equal('first')
      expect(commits[0].author.email).to.equal('test@example.com')
      expect(commits[0].timestamp).to.be.instanceOf(Date)
    })

    it('respects depth limit', async () => {
      await writeFile(join(testDir, 'f.md'), 'x')
      await service.add({directory: testDir, filePaths: ['f.md']})
      await service.commit({directory: testDir, message: 'first'})

      await writeFile(join(testDir, 'f.md'), 'y')
      await service.add({directory: testDir, filePaths: ['f.md']})
      await service.commit({directory: testDir, message: 'second'})

      const commits = await service.log({depth: 1, directory: testDir})
      expect(commits).to.have.length(1)
    })

    it('filters commits by filepath', async () => {
      await writeFile(join(testDir, 'a.md'), 'a')
      await service.add({directory: testDir, filePaths: ['a.md']})
      await service.commit({directory: testDir, message: 'add a'})

      await writeFile(join(testDir, 'b.md'), 'b')
      await service.add({directory: testDir, filePaths: ['b.md']})
      await service.commit({directory: testDir, message: 'add b'})

      await writeFile(join(testDir, 'a.md'), 'a updated')
      await service.add({directory: testDir, filePaths: ['a.md']})
      await service.commit({directory: testDir, message: 'update a'})

      const allCommits = await service.log({directory: testDir})
      expect(allCommits).to.have.length(3)

      const aCommits = await service.log({directory: testDir, filepath: 'a.md'})
      expect(aCommits).to.have.length(2)
      expect(aCommits[0].message).to.equal('update a')
      expect(aCommits[1].message).to.equal('add a')

      const bCommits = await service.log({directory: testDir, filepath: 'b.md'})
      expect(bCommits).to.have.length(1)
      expect(bCommits[0].message).to.equal('add b')
    })
  })

  // ---- createBranch() + listBranches() + getCurrentBranch() ----

  describe('branch management', () => {
    beforeEach(async () => {
      await service.init({directory: testDir})
      // Need at least one commit before branch refs exist
      await writeFile(join(testDir, 'seed.md'), 'seed')
      await service.add({directory: testDir, filePaths: ['seed.md']})
      await service.commit({directory: testDir, message: 'seed'})
    })

    it('listBranches returns main after first commit', async () => {
      const branches = await service.listBranches({directory: testDir})
      expect(branches).to.have.length(1)
      expect(branches[0].name).to.equal('main')
      expect(branches[0].isCurrent).to.be.true
    })

    it('createBranch adds a new branch', async () => {
      await service.createBranch({branch: 'feature', directory: testDir})
      const branches = await service.listBranches({directory: testDir})
      const names = branches.map((b) => b.name)
      expect(names).to.include('feature')
      expect(names).to.include('main')
    })

    it('isCurrent is false for non-active branch', async () => {
      await service.createBranch({branch: 'feature', directory: testDir})
      const branches = await service.listBranches({directory: testDir})
      const feature = branches.find((b) => b.name === 'feature')
      expect(feature?.isCurrent).to.be.false
    })

    it('getCurrentBranch returns main initially', async () => {
      const branch = await service.getCurrentBranch({directory: testDir})
      expect(branch).to.equal('main')
    })

    it('isRemote is false for local branches', async () => {
      const branches = await service.listBranches({directory: testDir})
      expect(branches[0].isRemote).to.be.false
    })

    it('deleteBranch removes a branch', async () => {
      await service.createBranch({branch: 'to-delete', directory: testDir})
      let branches = await service.listBranches({directory: testDir})
      expect(branches.map((b) => b.name)).to.include('to-delete')

      await service.deleteBranch({branch: 'to-delete', directory: testDir})
      branches = await service.listBranches({directory: testDir})
      expect(branches.map((b) => b.name)).to.not.include('to-delete')
    })

    it('deleteBranch throws for non-existent branch', async () => {
      try {
        await service.deleteBranch({branch: 'nonexistent', directory: testDir})
        expect.fail('Expected error')
      } catch (error) {
        expect(error).to.be.an('error')
      }
    })

    it('createBranch with startPoint creates branch pointing at that ref', async () => {
      // Capture HEAD SHA at "seed", then add a second commit on main.
      const [seedCommit] = await service.log({depth: 1, directory: testDir})
      await writeFile(join(testDir, 'later.md'), 'later')
      await service.add({directory: testDir, filePaths: ['later.md']})
      await service.commit({directory: testDir, message: 'later'})

      // Branch 'from-seed' should point at seed, not at HEAD.
      await service.createBranch({branch: 'from-seed', directory: testDir, startPoint: seedCommit.sha})

      const branchLog = await service.log({depth: 1, directory: testDir, ref: 'from-seed'})
      expect(branchLog[0].sha).to.equal(seedCommit.sha)
    })

    it('createBranch and deleteBranch work with slash in name (feature/test)', async () => {
      await service.createBranch({branch: 'feature/test', directory: testDir})
      let branches = await service.listBranches({directory: testDir})
      expect(branches.map((b) => b.name)).to.include('feature/test')

      await service.deleteBranch({branch: 'feature/test', directory: testDir})
      branches = await service.listBranches({directory: testDir})
      expect(branches.map((b) => b.name)).to.not.include('feature/test')
    })

    it('listBranches returns empty array before any commits', async () => {
      const emptyDir = makeTestDir()
      await mkdir(emptyDir, {recursive: true})
      await service.init({directory: emptyDir})
      const branches = await service.listBranches({directory: emptyDir})
      expect(branches).to.be.an('array').that.is.empty
      await rm(emptyDir, {force: true, recursive: true})
    })

    it('listBranches with remote returns local-only when no remote configured', async () => {
      const branches = await service.listBranches({directory: testDir, remote: 'origin'})
      // Should not throw, just return local branches
      expect(branches).to.have.length(1)
      expect(branches[0].name).to.equal('main')
      expect(branches[0].isRemote).to.be.false
    })
  })

  // ---- checkout() ----

  describe('checkout()', () => {
    beforeEach(async () => {
      await service.init({directory: testDir})
      await writeFile(join(testDir, 'seed.md'), 'seed')
      await service.add({directory: testDir, filePaths: ['seed.md']})
      await service.commit({directory: testDir, message: 'seed'})
      await service.createBranch({branch: 'feature', directory: testDir})
    })

    it('switches to a different branch', async () => {
      await service.checkout({directory: testDir, ref: 'feature'})
      const branch = await service.getCurrentBranch({directory: testDir})
      expect(branch).to.equal('feature')
    })

    it('blocks checkout when staged changes conflict with target branch', async () => {
      // Setup: feature branch has a.txt="v2", main has a.txt="v1"
      await service.checkout({directory: testDir, ref: 'feature'})
      await writeFile(join(testDir, 'a.txt'), 'v2')
      await service.add({directory: testDir, filePaths: ['a.txt']})
      await service.commit({directory: testDir, message: 'feature: add a.txt'})

      await service.checkout({directory: testDir, ref: 'main'})
      // Stage a change to a.txt on main (not committed)
      await writeFile(join(testDir, 'a.txt'), 'staged-change')
      await service.add({directory: testDir, filePaths: ['a.txt']})

      // Checkout feature should block — staged a.txt would be overwritten
      try {
        await service.checkout({directory: testDir, ref: 'feature'})
        expect.fail('Expected GitError for staged conflict')
      } catch (error) {
        expect(error).to.be.instanceOf(GitError)
        expect((error as GitError).message).to.include('would be overwritten')
        expect((error as GitError).message).to.include('a.txt')
      }

      // Verify staged change is preserved (no data loss)
      const content = await readFile(join(testDir, 'a.txt'), 'utf8')
      expect(content).to.equal('staged-change')
    })

    it('allows checkout when staged changes do not conflict with target branch', async () => {
      // Setup: both branches have seed.md="seed" (same content).
      // Feature adds a.txt (unrelated change). Main stages seed.md modification.
      await service.checkout({directory: testDir, ref: 'feature'})
      await writeFile(join(testDir, 'a.txt'), 'feature-only')
      await service.add({directory: testDir, filePaths: ['a.txt']})
      await service.commit({directory: testDir, message: 'feature: add a.txt'})

      await service.checkout({directory: testDir, ref: 'main'})
      // Stage a modification to seed.md — same content on both branches, so no conflict
      await writeFile(join(testDir, 'seed.md'), 'staged-seed')
      await service.add({directory: testDir, filePaths: ['seed.md']})

      // Checkout feature should succeed — staged seed.md doesn't conflict (same on both branches)
      await service.checkout({directory: testDir, ref: 'feature'})
      const branch = await service.getCurrentBranch({directory: testDir})
      expect(branch).to.equal('feature')
    })

    it('allows checkout with force even when staged changes conflict', async () => {
      // Setup: feature branch has a.txt="v2", main stages a.txt="staged"
      await service.checkout({directory: testDir, ref: 'feature'})
      await writeFile(join(testDir, 'a.txt'), 'v2')
      await service.add({directory: testDir, filePaths: ['a.txt']})
      await service.commit({directory: testDir, message: 'feature: add a.txt'})

      await service.checkout({directory: testDir, ref: 'main'})
      await writeFile(join(testDir, 'a.txt'), 'staged-change')
      await service.add({directory: testDir, filePaths: ['a.txt']})

      // Force checkout should succeed — discards staged changes
      await service.checkout({directory: testDir, force: true, ref: 'feature'})
      const branch = await service.getCurrentBranch({directory: testDir})
      expect(branch).to.equal('feature')

      // a.txt now has feature branch content
      const content = await readFile(join(testDir, 'a.txt'), 'utf8')
      expect(content).to.equal('v2')
    })

    it('checks out a remote-tracking ref from an unborn HEAD (init + fetch + checkout)', async () => {
      // Simulate: `brv vc init` then `brv vc fetch` then `brv vc checkout feat/ENG-2512`.
      // Use a separate "remote" repo so we don't depend on network.
      const remoteDir = makeTestDir()
      extraTmpDirs.push(remoteDir)
      await mkdir(remoteDir, {recursive: true})
      const remoteSvc = new IsomorphicGitService(makeAuth())
      await remoteSvc.init({directory: remoteDir})
      await initWithCommit(remoteSvc, remoteDir, 'remote-only.md', 'remote body', 'init')
      await remoteSvc.createBranch({branch: 'feat/ENG-2512', directory: remoteDir})
      const remoteHeadSha = await git.resolveRef({dir: remoteDir, fs, ref: 'refs/heads/feat/ENG-2512'})

      // Fresh repo with unborn HEAD → main, and a remote-tracking ref written manually
      // (equivalent to what `git fetch` populates).
      const freshDir = makeTestDir()
      extraTmpDirs.push(freshDir)
      await mkdir(freshDir, {recursive: true})
      const freshSvc = new IsomorphicGitService(makeAuth())
      await freshSvc.init({directory: freshDir})
      await freshSvc.addRemote({directory: freshDir, remote: 'origin', url: 'https://example.invalid/repo.git'})
      await mkdir(join(freshDir, '.git', 'refs', 'remotes', 'origin', 'feat'), {recursive: true})
      await writeFile(join(freshDir, '.git', 'refs', 'remotes', 'origin', 'feat', 'ENG-2512'), `${remoteHeadSha}\n`)
      // Copy the commit + tree + blob objects so the ref resolves. Inline `await import`
      // because the lint rule `n/no-unsupported-features/node-builtins` flags a static
      // `cpSync` import (experimental until Node 22.3.0; project requires Node >=20.0.0).
      const {cpSync} = await import('node:fs')
      cpSync(join(remoteDir, '.git', 'objects'), join(freshDir, '.git', 'objects'), {recursive: true})

      // HEAD is still on unborn main — this is the scenario that previously failed.
      const beforeBranch = await freshSvc.getCurrentBranch({directory: freshDir})
      expect(beforeBranch).to.equal('main')

      await freshSvc.checkout({directory: freshDir, ref: 'feat/ENG-2512'})

      const branch = await freshSvc.getCurrentBranch({directory: freshDir})
      expect(branch).to.equal('feat/ENG-2512')
      const checkedOut = await readFile(join(freshDir, 'remote-only.md'), 'utf8')
      expect(checkedOut).to.equal('remote body')
    })

    it('checks out a remote-tracking ref when local main is on a stale commit (fetch + checkout)', async () => {
      // Simulate: clone-then-fetch flow — local main has commits (stale), fetch adds
      // a NEW remote-only branch, checkout switches and creates the local branch.
      const remoteDir = makeTestDir()
      extraTmpDirs.push(remoteDir)
      await mkdir(remoteDir, {recursive: true})
      const remoteSvc = new IsomorphicGitService(makeAuth())
      await remoteSvc.init({directory: remoteDir})
      await initWithCommit(remoteSvc, remoteDir, 'shared.md', 'v1', 'init')
      await remoteSvc.createBranch({branch: 'feat/new', directory: remoteDir})
      await remoteSvc.checkout({directory: remoteDir, ref: 'feat/new'})
      await writeFile(join(remoteDir, 'feature.md'), 'feature body')
      await writeFile(join(remoteDir, 'shared.md'), 'v2')
      await remoteSvc.add({directory: remoteDir, filePaths: ['feature.md', 'shared.md']})
      await remoteSvc.commit({directory: remoteDir, message: 'feature'})
      const remoteFeatSha = await git.resolveRef({dir: remoteDir, fs, ref: 'refs/heads/feat/new'})

      // Local repo: pre-populated main on the initial commit only ("stale main").
      const localDir = makeTestDir()
      extraTmpDirs.push(localDir)
      await mkdir(localDir, {recursive: true})
      const localSvc = new IsomorphicGitService(makeAuth())
      await localSvc.init({directory: localDir})
      await initWithCommit(localSvc, localDir, 'shared.md', 'v1', 'init')
      await localSvc.addRemote({directory: localDir, remote: 'origin', url: 'https://example.invalid/repo.git'})

      // Manually populate refs/remotes/origin/feat/new + copy objects (simulates fetch).
      await mkdir(join(localDir, '.git', 'refs', 'remotes', 'origin', 'feat'), {recursive: true})
      await writeFile(join(localDir, '.git', 'refs', 'remotes', 'origin', 'feat', 'new'), `${remoteFeatSha}\n`)
      // cpSync via dynamic import: the lint rule flags static use of an API stable only on Node >=22.3
      const {cpSync} = await import('node:fs')
      cpSync(join(remoteDir, '.git', 'objects'), join(localDir, '.git', 'objects'), {recursive: true})

      // Sanity: main resolves (not unborn), workdir has the old shared.md.
      const mainSha = await git.resolveRef({dir: localDir, fs, ref: 'main'})
      expect(mainSha).to.be.a('string')

      await localSvc.checkout({directory: localDir, ref: 'feat/new'})

      const branch = await localSvc.getCurrentBranch({directory: localDir})
      expect(branch).to.equal('feat/new')
      // shared.md updated from v1 → v2.
      const shared = await readFile(join(localDir, 'shared.md'), 'utf8')
      expect(shared).to.equal('v2')
      // feature.md (introduced on feat/new) is now present.
      const feature = await readFile(join(localDir, 'feature.md'), 'utf8')
      expect(feature).to.equal('feature body')
    })

    it('blocks checkout when unborn HEAD has a staged file that conflicts with target tree', async () => {
      // After the unborn-source fix, `guardStagedConflicts` is skipped for unborn HEAD.
      // Verify isomorphic-git's own CheckoutConflictError still protects against data
      // loss when a staged blob would be overwritten by the target.
      const remoteDir = makeTestDir()
      extraTmpDirs.push(remoteDir)
      await mkdir(remoteDir, {recursive: true})
      const remoteSvc = new IsomorphicGitService(makeAuth())
      await remoteSvc.init({directory: remoteDir})
      await initWithCommit(remoteSvc, remoteDir, 'shared.txt', 'remote-content', 'init')
      await remoteSvc.createBranch({branch: 'topic', directory: remoteDir})
      const topicSha = await git.resolveRef({dir: remoteDir, fs, ref: 'refs/heads/topic'})

      const freshDir = makeTestDir()
      extraTmpDirs.push(freshDir)
      await mkdir(freshDir, {recursive: true})
      const freshSvc = new IsomorphicGitService(makeAuth())
      await freshSvc.init({directory: freshDir})
      await freshSvc.addRemote({directory: freshDir, remote: 'origin', url: 'https://example.invalid/repo.git'})
      await mkdir(join(freshDir, '.git', 'refs', 'remotes', 'origin'), {recursive: true})
      await writeFile(join(freshDir, '.git', 'refs', 'remotes', 'origin', 'topic'), `${topicSha}\n`)
      const {cpSync} = await import('node:fs')
      cpSync(join(remoteDir, '.git', 'objects'), join(freshDir, '.git', 'objects'), {recursive: true})

      // Unborn HEAD; stage a file with content that differs from target.
      await writeFile(join(freshDir, 'shared.txt'), 'local-staged')
      await freshSvc.add({directory: freshDir, filePaths: ['shared.txt']})

      let threw = false
      try {
        await freshSvc.checkout({directory: freshDir, ref: 'topic'})
      } catch (error) {
        threw = true
        expect(error).to.be.instanceOf(GitError)
        expect((error as GitError).message).to.include('would be overwritten')
      }

      expect(threw, 'expected checkout to block on conflicting workdir/staged file').to.be.true
      const preserved = await readFile(join(freshDir, 'shared.txt'), 'utf8')
      expect(preserved).to.equal('local-staged')
    })

    it('blocks checkout from detached HEAD when a staged file conflicts with target tree', async () => {
      // The guard's gate widened in ENG-2835 to also cover detached HEAD (previously
      // skipped, leaving the documented data-loss bug unprotected). Verify the guard
      // now trips: stage a file on a detached commit, then attempt to switch to a
      // branch where that file has different content.
      await initWithCommit(service, testDir, 'shared.txt', 'commit-a', 'a')
      const detachedSha = await git.resolveRef({dir: testDir, fs, ref: 'HEAD'})
      await service.createBranch({branch: 'other', directory: testDir})
      await service.checkout({directory: testDir, ref: 'other'})
      await writeFile(join(testDir, 'shared.txt'), 'other-content')
      await service.add({directory: testDir, filePaths: ['shared.txt']})
      await service.commit({directory: testDir, message: 'other'})

      // Detach HEAD by writing the SHA directly to `.git/HEAD`. isomorphic-git's
      // `git.checkout({ref: sha})` creates/switches a local branch and does not have
      // a `--detach` mode, so a filesystem-layer write is the only way to reach the
      // detached-HEAD state we need to exercise here.
      await writeFile(join(testDir, '.git', 'HEAD'), `${detachedSha}\n`)
      const branchNow = await service.getCurrentBranch({directory: testDir})
      expect(branchNow, 'precondition: HEAD must be detached').to.equal(undefined)

      // Stage a conflicting blob; attempt to switch to `other`.
      await writeFile(join(testDir, 'shared.txt'), 'detached-staged')
      await service.add({directory: testDir, filePaths: ['shared.txt']})

      let threw = false
      try {
        await service.checkout({directory: testDir, ref: 'other'})
      } catch (error) {
        threw = true
        expect(error).to.be.instanceOf(GitError)
        expect((error as GitError).message).to.include('would be overwritten')
      }

      expect(threw, 'expected checkout from detached HEAD to block on staged conflict').to.be.true
      const preserved = await readFile(join(testDir, 'shared.txt'), 'utf8')
      expect(preserved).to.equal('detached-staged')
    })

    it('blocks checkout when unborn HEAD workdir has an untracked file conflicting with target tree', async () => {
      // Untracked file with different content than target — isomorphic-git's
      // CheckoutConflictError should block (matches native git behavior).
      const remoteDir = makeTestDir()
      extraTmpDirs.push(remoteDir)
      await mkdir(remoteDir, {recursive: true})
      const remoteSvc = new IsomorphicGitService(makeAuth())
      await remoteSvc.init({directory: remoteDir})
      await initWithCommit(remoteSvc, remoteDir, 'overlap.md', 'remote-version', 'init')
      const topicSha = await git.resolveRef({dir: remoteDir, fs, ref: 'main'})

      const freshDir = makeTestDir()
      extraTmpDirs.push(freshDir)
      await mkdir(freshDir, {recursive: true})
      const freshSvc = new IsomorphicGitService(makeAuth())
      await freshSvc.init({directory: freshDir})
      await freshSvc.addRemote({directory: freshDir, remote: 'origin', url: 'https://example.invalid/repo.git'})
      await mkdir(join(freshDir, '.git', 'refs', 'remotes', 'origin'), {recursive: true})
      await writeFile(join(freshDir, '.git', 'refs', 'remotes', 'origin', 'topic'), `${topicSha}\n`)
      const {cpSync} = await import('node:fs')
      cpSync(join(remoteDir, '.git', 'objects'), join(freshDir, '.git', 'objects'), {recursive: true})

      // Untracked file with different content already on disk.
      await writeFile(join(freshDir, 'overlap.md'), 'local-untracked')

      let threw = false
      try {
        await freshSvc.checkout({directory: freshDir, ref: 'topic'})
      } catch (error) {
        threw = true
        expect(error).to.be.instanceOf(GitError)
      }

      expect(threw, 'expected checkout to block on untracked-file conflict').to.be.true
      const preserved = await readFile(join(freshDir, 'overlap.md'), 'utf8')
      expect(preserved).to.equal('local-untracked')
    })
  })

  // ---- getConflicts() ----

  describe('getConflicts()', () => {
    beforeEach(async () => {
      await service.init({directory: testDir})
    })

    it('returns empty array when no merge in progress', async () => {
      await writeFile(join(testDir, 'clean.md'), 'no conflicts')
      const conflicts = await service.getConflicts({directory: testDir})
      expect(conflicts).to.be.empty
    })

    it('detects both_modified conflict after a real merge', async () => {
      // Common ancestor with the tracked file
      await writeFile(join(testDir, 'file.md'), 'initial')
      await service.add({directory: testDir, filePaths: ['file.md']})
      await service.commit({directory: testDir, message: 'initial'})

      // Diverge: feature branch modifies file
      await service.createBranch({branch: 'feature', directory: testDir})
      await service.checkout({directory: testDir, ref: 'feature'})
      await writeFile(join(testDir, 'file.md'), 'feature version')
      await service.add({directory: testDir, filePaths: ['file.md']})
      await service.commit({directory: testDir, message: 'feature change'})

      // main also modifies file → conflicting change
      await service.checkout({directory: testDir, ref: 'main'})
      await writeFile(join(testDir, 'file.md'), 'main version')
      await service.add({directory: testDir, filePaths: ['file.md']})
      await service.commit({directory: testDir, message: 'main change'})

      await service.merge({branch: 'feature', directory: testDir})

      const conflicts = await service.getConflicts({directory: testDir})
      expect(conflicts).to.have.length(1)
      expect(conflicts[0].path).to.equal('file.md')
      expect(conflicts[0].type).to.equal('both_modified')
    })

    it('detects deleted_modified conflict when tracked file is deleted from workdir', async () => {
      // File exists in HEAD but is deleted from workdir
      await writeFile(join(testDir, 'tracked.md'), 'content')
      await service.add({directory: testDir, filePaths: ['tracked.md']})
      await service.commit({directory: testDir, message: 'add tracked'})

      await writeFile(join(testDir, '.git', 'MERGE_HEAD'), 'deadbeef\n')
      await unlink(join(testDir, 'tracked.md'))

      const conflicts = await service.getConflicts({directory: testDir})
      expect(conflicts).to.have.length(1)
      expect(conflicts[0].path).to.equal('tracked.md')
      expect(conflicts[0].type).to.equal('deleted_modified')
    })

    it('detects conflicts in nested directories', async () => {
      // Common ancestor with a nested tracked file
      await mkdir(join(testDir, 'sub'), {recursive: true})
      await writeFile(join(testDir, 'sub', 'nested.md'), 'initial')
      await service.add({directory: testDir, filePaths: ['sub/nested.md']})
      await service.commit({directory: testDir, message: 'initial'})

      // Diverge: feature modifies nested file
      await service.createBranch({branch: 'feature', directory: testDir})
      await service.checkout({directory: testDir, ref: 'feature'})
      await writeFile(join(testDir, 'sub', 'nested.md'), 'feature version')
      await service.add({directory: testDir, filePaths: ['sub/nested.md']})
      await service.commit({directory: testDir, message: 'feature change'})

      // main also modifies → conflicting change
      await service.checkout({directory: testDir, ref: 'main'})
      await writeFile(join(testDir, 'sub', 'nested.md'), 'main version')
      await service.add({directory: testDir, filePaths: ['sub/nested.md']})
      await service.commit({directory: testDir, message: 'main change'})

      await service.merge({branch: 'feature', directory: testDir})

      const conflicts = await service.getConflicts({directory: testDir})
      expect(conflicts).to.have.length(1)
      expect(conflicts[0].path).to.equal(join('sub', 'nested.md'))
      expect(conflicts[0].type).to.equal('both_modified')
    })
  })

  // ---- getFilesWithConflictMarkers() ----

  describe('getFilesWithConflictMarkers()', () => {
    beforeEach(async () => {
      await service.init({directory: testDir})
    })

    it('returns empty array when no files have conflict markers', async () => {
      await writeFile(join(testDir, 'clean.md'), 'no conflicts here')
      await service.add({directory: testDir, filePaths: ['clean.md']})
      await service.commit({directory: testDir, message: 'clean'})

      const files = await service.getFilesWithConflictMarkers({directory: testDir})
      expect(files).to.be.empty
    })

    it('detects files with all three conflict markers', async () => {
      await writeFile(join(testDir, 'file.md'), 'initial')
      await service.add({directory: testDir, filePaths: ['file.md']})
      await service.commit({directory: testDir, message: 'initial'})

      await writeFile(join(testDir, 'file.md'), '<<<<<<< HEAD\nours\n=======\ntheirs\n>>>>>>> branch')

      const files = await service.getFilesWithConflictMarkers({directory: testDir})
      expect(files).to.deep.equal(['file.md'])
    })

    it('does not flag files with only partial markers', async () => {
      await writeFile(join(testDir, 'partial.md'), '<<<<<<< HEAD\nsome content\n=======')
      await service.add({directory: testDir, filePaths: ['partial.md']})
      await service.commit({directory: testDir, message: 'partial'})

      // Rewrite without >>>>>>> — should NOT be detected
      await writeFile(join(testDir, 'partial.md'), '<<<<<<< HEAD\nsome content\n=======')

      const files = await service.getFilesWithConflictMarkers({directory: testDir})
      expect(files).to.be.empty
    })

    it('works regardless of merge state (no MERGE_HEAD required)', async () => {
      await writeFile(join(testDir, 'file.md'), 'initial')
      await service.add({directory: testDir, filePaths: ['file.md']})
      await service.commit({directory: testDir, message: 'initial'})

      // No MERGE_HEAD — simulates leftover markers after merge abort/continue
      await writeFile(join(testDir, 'file.md'), '<<<<<<< HEAD\nours\n=======\ntheirs\n>>>>>>> branch')

      const files = await service.getFilesWithConflictMarkers({directory: testDir})
      expect(files).to.deep.equal(['file.md'])
    })

    it('detects conflict markers in nested directories', async () => {
      await mkdir(join(testDir, 'sub'), {recursive: true})
      await writeFile(join(testDir, 'sub', 'nested.md'), 'initial')
      await service.add({directory: testDir, filePaths: ['sub/nested.md']})
      await service.commit({directory: testDir, message: 'initial'})

      await writeFile(join(testDir, 'sub', 'nested.md'), '<<<<<<< HEAD\nours\n=======\ntheirs\n>>>>>>> branch')

      const files = await service.getFilesWithConflictMarkers({directory: testDir})
      expect(files).to.deep.equal([join('sub', 'nested.md')])
    })

    it('returns sorted file paths when multiple files have markers', async () => {
      await writeFile(join(testDir, 'b.md'), 'initial')
      await writeFile(join(testDir, 'a.md'), 'initial')
      await service.add({directory: testDir, filePaths: ['a.md', 'b.md']})
      await service.commit({directory: testDir, message: 'initial'})

      await writeFile(join(testDir, 'b.md'), '<<<<<<< HEAD\n=======\n>>>>>>> x')
      await writeFile(join(testDir, 'a.md'), '<<<<<<< HEAD\n=======\n>>>>>>> x')

      const files = await service.getFilesWithConflictMarkers({directory: testDir})
      expect(files).to.deep.equal(['a.md', 'b.md'])
    })
  })

  // ---- merge() ----

  describe('merge()', () => {
    beforeEach(async () => {
      await service.init({directory: testDir})
      await writeFile(join(testDir, 'a.md'), 'base')
      await service.add({directory: testDir, filePaths: ['a.md']})
      await service.commit({directory: testDir, message: 'base'})
    })

    it('returns success: true for clean merge (different files)', async () => {
      await service.createBranch({branch: 'feature', directory: testDir})
      await service.checkout({directory: testDir, ref: 'feature'})
      await writeFile(join(testDir, 'b.md'), 'new')
      await service.add({directory: testDir, filePaths: ['b.md']})
      await service.commit({directory: testDir, message: 'feature'})

      await service.checkout({directory: testDir, ref: 'main'})
      const result = await service.merge({branch: 'feature', directory: testDir})
      expect(result.success).to.be.true
    })

    it('returns conflicts for both_modified case', async () => {
      await service.createBranch({branch: 'feature', directory: testDir})
      await service.checkout({directory: testDir, ref: 'feature'})
      await writeFile(join(testDir, 'a.md'), 'feature version')
      await service.add({directory: testDir, filePaths: ['a.md']})
      await service.commit({directory: testDir, message: 'feature change'})

      await service.checkout({directory: testDir, ref: 'main'})
      await writeFile(join(testDir, 'a.md'), 'main version')
      await service.add({directory: testDir, filePaths: ['a.md']})
      await service.commit({directory: testDir, message: 'main change'})

      const result = await service.merge({branch: 'feature', directory: testDir})
      expect(result.success).to.be.false
      if (!result.success) {
        expect(result.conflicts).to.have.length(1)
        expect(result.conflicts[0].path).to.equal('a.md')
        expect(result.conflicts[0].type).to.equal('both_modified')
      }
    })

    it('uses <<<<<<< HEAD and >>>>>>> <branch> in conflict markers', async () => {
      await service.createBranch({branch: 'feature', directory: testDir})
      await service.checkout({directory: testDir, ref: 'feature'})
      await writeFile(join(testDir, 'a.md'), 'feature version')
      await service.add({directory: testDir, filePaths: ['a.md']})
      await service.commit({directory: testDir, message: 'feature change'})

      await service.checkout({directory: testDir, ref: 'main'})
      await writeFile(join(testDir, 'a.md'), 'main version')
      await service.add({directory: testDir, filePaths: ['a.md']})
      await service.commit({directory: testDir, message: 'main change'})

      await service.merge({branch: 'feature', directory: testDir})

      const content = await readFile(join(testDir, 'a.md'), 'utf8')
      expect(content).to.include('<<<<<<< HEAD')
      expect(content).to.include('>>>>>>> feature')
    })

    it('writes MERGE_HEAD after conflict so getConflicts() works post-restart', async () => {
      await service.createBranch({branch: 'feature', directory: testDir})
      await service.checkout({directory: testDir, ref: 'feature'})
      await writeFile(join(testDir, 'a.md'), 'feature version')
      await service.add({directory: testDir, filePaths: ['a.md']})
      await service.commit({directory: testDir, message: 'feature'})

      await service.checkout({directory: testDir, ref: 'main'})
      await writeFile(join(testDir, 'a.md'), 'main version')
      await service.add({directory: testDir, filePaths: ['a.md']})
      await service.commit({directory: testDir, message: 'main'})

      await service.merge({branch: 'feature', directory: testDir})

      // Simulate post-restart: call getConflicts() without the original error
      const conflicts = await service.getConflicts({directory: testDir})
      expect(conflicts).to.have.length(1)
      expect(conflicts[0].path).to.equal('a.md')
    })
  })

  // ---- abortMerge() ----

  describe('abortMerge()', () => {
    beforeEach(async () => {
      await service.init({directory: testDir})
      await writeFile(join(testDir, 'a.md'), 'base')
      await service.add({directory: testDir, filePaths: ['a.md']})
      await service.commit({directory: testDir, message: 'base'})
    })

    it('restores working tree, removes MERGE_HEAD and MERGE_MSG', async () => {
      // Create a conflict
      await service.createBranch({branch: 'feature', directory: testDir})
      await service.checkout({directory: testDir, ref: 'feature'})
      await writeFile(join(testDir, 'a.md'), 'feature version')
      await service.add({directory: testDir, filePaths: ['a.md']})
      await service.commit({directory: testDir, message: 'feature'})

      await service.checkout({directory: testDir, ref: 'main'})
      await writeFile(join(testDir, 'a.md'), 'main version')
      await service.add({directory: testDir, filePaths: ['a.md']})
      await service.commit({directory: testDir, message: 'main'})

      const mergeResult = await service.merge({branch: 'feature', directory: testDir})
      expect(mergeResult.success).to.be.false

      // Verify MERGE_HEAD and MERGE_MSG exist after conflict
      expect(existsSync(join(testDir, '.git', 'MERGE_HEAD'))).to.be.true
      expect(existsSync(join(testDir, '.git', 'MERGE_MSG'))).to.be.true

      // Abort the merge
      await service.abortMerge({directory: testDir})

      // MERGE_HEAD and MERGE_MSG should be removed
      expect(existsSync(join(testDir, '.git', 'MERGE_HEAD'))).to.be.false
      expect(existsSync(join(testDir, '.git', 'MERGE_MSG'))).to.be.false

      // Working tree should be restored to pre-merge state
      const content = await readFile(join(testDir, 'a.md'), 'utf8')
      expect(content).to.equal('main version')

      // No conflicts should remain
      const conflicts = await service.getConflicts({directory: testDir})
      expect(conflicts).to.be.empty
    })
  })

  // ---- merge() MERGE_MSG ----

  describe('merge() MERGE_MSG', () => {
    beforeEach(async () => {
      await service.init({directory: testDir})
      await writeFile(join(testDir, 'a.md'), 'base')
      await service.add({directory: testDir, filePaths: ['a.md']})
      await service.commit({directory: testDir, message: 'base'})
    })

    it('writes MERGE_MSG alongside MERGE_HEAD on conflict', async () => {
      await service.createBranch({branch: 'feature', directory: testDir})
      await service.checkout({directory: testDir, ref: 'feature'})
      await writeFile(join(testDir, 'a.md'), 'feature version')
      await service.add({directory: testDir, filePaths: ['a.md']})
      await service.commit({directory: testDir, message: 'feature'})

      await service.checkout({directory: testDir, ref: 'main'})
      await writeFile(join(testDir, 'a.md'), 'main version')
      await service.add({directory: testDir, filePaths: ['a.md']})
      await service.commit({directory: testDir, message: 'main'})

      await service.merge({branch: 'feature', directory: testDir})

      const mergeMsg = await readFile(join(testDir, '.git', 'MERGE_MSG'), 'utf8')
      expect(mergeMsg.trim()).to.equal("Merge branch 'feature'")
    })

    it('passes custom message to git.merge() on true merge commit', async () => {
      // Create diverged branches so a merge commit is required (not fast-forward)
      await service.createBranch({branch: 'feature', directory: testDir})
      await service.checkout({directory: testDir, ref: 'feature'})
      await writeFile(join(testDir, 'b.md'), 'feature file')
      await service.add({directory: testDir, filePaths: ['b.md']})
      await service.commit({directory: testDir, message: 'feature commit'})

      await service.checkout({directory: testDir, ref: 'main'})
      await writeFile(join(testDir, 'c.md'), 'main file')
      await service.add({directory: testDir, filePaths: ['c.md']})
      await service.commit({directory: testDir, message: 'main commit'})

      const result = await service.merge({branch: 'feature', directory: testDir, message: 'Custom merge msg'})
      expect(result.success).to.be.true

      // Verify the commit message
      const log = await service.log({depth: 1, directory: testDir})
      expect(log[0].message).to.equal('Custom merge msg')
    })
  })

  // ---- remote management ----

  describe('remote management', () => {
    beforeEach(async () => {
      await service.init({directory: testDir})
    })

    it('addRemote + listRemotes', async () => {
      await service.addRemote({directory: testDir, remote: 'origin', url: `${COGIT_BASE}/team-1/space-1.git`})
      const remotes = await service.listRemotes({directory: testDir})

      expect(remotes).to.have.length(1)
      expect(remotes[0].remote).to.equal('origin')
      expect(remotes[0].url).to.equal(`${COGIT_BASE}/team-1/space-1.git`)
    })

    it('listRemotes returns empty array when no remotes', async () => {
      const remotes = await service.listRemotes({directory: testDir})
      expect(remotes).to.be.empty
    })

    it('getRemoteUrl returns URL for existing remote', async () => {
      const url = `${COGIT_BASE}/team-1/space-1.git`
      await service.addRemote({directory: testDir, remote: 'origin', url})
      expect(await service.getRemoteUrl({directory: testDir, remote: 'origin'})).to.equal(url)
    })

    it('getRemoteUrl returns undefined for missing remote', async () => {
      expect(await service.getRemoteUrl({directory: testDir, remote: 'nonexistent'})).to.be.undefined
    })

    it('removeRemote deletes the remote', async () => {
      await service.addRemote({directory: testDir, remote: 'origin', url: 'https://example.com/1.git'})
      await service.removeRemote({directory: testDir, remote: 'origin'})
      expect(await service.listRemotes({directory: testDir})).to.be.empty
    })
  })

  // ---- error handling ----

  describe('error handling', () => {
    it('throws GitError when directory is empty string', async () => {
      try {
        await service.status({directory: ''})
        expect.fail('should have thrown')
      } catch (error) {
        expect(error).to.be.instanceOf(GitError)
      }
    })

    it('throws GitAuthError when pushing without a token', async () => {
      const noAuthService = new IsomorphicGitService(makeAuth({noAuth: true}))

      await service.init({directory: testDir})
      // Remote is required — onAuth is only invoked when isomorphic-git has a URL to connect to
      await service.addRemote({directory: testDir, remote: 'origin', url: `${COGIT_BASE}/team-1/space-1.git`})
      await writeFile(join(testDir, 'f.md'), 'x')
      await service.add({directory: testDir, filePaths: ['f.md']})
      await service.commit({directory: testDir, message: 'init'})

      try {
        await noAuthService.push({directory: testDir})
        expect.fail('should have thrown')
      } catch (error) {
        expect(error).to.be.instanceOf(GitAuthError)
      }
    })
  })

  // ---- getTrackingBranch() / setTrackingBranch() ----

  describe('getTrackingBranch()', () => {
    it('returns undefined when no tracking config is set', async () => {
      await service.init({directory: testDir})
      await writeFile(join(testDir, 'a.md'), 'content')
      await service.add({directory: testDir, filePaths: ['a.md']})
      await service.commit({directory: testDir, message: 'init'})

      const result = await service.getTrackingBranch({branch: 'main', directory: testDir})

      expect(result).to.be.undefined
    })

    it('returns tracking config after setTrackingBranch', async () => {
      await service.init({directory: testDir})
      await writeFile(join(testDir, 'a.md'), 'content')
      await service.add({directory: testDir, filePaths: ['a.md']})
      await service.commit({directory: testDir, message: 'init'})

      await service.setTrackingBranch({branch: 'main', directory: testDir, remote: 'origin', remoteBranch: 'main'})
      const result = await service.getTrackingBranch({branch: 'main', directory: testDir})

      expect(result).to.deep.equal({remote: 'origin', remoteBranch: 'main'})
    })

    it('overwrites existing tracking config', async () => {
      await service.init({directory: testDir})
      await writeFile(join(testDir, 'a.md'), 'content')
      await service.add({directory: testDir, filePaths: ['a.md']})
      await service.commit({directory: testDir, message: 'init'})

      await service.setTrackingBranch({branch: 'main', directory: testDir, remote: 'origin', remoteBranch: 'main'})
      await service.setTrackingBranch({branch: 'main', directory: testDir, remote: 'origin', remoteBranch: 'develop'})
      const result = await service.getTrackingBranch({branch: 'main', directory: testDir})

      expect(result).to.deep.equal({remote: 'origin', remoteBranch: 'develop'})
    })
  })

  // ---- getAheadBehind() ----

  describe('getAheadBehind()', () => {
    it('returns {ahead: 0, behind: 0} when refs are equal', async () => {
      await service.init({directory: testDir})
      await writeFile(join(testDir, 'a.md'), 'content')
      await service.add({directory: testDir, filePaths: ['a.md']})
      await service.commit({directory: testDir, message: 'init'})

      const result = await service.getAheadBehind({
        directory: testDir,
        localRef: 'refs/heads/main',
        remoteRef: 'refs/heads/main',
      })

      expect(result).to.deep.equal({ahead: 0, behind: 0})
    })

    it('returns {ahead: 0, behind: 0} when remote ref does not exist', async () => {
      await service.init({directory: testDir})
      await writeFile(join(testDir, 'a.md'), 'content')
      await service.add({directory: testDir, filePaths: ['a.md']})
      await service.commit({directory: testDir, message: 'init'})

      const result = await service.getAheadBehind({
        directory: testDir,
        localRef: 'refs/heads/main',
        remoteRef: 'refs/remotes/origin/main',
      })

      expect(result).to.deep.equal({ahead: 0, behind: 0})
    })

    it('counts commits ahead when local has more commits', async () => {
      await service.init({directory: testDir})
      await writeFile(join(testDir, 'a.md'), 'v1')
      await service.add({directory: testDir, filePaths: ['a.md']})
      await service.commit({directory: testDir, message: 'commit 1'})

      // Create a branch to act as remote ref point
      await service.createBranch({branch: 'remote-snapshot', directory: testDir})

      // Add 2 more commits on main
      await writeFile(join(testDir, 'a.md'), 'v2')
      await service.add({directory: testDir, filePaths: ['a.md']})
      await service.commit({directory: testDir, message: 'commit 2'})
      await writeFile(join(testDir, 'a.md'), 'v3')
      await service.add({directory: testDir, filePaths: ['a.md']})
      await service.commit({directory: testDir, message: 'commit 3'})

      const result = await service.getAheadBehind({
        directory: testDir,
        localRef: 'refs/heads/main',
        remoteRef: 'refs/heads/remote-snapshot',
      })

      expect(result.ahead).to.equal(2)
      expect(result.behind).to.equal(0)
    })
  })

  // ---- reset() ----

  describe('reset()', () => {
    describe('unstage all (default)', () => {
      it('unstages a staged new file', async () => {
        await service.init({directory: testDir})
        await initWithCommit(service, testDir, 'base.md', 'base', 'initial')

        await writeFile(join(testDir, 'new.md'), 'new content')
        await service.add({directory: testDir, filePaths: ['new.md']})

        // Verify staged
        let status = await service.status({directory: testDir})
        expect(status.files.some((f) => f.path === 'new.md' && f.staged)).to.be.true

        const result = await service.reset({directory: testDir})

        expect(result.filesChanged).to.equal(1)

        // Verify unstaged — file should be untracked now
        status = await service.status({directory: testDir})
        const newFile = status.files.find((f) => f.path === 'new.md')
        expect(newFile).to.exist
        expect(newFile!.staged).to.be.false
        expect(newFile!.status).to.equal('untracked')
      })

      it('unstages a staged modification', async () => {
        await service.init({directory: testDir})
        await initWithCommit(service, testDir, 'a.md', 'original', 'initial')

        await writeFile(join(testDir, 'a.md'), 'modified')
        await service.add({directory: testDir, filePaths: ['a.md']})

        let status = await service.status({directory: testDir})
        expect(status.files.some((f) => f.path === 'a.md' && f.staged && f.status === 'modified')).to.be.true

        await service.reset({directory: testDir})

        status = await service.status({directory: testDir})
        const file = status.files.find((f) => f.path === 'a.md')
        expect(file).to.exist
        expect(file!.staged).to.be.false
        expect(file!.status).to.equal('modified')
      })

      it('unstages a staged deletion', async () => {
        await service.init({directory: testDir})
        await initWithCommit(service, testDir, 'a.md', 'content', 'initial')

        await unlink(join(testDir, 'a.md'))
        await service.add({directory: testDir, filePaths: ['a.md']})

        let status = await service.status({directory: testDir})
        expect(status.files.some((f) => f.path === 'a.md' && f.staged && f.status === 'deleted')).to.be.true

        await service.reset({directory: testDir})

        status = await service.status({directory: testDir})
        const file = status.files.find((f) => f.path === 'a.md')
        expect(file).to.exist
        expect(file!.staged).to.be.false
        expect(file!.status).to.equal('deleted')
      })

      it('returns filesChanged=0 when nothing is staged', async () => {
        await service.init({directory: testDir})
        await initWithCommit(service, testDir, 'a.md', 'content', 'initial')

        const result = await service.reset({directory: testDir})
        expect(result.filesChanged).to.equal(0)
      })
    })

    describe('unstage specific file', () => {
      it('unstages only the specified file', async () => {
        await service.init({directory: testDir})
        await initWithCommit(service, testDir, 'a.md', 'a', 'initial')

        await writeFile(join(testDir, 'a.md'), 'modified a')
        await writeFile(join(testDir, 'b.md'), 'new b')
        await service.add({directory: testDir, filePaths: ['a.md', 'b.md']})

        await service.reset({directory: testDir, filePaths: ['b.md']})

        const status = await service.status({directory: testDir})
        // a.md should still be staged
        expect(status.files.some((f) => f.path === 'a.md' && f.staged)).to.be.true
        // b.md should be unstaged (untracked)
        const bFile = status.files.find((f) => f.path === 'b.md')
        expect(bFile).to.exist
        expect(bFile!.staged).to.be.false
      })
    })

    describe('soft reset', () => {
      it('moves HEAD back, keeps changes staged', async () => {
        await service.init({directory: testDir})
        const sha1 = await initWithCommit(service, testDir, 'a.md', 'v1', 'commit 1')
        await initWithCommit(service, testDir, 'a.md', 'v2', 'commit 2')

        const result = await service.reset({directory: testDir, mode: 'soft', ref: 'HEAD~1'})

        expect(result.headSha).to.equal(sha1)

        // HEAD should be at sha1
        const log = await service.log({depth: 1, directory: testDir})
        expect(log[0].sha).to.equal(sha1)

        // Changes from commit 2 should still be staged
        const status = await service.status({directory: testDir})
        expect(status.files.some((f) => f.path === 'a.md' && f.staged && f.status === 'modified')).to.be.true

        // Working tree should have v2 content
        const content = await readFile(join(testDir, 'a.md'), 'utf8')
        expect(content).to.equal('v2')
      })
    })

    describe('hard reset', () => {
      it('moves HEAD back and discards all changes', async () => {
        await service.init({directory: testDir})
        const sha1 = await initWithCommit(service, testDir, 'a.md', 'v1', 'commit 1')
        await initWithCommit(service, testDir, 'a.md', 'v2', 'commit 2')

        const result = await service.reset({directory: testDir, mode: 'hard', ref: 'HEAD~1'})

        expect(result.headSha).to.equal(sha1)

        // HEAD should be at sha1
        const log = await service.log({depth: 1, directory: testDir})
        expect(log[0].sha).to.equal(sha1)

        // Working tree should be clean with v1 content
        const content = await readFile(join(testDir, 'a.md'), 'utf8')
        expect(content).to.equal('v1')

        const status = await service.status({directory: testDir})
        expect(status.isClean).to.be.true
      })

      it('removes files that were added in the reset-away commit', async () => {
        await service.init({directory: testDir})
        const sha1 = await initWithCommit(service, testDir, 'a.md', 'a', 'commit 1')
        await initWithCommit(service, testDir, 'b.md', 'b', 'commit 2')

        await service.reset({directory: testDir, mode: 'hard', ref: 'HEAD~1'})

        // b.md should be gone from disk
        expect(existsSync(join(testDir, 'b.md'))).to.be.false

        // a.md should still exist
        expect(existsSync(join(testDir, 'a.md'))).to.be.true

        const log = await service.log({depth: 1, directory: testDir})
        expect(log[0].sha).to.equal(sha1)
      })
    })

    describe('mixed reset with ref', () => {
      it('moves HEAD back and unstages changes', async () => {
        await service.init({directory: testDir})
        const sha1 = await initWithCommit(service, testDir, 'a.md', 'v1', 'commit 1')
        await initWithCommit(service, testDir, 'a.md', 'v2', 'commit 2')

        const result = await service.reset({directory: testDir, mode: 'mixed', ref: 'HEAD~1'})

        expect(result.headSha).to.equal(sha1)

        // HEAD should be at sha1
        const log = await service.log({depth: 1, directory: testDir})
        expect(log[0].sha).to.equal(sha1)

        // Working tree should have v2 (untouched)
        const content = await readFile(join(testDir, 'a.md'), 'utf8')
        expect(content).to.equal('v2')

        // Changes should be unstaged (not staged)
        const status = await service.status({directory: testDir})
        expect(status.files.some((f) => f.path === 'a.md' && !f.staged && f.status === 'modified')).to.be.true
      })
    })

    describe('edge cases', () => {
      it('throws when HEAD~N exceeds history', async () => {
        await service.init({directory: testDir})
        await initWithCommit(service, testDir, 'a.md', 'v1', 'commit 1')

        try {
          await service.reset({directory: testDir, mode: 'soft', ref: 'HEAD~5'})
          expect.fail('Expected error')
        } catch (error) {
          expect(error).to.be.instanceOf(GitError)
          expect((error as GitError).message).to.include('not enough ancestors')
        }
      })

      it('resolves HEAD~0 to current HEAD', async () => {
        await service.init({directory: testDir})
        const sha = await initWithCommit(service, testDir, 'a.md', 'v1', 'commit 1')

        const result = await service.reset({directory: testDir, mode: 'soft', ref: 'HEAD~0'})
        expect(result.headSha).to.equal(sha)
      })
    })
  })

  // ---- diff primitives (listChangedFiles, getOid, hashBlob, getBlobContent at commitish) ----

  describe('listChangedFiles()', () => {
    describe('unstaged: STAGE -> WORKDIR', () => {
      it('returns modified files (workdir differs from stage)', async () => {
        await service.init({directory: testDir})
        await initWithCommit(service, testDir, 'a.md', 'short\n', 'c1')
        // Different length so isomorphic-git's stat-based fast path can't skip the content read.
        await writeFile(join(testDir, 'a.md'), 'a much longer line of content\n')

        const changes = await service.listChangedFiles({directory: testDir, from: 'STAGE', to: 'WORKDIR'})
        expect(changes).to.deep.equal([{path: 'a.md', status: 'modified'}])
      })

      it('returns deleted files (present in stage, missing from workdir)', async () => {
        await service.init({directory: testDir})
        await initWithCommit(service, testDir, 'gone.md', 'v1\n', 'c1')
        await unlink(join(testDir, 'gone.md'))

        const changes = await service.listChangedFiles({directory: testDir, from: 'STAGE', to: 'WORKDIR'})
        expect(changes).to.deep.equal([{path: 'gone.md', status: 'deleted'}])
      })

      it('excludes untracked files (matches `git diff` no-args behavior)', async () => {
        await service.init({directory: testDir})
        await initWithCommit(service, testDir, 'tracked.md', 'v1\n', 'c1')
        await writeFile(join(testDir, 'untracked.md'), 'untracked\n')

        const changes = await service.listChangedFiles({directory: testDir, from: 'STAGE', to: 'WORKDIR'})
        expect(changes).to.deep.equal([])
      })
    })

    describe('staged: HEAD -> STAGE', () => {
      it('returns added files (staged but not in HEAD)', async () => {
        await service.init({directory: testDir})
        await initWithCommit(service, testDir, 'a.md', 'v1\n', 'c1')
        await writeFile(join(testDir, 'b.md'), 'new\n')
        await service.add({directory: testDir, filePaths: ['b.md']})

        const changes = await service.listChangedFiles({
          directory: testDir,
          from: {commitish: 'HEAD'},
          to: 'STAGE',
        })
        expect(changes).to.deep.equal([{path: 'b.md', status: 'added'}])
      })

      it('returns modified files (staged change differs from HEAD)', async () => {
        await service.init({directory: testDir})
        await initWithCommit(service, testDir, 'a.md', 'v1\n', 'c1')
        await writeFile(join(testDir, 'a.md'), 'v2\n')
        await service.add({directory: testDir, filePaths: ['a.md']})

        const changes = await service.listChangedFiles({
          directory: testDir,
          from: {commitish: 'HEAD'},
          to: 'STAGE',
        })
        expect(changes).to.deep.equal([{path: 'a.md', status: 'modified'}])
      })
    })

    describe('range: commit-vs-commit', () => {
      it('returns all 3 statuses across two commits', async () => {
        await service.init({directory: testDir})
        await initWithCommit(service, testDir, 'kept.md', 'k1\n', 'c1')
        await initWithCommit(service, testDir, 'modified.md', 'm1\n', 'c2')
        const sha2 = await initWithCommit(service, testDir, 'deleted.md', 'd1\n', 'c3')

        // Now create the "to" commit: modify, delete, and add
        await writeFile(join(testDir, 'modified.md'), 'm2\n')
        await unlink(join(testDir, 'deleted.md'))
        await writeFile(join(testDir, 'added.md'), 'new\n')
        await service.add({directory: testDir, filePaths: ['modified.md', 'added.md']})
        // Stage the deletion explicitly
        await git.remove({dir: testDir, filepath: 'deleted.md', fs})
        const c4 = await service.commit({directory: testDir, message: 'c4'})

        const changes = await service.listChangedFiles({
          directory: testDir,
          from: {commitish: sha2},
          to: {commitish: c4.sha},
        })
        const byPath = Object.fromEntries(changes.map((c) => [c.path, c.status]))
        expect(byPath).to.deep.equal({
          'added.md': 'added',
          'deleted.md': 'deleted',
          'modified.md': 'modified',
        })
      })
    })

    describe('ref-vs-worktree', () => {
      it('reports modifications between a commit and the working tree', async () => {
        await service.init({directory: testDir})
        await initWithCommit(service, testDir, 'a.md', 'v1\n', 'c1')
        await writeFile(join(testDir, 'a.md'), 'v2\n')
        await service.add({directory: testDir, filePaths: ['a.md']})

        const changes = await service.listChangedFiles({
          directory: testDir,
          from: {commitish: 'HEAD'},
          to: 'WORKDIR',
        })
        expect(changes).to.deep.equal([{path: 'a.md', status: 'modified'}])
      })

      it('reports deleted file vs commit', async () => {
        await service.init({directory: testDir})
        await initWithCommit(service, testDir, 'old.md', 'v1\n', 'c1')
        await unlink(join(testDir, 'old.md'))

        const changes = await service.listChangedFiles({
          directory: testDir,
          from: {commitish: 'HEAD'},
          to: 'WORKDIR',
        })
        expect(changes).to.deep.equal([{path: 'old.md', status: 'deleted'}])
      })

      it('excludes untracked files (matches `git diff <commit>` behavior)', async () => {
        await service.init({directory: testDir})
        await initWithCommit(service, testDir, 'committed.md', 'v1\n', 'c1')
        // Untracked file — real `git diff HEAD` does NOT report this.
        await writeFile(join(testDir, 'untracked.md'), 'fresh\n')

        const changes = await service.listChangedFiles({
          directory: testDir,
          from: {commitish: 'HEAD'},
          to: 'WORKDIR',
        })
        expect(changes).to.deep.equal([])
      })

      it('reports staged-new files vs commit (in index but not in source ref)', async () => {
        await service.init({directory: testDir})
        await initWithCommit(service, testDir, 'committed.md', 'v1\n', 'c1')
        await writeFile(join(testDir, 'staged.md'), 'fresh\n')
        await service.add({directory: testDir, filePaths: ['staged.md']})

        const changes = await service.listChangedFiles({
          directory: testDir,
          from: {commitish: 'HEAD'},
          to: 'WORKDIR',
        })
        expect(changes).to.deep.equal([{path: 'staged.md', status: 'added'}])
      })
    })
  })

  describe('getTextBlob()', () => {
    it('returns content + 7-char short oid for a file at HEAD', async () => {
      await service.init({directory: testDir})
      await initWithCommit(service, testDir, 'a.md', 'hello\n', 'c1')

      const blob = await service.getTextBlob({directory: testDir, path: 'a.md', ref: {commitish: 'HEAD'}})
      expect(blob).to.not.equal(undefined)
      expect(blob?.content).to.equal('hello\n')
      expect(blob?.oid).to.have.lengthOf(7)
      expect(blob?.oid).to.match(/^[\da-f]{7}$/)
    })

    it('returns content + oid for a staged file', async () => {
      await service.init({directory: testDir})
      await writeFile(join(testDir, 'b.md'), 'staged\n')
      await service.add({directory: testDir, filePaths: ['b.md']})

      const blob = await service.getTextBlob({directory: testDir, path: 'b.md', ref: 'STAGE'})
      expect(blob?.content).to.equal('staged\n')
      expect(blob?.oid).to.have.lengthOf(7)
    })

    it('returns undefined for a non-existent file', async () => {
      await service.init({directory: testDir})
      await initWithCommit(service, testDir, 'a.md', 'hello\n', 'c1')

      const blob = await service.getTextBlob({directory: testDir, path: 'missing.md', ref: {commitish: 'HEAD'}})
      expect(blob).to.equal(undefined)
    })

    it('marks a binary blob (contains NUL byte) with binary:true and empty content', async () => {
      await service.init({directory: testDir})
      // Commit a file containing a NUL byte.
      await writeFile(join(testDir, 'logo.bin'), Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x00, 0x01]))
      await service.add({directory: testDir, filePaths: ['logo.bin']})
      await service.commit({directory: testDir, message: 'add binary'})

      const blob = await service.getTextBlob({directory: testDir, path: 'logo.bin', ref: {commitish: 'HEAD'}})
      expect(blob).to.not.equal(undefined)
      expect(blob?.binary).to.equal(true)
      expect(blob?.content).to.equal('')
      expect(blob?.oid).to.have.lengthOf(7)
    })
  })

  describe('hashBlob()', () => {
    it('returns the same 7-char short oid that git would compute for the content', async () => {
      await service.init({directory: testDir})
      await initWithCommit(service, testDir, 'a.md', 'hello\n', 'c1')

      const blob = await service.getTextBlob({directory: testDir, path: 'a.md', ref: {commitish: 'HEAD'}})
      const hashed = await service.hashBlob(Buffer.from('hello\n', 'utf8'))
      expect(hashed).to.equal(blob?.oid)
    })
  })

  describe('getBlobContent() at commit-ish', () => {
    it('reads a file blob at HEAD via {commitish}', async () => {
      await service.init({directory: testDir})
      await initWithCommit(service, testDir, 'a.md', 'committed\n', 'c1')
      await writeFile(join(testDir, 'a.md'), 'modified\n')

      const content = await service.getBlobContent({
        directory: testDir,
        path: 'a.md',
        ref: {commitish: 'HEAD'},
      })
      expect(content).to.equal('committed\n')
    })

    it('reads a file blob at an arbitrary commit SHA', async () => {
      await service.init({directory: testDir})
      const sha1 = await initWithCommit(service, testDir, 'a.md', 'v1\n', 'c1')
      await initWithCommit(service, testDir, 'a.md', 'v2\n', 'c2')

      const content = await service.getBlobContent({directory: testDir, path: 'a.md', ref: {commitish: sha1}})
      expect(content).to.equal('v1\n')
    })
  })
})
