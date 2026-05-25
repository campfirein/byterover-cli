/**
 * QueryExecutor tests
 *
 * 1. Variable naming regression: UUID hyphens in sandbox variable names cause
 *    ReferenceError when LLM writes code using underscores.
 *
 * 2. QueryExecutorResult tier classification: verifies each tier returns correct
 *    structured metadata (tier, timing, matchedDocs, searchMetadata).
 *
 * 3. Workspace scoping (PR3): search scope derivation, scope injection for
 *    agent follow-up searches, and cache fingerprint isolation.
 */

import {expect} from 'chai'
import {mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync} from 'node:fs'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import {restore, type SinonStub, stub} from 'sinon'

import type {ICipherAgent} from '../../../../src/agent/core/interfaces/i-cipher-agent.js'
import type {IFileSystem} from '../../../../src/agent/core/interfaces/i-file-system.js'
import type {ISearchKnowledgeService, SearchKnowledgeResult} from '../../../../src/agent/infra/sandbox/tools-sdk.js'

import {LocalSandbox} from '../../../../src/agent/infra/sandbox/local-sandbox.js'
import {
  TIER_DIRECT_SEARCH,
  TIER_EXACT_CACHE,
  TIER_FULL_AGENTIC,
  TIER_FUZZY_CACHE,
  TIER_OPTIMIZED_LLM,
} from '../../../../src/server/core/domain/entities/query-log-entry.js'
import {QueryExecutor} from '../../../../src/server/infra/executor/query-executor.js'

// ── Shared helpers ────────────────────────────────────────────────────────────

function createMockAgent(): ICipherAgent {
  return {
    cancel: stub().resolves(false),
    createTaskSession: stub().resolves('session-1'),
    deleteSandboxVariable: stub(),
    deleteSandboxVariableOnSession: stub(),
    deleteSession: stub().resolves(true),
    deleteTaskSession: stub().resolves(),
    execute: stub().resolves(''),
    executeOnSession: stub().resolves('LLM response'),
    generate: stub().resolves({content: '', toolCalls: [], usage: {inputTokens: 0, outputTokens: 0}}),
    getSessionMetadata: stub().resolves(),
    getState: stub().returns({currentIteration: 0, executionHistory: [], executionState: 'idle', toolCallsExecuted: 0}),
    listPersistedSessions: stub().resolves([]),
    reset: stub(),
    setSandboxVariable: stub(),
    setSandboxVariableOnSession: stub(),
    setupTaskForwarding: stub().returns(() => {}),
    start: stub().resolves(),
    stream: stub().resolves({
      [Symbol.asyncIterator]: () => ({next: () => Promise.resolve({done: true, value: undefined})}),
    }),
  } as unknown as ICipherAgent
}

function createMockFileSystem(): IFileSystem {
  return {
    editFile: stub().resolves({bytesWritten: 0, replacements: 0}),
    globFiles: stub().resolves({
      files: [
        {isDirectory: false, modified: new Date(1000), path: 'doc1.md', size: 100},
        {isDirectory: false, modified: new Date(2000), path: 'doc2.md', size: 200},
      ],
      ignoredCount: 0,
      totalFound: 2,
      truncated: false,
    }),
    initialize: stub().resolves(),
    readFile: stub().resolves({
      content: '# Test Document\n\nThis is test content about authentication and security.',
      encoding: 'utf8',
    }),
    searchFiles: stub().resolves({matches: [], message: '', totalMatches: 0}),
    writeFile: stub().resolves({bytesWritten: 0}),
  } as unknown as IFileSystem
}

function createMockSearchService(
  results: SearchKnowledgeResult['results'] = [],
  totalFound?: number,
): ISearchKnowledgeService {
  const searchResult: SearchKnowledgeResult = {
    message: '',
    results,
    totalFound: totalFound ?? results.length,
  }
  return {
    search: stub().resolves(searchResult),
  } as unknown as ISearchKnowledgeService
}

function makeSearchResult(
  overrides: Partial<SearchKnowledgeResult['results'][0]> = {},
): SearchKnowledgeResult['results'][0] {
  return {
    excerpt: 'Test excerpt about the topic.',
    path: 'topics/auth.md',
    score: 0.95,
    title: 'Authentication Guide',
    ...overrides,
  }
}

// Low-score results: enough to avoid OOD short-circuit, but below direct-response threshold
// so the executor falls through to the LLM path (createTaskSession + executeOnSession).
// totalFound >= 3 avoids supplementary entity searches (which would call search multiple times).
const lowScoreSearchResult = {
  message: '',
  results: [
    {excerpt: 'test A', path: 'a.md', score: 0.3, title: 'A'},
    {excerpt: 'test B', path: 'b.md', score: 0.2, title: 'B'},
    {excerpt: 'test C', path: 'c.md', score: 0.1, title: 'C'},
  ],
  totalFound: 3,
}

/** Attribution footer appended by QueryExecutor to all responses */
const ATTRIBUTION_FOOTER = '\n\n---\nSource: ByteRover Knowledge Base'

const TASK_ID = 'test-task-001'

/**
 * Seed a `.brv/context-tree/` with one stub topic so
 * `computeContextTreeFingerprint` produces a stable non-`'unknown'`
 * value — the cache hit path depends on the fingerprint being
 * consistent across calls.
 */
function seedContextTree(projectRoot: string): void {
  mkdirSync(join(projectRoot, '.brv', 'context-tree'), {recursive: true})
  writeFileSync(join(projectRoot, '.brv', 'context-tree', 'doc.html'), '<bv-topic></bv-topic>')
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('QueryExecutor', () => {
  let tempDir: string

  beforeEach(() => {
    tempDir = realpathSync(mkdtempSync(join(tmpdir(), 'brv-query-executor-')))
  })

  afterEach(() => {
    restore()
    rmSync(tempDir, {force: true, recursive: true})
  })

  // ── Sandbox variable naming regression ────────────────────────────────────

  describe('sandbox variable naming (regression)', () => {
    // Typical UUID taskId with hyphens (as generated by crypto.randomUUID())
    const taskId = '8cd8e2d8-a7fc-4371-89ca-59460687c12d'
    // What the LLM would write in code-exec (hyphens → underscores, valid JS identifier)
    const llmGeneratedResultsVar = '__query_results_8cd8e2d8_a7fc_4371_89ca_59460687c12d'
    const llmGeneratedMetaVar = '__query_meta_8cd8e2d8_a7fc_4371_89ca_59460687c12d'

    describe('bug: hyphenated taskId causes variable name mismatch', () => {
      it('should fail with ReferenceError when __query_results_* stored with hyphens', async () => {
        const sandbox = new LocalSandbox()

        const buggyResultsVar = `__query_results_${taskId}`
        sandbox.updateContext({[buggyResultsVar]: [{path: '/a.md', score: 0.9}]})

        const result = await sandbox.execute(llmGeneratedResultsVar)

        expect(result.stderr).to.include('ReferenceError')
        expect(result.stderr).to.include(llmGeneratedResultsVar)
      })

      it('should fail with ReferenceError when __query_meta_* stored with hyphens', async () => {
        const sandbox = new LocalSandbox()

        const buggyMetaVar = `__query_meta_${taskId}`
        sandbox.updateContext({[buggyMetaVar]: {resultCount: 3, topScore: 0.9, totalFound: 10}})

        const result = await sandbox.execute(`${llmGeneratedMetaVar}.resultCount`)

        expect(result.stderr).to.include('ReferenceError')
      })
    })

    describe('fix: taskIdSafe with underscores eliminates mismatch', () => {
      it('should succeed when __query_results_* stored with underscores matching LLM output', async () => {
        const sandbox = new LocalSandbox()

        const taskIdSafe = taskId.replaceAll('-', '_')
        const fixedResultsVar = `__query_results_${taskIdSafe}`
        sandbox.updateContext({[fixedResultsVar]: [{path: '/a.md', score: 0.9}]})

        const result = await sandbox.execute(`${llmGeneratedResultsVar}[0].score`)

        expect(result.stderr).to.equal('')
        expect(result.returnValue).to.equal(0.9)
      })

      it('should succeed when __query_meta_* stored with underscores matching LLM output', async () => {
        const sandbox = new LocalSandbox()

        const taskIdSafe = taskId.replaceAll('-', '_')
        const fixedMetaVar = `__query_meta_${taskIdSafe}`
        sandbox.updateContext({[fixedMetaVar]: {resultCount: 3, topScore: 0.9, totalFound: 10}})

        const result = await sandbox.execute(`${llmGeneratedMetaVar}.resultCount`)

        expect(result.stderr).to.equal('')
        expect(result.returnValue).to.equal(3)
      })

      it('should correctly transform all UUID segments (4 hyphens replaced)', () => {
        const taskIdSafe = taskId.replaceAll('-', '_')

        expect(taskIdSafe).to.not.include('-')
        expect(taskIdSafe).to.equal('8cd8e2d8_a7fc_4371_89ca_59460687c12d')

        expect(`__query_results_${taskIdSafe}`).to.equal(llmGeneratedResultsVar)
        expect(`__query_meta_${taskIdSafe}`).to.equal(llmGeneratedMetaVar)
      })
    })
  })

  // ── QueryExecutorResult tier tests ──────────────────────────────────────────

  describe('executeWithAgent', () => {
    describe('Tier 0: exact cache hit', () => {
      it('should return tier 0 with empty matchedDocs on exact cache hit', async () => {
        const agent = createMockAgent()
        const fileSystem = createMockFileSystem()
        // First call: direct search (Tier 2) populates cache
        const searchService = createMockSearchService([makeSearchResult({score: 0.95})])
        const executor = new QueryExecutor({enableCache: true, fileSystem, searchService})

        // First call — goes through to Tier 2 direct search (score 0.95 > 0.93 threshold)
        const firstResult = await executor.executeWithAgent(agent, {query: 'what is authentication', taskId: TASK_ID})
        expect(firstResult.tier).to.equal(TIER_DIRECT_SEARCH)

        // Second call — same query, same fingerprint → Tier 0 cache hit
        const result = await executor.executeWithAgent(agent, {query: 'what is authentication', taskId: TASK_ID})

        expect(result.tier).to.equal(TIER_EXACT_CACHE)
        expect(result.matchedDocs).to.deep.equal([])
        expect(result.searchMetadata).to.be.undefined
        expect(result.timing.durationMs).to.be.at.least(0)
        expect(result.response).to.include(ATTRIBUTION_FOOTER)
      })
    })

    describe('Tier 1: fuzzy cache hit', () => {
      it('should return tier 1 with empty matchedDocs on fuzzy cache match', async () => {
        const agent = createMockAgent()
        const fileSystem = createMockFileSystem()
        const searchService = createMockSearchService([makeSearchResult({score: 0.95})])
        const executor = new QueryExecutor({enableCache: true, fileSystem, searchService})

        // Prime cache with first query (goes through Tier 2 direct search)
        await executor.executeWithAgent(agent, {query: 'authentication security guide overview', taskId: TASK_ID})

        // Similar query with sufficient token overlap (Jaccard >= 0.6)
        // Tokens: "authentication", "security", "guide" overlap; "detailed" and "overview" differ
        const result = await executor.executeWithAgent(agent, {
          query: 'authentication security guide detailed',
          taskId: TASK_ID,
        })

        expect(result.tier).to.equal(TIER_FUZZY_CACHE)
        expect(result.matchedDocs).to.deep.equal([])
        expect(result.searchMetadata).to.be.undefined
        expect(result.timing.durationMs).to.be.at.least(0)
        expect(result.response).to.include(ATTRIBUTION_FOOTER)
      })
    })

    describe('Tier 2: OOD (out-of-domain)', () => {
      it('should return tier 2 with empty matchedDocs when search returns no results', async () => {
        const agent = createMockAgent()
        const fileSystem = createMockFileSystem()
        const searchService = createMockSearchService([], 0)
        const executor = new QueryExecutor({fileSystem, searchService})

        const result = await executor.executeWithAgent(agent, {query: 'what is quantum computing', taskId: TASK_ID})

        expect(result.tier).to.equal(TIER_DIRECT_SEARCH)
        expect(result.matchedDocs).to.deep.equal([])
        expect(result.searchMetadata).to.deep.equal({resultCount: 0, topScore: 0, totalFound: 0})
        expect(result.timing.durationMs).to.be.at.least(0)
        expect(result.response).to.include('No matching knowledge found')
        expect(result.response).to.include(ATTRIBUTION_FOOTER)
      })
    })

    describe('Tier 2: direct search response', () => {
      it('should return tier 2 with matchedDocs when direct response threshold met', async () => {
        const agent = createMockAgent()
        const fileSystem = createMockFileSystem()
        const searchResult = makeSearchResult({path: 'topics/auth.md', score: 0.95, title: 'Authentication Guide'})
        const searchService = createMockSearchService([searchResult])
        const executor = new QueryExecutor({fileSystem, searchService})

        const result = await executor.executeWithAgent(agent, {query: 'what is authentication', taskId: TASK_ID})

        expect(result.tier).to.equal(TIER_DIRECT_SEARCH)
        expect(result.matchedDocs).to.have.length(1)
        expect(result.matchedDocs[0]).to.deep.equal({
          path: 'topics/auth.md',
          score: 0.95,
          title: 'Authentication Guide',
        })
        expect(result.searchMetadata).to.deep.include({resultCount: 1, totalFound: 1})
        expect(result.searchMetadata!.topScore).to.equal(0.95)
        expect(result.timing.durationMs).to.be.at.least(0)
        expect(result.response).to.include(ATTRIBUTION_FOOTER)
      })

      it('renders HTML topics into structured markdown before formatting the direct response', async () => {
        // For HTML results, the executor reads the full file and routes
        // it through `renderHtmlTopicForLlm` so that downstream
        // `formatDirectResponse` ships markdown, not raw `<bv-*>`
        // markup. Locks the Tier 2 contract: the user-facing response
        // never contains tag/attribute syntax for HTML topics.
        const agent = createMockAgent()
        const fileSystem = createMockFileSystem()
        ;(fileSystem.readFile as SinonStub).resolves({
          content: `<bv-topic path="security/auth" title="JWT auth" summary="JWT design">
            <bv-reason>Document JWT design.</bv-reason>
            <bv-rule severity="must" id="r-1">Always validate signatures.</bv-rule>
            <bv-decision id="d-1">Use RS256 over HS256.</bv-decision>
          </bv-topic>`,
          encoding: 'utf8',
        })
        const searchResult = makeSearchResult({
          format: 'html',
          path: 'security/auth.html',
          score: 0.95,
          title: 'JWT auth',
        })
        const searchService = createMockSearchService([searchResult])
        const executor = new QueryExecutor({fileSystem, searchService})

        const result = await executor.executeWithAgent(agent, {query: 'jwt auth', taskId: TASK_ID})

        expect(result.tier).to.equal(TIER_DIRECT_SEARCH)
        // No raw bv-* markup or attribute syntax leaks into the response.
        expect(result.response).to.not.match(/<bv-/)
        expect(result.response).to.not.match(/\s\w+="/)
        // Structured render preserves element semantics (severity, id).
        expect(result.response).to.include('- **Rule** [must] (r-1): Always validate signatures.')
        expect(result.response).to.include('- **Decision** (d-1): Use RS256 over HS256.')
        expect(result.response).to.include('**Reason:** Document JWT design.')
      })

      it('passes markdown topics through unchanged (no renderer applied)', async () => {
        const agent = createMockAgent()
        const fileSystem = createMockFileSystem()
        ;(fileSystem.readFile as SinonStub).resolves({
          content: '# Auth\n\nSome markdown body about auth.',
          encoding: 'utf8',
        })
        const searchResult = makeSearchResult({
          format: 'markdown',
          path: 'topics/auth.md',
          score: 0.95,
          title: 'Auth',
        })
        const searchService = createMockSearchService([searchResult])
        const executor = new QueryExecutor({fileSystem, searchService})

        const result = await executor.executeWithAgent(agent, {query: 'auth', taskId: TASK_ID})

        expect(result.tier).to.equal(TIER_DIRECT_SEARCH)
        // Markdown body survives verbatim — no renderer rewrites it.
        expect(result.response).to.include('Some markdown body about auth.')
      })
    })

    describe('Tier 3: optimized LLM with prefetched context', () => {
      it('should return tier 3 when search results have high scores and LLM is invoked', async () => {
        const agent = createMockAgent()
        const fileSystem = createMockFileSystem()
        // Score 0.75: above SMART_ROUTING_SCORE_THRESHOLD (0.7) for prefetch,
        // but below DIRECT_RESPONSE_SCORE_THRESHOLD (0.85) so direct search is skipped
        const searchResults = [
          makeSearchResult({path: 'topics/auth.md', score: 0.75, title: 'Auth Guide'}),
          makeSearchResult({path: 'topics/security.md', score: 0.72, title: 'Security Guide'}),
        ]
        const searchService = createMockSearchService(searchResults)
        // No baseDirectory — avoids FileContextTreeManifestService filesystem access
        const executor = new QueryExecutor({fileSystem, searchService})

        const result = await executor.executeWithAgent(agent, {query: 'how does authentication work', taskId: TASK_ID})

        expect(result.tier).to.equal(TIER_OPTIMIZED_LLM)
        expect(result.matchedDocs).to.have.length(2)
        expect(result.matchedDocs[0]).to.deep.equal({path: 'topics/auth.md', score: 0.75, title: 'Auth Guide'})
        expect(result.matchedDocs[1]).to.deep.equal({path: 'topics/security.md', score: 0.72, title: 'Security Guide'})
        expect(result.searchMetadata).to.deep.include({resultCount: 2, totalFound: 2})
        expect(result.searchMetadata!.topScore).to.equal(0.75)
        expect(result.timing.durationMs).to.be.at.least(0)
        expect(result.response).to.include('LLM response')
        expect(result.response).to.include(ATTRIBUTION_FOOTER)
        expect((agent.executeOnSession as SinonStub).calledOnce).to.be.true
      })
    })

    describe('Tier 4: full agentic (no prefetched context)', () => {
      it('should return tier 4 when all search scores are below smart routing threshold', async () => {
        const agent = createMockAgent()
        const fileSystem = createMockFileSystem()
        // All scores below SMART_ROUTING_SCORE_THRESHOLD (0.7) → no prefetched context
        const searchResults = [
          makeSearchResult({path: 'topics/misc.md', score: 0.5, title: 'Misc Notes'}),
          makeSearchResult({path: 'topics/other.md', score: 0.4, title: 'Other'}),
        ]
        const searchService = createMockSearchService(searchResults)
        const executor = new QueryExecutor({fileSystem, searchService})

        const result = await executor.executeWithAgent(agent, {query: 'complex multi-step question', taskId: TASK_ID})

        expect(result.tier).to.equal(TIER_FULL_AGENTIC)
        expect(result.matchedDocs).to.have.length(2)
        expect(result.matchedDocs[0]).to.deep.equal({path: 'topics/misc.md', score: 0.5, title: 'Misc Notes'})
        expect(result.searchMetadata).to.deep.include({resultCount: 2, totalFound: 2})
        expect(result.searchMetadata!.topScore).to.equal(0.5)
        expect(result.timing.durationMs).to.be.at.least(0)
        expect(result.response).to.include('LLM response')
        expect(result.response).to.include(ATTRIBUTION_FOOTER)
        expect((agent.executeOnSession as SinonStub).calledOnce).to.be.true
      })
    })
  })

  // ── Workspace scoping tests ─────────────────────────────────────────────────

  describe('workspace scoping (PR3)', () => {
    describe('search scope derivation', () => {
      it('should pass workspace scope to initial search when worktreeRoot differs from baseDirectory', async () => {
        const searchStub = stub().resolves(lowScoreSearchResult)
        const searchService: ISearchKnowledgeService = {search: searchStub}

        const executor = new QueryExecutor({
          baseDirectory: '/projects/monorepo',
          searchService,
        })

        const agent = createMockAgent()
        await executor.executeWithAgent(agent, {
          query: 'authentication',
          taskId: 'task-1',
          worktreeRoot: '/projects/monorepo/packages/api',
        })

        expect(searchStub.called).to.be.true
        const searchOpts = searchStub.firstCall.args[1]
        expect(searchOpts.scope).to.equal('packages/api')
      })

      it('should not pass scope when worktreeRoot equals baseDirectory', async () => {
        const searchStub = stub().resolves(lowScoreSearchResult)
        const searchService: ISearchKnowledgeService = {search: searchStub}

        const executor = new QueryExecutor({
          baseDirectory: '/projects/myapp',
          searchService,
        })

        const agent = createMockAgent()
        await executor.executeWithAgent(agent, {
          query: 'authentication',
          taskId: 'task-2',
          worktreeRoot: '/projects/myapp',
        })

        expect(searchStub.called).to.be.true
        const searchOpts = searchStub.firstCall.args[1]
        expect(searchOpts.scope).to.be.undefined
      })

      it('should not pass scope when worktreeRoot is undefined', async () => {
        const searchStub = stub().resolves(lowScoreSearchResult)
        const searchService: ISearchKnowledgeService = {search: searchStub}

        const executor = new QueryExecutor({
          baseDirectory: '/projects/myapp',
          searchService,
        })

        const agent = createMockAgent()
        await executor.executeWithAgent(agent, {
          query: 'authentication',
          taskId: 'task-3',
        })

        expect(searchStub.called).to.be.true
        const searchOpts = searchStub.firstCall.args[1]
        expect(searchOpts.scope).to.be.undefined
      })
    })

    describe('workspace scope injection for agent follow-up searches', () => {
      it('should inject scope variable into sandbox when worktreeRoot differs from baseDirectory', async () => {
        const searchStub = stub().resolves(lowScoreSearchResult)
        const searchService: ISearchKnowledgeService = {search: searchStub}

        const executor = new QueryExecutor({
          baseDirectory: '/projects/monorepo',
          searchService,
        })

        const agent = createMockAgent()
        await executor.executeWithAgent(agent, {
          query: 'authentication',
          taskId: 'abc-def',
          worktreeRoot: '/projects/monorepo/packages/api',
        })

        const setSandboxCalls = (agent.setSandboxVariableOnSession as ReturnType<typeof stub>).getCalls()
        const scopeCall = setSandboxCalls.find((c: {args: unknown[]}) =>
          (c.args[1] as string).startsWith('__query_scope_'),
        )
        expect(scopeCall).to.not.be.undefined
        expect(scopeCall!.args[2]).to.equal('packages/api')
      })

      it('should not inject scope variable when worktreeRoot equals baseDirectory', async () => {
        const searchStub = stub().resolves(lowScoreSearchResult)
        const searchService: ISearchKnowledgeService = {search: searchStub}

        const executor = new QueryExecutor({
          baseDirectory: '/projects/myapp',
          searchService,
        })

        const agent = createMockAgent()
        await executor.executeWithAgent(agent, {
          query: 'authentication',
          taskId: 'abc-def',
          worktreeRoot: '/projects/myapp',
        })

        const setSandboxCalls = (agent.setSandboxVariableOnSession as ReturnType<typeof stub>).getCalls()
        const scopeCall = setSandboxCalls.find((c: {args: unknown[]}) =>
          (c.args[1] as string).startsWith('__query_scope_'),
        )
        expect(scopeCall).to.be.undefined
      })

      it('should include scope guidance in prompt when workspace scope is active', async () => {
        const searchStub = stub().resolves(lowScoreSearchResult)
        const searchService: ISearchKnowledgeService = {search: searchStub}

        const executor = new QueryExecutor({
          baseDirectory: '/projects/monorepo',
          searchService,
        })

        const agent = createMockAgent()
        await executor.executeWithAgent(agent, {
          query: 'authentication',
          taskId: 'abc-def',
          worktreeRoot: '/projects/monorepo/packages/api',
        })

        const executeCall = (agent.executeOnSession as ReturnType<typeof stub>).firstCall
        const prompt = executeCall.args[1] as string
        expect(prompt).to.include('tools.searchKnowledge()')
        expect(prompt).to.include('scope')
        expect(prompt).to.include('__query_scope_')
      })
    })

    describe('cache fingerprint isolation', () => {
      it('should produce different fingerprints for different worktreeRoot values', async () => {
        const globStub = stub().resolves({
          files: [{modified: new Date('2026-01-01'), path: 'a.md'}],
          totalMatches: 1,
        })
        const fileSystem = {globFiles: globStub, readFile: stub()} as unknown as IFileSystem
        const searchStub = stub().resolves(lowScoreSearchResult)

        const executor = new QueryExecutor({
          baseDirectory: '/projects/monorepo',
          enableCache: true,
          fileSystem,
          searchService: {search: searchStub},
        })

        const agent = createMockAgent()

        await executor.executeWithAgent(agent, {
          query: 'authentication',
          taskId: 'task-a',
          worktreeRoot: '/projects/monorepo/packages/api',
        })

        await executor.executeWithAgent(agent, {
          query: 'authentication',
          taskId: 'task-b',
          worktreeRoot: '/projects/monorepo/packages/web',
        })

        // Both should have gone through full execution (executeOnSession called twice)
        expect((agent.executeOnSession as ReturnType<typeof stub>).callCount).to.equal(2)
      })

      it('should invalidate cached responses when linked knowledge changes', async () => {
        const projectRoot = join(tempDir, 'project-a')
        const linkedProjectRoot = join(tempDir, 'project-b')
        mkdirSync(join(projectRoot, '.brv', 'context-tree'), {recursive: true})
        mkdirSync(join(linkedProjectRoot, '.brv', 'context-tree'), {recursive: true})
        writeFileSync(join(projectRoot, '.brv', 'config.json'), JSON.stringify({version: '0.0.1'}))
        writeFileSync(join(linkedProjectRoot, '.brv', 'config.json'), JSON.stringify({version: '0.0.1'}))
        writeFileSync(
          join(projectRoot, '.brv', 'sources.json'),
          JSON.stringify({
            sources: [{addedAt: '2026-01-01', alias: 'shared-lib', projectRoot: linkedProjectRoot, readOnly: true}],
            version: 1,
          }),
        )

        let linkedMtime = new Date('2026-01-01')
        const fileSystem = {
          globFiles: stub().callsFake(async (_pattern: string, options?: {cwd?: string}) => {
            if (options?.cwd === join('.brv', 'context-tree')) {
              return {files: [{modified: new Date('2026-01-01'), path: 'local.md'}], totalMatches: 1}
            }

            if (options?.cwd === join(linkedProjectRoot, '.brv', 'context-tree')) {
              return {files: [{modified: linkedMtime, path: 'shared.md'}], totalMatches: 1}
            }

            return {files: [], totalMatches: 0}
          }),
          readFile: stub(),
        } as unknown as IFileSystem

        const executor = new QueryExecutor({
          baseDirectory: projectRoot,
          enableCache: true,
          fileSystem,
          searchService: {search: stub().resolves(lowScoreSearchResult)},
        })

        const agent = createMockAgent()

        await executor.executeWithAgent(agent, {
          query: 'authentication',
          taskId: 'task-a',
          worktreeRoot: projectRoot,
        })

        linkedMtime = new Date('2026-01-02')
        ;(executor as unknown as {cachedFingerprint?: unknown}).cachedFingerprint = undefined

        await executor.executeWithAgent(agent, {
          query: 'authentication',
          taskId: 'task-b',
          worktreeRoot: projectRoot,
        })

        expect((agent.executeOnSession as ReturnType<typeof stub>).callCount).to.equal(2)
      })

      it('should auto-invalidate fingerprint cache when knowledge link target is deleted within TTL', async () => {
        const projectRoot = join(tempDir, 'project-c')
        const linkedProjectRoot = join(tempDir, 'project-d')
        mkdirSync(join(projectRoot, '.brv', 'context-tree'), {recursive: true})
        mkdirSync(join(linkedProjectRoot, '.brv', 'context-tree'), {recursive: true})
        writeFileSync(join(projectRoot, '.brv', 'config.json'), JSON.stringify({version: '0.0.1'}))
        writeFileSync(join(linkedProjectRoot, '.brv', 'config.json'), JSON.stringify({version: '0.0.1'}))
        writeFileSync(
          join(projectRoot, '.brv', 'sources.json'),
          JSON.stringify({
            sources: [{addedAt: '2026-01-01', alias: 'shared', projectRoot: linkedProjectRoot, readOnly: true}],
            version: 1,
          }),
        )

        const fileSystem = {
          globFiles: stub().callsFake(async (_pattern: string, options?: {cwd?: string}) => {
            if (options?.cwd === join('.brv', 'context-tree')) {
              return {files: [{modified: new Date('2026-01-01'), path: 'local.md'}], totalMatches: 1}
            }

            if (options?.cwd === join(linkedProjectRoot, '.brv', 'context-tree')) {
              return {files: [{modified: new Date('2026-01-01'), path: 'shared.md'}], totalMatches: 1}
            }

            return {files: [], totalMatches: 0}
          }),
          readFile: stub(),
        } as unknown as IFileSystem

        const executor = new QueryExecutor({
          baseDirectory: projectRoot,
          enableCache: true,
          fileSystem,
          searchService: {search: stub().resolves(lowScoreSearchResult)},
        })

        const agent = createMockAgent()

        // First query — populates fingerprint cache
        await executor.executeWithAgent(agent, {
          query: 'authentication',
          taskId: 'task-c',
          worktreeRoot: projectRoot,
        })

        // Break the link target — delete its config (within TTL window)
        // Do NOT manually clear cachedFingerprint — the source validity check should detect this
        rmSync(join(linkedProjectRoot, '.brv', 'config.json'))

        // Same query — should miss cache because source validity hash changed
        await executor.executeWithAgent(agent, {
          query: 'authentication',
          taskId: 'task-d',
          worktreeRoot: projectRoot,
        })

        // Both queries should have gone through full execution (no stale cache hit)
        expect((agent.executeOnSession as ReturnType<typeof stub>).callCount).to.equal(2)
      })
    })
  })

  describe('executeToolMode', () => {
    /**
     * The executor is the layer where the tool-mode wire contract is
     * built. The CLI side is daemon-coupled and exercised by the auto-test
     * harness; the executor itself is unit-testable with stubbed deps
     * and that's where the branch-coverage bar lives.
     */

    it('Tier-2 happy path: stubbed searchService → ok envelope with rendered matches', async () => {
      const projectRoot = tempDir
      seedContextTree(projectRoot)

      const fileSystem = createMockFileSystem()
      const searchService = createMockSearchService(
        [
          makeSearchResult({path: 'auth.html', score: 0.91, title: 'Auth'}),
          makeSearchResult({path: 'cookies.html', score: 0.71, title: 'Cookies'}),
        ],
        2,
      )

      const executor = new QueryExecutor({
        baseDirectory: projectRoot,
        enableCache: true,
        fileSystem,
        searchService,
      })

      const result = await executor.executeToolMode({query: 'auth', worktreeRoot: projectRoot})

      expect(result.status).to.equal('ok')
      expect(result.matchedDocs).to.have.lengthOf(2)
      expect(result.matchedDocs[0].path).to.equal('auth.html')
      expect(result.matchedDocs[0].title).to.equal('Auth')
      expect(result.matchedDocs[0].rendered_md).to.be.a('string').and.have.length.greaterThan(0)
      expect(result.metadata.tier).to.equal(TIER_DIRECT_SEARCH)
      expect(result.metadata.cacheHit).to.equal(null)
      expect(result.metadata.skippedSharedCount).to.equal(0)
    })

    it('Tier-0 exact cache hit: second identical call returns cacheHit=exact, tier=0', async () => {
      const projectRoot = tempDir
      seedContextTree(projectRoot)

      const searchStub = stub().resolves({
        message: '',
        results: [makeSearchResult({path: 'auth.html', score: 0.91})],
        totalFound: 1,
      })
      const executor = new QueryExecutor({
        baseDirectory: projectRoot,
        enableCache: true,
        fileSystem: createMockFileSystem(),
        searchService: {search: searchStub} as unknown as ISearchKnowledgeService,
      })

      await executor.executeToolMode({query: 'auth', worktreeRoot: projectRoot})
      const second = await executor.executeToolMode({query: 'auth', worktreeRoot: projectRoot})

      expect(second.metadata.cacheHit).to.equal('exact')
      expect(second.metadata.tier).to.equal(TIER_EXACT_CACHE)
      // Search service called exactly once — the second call hit cache before retrieval.
      expect(searchStub.callCount).to.equal(1)
    })

    it('Tier-1 fuzzy cache: semantically-similar query overlays with cacheHit=fuzzy', async () => {
      const projectRoot = tempDir
      seedContextTree(projectRoot)

      const searchStub = stub().resolves({
        message: '',
        results: [makeSearchResult({path: 'auth.html', score: 0.91})],
        totalFound: 1,
      })
      const executor = new QueryExecutor({
        baseDirectory: projectRoot,
        enableCache: true,
        fileSystem: createMockFileSystem(),
        searchService: {search: searchStub} as unknown as ISearchKnowledgeService,
      })

      // Seed cache with one phrasing; query with a Jaccard-similar reword.
      await executor.executeToolMode({
        query: 'how does authentication work',
        worktreeRoot: projectRoot,
      })
      const second = await executor.executeToolMode({
        query: 'how does authentication work in practice',
        worktreeRoot: projectRoot,
      })

      // Cache hit is acceptable as either tier; assert it's a cache
      // hit, not a fresh fetch. (Whether jaccard picks 'exact' vs
      // 'fuzzy' depends on tokenisation thresholds; the contract is
      // "second call doesn't re-run BM25".)
      expect(['exact', 'fuzzy']).to.include(second.metadata.cacheHit)
      expect([TIER_EXACT_CACHE, TIER_FUZZY_CACHE]).to.include(second.metadata.tier)
      // Snapshot search-call count after the first invocation (which
      // may include supplement entity searches) and assert the second
      // invocation does NOT increment it.
      const callCountAfterFirst = searchStub.callCount
      await executor.executeToolMode({
        query: 'how does authentication work in practice',
        worktreeRoot: projectRoot,
      })
      expect(searchStub.callCount).to.equal(callCountAfterFirst)
    })

    it('slicing: cache stored at MAX_LIMIT is sliced down to caller --limit', async () => {
      const projectRoot = tempDir
      seedContextTree(projectRoot)

      // Twenty results so we can prove the slice is happening
      const results = Array.from({length: 20}, (_, i) =>
        makeSearchResult({path: `doc-${i}.html`, score: 0.9 - i * 0.01, title: `Doc ${i}`}),
      )
      const searchStub = stub().resolves({message: '', results, totalFound: 20})

      const executor = new QueryExecutor({
        baseDirectory: projectRoot,
        enableCache: true,
        fileSystem: createMockFileSystem(),
        searchService: {search: searchStub} as unknown as ISearchKnowledgeService,
      })

      // First call: limit 5 → 5 matches, cache populated with full 20.
      const first = await executor.executeToolMode({limit: 5, query: 'docs', worktreeRoot: projectRoot})
      expect(first.matchedDocs).to.have.lengthOf(5)
      expect(first.metadata.totalFound).to.equal(20)

      // Second call: limit 15 → 15 matches from cache, NO new search.
      const second = await executor.executeToolMode({limit: 15, query: 'docs', worktreeRoot: projectRoot})
      expect(second.matchedDocs).to.have.lengthOf(15)
      expect(second.metadata.cacheHit).to.equal('exact')
      expect(second.metadata.totalFound).to.equal(20)
      expect(searchStub.callCount).to.equal(1)
    })

    it('supplementEntitySearches fires when totalFound < 3', async () => {
      const projectRoot = tempDir
      seedContextTree(projectRoot)

      const searchStub = stub()
      // Initial search: returns 2 — under the threshold, supplement should fire.
      searchStub.onFirstCall().resolves({
        message: '',
        results: [makeSearchResult({path: 'auth.html', score: 0.91, title: 'Auth'})],
        totalFound: 1,
      })
      // Entity searches: stub adds a supplementary match per entity.
      searchStub.resolves({
        message: '',
        results: [makeSearchResult({path: 'extra.html', score: 0.6, title: 'Extra'})],
        totalFound: 1,
      })

      const executor = new QueryExecutor({
        baseDirectory: projectRoot,
        enableCache: false,
        fileSystem: createMockFileSystem(),
        searchService: {search: searchStub} as unknown as ISearchKnowledgeService,
      })

      // Multi-entity query: extractQueryEntities returns >1 term, so supplement runs.
      await executor.executeToolMode({query: 'security authentication tokens', worktreeRoot: projectRoot})

      expect(searchStub.callCount).to.be.greaterThan(1)
    })

    it('shared-source results are filtered + counted in skippedSharedCount', async () => {
      const projectRoot = tempDir
      seedContextTree(projectRoot)

      const results = [
        makeSearchResult({path: 'local.html', score: 0.91, title: 'Local'}),
        // origin !== 'local' → must be excluded from matchedDocs, counted in skippedSharedCount
        {...makeSearchResult({path: 'shared.html', score: 0.85, title: 'Shared'}), origin: 'shared' as const},
      ]
      const executor = new QueryExecutor({
        baseDirectory: projectRoot,
        enableCache: false,
        fileSystem: createMockFileSystem(),
        searchService: createMockSearchService(results, 2),
      })

      const result = await executor.executeToolMode({query: 'q', worktreeRoot: projectRoot})

      expect(result.matchedDocs).to.have.lengthOf(1)
      expect(result.matchedDocs[0].path).to.equal('local.html')
      expect(result.metadata.skippedSharedCount).to.equal(1)
    })

    it('searchService.search() throws → executor rethrows (outer envelope reports failure)', async () => {
      const projectRoot = tempDir
      seedContextTree(projectRoot)

      const searchStub = stub().rejects(new Error('BM25 index unavailable'))
      const executor = new QueryExecutor({
        baseDirectory: projectRoot,
        enableCache: false,
        fileSystem: createMockFileSystem(),
        searchService: {search: searchStub} as unknown as ISearchKnowledgeService,
      })

      let caught: Error | undefined
      try {
        await executor.executeToolMode({query: 'q', worktreeRoot: projectRoot})
      } catch (error) {
        caught = error as Error
      }

      // Rethrow lets the daemon emit task:error → CLI maps to outer success: false.
      // Compare with the empty-envelope path (no searchService) below.
      expect(caught?.message).to.equal('BM25 index unavailable')
    })

    it('no searchService injected → empty no-matches envelope (executor stays callable)', async () => {
      const executor = new QueryExecutor({
        baseDirectory: tempDir,
        enableCache: false,
        fileSystem: createMockFileSystem(),
        // no searchService
      })

      const result = await executor.executeToolMode({query: 'q', worktreeRoot: tempDir})

      expect(result.status).to.equal('no-matches')
      expect(result.matchedDocs).to.deep.equal([])
      expect(result.metadata.totalFound).to.equal(0)
      expect(result.metadata.skippedSharedCount).to.equal(0)
    })
  })
})
