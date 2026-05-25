/**
 * Integration tests for workspace-scoped executor behavior.
 *
 * Verifies that QueryExecutor and FolderPackExecutor correctly use
 * worktreeRoot for search scoping, cache isolation, and path defaults.
 *
 * Uses real filesystem (tmpdir) + real resolveProject() with stubbed
 * agent/search service (no LLM, no network).
 */

import {expect} from 'chai'
import {mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync} from 'node:fs'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import {createSandbox, type SinonSandbox, type SinonStub} from 'sinon'

import type {FolderPackResult} from '../../../src/agent/core/domain/folder-pack/types.js'
import type {ICipherAgent} from '../../../src/agent/core/interfaces/i-cipher-agent.js'
import type {IFileSystem} from '../../../src/agent/core/interfaces/i-file-system.js'
import type {IFolderPackService} from '../../../src/agent/core/interfaces/i-folder-pack-service.js'
import type {ISearchKnowledgeService} from '../../../src/agent/infra/sandbox/tools-sdk.js'

import {CurateExecutor} from '../../../src/server/infra/executor/curate-executor.js'
import {FolderPackExecutor} from '../../../src/server/infra/executor/folder-pack-executor.js'
import {QueryExecutor} from '../../../src/server/infra/executor/query-executor.js'
import {resolveProject} from '../../../src/server/infra/project/resolve-project.js'

// ============================================================================
// Helpers
// ============================================================================

function createBrvConfig(dir: string): void {
  mkdirSync(join(dir, '.brv'), {recursive: true})
  writeFileSync(join(dir, '.brv', 'config.json'), JSON.stringify({version: '0.0.1'}))
}

function createWorkspaceLink(dir: string, projectRoot: string): void {
  writeFileSync(join(dir, '.brv'), JSON.stringify({projectRoot}, null, 2) + '\n')
}

function makeStubAgent(sandbox: SinonSandbox): ICipherAgent & {
  createTaskSession: SinonStub
  deleteTaskSession: SinonStub
  executeOnSession: SinonStub
  setSandboxVariableOnSession: SinonStub
} {
  return {
    cancel: sandbox.stub().resolves(false),
    cancelTask: sandbox.stub().resolves(false),
    createTaskSession: sandbox.stub().resolves('task-session-1'),
    deleteSandboxVariable: sandbox.stub(),
    deleteSandboxVariableOnSession: sandbox.stub(),
    deleteSession: sandbox.stub().resolves(true),
    deleteTaskSession: sandbox.stub().resolves(),
    execute: sandbox.stub().resolves('response'),
    executeOnSession: sandbox.stub().resolves('query response'),
    generate: sandbox.stub().resolves({content: '', toolCalls: [], usage: {inputTokens: 0, outputTokens: 0}}),
    getSessionMetadata: sandbox.stub().resolves(),
    getState: sandbox.stub().returns({
      currentIteration: 0,
      executionHistory: [],
      executionState: 'idle',
      toolCallsExecuted: 0,
    }),
    listPersistedSessions: sandbox.stub().resolves([]),
    reset: sandbox.stub(),
    setSandboxVariable: sandbox.stub(),
    setSandboxVariableOnSession: sandbox.stub(),
    start: sandbox.stub().resolves(),
    stream: sandbox.stub().resolves({
      [Symbol.asyncIterator]: () => ({next: () => Promise.resolve({done: true, value: undefined})}),
    }),
  }
}

function makeStubSearchService(sandbox: SinonSandbox): ISearchKnowledgeService & {search: SinonStub} {
  return {
    search: sandbox.stub().resolves({
      message: 'Found 0 results',
      results: [],
      totalFound: 0,
    }),
  }
}

function makeStubFileSystem(sandbox: SinonSandbox): IFileSystem & {globFiles: SinonStub; readFile: SinonStub} {
  return {
    editFile: sandbox.stub().resolves({bytesWritten: 0, replacements: 0}),
    globFiles: sandbox.stub().resolves({files: [], totalFound: 0}),
    initialize: sandbox.stub().resolves(),
    listDirectory: sandbox.stub().resolves({entries: [], tree: ''}),
    readFile: sandbox.stub().resolves({content: '', lines: 0, truncated: false}),
    searchContent: sandbox.stub().resolves({matches: [], totalMatches: 0}),
    writeFile: sandbox.stub().resolves({bytesWritten: 0, path: ''}),
  }
}

// ============================================================================
// Tests
// ============================================================================

describe('workspace-scoped execution (integration)', () => {
  let sandbox: SinonSandbox
  let testDir: string

  beforeEach(() => {
    sandbox = createSandbox()
    testDir = realpathSync(mkdtempSync(join(tmpdir(), 'brv-exec-integ-')))
  })

  afterEach(() => {
    sandbox.restore()
    rmSync(testDir, {force: true, recursive: true})
  })

  describe('QueryExecutor workspace scoping', () => {
    it('should pass workspace scope to search service when linked', async () => {
      const projectRoot = join(testDir, 'project')
      const workspace = join(projectRoot, 'packages', 'api')
      mkdirSync(workspace, {recursive: true})
      createBrvConfig(projectRoot)
      createWorkspaceLink(workspace, projectRoot)

      const resolution = resolveProject({cwd: workspace})
      expect(resolution!.source).to.equal('linked')

      const searchService = makeStubSearchService(sandbox)
      const agent = makeStubAgent(sandbox)

      const executor = new QueryExecutor({
        baseDirectory: resolution!.projectRoot,
        searchService,
      })

      await executor.executeWithAgent(agent, {
        query: 'how does auth work',
        taskId: 'task-1',
        worktreeRoot: resolution!.worktreeRoot,
      })

      // Search should have been called with scope = relative path
      expect(searchService.search.called).to.be.true
      const searchOptions = searchService.search.firstCall.args[1]
      expect(searchOptions?.scope).to.equal('packages/api')
    })

    it('should not pass scope when workspace equals project root', async () => {
      const projectRoot = join(testDir, 'project')
      mkdirSync(projectRoot, {recursive: true})
      createBrvConfig(projectRoot)

      const resolution = resolveProject({cwd: projectRoot})
      expect(resolution!.source).to.equal('direct')

      const searchService = makeStubSearchService(sandbox)
      const agent = makeStubAgent(sandbox)

      const executor = new QueryExecutor({
        baseDirectory: resolution!.projectRoot,
        searchService,
      })

      await executor.executeWithAgent(agent, {
        query: 'how does auth work',
        taskId: 'task-2',
        worktreeRoot: resolution!.worktreeRoot,
      })

      expect(searchService.search.called).to.be.true
      const searchOptions = searchService.search.firstCall.args[1]
      // No scope when worktreeRoot === projectRoot
      expect(searchOptions?.scope).to.be.undefined
    })

    it('should scope reverts to unscoped after unlink', async () => {
      const projectRoot = join(testDir, 'project')
      const workspace = join(projectRoot, 'packages', 'api')
      mkdirSync(workspace, {recursive: true})
      createBrvConfig(projectRoot)
      createWorkspaceLink(workspace, projectRoot)

      const searchService = makeStubSearchService(sandbox)
      const agent = makeStubAgent(sandbox)

      // First: linked — scoped
      const linked = resolveProject({cwd: workspace})
      const executor1 = new QueryExecutor({
        baseDirectory: linked!.projectRoot,
        searchService,
      })

      await executor1.executeWithAgent(agent, {
        query: 'test query',
        taskId: 'task-3a',
        worktreeRoot: linked!.worktreeRoot,
      })

      expect(searchService.search.firstCall.args[1]?.scope).to.equal('packages/api')

      // Unlink
      const {unlinkSync} = await import('node:fs')
      unlinkSync(join(workspace, '.brv'))

      // Reset search stub to isolate second executor's calls
      searchService.search.resetHistory()

      // Second: walked-up — unscoped (worktreeRoot === projectRoot)
      const walkedUp = resolveProject({cwd: workspace})
      const executor2 = new QueryExecutor({
        baseDirectory: walkedUp!.projectRoot,
        searchService,
      })

      await executor2.executeWithAgent(agent, {
        query: 'test query',
        taskId: 'task-3b',
        worktreeRoot: walkedUp!.worktreeRoot,
      })

      // First call after reset is the main search — should have no scope
      expect(searchService.search.firstCall.args[1]?.scope).to.be.undefined
    })

    it('should isolate cache fingerprints by worktreeRoot', async () => {
      const projectRoot = join(testDir, 'project')
      mkdirSync(projectRoot, {recursive: true})
      createBrvConfig(projectRoot)

      const fileSystem = makeStubFileSystem(sandbox)
      fileSystem.globFiles.resolves({
        files: [{modified: new Date(), path: 'auth/overview.md'}],
        totalFound: 1,
      })

      // Return non-empty results so OOD short-circuit doesn't fire and LLM is called
      const searchService = makeStubSearchService(sandbox)
      searchService.search.resolves({
        message: 'Found 1 result',
        results: [{excerpt: 'auth overview content', path: 'auth/overview.md', score: 0.5, title: 'Auth Overview'}],
        totalFound: 1,
      })

      const agent = makeStubAgent(sandbox)

      const executor = new QueryExecutor({
        baseDirectory: projectRoot,
        enableCache: true,
        fileSystem,
        searchService,
      })

      // Execute with workspace A
      await executor.executeWithAgent(agent, {
        query: 'auth overview',
        taskId: 'task-4a',
        worktreeRoot: join(projectRoot, 'packages', 'api'),
      })

      // Execute same query with workspace B
      await executor.executeWithAgent(agent, {
        query: 'auth overview',
        taskId: 'task-4b',
        worktreeRoot: join(projectRoot, 'packages', 'web'),
      })

      // Agent should have been called twice (no cross-workspace cache hit)
      expect(agent.executeOnSession.callCount).to.equal(2)
    })
  })

  describe('FolderPackExecutor workspace defaults', () => {
    it('should default folder path to worktreeRoot when omitted', async () => {
      const projectRoot = join(testDir, 'project')
      const workspace = join(projectRoot, 'packages', 'api')
      mkdirSync(workspace, {recursive: true})
      createBrvConfig(projectRoot)
      createWorkspaceLink(workspace, projectRoot)

      const resolution = resolveProject({cwd: workspace})
      const agent = makeStubAgent(sandbox)

      const mockPackResult: FolderPackResult = {
        config: {extractDocuments: false, extractPdfText: false, ignore: [], include: [], includeTree: true, maxFileSize: 1024, maxLinesPerFile: 1000, useGitignore: false},
        directoryTree: 'index.ts',
        durationMs: 10,
        fileCount: 1,
        files: [{content: 'test', fileType: 'code', lineCount: 1, path: 'index.ts', size: 4, truncated: false}],
        rootPath: '/tmp/test',
        skippedCount: 0,
        skippedFiles: [],
        totalCharacters: 4,
        totalLines: 1,
      }

      const folderPackService: IFolderPackService = {
        generateXml: sandbox.stub().returns('<packed_folder></packed_folder>'),
        initialize: sandbox.stub().resolves(),
        pack: sandbox.stub().resolves(mockPackResult),
      }

      const executor = new FolderPackExecutor(folderPackService)

      await executor.executeWithAgent(agent, {
        content: 'curate this',
        projectRoot: resolution!.projectRoot,
        taskId: 'task-5',
        worktreeRoot: resolution!.worktreeRoot,
      })

      // folderPath omitted → pack() called with worktreeRoot
      const packCall = (folderPackService.pack as SinonStub).firstCall
      expect(packCall.args[0]).to.equal(workspace)
    })

    it('should use projectRoot for temp file location', async () => {
      const projectRoot = join(testDir, 'project')
      const workspace = join(projectRoot, 'packages', 'api')
      mkdirSync(workspace, {recursive: true})
      createBrvConfig(projectRoot)

      const agent = makeStubAgent(sandbox)

      const mockPackResult: FolderPackResult = {
        config: {extractDocuments: false, extractPdfText: false, ignore: [], include: [], includeTree: true, maxFileSize: 1024, maxLinesPerFile: 1000, useGitignore: false},
        directoryTree: 'index.ts',
        durationMs: 10,
        fileCount: 1,
        files: [{content: 'test', fileType: 'code', lineCount: 1, path: 'index.ts', size: 4, truncated: false}],
        rootPath: '/tmp/test',
        skippedCount: 0,
        skippedFiles: [],
        totalCharacters: 4,
        totalLines: 1,
      }

      const folderPackService: IFolderPackService = {
        generateXml: sandbox.stub().returns('<packed_folder></packed_folder>'),
        initialize: sandbox.stub().resolves(),
        pack: sandbox.stub().resolves(mockPackResult),
      }

      const executor = new FolderPackExecutor(folderPackService)

      await executor.executeWithAgent(agent, {
        content: 'curate this',
        projectRoot,
        taskId: 'task-6',
        worktreeRoot: workspace,
      })

      // Agent should be called with a prompt containing temp file path under projectRoot
      const prompt = agent.executeOnSession.firstCall.args[1] as string
      expect(prompt).to.include(projectRoot)
    })
  })

  describe('CurateExecutor file path resolution', () => {
    it('should resolve explicit relative --files paths from clientCwd, not worktreeRoot', async () => {
      const projectRoot = join(testDir, 'project')
      const workspace = join(projectRoot, 'packages', 'api')
      const clientCwd = join(workspace, 'src')
      mkdirSync(clientCwd, {recursive: true})
      createBrvConfig(projectRoot)
      createWorkspaceLink(workspace, projectRoot)
      writeFileSync(join(clientCwd, 'auth.ts'), 'export const auth = true\n')

      const resolution = resolveProject({cwd: clientCwd})
      expect(resolution!.worktreeRoot).to.equal(workspace)

      const agent = makeStubAgent(sandbox)
      const readFiles = sandbox.stub().resolves([
        {
          content: 'export const auth = true\n',
          filePath: join(clientCwd, 'auth.ts'),
          fileType: 'text',
          success: true,
        },
      ])
      const fakeReader = {readFiles}
      const executor = new CurateExecutor(fakeReader as never)

      await executor.executeWithAgent(agent, {
        clientCwd,
        content: 'curate auth module',
        files: ['./auth.ts'],
        projectRoot: resolution!.projectRoot,
        taskId: 'task-7',
        worktreeRoot: resolution!.worktreeRoot,
      })

      expect(readFiles.calledOnce).to.be.true
      expect(readFiles.firstCall.args[0]).to.deep.equal([join(clientCwd, 'auth.ts')])
    })
  })
})
