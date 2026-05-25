import type {
  FileContent,
  GlobResult,
  ListDirectoryResult,
  SearchResult,
  WriteResult,
} from '../../core/domain/file-system/types.js'
import type {IContentGenerator} from '../../core/interfaces/i-content-generator.js'
import type {
  CurateOperation,
  CurateOptions,
  CurateResult,
  DetectDomainsInput,
  DetectDomainsResult,
  ICurateService,
} from '../../core/interfaces/i-curate-service.js'
import type {IFileSystem} from '../../core/interfaces/i-file-system.js'
import type {ISandboxService} from '../../core/interfaces/i-sandbox-service.js'
import type {ISwarmCoordinator} from '../../core/interfaces/i-swarm-coordinator.js'
import type {SessionManager} from '../session/session-manager.js'

import {ContextTreeStore} from '../map/context-tree-store.js'
import {executeLlmMapMemory} from '../map/llm-map-memory.js'
import {validateWriteTarget} from '../tools/write-guard.js'
import {
  chunk,
  type ChunkResult,
  type CurationFact,
  dedup,
  detectMessageBoundaries,
  groupBySubject,
  type MessageBoundary,
  recon,
  type ReconResult,
  recordProgress,
} from './curation-helpers.js'

/**
 * Options for glob operation in ToolsSDK.
 */
export interface GlobOptions {
  /** Case-sensitive pattern matching (default: true) */
  caseSensitive?: boolean
  /** Maximum number of results to return (default: 1000) */
  maxResults?: number
  /** Base directory to search from (defaults to working directory) */
  path?: string
}

/**
 * Options for grep operation in ToolsSDK.
 */
export interface GrepOptions {
  /** Perform case-insensitive search (default: false) */
  caseInsensitive?: boolean
  /** Number of context lines before and after each match (default: 0) */
  contextLines?: number
  /** Glob pattern to filter files (e.g., "*.ts") */
  glob?: string
  /** Maximum number of results to return (default: 100) */
  maxResults?: number
  /** Directory to search in (defaults to working directory) */
  path?: string
}

/**
 * Options for readFile operation in ToolsSDK.
 */
export interface ReadFileOptions {
  /** Maximum number of lines to read (default: 2000) */
  limit?: number
  /** Starting line number (1-based) */
  offset?: number
}

/**
 * Options for writeFile operation in ToolsSDK.
 */
export interface WriteFileOptions {
  /** Create parent directories if they don't exist (default: false) */
  createDirs?: boolean
}

/**
 * Options for listDirectory operation in ToolsSDK.
 */
export interface ListDirectoryOptions {
  /** Additional glob patterns to ignore */
  ignore?: string[]
  /** Maximum number of files to return (default: 100) */
  maxResults?: number
}

/**
 * Optional structural-axis hint applied before BM25 ranking. Restricts
 * the candidate set to topic files containing at least one matching
 * `<bv-*>` element. Wired but unused by today's callers — the
 * structural-selector grammar will plug into this without reshaping
 * the search call signature.
 *
 * Discriminated union: either filter by tag alone, or by tag plus an
 * `attribute=value` pair. A half-set form is rejected at compile time
 * so callers can't silently drop a value and get broader results than
 * they asked for.
 */
export type SearchKnowledgeElementHint =
  | {attribute: string; tag: string; value: string}
  | {tag: string}

/**
 * Options for searchKnowledge operation in ToolsSDK.
 */
export interface SearchKnowledgeOptions {
  /** Pre-filter candidate set by `<bv-*>` element shape before BM25 ranking. */
  elementHint?: SearchKnowledgeElementHint
  /** Maximum number of results to return (default: 10) */
  limit?: number
  /** Path prefix to scope search within (e.g. "auth" or "packages/api") */
  scope?: string
}

/**
 * Result type for searchKnowledge operation.
 */
export interface SearchKnowledgeResult {
  message: string
  results: Array<{
    /** For archive stubs: path to full content (for expand_knowledge tool) */
    archiveFullPath?: string
    /** Number of other memories that reference this one */
    backlinkCount?: number
    excerpt: string
    /** Source format of the topic file ('html' for `<bv-topic>` HTML, 'markdown' for the legacy MD path used by `brv swarm`). */
    format?: 'html' | 'markdown'
    /** Origin: 'local' for this project, 'shared' for results from knowledge source */
    origin?: 'local' | 'shared'
    /** Alias of the shared source (undefined for local results) */
    originAlias?: string
    /** Absolute path to the context tree root this result belongs to. Use join(originContextTreeRoot, path) to read. */
    originContextTreeRoot?: string
    /** Path to .overview.md for this entry; present when L1 overview exists */
    overviewPath?: string
    path: string
    /** Top backlink source paths (max 3) */
    relatedPaths?: string[]
    score: number
    /** Symbol kind: 'domain' | 'topic' | 'subtopic' | 'context' | 'archive_stub' | 'summary' */
    symbolKind?: string
    /** Resolved hierarchical path in the symbol tree */
    symbolPath?: string
    title: string
  }>
  totalFound: number
}

/**
 * Service interface for search knowledge functionality.
 * Allows injection of knowledge search capability into ToolsSDK.
 */
export interface ISearchKnowledgeService {
  search(query: string, options?: SearchKnowledgeOptions): Promise<SearchKnowledgeResult>
}

/**
 * Tools SDK interface exposed to sandbox code execution.
 * Provides async file system operations for programmatic access.
 */
export interface ToolsSDK {
  /**
   * Spawn a sub-agent to process a prompt with full code_exec access.
   * The sub-agent runs in an isolated context (does not pollute parent).
   * Only the final response string flows back.
   * @param prompt - Prompt for the sub-agent
   * @param options - Optional limits
   * @param options.contextData - Optional key/value context injected into child session sandbox
   * @param options.maxIterations - Maximum agentic iterations (default: 5)
   * @returns Promise resolving to the sub-agent's final response
   */
  agentQuery(prompt: string, options?: { contextData?: Record<string, unknown>; maxIterations?: number }): Promise<string>

  /**
   * Execute curate operations on knowledge topics.
   * Operations: ADD, UPDATE, MERGE, DELETE
   * @param operations - Array of curate operations to apply
   * @param options - Curate options (basePath defaults to .brv/context-tree)
   * @returns Promise resolving to curate result with applied operations and summary
   */
  curate(operations: CurateOperation[], options?: CurateOptions): Promise<CurateResult>

  /**
   * Pre-built curation helpers — reduces LLM iteration overhead.
   * Stateless functions except recordProgress (intentionally mutating).
   */
  readonly curation: {
    /** Intelligent boundary-aware text splitting */
    chunk(context: string, options?: {overlap?: number; size?: number}): ChunkResult
    /** Remove near-duplicate facts using Jaccard word-overlap similarity */
    dedup(facts: CurationFact[], threshold?: number): CurationFact[]
    /** Find [USER]: and [ASSISTANT]: markers with offsets */
    detectMessageBoundaries(context: string): MessageBoundary[]
    /** Group facts by subject, with fallback to category */
    groupBySubject(facts: CurationFact[]): Record<string, CurationFact[]>
    /** Parallel LLM extraction over chunked context. Curate mode only. */
    mapExtract(context: string, options: {chunkSize?: number; concurrency?: number; maxContextTokens?: number; prompt: string; taskId?: string}): Promise<{facts: CurationFact[]; failed: number; succeeded: number; total: number}>
    /** Combine Steps 0-2 into one call: metadata + history + preview + mode recommendation */
    recon(context: string, meta: Record<string, unknown>, history: Record<string, unknown>): ReconResult
    /** Push entry into history and increment totalProcessed (intentionally mutating) */
    recordProgress(history: Record<string, unknown>, entry: {domain: string; keyFacts: string[]; title: string}): void
  }

  /**
   * Detect and validate domains from input data.
   * Use this to analyze text and categorize it into knowledge domains.
   * @param domains - Array of detected domains with text segments
   * @returns Promise resolving to validated domains
   */
  detectDomains(domains: DetectDomainsInput[]): Promise<DetectDomainsResult>

  /**
   * Find files matching a glob pattern.
   * @param pattern - Glob pattern (e.g., "**\/*.ts", "src/**\/*.js")
   * @param options - Glob options
   * @returns Promise resolving to glob result with matched files
   */
  glob(pattern: string, options?: GlobOptions): Promise<GlobResult>

  /**
   * Search file contents for a regex pattern.
   * @param pattern - Regular expression pattern to search for
   * @param options - Grep options
   * @returns Promise resolving to search result with matches
   */
  grep(pattern: string, options?: GrepOptions): Promise<SearchResult>

  /**
   * List files and directories in a tree structure.
   * @param path - Directory path (defaults to working directory)
   * @param options - List options
   * @returns Promise resolving to directory listing
   */
  listDirectory(path?: string, options?: ListDirectoryOptions): Promise<ListDirectoryResult>

  /**
   * Read the contents of a file.
   * @param filePath - Path to the file (absolute or relative)
   * @param options - Read options for pagination
   * @returns Promise resolving to file content
   */
  readFile(filePath: string, options?: ReadFileOptions): Promise<FileContent>

  /**
   * Search the curated knowledge base for relevant topics.
   * @param query - Natural language query string
   * @param options - Search options
   * @returns Promise resolving to search results
   */
  searchKnowledge(query: string, options?: SearchKnowledgeOptions): Promise<SearchKnowledgeResult>

  /**
   * Search across all active swarm memory providers.
   * Available in both query and curate modes (read operation).
   * @param query - Natural language search query
   * @param options - Optional limit and scope
   * @returns Promise resolving to ranked results from all active providers
   */
  swarmQuery(query: string, options?: {limit?: number; scope?: string}): Promise<unknown>

  /**
   * Store knowledge in a swarm provider (GBrain, local markdown).
   * Disabled in query (read-only) mode.
   * @param request - Store request with content, optional contentType and provider
   * @returns Promise resolving to store result with provider ID and latency
   */
  swarmStore(request: {content: string; contentType?: 'entity' | 'general' | 'note'; provider?: string}): Promise<unknown>

  /**
   * Write content to a file.
   * @param filePath - Absolute path where the file should be written
   * @param content - Content to write
   * @param options - Write options
   * @returns Promise resolving to write result
   */
  writeFile(filePath: string, content: string, options?: WriteFileOptions): Promise<WriteResult>
}

/**
 * Options for creating a Tools SDK instance.
 */
export interface CreateToolsSDKOptions {
  /** Command type — when 'query', mutating APIs (curate, writeFile) are disabled */
  commandType?: string
  /** Content generator for parallel LLM operations (mapExtract) */
  contentGenerator?: IContentGenerator
  /** Curate service for knowledge curation */
  curateService?: ICurateService
  /** File system service for file operations */
  fileSystem: IFileSystem
  /** Parent session ID for creating child sessions (required for agentQuery) */
  parentSessionId?: string
  /** Project root for write guard validation (blocks writes to shared source context trees) */
  projectRoot?: string
  /** Sandbox service for variable injection into child sessions (optional, enables contextData in agentQuery) */
  sandboxService?: ISandboxService
  /** Search knowledge service */
  searchKnowledgeService?: ISearchKnowledgeService
  /** Session manager for sub-agent delegation (required for agentQuery) */
  sessionManager?: SessionManager
  /** Swarm coordinator for cross-provider query and store (optional) */
  swarmCoordinator?: ISwarmCoordinator
}

/**
 * Creates a Tools SDK instance for sandbox code execution.
 *
 * The SDK provides async wrapper functions around file system operations,
 * allowing code executed in the sandbox to access file system tools programmatically.
 *
 * @param options - Configuration options for the Tools SDK
 * @returns ToolsSDK instance ready to be injected into sandbox context
 */
export function createToolsSDK(options: CreateToolsSDKOptions): ToolsSDK {
  const {commandType, contentGenerator, curateService, fileSystem, parentSessionId, projectRoot, sandboxService, searchKnowledgeService, sessionManager, swarmCoordinator} = options
  const isReadOnly = commandType === 'query'
  return {
    async agentQuery(prompt: string, options?: { contextData?: Record<string, unknown>; maxIterations?: number }): Promise<string> {
      if (!sessionManager || !parentSessionId) {
        throw new Error('agentQuery not available — no session manager configured')
      }

      const childSession = await sessionManager.createChildSession(parentSessionId, 'sub-query')
      try {
        // Inject context data as sandbox variables in child session (RLM pattern).
        // This avoids embedding large data directly in the prompt string.
        if (options?.contextData && sandboxService) {
          for (const [key, value] of Object.entries(options.contextData)) {
            sandboxService.setSandboxVariable(childSession.id, key, value)
          }
        }

        const response = await childSession.run(prompt, {
          emitTaskId: false,
          executionContext: {
            commandType: 'query',
            maxIterations: options?.maxIterations ?? 5,
          },
        })

        return response
      } finally {
        await sessionManager.deleteSession(childSession.id)
      }
    },

    async curate(operations: CurateOperation[], options?: CurateOptions): Promise<CurateResult> {
      if (isReadOnly) {
        throw new Error('curate() is disabled in read-only (query) mode')
      }

      if (!curateService) {
        return {
          applied: [{
            message: 'Curate service not available.',
            path: '',
            status: 'failed',
            type: 'ADD',
          }],
          summary: {
            added: 0,
            deleted: 0,
            failed: 1,
            merged: 0,
            updated: 0,
          },
        }
      }

      return curateService.curate(operations, options)
    },

    curation: {
      chunk,
      dedup,
      detectMessageBoundaries,
      groupBySubject,
      async mapExtract(context: string, options: {chunkSize?: number; concurrency?: number; maxContextTokens?: number; prompt: string; taskId?: string}): Promise<{facts: CurationFact[]; failed: number; succeeded: number; total: number}> {
        if (commandType !== 'curate') {
          throw new Error('mapExtract only available in curate mode')
        }

        if (!contentGenerator) {
          throw new Error('mapExtract not available — no content generator configured')
        }

        const chunks = chunk(context, {size: options.chunkSize ?? 8000})
        const items = chunks.chunks.map((c, i) => ({chunk: c, index: i, totalChunks: chunks.totalChunks}))

        // Construct ContextTreeStore with adapter tokenizer (zero-divergence)
        const tauHard = Math.floor((options.maxContextTokens ?? 100_000) * 0.5)
        const contextTreeStore = new ContextTreeStore({
          generator: contentGenerator,
          tauHard,
          tokenizer: {countTokens: (text: string) => contentGenerator.estimateTokensSync(text)},
        })

        const result = await executeLlmMapMemory({
          concurrency: options.concurrency ?? 8,
          contextTreeStore,
          generator: contentGenerator,
          items,
          prompt: options.prompt,
          taskId: options.taskId,
        })

        // Throw when all chunks fail — no facts to work with
        if (result.succeeded === 0 && result.total > 0) {
          throw new Error(`mapExtract failed: all ${result.total} chunks failed extraction`)
        }

        const facts = result.results
          .filter((r): r is CurationFact[] => r !== null)
          .flat()

        return {facts, failed: result.failed, succeeded: result.succeeded, total: result.total}
      },
      recon,
      recordProgress,
    },

    async detectDomains(domains: DetectDomainsInput[]): Promise<DetectDomainsResult> {
      if (!curateService) {
        return {
          domains: [],
        }
      }

      return curateService.detectDomains(domains)
    },

    async glob(pattern: string, options?: GlobOptions): Promise<GlobResult> {
      return fileSystem.globFiles(pattern, {
        caseSensitive: options?.caseSensitive ?? true,
        cwd: options?.path,
        includeMetadata: true,
        maxResults: options?.maxResults ?? 1000,
        respectGitignore: true,
      })
    },

    async grep(pattern: string, options?: GrepOptions): Promise<SearchResult> {
      return fileSystem.searchContent(pattern, {
        caseInsensitive: options?.caseInsensitive ?? false,
        contextLines: options?.contextLines ?? 0,
        cwd: options?.path,
        globPattern: options?.glob,
        maxResults: options?.maxResults ?? 100,
      })
    },

    async listDirectory(path?: string, options?: ListDirectoryOptions): Promise<ListDirectoryResult> {
      return fileSystem.listDirectory(path ?? '.', {
        ignore: options?.ignore,
        maxResults: options?.maxResults ?? 100,
      })
    },

    async readFile(filePath: string, options?: ReadFileOptions): Promise<FileContent> {
      return fileSystem.readFile(filePath, {
        limit: options?.limit,
        offset: options?.offset,
      })
    },

    async searchKnowledge(query: string, options?: SearchKnowledgeOptions): Promise<SearchKnowledgeResult> {
      if (!searchKnowledgeService) {
        return {
          message: 'Search knowledge service not available.',
          results: [],
          totalFound: 0,
        }
      }

      return searchKnowledgeService.search(query, options)
    },

    async swarmQuery(query: string, queryOptions?: {limit?: number; scope?: string}): Promise<unknown> {
      if (!swarmCoordinator) {
        throw new Error('Swarm query not available — no swarm coordinator configured.')
      }

      return swarmCoordinator.execute({
        maxResults: queryOptions?.limit,
        query,
        scope: queryOptions?.scope,
      })
    },

    async swarmStore(request: {content: string; contentType?: 'entity' | 'general' | 'note'; provider?: string}): Promise<unknown> {
      if (isReadOnly) {
        throw new Error('swarmStore() is disabled in read-only (query) mode')
      }

      if (!swarmCoordinator) {
        throw new Error('Swarm store not available — no swarm coordinator configured.')
      }

      return swarmCoordinator.store({
        content: request.content,
        contentType: request.contentType,
        provider: request.provider,
      })
    },

    async writeFile(filePath: string, content: string, options?: WriteFileOptions): Promise<WriteResult> {
      if (isReadOnly) {
        throw new Error('writeFile() is disabled in read-only (query) mode')
      }

      // Write guard: block writes to shared source context trees
      if (projectRoot) {
        const writeError = validateWriteTarget(filePath, projectRoot)
        if (writeError) {
          throw new Error(writeError)
        }
      }

      return fileSystem.writeFile(filePath, content, {
        createDirs: options?.createDirs ?? false,
      })
    },
  }
}
