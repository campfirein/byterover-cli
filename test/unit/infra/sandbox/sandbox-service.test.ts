/**
 * SandboxService Unit Tests
 *
 * Tests the SandboxService class for managing sandbox instances per session.
 *
 * Key scenarios:
 * - Session-based sandbox management
 * - File system service injection via setFileSystem
 * - Search knowledge service injection via setSearchKnowledgeService
 * - Tools are available after services are set
 * - Sandbox state isolation between sessions
 */

import {expect} from 'chai'
import {createSandbox, type SinonSandbox, type SinonStub} from 'sinon'

import type {ICurateService} from '../../../../src/agent/core/interfaces/i-curate-service.js'
import type {IFileSystem} from '../../../../src/agent/core/interfaces/i-file-system.js'
import type {ISearchKnowledgeService} from '../../../../src/agent/infra/sandbox/tools-sdk.js'

import {SandboxService} from '../../../../src/agent/infra/sandbox/sandbox-service.js'

describe('SandboxService', () => {
  let sandbox: SinonSandbox
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

    mockFileSystem = {
      editFile: sandbox.stub(),
      globFiles: sandbox.stub().resolves({files: [], totalFound: 0, truncated: false}),
      initialize: sandbox.stub(),
      listDirectory: sandbox.stub().resolves({files: [], tree: '', truncated: false}),
      readFile: sandbox.stub().resolves({content: 'test', exists: true, path: '/test.ts'}),
      searchContent: sandbox.stub().resolves({matches: [], totalMatches: 0, truncated: false}),
      writeFile: sandbox.stub().resolves({bytesWritten: 4, path: '/test.txt'}),
    }

    mockSearchKnowledgeService = {
      search: sandbox.stub().resolves({
        message: 'Found 0 results',
        results: [],
        totalFound: 0,
      }),
    }
  })

  afterEach(() => {
    sandbox.restore()
  })

  describe('Session Management', () => {
    it('should create separate sandboxes for different sessions', async () => {
      const service = new SandboxService()
      service.setFileSystem(mockFileSystem as unknown as IFileSystem)

      // Set variable in session 1
      await service.executeCode('var sessionId = "session1"', 'session1')

      // Set different variable in session 2
      await service.executeCode('var sessionId = "session2"', 'session2')

      // Verify each session has its own state
      const result1 = await service.executeCode('sessionId', 'session1')
      const result2 = await service.executeCode('sessionId', 'session2')

      expect(result1.returnValue).to.equal('session1')
      expect(result2.returnValue).to.equal('session2')
    })

    it('should persist state within the same session', async () => {
      const service = new SandboxService()
      service.setFileSystem(mockFileSystem as unknown as IFileSystem)

      await service.executeCode('var counter = 0', 'session1')
      await service.executeCode('counter++', 'session1')
      await service.executeCode('counter++', 'session1')
      const result = await service.executeCode('counter', 'session1')

      expect(result.returnValue).to.equal(2)
    })

    it('should clear session state on clearSession', async () => {
      const service = new SandboxService()
      service.setFileSystem(mockFileSystem as unknown as IFileSystem)

      await service.executeCode('var data = "important"', 'session1')
      await service.clearSession('session1')

      // New execution should not have the old variable
      const result = await service.executeCode('typeof data', 'session1')
      expect(result.returnValue).to.equal('undefined')
    })

    it('should clear all sessions on cleanup', async () => {
      const service = new SandboxService()
      service.setFileSystem(mockFileSystem as unknown as IFileSystem)

      await service.executeCode('var x = 1', 'session1')
      await service.executeCode('var y = 2', 'session2')

      await service.cleanup()

      // Both sessions should be fresh
      const result1 = await service.executeCode('typeof x', 'session1')
      const result2 = await service.executeCode('typeof y', 'session2')

      expect(result1.returnValue).to.equal('undefined')
      expect(result2.returnValue).to.equal('undefined')
    })
  })

  describe('setFileSystem', () => {
    it('should make tools available after setFileSystem is called', async () => {
      const service = new SandboxService()
      service.setFileSystem(mockFileSystem as unknown as IFileSystem)

      const result = await service.executeCode('typeof tools', 'session1')

      expect(result.returnValue).to.equal('object')
    })

    it('should have tools.glob available', async () => {
      const service = new SandboxService()
      service.setFileSystem(mockFileSystem as unknown as IFileSystem)

      const result = await service.executeCode('typeof tools.glob', 'session1')

      expect(result.returnValue).to.equal('function')
    })

    it('should have tools.readFile available', async () => {
      const service = new SandboxService()
      service.setFileSystem(mockFileSystem as unknown as IFileSystem)

      const result = await service.executeCode('typeof tools.readFile', 'session1')

      expect(result.returnValue).to.equal('function')
    })

    it('should have tools.writeFile available', async () => {
      const service = new SandboxService()
      service.setFileSystem(mockFileSystem as unknown as IFileSystem)

      const result = await service.executeCode('typeof tools.writeFile', 'session1')

      expect(result.returnValue).to.equal('function')
    })

    it('should have tools.grep available', async () => {
      const service = new SandboxService()
      service.setFileSystem(mockFileSystem as unknown as IFileSystem)

      const result = await service.executeCode('typeof tools.grep', 'session1')

      expect(result.returnValue).to.equal('function')
    })

    it('should have tools.listDirectory available', async () => {
      const service = new SandboxService()
      service.setFileSystem(mockFileSystem as unknown as IFileSystem)

      const result = await service.executeCode('typeof tools.listDirectory', 'session1')

      expect(result.returnValue).to.equal('function')
    })

    it('should clear existing sandboxes when setFileSystem is called', async () => {
      const service = new SandboxService()
      service.setFileSystem(mockFileSystem as unknown as IFileSystem)

      await service.executeCode('var oldData = "exists"', 'session1')

      // Setting file system again clears sandboxes
      service.setFileSystem(mockFileSystem as unknown as IFileSystem)

      const result = await service.executeCode('typeof oldData', 'session1')
      expect(result.returnValue).to.equal('undefined')
    })
  })

  describe('setSearchKnowledgeService', () => {
    it('should make tools.searchKnowledge functional after service is set', async () => {
      const service = new SandboxService()
      service.setFileSystem(mockFileSystem as unknown as IFileSystem)
      service.setSearchKnowledgeService(mockSearchKnowledgeService as unknown as ISearchKnowledgeService)

      const result = await service.executeCode('tools.searchKnowledge("test")', 'session1')

      // LocalSandbox.execute() now awaits Promises, so returnValue is the resolved result
      expect(result.returnValue).to.have.property('totalFound')
    })

    it('should call the search service with correct parameters', async () => {
      const service = new SandboxService()
      service.setFileSystem(mockFileSystem as unknown as IFileSystem)
      service.setSearchKnowledgeService(mockSearchKnowledgeService as unknown as ISearchKnowledgeService)

      await service.executeCode(
        'tools.searchKnowledge("authentication", { limit: 5 })',
        'session1',
      )

      expect(mockSearchKnowledgeService.search.calledOnce).to.be.true
      expect(mockSearchKnowledgeService.search.firstCall.args[0]).to.equal('authentication')
      expect(mockSearchKnowledgeService.search.firstCall.args[1]).to.deep.equal({limit: 5})
    })
  })

  describe('Tools SDK Integration', () => {
    it('should execute tools.glob and return results', async () => {
      mockFileSystem.globFiles.resolves({
        files: [{path: 'src/index.ts'}, {path: 'src/main.ts'}],
        totalFound: 2,
        truncated: false,
      })

      const service = new SandboxService()
      service.setFileSystem(mockFileSystem as unknown as IFileSystem)

      const result = await service.executeCode('tools.glob("**/*.ts")', 'session1')
      const globResult = await (result.returnValue as Promise<unknown>)

      expect(globResult).to.have.property('totalFound', 2)
    })

    it('should execute tools.readFile and return content', async () => {
      mockFileSystem.readFile.resolves({
        content: 'export const main = () => {}',
        exists: true,
        path: '/project/index.ts',
      })

      const service = new SandboxService()
      service.setFileSystem(mockFileSystem as unknown as IFileSystem)

      const result = await service.executeCode('tools.readFile("/project/index.ts")', 'session1')
      const fileResult = await (result.returnValue as Promise<{content: string}>)

      expect(fileResult.content).to.equal('export const main = () => {}')
    })

    it('should execute tools.writeFile and return result', async () => {
      mockFileSystem.writeFile.resolves({
        bytesWritten: 12,
        path: '/output.txt',
      })

      const service = new SandboxService()
      service.setFileSystem(mockFileSystem as unknown as IFileSystem)

      const result = await service.executeCode(
        'tools.writeFile("/output.txt", "test content")',
        'session1',
      )
      const writeResult = await (result.returnValue as Promise<{bytesWritten: number}>)

      expect(writeResult.bytesWritten).to.equal(12)
    })

    it('should execute tools.grep and return matches', async () => {
      mockFileSystem.searchContent.resolves({
        matches: [{file: 'src/index.ts', line: 10, text: 'function main()'}],
        totalMatches: 1,
        truncated: false,
      })

      const service = new SandboxService()
      service.setFileSystem(mockFileSystem as unknown as IFileSystem)

      const result = await service.executeCode('tools.grep("function")', 'session1')
      const grepResult = await (result.returnValue as Promise<{totalMatches: number}>)

      expect(grepResult.totalMatches).to.equal(1)
    })
  })

  describe('Context Payload', () => {
    it('should inject context payload into sandbox', async () => {
      const service = new SandboxService()
      service.setFileSystem(mockFileSystem as unknown as IFileSystem)

      await service.executeCode('context.projectName', 'session1', {
        contextPayload: {projectName: 'MyProject'},
      })

      const result = await service.executeCode('context.projectName', 'session1')
      expect(result.returnValue).to.equal('MyProject')
    })

    it('should update context on subsequent calls', async () => {
      const service = new SandboxService()
      service.setFileSystem(mockFileSystem as unknown as IFileSystem)

      await service.executeCode('context.version', 'session1', {
        contextPayload: {version: '1.0'},
      })

      await service.executeCode('context.version', 'session1', {
        contextPayload: {version: '2.0'},
      })

      const result = await service.executeCode('context.version', 'session1')
      expect(result.returnValue).to.equal('2.0')
    })
  })

  describe('Error Handling in Tools', () => {
    it('should propagate errors from tool calls', async () => {
      const error = new Error('File not found')
      mockFileSystem.readFile.rejects(error)

      const service = new SandboxService()
      service.setFileSystem(mockFileSystem as unknown as IFileSystem)

      const result = await service.executeCode('tools.readFile("/nonexistent.ts")', 'session1')

      // The promise should reject
      try {
        await (result.returnValue as Promise<unknown>)
        expect.fail('Should have thrown')
      } catch (error_) {
        expect((error_ as Error).message).to.equal('File not found')
      }
    })
  })

  describe('Command Type Transitions (read-only enforcement)', () => {
    it('should reject tools.writeFile() when transitioning from curate to query', async () => {
      const service = new SandboxService()
      service.setFileSystem(mockFileSystem as unknown as IFileSystem)

      // First run as curate — writeFile should work
      const curateResult = await service.executeCode(
        'tools.writeFile("/test.txt", "data")',
        'session1',
        {commandType: 'curate'},
      )
      const writeResult = await (curateResult.returnValue as Promise<{bytesWritten: number}>)
      expect(writeResult.bytesWritten).to.equal(4)

      // Same session, now as query — writeFile must throw
      const queryResult = await service.executeCode(
        'tools.writeFile("/test.txt", "data")',
        'session1',
        {commandType: 'query'},
      )
      expect(queryResult.stderr).to.include('writeFile() is disabled in read-only (query) mode')
    })

    it('should reject tools.curate() when transitioning from curate to query', async () => {
      const service = new SandboxService()
      service.setFileSystem(mockFileSystem as unknown as IFileSystem)
      service.setCurateService({
        curate: sandbox.stub().resolves({applied: [], summary: {added: 0, deleted: 0, failed: 0, merged: 0, updated: 0}}),
        detectDomains: sandbox.stub().resolves({domains: []}),
      } as unknown as ICurateService)

      // First run as curate
      await service.executeCode('var x = 1', 'session1', {commandType: 'curate'})

      // Same session, now as query — curate must throw
      const result = await service.executeCode(
        'tools.curate([])',
        'session1',
        {commandType: 'query'},
      )
      expect(result.stderr).to.include('curate() is disabled in read-only (query) mode')
    })

    it('should preserve sandbox variable state across command type transitions', async () => {
      const service = new SandboxService()
      service.setFileSystem(mockFileSystem as unknown as IFileSystem)

      // Set a variable in curate mode
      await service.executeCode('var important = 42', 'session1', {commandType: 'curate'})

      // Transition to query — variable must survive
      const result = await service.executeCode('important', 'session1', {commandType: 'query'})
      expect(result.returnValue).to.equal(42)
    })

    it('should allow write operations when transitioning from query back to curate', async () => {
      const service = new SandboxService()
      service.setFileSystem(mockFileSystem as unknown as IFileSystem)

      // Start as query
      await service.executeCode('var data = "saved"', 'session1', {commandType: 'query'})

      // Transition to curate — writeFile must work
      const result = await service.executeCode(
        'tools.writeFile("/out.txt", data)',
        'session1',
        {commandType: 'curate'},
      )
      const writeResult = await (result.returnValue as Promise<{bytesWritten: number}>)
      expect(writeResult.bytesWritten).to.equal(4)
    })

    it('should handle undefined to query transition', async () => {
      const service = new SandboxService()
      service.setFileSystem(mockFileSystem as unknown as IFileSystem)

      // First call with no commandType (undefined)
      await service.executeCode('var x = 1', 'session1')

      // Now call with query — writeFile must be blocked
      const result = await service.executeCode(
        'tools.writeFile("/test.txt", "data")',
        'session1',
        {commandType: 'query'},
      )
      expect(result.stderr).to.include('writeFile() is disabled in read-only (query) mode')
    })

    it('should not rebuild ToolsSDK when commandType stays the same', async () => {
      const service = new SandboxService()
      service.setFileSystem(mockFileSystem as unknown as IFileSystem)

      // Two calls with the same commandType
      await service.executeCode('var counter = 0', 'session1', {commandType: 'query'})
      const result = await service.executeCode('counter', 'session1', {commandType: 'query'})

      // Variable persists and no unnecessary rebuild
      expect(result.returnValue).to.equal(0)
    })
  })
})
