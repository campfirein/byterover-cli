/**
 * ToolsSDK Unit Tests
 *
 * Tests the ToolsSDK factory function that provides file system operations
 * for sandbox code execution.
 *
 * Key scenarios:
 * - Each method delegates correctly to IFileSystem
 * - Options are passed through with correct defaults
 * - searchKnowledge handles missing service gracefully
 */

import {expect} from 'chai'
import {mkdirSync, mkdtempSync, rmSync, writeFileSync} from 'node:fs'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import {createSandbox, type SinonSandbox, type SinonStub} from 'sinon'

import type {IFileSystem} from '../../../../src/agent/core/interfaces/i-file-system.js'
import type {ISearchKnowledgeService} from '../../../../src/agent/infra/sandbox/tools-sdk.js'

import {createToolsSDK} from '../../../../src/agent/infra/sandbox/tools-sdk.js'

describe('ToolsSDK', () => {
  let sandbox: SinonSandbox
  let tempDir: string
  let mockFileSystem: {
    editFile: SinonStub
    globFiles: SinonStub
    initialize: SinonStub
    listDirectory: SinonStub
    readFile: SinonStub
    searchContent: SinonStub
    writeFile: SinonStub
  }
  let mockSearchKnowledgeService: {
    search: SinonStub
  }

  beforeEach(() => {
    sandbox = createSandbox()
    tempDir = mkdtempSync(join(tmpdir(), 'brv-tools-sdk-'))

    mockFileSystem = {
      editFile: sandbox.stub(),
      globFiles: sandbox.stub(),
      initialize: sandbox.stub(),
      listDirectory: sandbox.stub(),
      readFile: sandbox.stub(),
      searchContent: sandbox.stub(),
      writeFile: sandbox.stub(),
    }

    mockSearchKnowledgeService = {
      search: sandbox.stub(),
    }
  })

  afterEach(() => {
    sandbox.restore()
    rmSync(tempDir, {force: true, recursive: true})
  })

  describe('createToolsSDK', () => {
    it('should return an object with all required methods', () => {
      const sdk = createToolsSDK({fileSystem: mockFileSystem as unknown as IFileSystem})

      expect(sdk).to.have.property('glob').that.is.a('function')
      expect(sdk).to.have.property('grep').that.is.a('function')
      expect(sdk).to.have.property('listDirectory').that.is.a('function')
      expect(sdk).to.have.property('readFile').that.is.a('function')
      expect(sdk).to.have.property('writeFile').that.is.a('function')
      expect(sdk).to.have.property('searchKnowledge').that.is.a('function')
    })
  })

  describe('glob', () => {
    it('should delegate to fileSystem.globFiles with correct options', async () => {
      const expectedResult = {files: [{path: 'src/index.ts'}], totalFound: 1, truncated: false}
      mockFileSystem.globFiles.resolves(expectedResult)

      const sdk = createToolsSDK({fileSystem: mockFileSystem as unknown as IFileSystem})
      const result = await sdk.glob('**/*.ts', {maxResults: 10, path: '/project'})

      expect(result).to.deep.equal(expectedResult)
      expect(mockFileSystem.globFiles.calledOnce).to.be.true
      expect(mockFileSystem.globFiles.firstCall.args[0]).to.equal('**/*.ts')
      expect(mockFileSystem.globFiles.firstCall.args[1]).to.deep.include({
        caseSensitive: true,
        cwd: '/project',
        includeMetadata: true,
        maxResults: 10,
        respectGitignore: true,
      })
    })

    it('should use default options when not provided', async () => {
      mockFileSystem.globFiles.resolves({files: [], totalFound: 0, truncated: false})

      const sdk = createToolsSDK({fileSystem: mockFileSystem as unknown as IFileSystem})
      await sdk.glob('*.js')

      expect(mockFileSystem.globFiles.firstCall.args[1]).to.deep.include({
        caseSensitive: true,
        maxResults: 1000,
        respectGitignore: true,
      })
    })

    it('should pass caseSensitive option correctly', async () => {
      mockFileSystem.globFiles.resolves({files: [], totalFound: 0, truncated: false})

      const sdk = createToolsSDK({fileSystem: mockFileSystem as unknown as IFileSystem})
      await sdk.glob('*.js', {caseSensitive: false})

      expect(mockFileSystem.globFiles.firstCall.args[1]).to.deep.include({
        caseSensitive: false,
      })
    })
  })

  describe('grep', () => {
    it('should delegate to fileSystem.searchContent with correct options', async () => {
      const expectedResult = {matches: [], totalMatches: 0, truncated: false}
      mockFileSystem.searchContent.resolves(expectedResult)

      const sdk = createToolsSDK({fileSystem: mockFileSystem as unknown as IFileSystem})
      const result = await sdk.grep('function', {
        caseInsensitive: true,
        contextLines: 2,
        glob: '*.ts',
        maxResults: 50,
        path: '/src',
      })

      expect(result).to.deep.equal(expectedResult)
      expect(mockFileSystem.searchContent.calledOnce).to.be.true
      expect(mockFileSystem.searchContent.firstCall.args[0]).to.equal('function')
      expect(mockFileSystem.searchContent.firstCall.args[1]).to.deep.include({
        caseInsensitive: true,
        contextLines: 2,
        cwd: '/src',
        globPattern: '*.ts',
        maxResults: 50,
      })
    })

    it('should use default options when not provided', async () => {
      mockFileSystem.searchContent.resolves({matches: [], totalMatches: 0, truncated: false})

      const sdk = createToolsSDK({fileSystem: mockFileSystem as unknown as IFileSystem})
      await sdk.grep('class')

      expect(mockFileSystem.searchContent.firstCall.args[1]).to.deep.include({
        caseInsensitive: false,
        contextLines: 0,
        maxResults: 100,
      })
    })
  })

  describe('listDirectory', () => {
    it('should delegate to fileSystem.listDirectory with correct options', async () => {
      const expectedResult = {files: [], tree: '', truncated: false}
      mockFileSystem.listDirectory.resolves(expectedResult)

      const sdk = createToolsSDK({fileSystem: mockFileSystem as unknown as IFileSystem})
      const result = await sdk.listDirectory('/project', {
        ignore: ['node_modules'],
        maxResults: 50,
      })

      expect(result).to.deep.equal(expectedResult)
      expect(mockFileSystem.listDirectory.calledOnce).to.be.true
      expect(mockFileSystem.listDirectory.firstCall.args[0]).to.equal('/project')
      expect(mockFileSystem.listDirectory.firstCall.args[1]).to.deep.include({
        ignore: ['node_modules'],
        maxResults: 50,
      })
    })

    it('should default to current directory when path not provided', async () => {
      mockFileSystem.listDirectory.resolves({files: [], tree: '', truncated: false})

      const sdk = createToolsSDK({fileSystem: mockFileSystem as unknown as IFileSystem})
      await sdk.listDirectory()

      expect(mockFileSystem.listDirectory.firstCall.args[0]).to.equal('.')
      expect(mockFileSystem.listDirectory.firstCall.args[1]).to.deep.include({
        maxResults: 100,
      })
    })
  })

  describe('readFile', () => {
    it('should delegate to fileSystem.readFile with correct options', async () => {
      const expectedResult = {content: 'file content', exists: true, path: '/file.ts'}
      mockFileSystem.readFile.resolves(expectedResult)

      const sdk = createToolsSDK({fileSystem: mockFileSystem as unknown as IFileSystem})
      const result = await sdk.readFile('/project/file.ts', {limit: 100, offset: 10})

      expect(result).to.deep.equal(expectedResult)
      expect(mockFileSystem.readFile.calledOnce).to.be.true
      expect(mockFileSystem.readFile.firstCall.args[0]).to.equal('/project/file.ts')
      expect(mockFileSystem.readFile.firstCall.args[1]).to.deep.include({
        limit: 100,
        offset: 10,
      })
    })

    it('should work without options', async () => {
      mockFileSystem.readFile.resolves({content: 'data', exists: true, path: '/file.ts'})

      const sdk = createToolsSDK({fileSystem: mockFileSystem as unknown as IFileSystem})
      await sdk.readFile('/file.ts')

      expect(mockFileSystem.readFile.calledOnce).to.be.true
      expect(mockFileSystem.readFile.firstCall.args[1]).to.deep.include({
        limit: undefined,
        offset: undefined,
      })
    })
  })

  describe('writeFile', () => {
    it('should delegate to fileSystem.writeFile with correct options', async () => {
      const expectedResult = {bytesWritten: 12, path: '/output.txt'}
      mockFileSystem.writeFile.resolves(expectedResult)

      const sdk = createToolsSDK({fileSystem: mockFileSystem as unknown as IFileSystem})
      const result = await sdk.writeFile('/output.txt', 'file content', {createDirs: true})

      expect(result).to.deep.equal(expectedResult)
      expect(mockFileSystem.writeFile.calledOnce).to.be.true
      expect(mockFileSystem.writeFile.firstCall.args[0]).to.equal('/output.txt')
      expect(mockFileSystem.writeFile.firstCall.args[1]).to.equal('file content')
      expect(mockFileSystem.writeFile.firstCall.args[2]).to.deep.include({
        createDirs: true,
      })
    })

    it('should default createDirs to false', async () => {
      mockFileSystem.writeFile.resolves({bytesWritten: 4, path: '/file.txt'})

      const sdk = createToolsSDK({fileSystem: mockFileSystem as unknown as IFileSystem})
      await sdk.writeFile('/file.txt', 'data')

      expect(mockFileSystem.writeFile.firstCall.args[2]).to.deep.include({
        createDirs: false,
      })
    })

    it('should reject writes outside the local context tree when projectRoot is provided', async () => {
      mkdirSync(join(tempDir, '.brv', 'context-tree'), {recursive: true})
      writeFileSync(join(tempDir, '.brv', 'config.json'), JSON.stringify({version: '0.0.1'}))

      const sdk = createToolsSDK({
        fileSystem: mockFileSystem as unknown as IFileSystem,
        projectRoot: tempDir,
      })

      try {
        await sdk.writeFile(join(tempDir, 'notes.md'), 'data')
        expect.fail('Should have thrown')
      } catch (error) {
        expect(error).to.be.instanceOf(Error)
        expect((error as Error).message).to.include('outside the local context tree')
      }

      expect(mockFileSystem.writeFile.called).to.be.false
    })
  })

  describe('searchKnowledge', () => {
    it('should delegate to searchKnowledgeService when available', async () => {
      const expectedResult = {
        message: 'Found 2 results',
        results: [
          {excerpt: 'Auth design...', path: 'auth.md', score: 0.95, title: 'Authentication'},
        ],
        totalFound: 2,
      }
      mockSearchKnowledgeService.search.resolves(expectedResult)

      const sdk = createToolsSDK({
        fileSystem: mockFileSystem as unknown as IFileSystem,
        searchKnowledgeService: mockSearchKnowledgeService as unknown as ISearchKnowledgeService,
      })
      const result = await sdk.searchKnowledge('authentication', {limit: 5})

      expect(result).to.deep.equal(expectedResult)
      expect(mockSearchKnowledgeService.search.calledOnce).to.be.true
      expect(mockSearchKnowledgeService.search.firstCall.args[0]).to.equal('authentication')
      expect(mockSearchKnowledgeService.search.firstCall.args[1]).to.deep.equal({limit: 5})
    })

    it('should return empty result when service not available', async () => {
      const sdk = createToolsSDK({fileSystem: mockFileSystem as unknown as IFileSystem})
      const result = await sdk.searchKnowledge('test query')

      expect(result).to.deep.equal({
        message: 'Search knowledge service not available.',
        results: [],
        totalFound: 0,
      })
    })

    it('should work without options', async () => {
      mockSearchKnowledgeService.search.resolves({
        message: 'Found 0 results',
        results: [],
        totalFound: 0,
      })

      const sdk = createToolsSDK({
        fileSystem: mockFileSystem as unknown as IFileSystem,
        searchKnowledgeService: mockSearchKnowledgeService as unknown as ISearchKnowledgeService,
      })
      await sdk.searchKnowledge('query')

      expect(mockSearchKnowledgeService.search.firstCall.args[1]).to.be.undefined
    })
  })

  describe('Error Handling', () => {
    it('should propagate errors from fileSystem.globFiles', async () => {
      const error = new Error('Permission denied')
      mockFileSystem.globFiles.rejects(error)

      const sdk = createToolsSDK({fileSystem: mockFileSystem as unknown as IFileSystem})

      try {
        await sdk.glob('**/*')
        expect.fail('Should have thrown')
      } catch (error_) {
        expect(error_).to.equal(error)
      }
    })

    it('should propagate errors from fileSystem.readFile', async () => {
      const error = new Error('File not found')
      mockFileSystem.readFile.rejects(error)

      const sdk = createToolsSDK({fileSystem: mockFileSystem as unknown as IFileSystem})

      try {
        await sdk.readFile('/nonexistent.ts')
        expect.fail('Should have thrown')
      } catch (error_) {
        expect(error_).to.equal(error)
      }
    })

    it('should propagate errors from searchKnowledgeService', async () => {
      const error = new Error('Index not initialized')
      mockSearchKnowledgeService.search.rejects(error)

      const sdk = createToolsSDK({
        fileSystem: mockFileSystem as unknown as IFileSystem,
        searchKnowledgeService: mockSearchKnowledgeService as unknown as ISearchKnowledgeService,
      })

      try {
        await sdk.searchKnowledge('test')
        expect.fail('Should have thrown')
      } catch (error_) {
        expect(error_).to.equal(error)
      }
    })
  })
})
