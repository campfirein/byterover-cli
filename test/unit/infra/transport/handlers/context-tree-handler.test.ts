import type {SinonStub} from 'sinon'

import {expect} from 'chai'
import {mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync} from 'node:fs'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import {restore, stub} from 'sinon'

import {ContextTreeEvents} from '../../../../../src/shared/transport/events/context-tree-events.js'
import {createMockTransportServer, type MockTransportServer} from '../../../../helpers/mock-factories.js'

// ==================== Test Helpers ====================

function makeDeps() {
  return {
    contextFileReader: {
      read: stub() as SinonStub,
      readMany: stub() as SinonStub,
    },
    contextTreeService: {
      delete: stub() as SinonStub,
      exists: stub().resolves(false) as SinonStub,
      hasGitRepo: stub().resolves(false) as SinonStub,
      initialize: stub() as SinonStub,
      resolvePath: stub().callsFake((dir: string) => join(dir, '.brv', 'context-tree')) as SinonStub,
    },
    gitService: {
      log: stub().resolves([]) as SinonStub,
    },
  }
}

function makeCommit(sha: string, message: string, name = 'Test User', email = 'test@example.com') {
  return {
    author: {email, name},
    message,
    sha,
    timestamp: new Date('2026-01-15T10:00:00Z'),
  }
}

// ==================== Tests ====================

describe('ContextTreeHandler', () => {
  let deps: ReturnType<typeof makeDeps>
  let resolveProjectPath: SinonStub
  let testDir: string
  let transport: MockTransportServer

  beforeEach(() => {
    deps = makeDeps()
    resolveProjectPath = stub().returns('/project/root')
    transport = createMockTransportServer()
    testDir = realpathSync(mkdtempSync(join(tmpdir(), 'brv-context-tree-handler-')))
    stub(console, 'error')
  })

  afterEach(() => {
    restore()
    rmSync(testDir, {force: true, recursive: true})
  })

  // Lazily import handler to avoid ESM issues
  async function createHandler(projectPath?: string) {
    if (projectPath) {
      resolveProjectPath = stub().returns(projectPath)
      deps.contextTreeService.resolvePath.callsFake((dir: string) => join(dir, '.brv', 'context-tree'))
    }

    const {ContextTreeHandler} = await import(
      '../../../../../src/server/infra/transport/handlers/context-tree-handler.js'
    )
    const handler = new ContextTreeHandler({
      contextFileReader: deps.contextFileReader,
      contextTreeService: deps.contextTreeService,
      gitService: deps.gitService,
      resolveProjectPath,
      transport,
    })
    handler.setup()
    return handler
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  async function callHandler(event: string, data?: any, clientId = 'client-1'): Promise<any> {
    const handler = transport._handlers.get(event)
    expect(handler, `${event} handler should be registered`).to.exist
    return handler!(data, clientId)
  }

  describe('setup', () => {
    it('should register all four event handlers', async () => {
      await createHandler()
      expect(transport._handlers.has(ContextTreeEvents.GET_NODES)).to.be.true
      expect(transport._handlers.has(ContextTreeEvents.GET_FILE)).to.be.true
      expect(transport._handlers.has(ContextTreeEvents.UPDATE_FILE)).to.be.true
      expect(transport._handlers.has(ContextTreeEvents.GET_HISTORY)).to.be.true
    })
  })

  describe('projectPath override', () => {
    it('should use projectPath from request instead of client registration', async () => {
      const overridePath = join(testDir, 'override-project')
      const ctDir = join(overridePath, '.brv', 'context-tree')
      mkdirSync(ctDir, {recursive: true})
      writeFileSync(join(ctDir, 'override.md'), 'from override')

      await createHandler('/default/project')
      const result = await callHandler(ContextTreeEvents.GET_NODES, {projectPath: overridePath})

      expect(result.nodes).to.have.length(1)
      expect(result.nodes[0].name).to.equal('override.md')
    })
  })

  describe('GET_NODES', () => {
    it('should return empty nodes when context tree directory does not exist', async () => {
      const projectPath = join(testDir, 'no-project')
      mkdirSync(projectPath, {recursive: true})
      await createHandler(projectPath)

      const result = await callHandler(ContextTreeEvents.GET_NODES)
      expect(result.nodes).to.deep.equal([])
      expect(result.branch).to.be.a('string')
    })

    it('should return tree structure from context tree directory', async () => {
      const projectPath = testDir
      const ctDir = join(projectPath, '.brv', 'context-tree')
      mkdirSync(join(ctDir, 'architecture'), {recursive: true})
      writeFileSync(join(ctDir, 'architecture', 'auth.md'), '# Auth\nContent here')
      writeFileSync(join(ctDir, 'patterns.md'), '# Patterns\nContent here')

      await createHandler(projectPath)
      const result = await callHandler(ContextTreeEvents.GET_NODES)

      expect(result.nodes).to.have.length(2)

      // Folders first, then files (sorted)
      const folder = result.nodes.find((n: {name: string}) => n.name === 'architecture')
      const file = result.nodes.find((n: {name: string}) => n.name === 'patterns.md')

      expect(folder).to.exist
      expect(folder.type).to.equal('tree')
      expect(folder.path).to.equal('architecture')
      expect(folder.children).to.have.length(1)
      expect(folder.children[0].name).to.equal('auth.md')
      expect(folder.children[0].type).to.equal('blob')
      expect(folder.children[0].path).to.equal('architecture/auth.md')

      expect(file).to.exist
      expect(file.type).to.equal('blob')
      expect(file.path).to.equal('patterns.md')
    })

    it('should sort folders before files, then alphabetically', async () => {
      const projectPath = testDir
      const ctDir = join(projectPath, '.brv', 'context-tree')
      mkdirSync(join(ctDir, 'zebra'), {recursive: true})
      mkdirSync(join(ctDir, 'alpha'), {recursive: true})
      writeFileSync(join(ctDir, 'zebra', 'z.md'), 'z')
      writeFileSync(join(ctDir, 'alpha', 'a.md'), 'a')
      writeFileSync(join(ctDir, 'middle.md'), 'middle')
      writeFileSync(join(ctDir, 'aaa.md'), 'aaa')

      await createHandler(projectPath)
      const result = await callHandler(ContextTreeEvents.GET_NODES)

      const names = result.nodes.map((n: {name: string}) => n.name)
      expect(names).to.deep.equal(['alpha', 'zebra', 'aaa.md', 'middle.md'])
    })

    it('should skip .snapshot.json', async () => {
      const projectPath = testDir
      const ctDir = join(projectPath, '.brv', 'context-tree')
      mkdirSync(ctDir, {recursive: true})
      writeFileSync(join(ctDir, '.snapshot.json'), '{}')
      writeFileSync(join(ctDir, 'real.md'), 'content')

      await createHandler(projectPath)
      const result = await callHandler(ContextTreeEvents.GET_NODES)

      expect(result.nodes).to.have.length(1)
      expect(result.nodes[0].name).to.equal('real.md')
    })

    it('should skip _archived directory', async () => {
      const projectPath = testDir
      const ctDir = join(projectPath, '.brv', 'context-tree')
      mkdirSync(join(ctDir, '_archived'), {recursive: true})
      writeFileSync(join(ctDir, '_archived', 'old.stub.md'), 'stub')
      writeFileSync(join(ctDir, 'real.md'), 'content')

      await createHandler(projectPath)
      const result = await callHandler(ContextTreeEvents.GET_NODES)

      expect(result.nodes).to.have.length(1)
      expect(result.nodes[0].name).to.equal('real.md')
    })

    it('should skip _index.md and _manifest.json', async () => {
      const projectPath = testDir
      const ctDir = join(projectPath, '.brv', 'context-tree')
      mkdirSync(ctDir, {recursive: true})
      writeFileSync(join(ctDir, '_index.md'), 'index')
      writeFileSync(join(ctDir, '_manifest.json'), '{}')
      writeFileSync(join(ctDir, 'real.md'), 'content')

      await createHandler(projectPath)
      const result = await callHandler(ContextTreeEvents.GET_NODES)

      expect(result.nodes).to.have.length(1)
      expect(result.nodes[0].name).to.equal('real.md')
    })

    it('should skip .git directory and .gitignore file', async () => {
      const projectPath = testDir
      const ctDir = join(projectPath, '.brv', 'context-tree')
      mkdirSync(join(ctDir, '.git'), {recursive: true})
      writeFileSync(join(ctDir, '.git', 'HEAD'), 'ref: refs/heads/main')
      writeFileSync(join(ctDir, '.gitignore'), '*.tmp')
      writeFileSync(join(ctDir, 'real.md'), 'content')

      await createHandler(projectPath)
      const result = await callHandler(ContextTreeEvents.GET_NODES)

      expect(result.nodes).to.have.length(1)
      expect(result.nodes[0].name).to.equal('real.md')
    })

    it('should skip root README.md but keep README.md in subdirectories', async () => {
      const projectPath = testDir
      const ctDir = join(projectPath, '.brv', 'context-tree')
      mkdirSync(join(ctDir, 'docs'), {recursive: true})
      writeFileSync(join(ctDir, 'README.md'), 'root readme')
      writeFileSync(join(ctDir, 'docs', 'README.md'), 'docs readme')

      await createHandler(projectPath)
      const result = await callHandler(ContextTreeEvents.GET_NODES)

      expect(result.nodes).to.have.length(1)
      expect(result.nodes[0].name).to.equal('docs')
      expect(result.nodes[0].children).to.have.length(1)
      expect(result.nodes[0].children[0].name).to.equal('README.md')
    })

    it('should handle nested directories', async () => {
      const projectPath = testDir
      const ctDir = join(projectPath, '.brv', 'context-tree')
      mkdirSync(join(ctDir, 'a', 'b', 'c'), {recursive: true})
      writeFileSync(join(ctDir, 'a', 'b', 'c', 'deep.md'), 'deep content')

      await createHandler(projectPath)
      const result = await callHandler(ContextTreeEvents.GET_NODES)

      expect(result.nodes).to.have.length(1)
      expect(result.nodes[0].name).to.equal('a')
      expect(result.nodes[0].children[0].name).to.equal('b')
      expect(result.nodes[0].children[0].children[0].name).to.equal('c')
      expect(result.nodes[0].children[0].children[0].children[0].name).to.equal('deep.md')
    })

    it('should skip empty directories', async () => {
      const projectPath = testDir
      const ctDir = join(projectPath, '.brv', 'context-tree')
      mkdirSync(join(ctDir, 'empty-folder'), {recursive: true})
      writeFileSync(join(ctDir, 'real.md'), 'content')

      await createHandler(projectPath)
      const result = await callHandler(ContextTreeEvents.GET_NODES)

      expect(result.nodes).to.have.length(1)
      expect(result.nodes[0].name).to.equal('real.md')
    })
  })

  describe('GET_FILE', () => {
    it('should return file content using contextFileReader', async () => {
      deps.contextFileReader.read.resolves({
        content: '---\ntitle: Auth\ntags: [security]\n---\n# Auth\nContent',
        keywords: [],
        path: 'auth.md',
        tags: ['security'],
        title: 'Auth',
      })

      await createHandler()
      const result = await callHandler(ContextTreeEvents.GET_FILE, {path: 'auth.md'})

      expect(result.file).to.deep.equal({
        content: '---\ntitle: Auth\ntags: [security]\n---\n# Auth\nContent',
        path: 'auth.md',
        tags: ['security'],
        title: 'Auth',
      })
    })

    it('should throw when file is not found', async () => {
      deps.contextFileReader.read.resolves()

      await createHandler()

      try {
        await callHandler(ContextTreeEvents.GET_FILE, {path: 'nonexistent.md'})
        expect.fail('should have thrown')
      } catch (error) {
        expect((error as Error).message).to.include('not found')
      }
    })

    it('should pass project path to contextFileReader', async () => {
      const projectPath = '/my/project'
      deps.contextFileReader.read.resolves({
        content: 'content',
        keywords: [],
        path: 'test.md',
        tags: [],
        title: 'Test',
      })

      await createHandler(projectPath)
      await callHandler(ContextTreeEvents.GET_FILE, {path: 'test.md'})

      expect(deps.contextFileReader.read.calledWith('test.md', projectPath)).to.be.true
    })
  })

  describe('UPDATE_FILE', () => {
    it('should write content to the correct file path', async () => {
      const projectPath = testDir
      const ctDir = join(projectPath, '.brv', 'context-tree')
      mkdirSync(ctDir, {recursive: true})
      writeFileSync(join(ctDir, 'existing.md'), 'old content')

      await createHandler(projectPath)
      const result = await callHandler(ContextTreeEvents.UPDATE_FILE, {
        content: 'new content',
        path: 'existing.md',
      })

      expect(result.success).to.be.true

      // Verify file was actually written
      const {readFileSync} = await import('node:fs')
      const written = readFileSync(join(ctDir, 'existing.md'), 'utf8')
      expect(written).to.equal('new content')
    })

    it('should create parent directories if needed', async () => {
      const projectPath = testDir
      const ctDir = join(projectPath, '.brv', 'context-tree')
      mkdirSync(ctDir, {recursive: true})

      await createHandler(projectPath)
      const result = await callHandler(ContextTreeEvents.UPDATE_FILE, {
        content: 'new file content',
        path: 'new-folder/new-file.md',
      })

      expect(result.success).to.be.true

      const {readFileSync} = await import('node:fs')
      const written = readFileSync(join(ctDir, 'new-folder', 'new-file.md'), 'utf8')
      expect(written).to.equal('new file content')
    })

    it('should reject path traversal attempts', async () => {
      const projectPath = testDir
      const ctDir = join(projectPath, '.brv', 'context-tree')
      mkdirSync(ctDir, {recursive: true})

      await createHandler(projectPath)

      try {
        await callHandler(ContextTreeEvents.UPDATE_FILE, {
          content: 'malicious',
          path: '../../../etc/passwd',
        })
        expect.fail('should have thrown')
      } catch (error) {
        expect((error as Error).message).to.include('traversal')
      }
    })
  })

  describe('GET_HISTORY', () => {

    it('should register the handler', async () => {
      await createHandler()
      expect(transport._handlers.has(ContextTreeEvents.GET_HISTORY)).to.be.true
    })

    it('should return commits from gitService.log', async () => {
      deps.gitService.log.resolves([
        makeCommit('abc123', 'first commit'),
        makeCommit('def456', 'second commit'),
      ])

      await createHandler()
      const result = await callHandler(ContextTreeEvents.GET_HISTORY, {path: 'auth.md'})

      expect(result.commits).to.have.length(2)
      expect(result.commits[0].sha).to.equal('abc123')
      expect(result.commits[0].message).to.equal('first commit')
      expect(result.commits[0].timestamp).to.be.a('string')
      expect(result.hasMore).to.be.false
    })

    it('should pass filepath to gitService.log', async () => {
      deps.gitService.log.resolves([])

      await createHandler('/my/project')
      await callHandler(ContextTreeEvents.GET_HISTORY, {path: 'docs/auth.md'})

      const logCall = deps.gitService.log.firstCall.args[0]
      expect(logCall.filepath).to.equal('docs/auth.md')
    })

    it('should handle pagination with limit', async () => {
      const commits = Array.from({length: 6}, (_, i) => makeCommit(`sha${i}`, `commit ${i}`))
      deps.gitService.log.resolves(commits)

      await createHandler()
      const result = await callHandler(ContextTreeEvents.GET_HISTORY, {limit: 5, path: 'test.md'})

      expect(result.commits).to.have.length(5)
      expect(result.hasMore).to.be.true
      expect(result.nextCursor).to.equal('sha4')
    })

    it('should return hasMore false when commits fit in limit', async () => {
      deps.gitService.log.resolves([
        makeCommit('abc', 'only one'),
      ])

      await createHandler()
      const result = await callHandler(ContextTreeEvents.GET_HISTORY, {limit: 10, path: 'test.md'})

      expect(result.commits).to.have.length(1)
      expect(result.hasMore).to.be.false
      expect(result.nextCursor).to.be.undefined
    })

    it('should handle cursor-based pagination', async () => {
      const commits = Array.from({length: 4}, (_, i) => makeCommit(`sha${i}`, `commit ${i}`))
      deps.gitService.log.resolves(commits)

      await createHandler()
      await callHandler(ContextTreeEvents.GET_HISTORY, {
        cursor: 'prev-sha',
        limit: 3,
        path: 'test.md',
      })

      // With cursor, first result is the cursor commit itself — should be skipped
      const logCall = deps.gitService.log.firstCall.args[0]
      expect(logCall.ref).to.equal('prev-sha')
      // depth = limit + 2 (1 for cursor skip + 1 for hasMore check)
      expect(logCall.depth).to.equal(5)
    })

    it('should return empty when no commits exist', async () => {
      deps.gitService.log.resolves([])

      await createHandler()
      const result = await callHandler(ContextTreeEvents.GET_HISTORY, {path: 'test.md'})

      expect(result.commits).to.deep.equal([])
      expect(result.hasMore).to.be.false
    })
  })

  describe('GET_FILE_METADATA', () => {
    it('should return metadata for requested file paths', async () => {
      const commitDate = new Date('2026-04-10T12:00:00Z')
      deps.gitService.log.resolves([{
        author: {email: 'alice@test.com', name: 'Alice'},
        message: 'update',
        sha: 'abc123',
        timestamp: commitDate,
      }])

      await createHandler()
      const result = await callHandler(ContextTreeEvents.GET_FILE_METADATA, {
        paths: ['auth.md', 'patterns.md'],
      })

      expect(result.files).to.have.length(2)
      expect(result.files[0].path).to.equal('auth.md')
      expect(result.files[0].lastUpdatedBy).to.equal('Alice')
      expect(result.files[0].lastUpdatedWhen).to.equal(commitDate.toISOString())
      expect(result.files[1].path).to.equal('patterns.md')
    })

    it('should return path only when git has no commits', async () => {
      deps.gitService.log.resolves([])

      await createHandler()
      const result = await callHandler(ContextTreeEvents.GET_FILE_METADATA, {
        paths: ['file.md'],
      })

      expect(result.files[0].path).to.equal('file.md')
      expect(result.files[0].lastUpdatedBy).to.be.undefined
      expect(result.files[0].lastUpdatedWhen).to.be.undefined
    })

    it('should handle git errors gracefully', async () => {
      deps.gitService.log.rejects(new Error('git error'))

      await createHandler()
      const result = await callHandler(ContextTreeEvents.GET_FILE_METADATA, {
        paths: ['file.md'],
      })

      expect(result.files[0].path).to.equal('file.md')
      expect(result.files[0].lastUpdatedBy).to.be.undefined
    })

    it('should pass folder paths to gitService.log unchanged', async () => {
      deps.gitService.log.resolves([])

      await createHandler()
      await callHandler(ContextTreeEvents.GET_FILE_METADATA, {
        paths: ['architecture', 'testing'],
      })

      const filepaths = deps.gitService.log.getCalls().map((c) => c.args[0].filepath)
      expect(filepaths).to.have.members(['architecture', 'testing'])
    })

    it('should return folder metadata from the latest tree-touching commit', async () => {
      const commitDate = new Date('2026-04-15T09:00:00Z')
      deps.gitService.log.resolves([{
        author: {email: 'bob@test.com', name: 'Bob'},
        message: 'update folder',
        sha: 'def456',
        timestamp: commitDate,
      }])

      await createHandler()
      const result = await callHandler(ContextTreeEvents.GET_FILE_METADATA, {
        paths: ['authentication'],
      })

      expect(result.files).to.have.length(1)
      expect(result.files[0].path).to.equal('authentication')
      expect(result.files[0].lastUpdatedBy).to.equal('Bob')
      expect(result.files[0].lastUpdatedWhen).to.equal(commitDate.toISOString())
    })

    it('should accept a mix of file and folder paths in one request', async () => {
      deps.gitService.log.callsFake(async ({filepath}: {filepath: string}) => [{
        author: {email: 'carol@test.com', name: `Carol-${filepath}`},
        message: `update ${filepath}`,
        sha: 'xyz789',
        timestamp: new Date('2026-05-01T00:00:00Z'),
      }])

      await createHandler()
      const result = await callHandler(ContextTreeEvents.GET_FILE_METADATA, {
        paths: ['architecture', 'patterns.md', 'testing/integration.md'],
      })

      expect(result.files).to.have.length(3)
      const byPath = new Map(
        result.files.map((f: {lastUpdatedBy: string; path: string}) => [f.path, f.lastUpdatedBy]),
      )
      expect(byPath.get('architecture')).to.equal('Carol-architecture')
      expect(byPath.get('patterns.md')).to.equal('Carol-patterns.md')
      expect(byPath.get('testing/integration.md')).to.equal('Carol-testing/integration.md')
    })
  })
})
