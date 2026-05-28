import path from 'node:path'

import type {ICipherAgent} from '../../../agent/core/interfaces/i-cipher-agent.js'
import type {CurationStatus} from '../../core/domain/entities/curation-status.js'
import type {CurateExecuteOptions, ICurateExecutor} from '../../core/interfaces/executor/i-curate-executor.js'

import {recon as reconHelper} from '../../../agent/infra/sandbox/curation-helpers.js'
import {BRV_DIR, CONTEXT_TREE_DIR} from '../../constants.js'
import {FileValidationError} from '../../core/domain/errors/task-error.js'
import {
  createFileContentReader,
  type FileContentReader,
  type FileReadResult,
} from '../../utils/file-content-reader.js'
import {validateFileForCurate} from '../../utils/file-validator.js'
import {FileContextTreeManifestService} from '../context-tree/file-context-tree-manifest-service.js'
import {FileContextTreeSnapshotService} from '../context-tree/file-context-tree-snapshot-service.js'
import {diffStates} from '../context-tree/snapshot-diff.js'
import {DreamStateService} from '../dream/dream-state-service.js'
import {writeHtmlTopic} from '../render/writer/html-writer.js'
import {PreCompactionService} from './pre-compaction/pre-compaction-service.js'

type BackgroundDrainAgent = ICipherAgent & {drainBackgroundWork?: () => Promise<void>}

/**
 * CurateExecutor - Executes curate tasks with an injected CipherAgent.
 *
 * This is NOT a UseCase (which orchestrates business logic).
 * It's an Executor that wraps agent.execute() with curate-specific options.
 *
 * Architecture:
 * - AgentProcess injects the long-lived CipherAgent
 * - Event streaming is handled by agent-process (subscribes to agentEventBus)
 * - Transport handles task lifecycle (task:started, task:completed, task:error)
 * - Executor focuses solely on curate execution
 */
export class CurateExecutor implements ICurateExecutor {
  /** Maximum content length per file in characters */
  private static readonly MAX_CONTENT_PER_FILE = 40_000
  /** Maximum number of files allowed in --files flag */
  private static readonly MAX_FILES = 5
  /** Maximum lines to read for text files */
  private static readonly MAX_LINES_PER_FILE = 2000
  /** Maximum pages to extract for PDFs */
  private static readonly MAX_PDF_PAGES = 50
  /** Last curation status — available for future status-check command */
  public lastStatus?: CurationStatus
  private readonly fileContentReader: FileContentReader
  private readonly preCompactionService = new PreCompactionService()

  constructor(fileContentReader?: FileContentReader) {
    this.fileContentReader = fileContentReader ?? createFileContentReader()
  }

  /** Synchronous wrapper — runs Phases 1-3 and awaits Phase 4 inline. */
  public async executeWithAgent(agent: ICipherAgent, options: CurateExecuteOptions): Promise<string> {
    const {finalize, response} = await this.runAgentBody(agent, options)
    await finalize()
    return response
  }

  /**
   * Returns the response after Phases 1-3 plus a `finalize` thunk for Phase 4
   * (snapshot diff, summary regen, manifest rebuild, dream counter, drain,
   * task-session cleanup). Caller invokes `finalize` exactly once. The thunk
   * is fail-open. If the agent body itself throws, the task session is cleaned
   * up before propagating and no `finalize` is returned.
   */
  public async runAgentBody(
    agent: ICipherAgent,
    options: CurateExecuteOptions,
  ): Promise<{finalize: () => Promise<void>; response: string}> {
    const {clientCwd, content, files, projectRoot, taskId} = options
    const startedAt = Date.now()

    // --- Phase 1: Preprocessing (no sessions created yet — safe to throw) ---
    const fileReferenceInstructions = await this.processFileReferences(files ?? [], clientCwd)
    const fullContext = fileReferenceInstructions ? `${content}\n${fileReferenceInstructions}` : content

    // --- Phase 2: Pre-compaction (fail-open, manages its own session lifecycle) ---
    const compactionResult = await this.preCompactionService.compact(agent, fullContext, taskId)
    const effectiveContext = compactionResult.context

    // --- Phase 3: Curation (session created AFTER preprocessing + compaction) ---
    // Capture pre-curation state for snapshot diff (summary propagation)
    // Post-processing (snapshot, summary, manifest) operates on projectRoot where .brv/ lives.
    // worktreeRoot is a linked subdir — .brv/ does not exist there in linked setups.
    const baseDir = projectRoot ?? clientCwd ?? process.cwd()
    const snapshotService = new FileContextTreeSnapshotService({baseDirectory: baseDir})
    let preState: Map<string, import('../../core/domain/entities/context-tree-snapshot.js').FileState> | undefined
    try {
      preState = await snapshotService.getCurrentState(baseDir)
    } catch {
      // Fail-open: if snapshot fails, skip summary propagation
    }

    const taskSessionId = await agent.createTaskSession(taskId, 'curate', {mapRootEligible: true, userFacing: true})

    let response: string
    try {
      // Task-scoped variable names for RLM pattern.
      // Replace hyphens with underscores: UUIDs have hyphens which are invalid in JS identifiers,
      // so the LLM would naturally use underscores when writing code-exec calls — causing a
      // ReferenceError if the variable was stored under the hyphen version.
      const taskIdSafe = taskId.replaceAll('-', '_')
      const ctxVar = `__curate_ctx_${taskIdSafe}`
      const histVar = `__curate_hist_${taskIdSafe}`
      const metaVar = `__curate_meta_${taskIdSafe}`

      // Compute context metadata (RLM pattern — LM sees metadata, not raw content)
      const contextLines = effectiveContext.split('\n')
      const metadata = {
        charCount: effectiveContext.length,
        lineCount: contextLines.length,
        messageCount: (effectiveContext.match(/\n\n\[(USER|ASSISTANT)\]:/g) || []).length,
        ...(compactionResult.preCompacted && {
          originalCharCount: compactionResult.originalCharCount,
          preCompacted: true,
          preCompactionTier: compactionResult.preCompactionTier,
        }),
        preview: effectiveContext.slice(0, 500),
        type: 'string',
      }

      // Pre-pipeline the recon step (deterministic helper) so the agent loop
      // doesn't spend its first iteration calling tools.curation.recon. The
      // result is injected as a sandbox variable for code-exec access AND
      // its key findings are surfaced inline in the prompt so the agent's
      // first iteration can proceed directly to extraction. recon is pure
      // JS — no LLM judgment is needed for whether to call it; the answer
      // is always "yes, first thing." Surfacing it as an agent-tool meant
      // paying a full LLM iteration just to invoke a deterministic helper.
      const initialHistory = {entries: [], totalProcessed: 0}
      // The `metadata` arg is currently unused by `recon` — the helper
      // recomputes char/line/message counts from `effectiveContext`
      // directly. Passed through here to match the helper's existing
      // signature; do NOT assume changing `metadata` will alter
      // `reconResult`.
      const reconResult = reconHelper(effectiveContext, metadata, initialHistory)
      const reconVar = `__recon_result_${taskIdSafe}`

      // Inject context, metadata, empty history, taskId, and pre-computed
      // recon result into the TASK session's sandbox.
      const taskIdVar = `__taskId_${taskIdSafe}`
      agent.setSandboxVariableOnSession(taskSessionId, ctxVar, effectiveContext)
      agent.setSandboxVariableOnSession(taskSessionId, histVar, initialHistory)
      agent.setSandboxVariableOnSession(taskSessionId, metaVar, metadata)
      agent.setSandboxVariableOnSession(taskSessionId, taskIdVar, taskId)
      agent.setSandboxVariableOnSession(taskSessionId, reconVar, reconResult)

      // Prompt with curation helpers guidance (tools.curation.* replaces manual infrastructure code).
      // The agent's final response is the bv-topic HTML document — the curate
      // tool description (curate.txt) defines the output contract. Calling
      // tools.curate would write a sibling `.md` file and conflict with the
      // HTML written from the response, so it is explicitly forbidden.
      const prompt = [
        `Curate using RLM approach.`,
        `Context variable: ${ctxVar} (${metadata.charCount} chars, ${metadata.lineCount} lines, ${metadata.messageCount} messages)`,
        `History variable: ${histVar}`,
        `Metadata variable: ${metaVar}`,
        `Task ID variable: ${taskIdVar} (pass as bare variable, not a string)`,
        `Recon already computed in ${reconVar}: suggestedMode=${reconResult.suggestedMode}, suggestedChunkCount=${reconResult.suggestedChunkCount}, charCount=${reconResult.meta.charCount}, lineCount=${reconResult.meta.lineCount}, messageCount=${reconResult.meta.messageCount}.`,
        `IMPORTANT: Do NOT print raw context. Do NOT call tools.curation.recon — it has been pre-computed. Proceed directly to extraction.`,
        `For chunked extraction use tools.curation.mapExtract(). Pass taskId: ${taskIdVar} (bare variable).`,
        `IMPORTANT: Any code_exec call containing mapExtract MUST use timeout: 300000 on the code_exec tool call itself (not inside mapExtract options).`,
        `Use tools.curation.groupBySubject() and tools.curation.dedup() to organize extractions.`,
        `IMPORTANT: After all extraction, your FINAL RESPONSE is the HTML topic document per the curate tool description (single <bv-topic>...</bv-topic> root, no code fence). Do NOT call tools.curate — emit HTML directly as your final reply.`,
      ].join('\n')

      // Execute on the task session (isolated sandbox + history)
      // Task lifecycle is managed by Transport (task:started, task:completed, task:error)
      response = await agent.executeOnSession(taskSessionId, prompt, {
        executionContext: {clearHistory: true, commandType: 'curate', maxIterations: 50},
        taskId,
      })

      // The response is the bv-topic document; route through the html-writer
      // for fence-stripping, registry validation, and atomic write.
      this.lastStatus = await this.handleHtmlCurateResponse(taskId, response, baseDir)
    } catch (error) {
      // Best-effort: report partial telemetry before throwing so failed curates
      // don't underreport cost. The handler's error-finalization path picks up
      // the telemetry merge if the CURATE_RESULT message lands first.
      this.reportTelemetry(options, startedAt)
      // Clean up before propagating — error path returns no finalize.
      await agent.deleteTaskSession(taskSessionId)
      throw error
    }

    // Happy path: forward telemetry before returning so the wiring layer can
    // emit `task:curateResult` ahead of `task:completed`.
    this.reportTelemetry(options, startedAt)

    const finalize = async (): Promise<void> => {
      try {
        await this.propagateAndRebuild({baseDir, preState, snapshotService})
        await this.incrementDreamCounter(baseDir)
        await (agent as BackgroundDrainAgent).drainBackgroundWork?.()
      } finally {
        // In `finally` so the session is deleted even if Phase 4 throws.
        await agent.deleteTaskSession(taskSessionId)
      }
    }

    return {finalize, response}
  }

  /**
   * Format file contents for inclusion in the prompt.
   */
  private formatFileContentsForPrompt(
    readResults: FileReadResult[],
    skippedFiles: Array<{path: string; reason: string}>,
    projectRoot: string,
  ): string {
    const instructions: string[] = ['\n## File Contents (pre-loaded from --files flag)', '']

    // Separate successful and failed reads
    const successfulReads = readResults.filter((r) => r.success)
    const failedReads = readResults.filter((r) => !r.success)

    // Add successful file contents
    for (const result of successfulReads) {
      const relativePath = path.relative(projectRoot, result.filePath)
      const typeLabel = this.getFileTypeLabel(result.fileType)
      const truncatedNote = result.metadata?.truncated ? ' [truncated]' : ''

      instructions.push(`### File: ${relativePath} (${typeLabel}${truncatedNote})`, '```', result.content, '```', '')
    }

    // Add warnings for failed reads and skipped files
    if (failedReads.length > 0 || skippedFiles.length > 0) {
      instructions.push(
        '### Files that could not be read:',
        ...failedReads.map((r) => `- ${path.relative(projectRoot, r.filePath)}: ${r.error}`),
        ...skippedFiles.map((f) => `- ${f.path}: ${f.reason}`),
        '',
        '**Note:** You may use `read_file` or `grep_content` tools to find additional context if needed.',
        '',
      )
    }

    instructions.push(
      '**INSTRUCTIONS:**',
      '- The file contents above have been pre-loaded for you',
      '- Use this content to understand the context and create comprehensive knowledge topics',
      '- DO NOT use read_file tool for the files above - the content is already provided',
      '- Proceed with the normal workflow: detect domains, find existing knowledge, create/update topics',
      '- PRESERVE all diagrams (Mermaid, PlantUML, ASCII art) verbatim using narrative.diagrams array',
      '- PRESERVE all tables with every row - do not summarize table data',
      '- PRESERVE exact code examples, API signatures, and interface definitions',
      '- PRESERVE step-by-step procedures and numbered instructions in narrative.rules',
      '',
    )

    return instructions.join('\n')
  }

  /**
   * Get human-readable label for file type.
   */
  private getFileTypeLabel(fileType: string): string {
    switch (fileType) {
      case 'office': {
        return 'Office Document'
      }

      case 'pdf': {
        return 'PDF'
      }

      case 'text': {
        return 'Text'
      }

      default: {
        return fileType
      }
    }
  }

  /**
   * HTML-mode response handler.
   *
   * The agent's final response is expected to be a single `<bv-topic>`
   * HTML document. We route it through `writeHtmlTopic` (which strips
   * any code-fence wrapper, validates against the element registry,
   * and atomically writes to `<baseDir>/.brv/context-tree/<path>.html`).
   *
   * On failure we emit a `failed` curation status with `failed=1`
   * rather than throwing — the surrounding executor still wants to run
   * Phase 4 (snapshot diff, manifest rebuild) so subsequent reads see a
   * consistent tree. Errors are surfaced through `lastStatus` and the
   * structured curate-log entry.
   */
  private async handleHtmlCurateResponse(
    taskId: string,
    response: string,
    baseDir: string,
  ): Promise<CurationStatus> {
    const completedAt = new Date().toISOString()
    const defaultVerification = {checked: 0, confirmed: 0, missing: [] as string[]}
    const contextTreeRoot = path.join(baseDir, BRV_DIR, CONTEXT_TREE_DIR)

    let writeResult
    try {
      // `confirmOverwrite: true` bypasses the writer's path-exists guard.
      // The legacy in-daemon agent path has its own supervisory context:
      // the agent runs search + read before deciding to write, and the
      // surrounding executor lifecycle drives `pendingReview` snapshot /
      // approval for UPDATE operations. The guard is intended specifically
      // for tool mode where the calling agent lacks that machinery.
      writeResult = await writeHtmlTopic({confirmOverwrite: true, contextTreeRoot, rawHtml: response})
    } catch (error) {
      // Hard error (path traversal, I/O failure). Surface as `failed`
      // status; the executor's caller logs the error.
      return {
        completedAt,
        status: 'failed',
        summary: {added: 0, deleted: 0, failed: 1, merged: 0, updated: 0},
        taskId,
        verification: {...defaultVerification, missing: [(error as Error).message]},
      }
    }

    if (!writeResult.ok) {
      return {
        completedAt,
        status: 'failed',
        summary: {added: 0, deleted: 0, failed: 1, merged: 0, updated: 0},
        taskId,
        verification: {
          ...defaultVerification,
          missing: writeResult.errors.map((e) => {
            // Surface tag.field for attribute-validation so the
            // curate-log shows e.g. `attribute-validation
            // (bv-rule.severity): …` instead of just
            // `attribute-validation (bv-rule): …`.
            const qualifier = 'tag' in e
              ? ` (${e.tag}${'field' in e ? `.${e.field}` : ''})`
              : ''
            return `${e.kind}${qualifier}: ${e.message}`
          }),
        },
      }
    }

    return {
      completedAt,
      status: 'success',
      // ADD vs UPDATE is derived from path-existence; the writer
      // doesn't currently expose which one happened. Treat as "added=1"
      // for status-tracking purposes; downstream bench analysis
      // distinguishes via the snapshot diff, not via this counter.
      summary: {added: 1, deleted: 0, failed: 0, merged: 0, updated: 0},
      taskId,
      verification: {checked: 1, confirmed: 1, missing: []},
    }
  }

  /**
   * Phase 4d: bump the dream-state curation counter. Fail-open — dream state
   * tracking is non-critical and must never block curate completion.
   */
  private async incrementDreamCounter(baseDir: string): Promise<void> {
    try {
      const dreamStateService = new DreamStateService({baseDir: path.join(baseDir, BRV_DIR)})
      await dreamStateService.incrementCurationCount()
    } catch {
      // Dream state tracking is non-critical
    }
  }

  /**
   * Process file paths from --files flag.
   * Now reads file contents directly using FileContentReader.
   *
   * @param filePaths - Array of file paths (relative or absolute)
   * @param clientCwd - Client's working directory for file validation (optional, defaults to process.cwd())
   * @returns Formatted content with pre-read file contents
   * @throws {FileValidationError} If all files fail validation
   */
  private async processFileReferences(filePaths: string[], clientCwd?: string): Promise<string> {
    if (!filePaths || filePaths.length === 0) {
      return ''
    }

    // Truncate if exceeds max files
    let processedPaths = filePaths
    if (filePaths.length > CurateExecutor.MAX_FILES) {
      processedPaths = filePaths.slice(0, CurateExecutor.MAX_FILES)
    }

    const projectRoot = clientCwd ?? process.cwd()

    // Validate each file - skip non-existent files with warnings instead of failing
    const validPaths: string[] = []
    const skippedFiles: Array<{path: string; reason: string}> = []

    for (const filePath of processedPaths) {
      const result = validateFileForCurate(filePath, projectRoot)

      if (result.valid && result.normalizedPath) {
        validPaths.push(result.normalizedPath)
      } else {
        // Skip non-existent files instead of failing - agent can use grep to find alternatives
        skippedFiles.push({path: filePath, reason: result.error ?? 'Unknown error'})
      }
    }

    // If all files were skipped, throw an error
    if (validPaths.length === 0 && processedPaths.length > 0) {
      const errorMessage = `All specified files are invalid or do not exist:\n${skippedFiles.map((f) => `  - ${f.path}: ${f.reason}`).join('\n')}\n\nTry using grep to find the correct file paths.`
      throw new FileValidationError(errorMessage)
    }

    // Read file contents using FileContentReader
    const readResults = await this.fileContentReader.readFiles(validPaths, {
      maxContentLength: CurateExecutor.MAX_CONTENT_PER_FILE,
      maxLinesPerFile: CurateExecutor.MAX_LINES_PER_FILE,
      maxPdfPages: CurateExecutor.MAX_PDF_PAGES,
    })

    // Format with actual content
    return this.formatFileContentsForPrompt(readResults, skippedFiles, projectRoot)
  }

  /**
   * Phase 4: snapshot diff → enqueue stale paths for dream → rebuild manifest.
   *
   * Summary cascade regeneration (the LLM-driven `propagateStaleness` walk) is
   * deferred to the next dream cycle to keep curate's hot path free of LLM
   * calls. The manifest is rebuilt inline because it is a pure file scan (no
   * LLM) and keeps newly-curated leaf files immediately discoverable via
   * manifest-driven retrieval.
   *
   * Two independent fail-open concerns: (a) enqueue the deferred summary-cascade
   * work to dream's queue; (b) rebuild the search manifest. They share
   * `changedPaths` but otherwise are unrelated — a transient disk error on the
   * dream-state write must not skip the pure-filesystem manifest scan. Each
   * runs in its own try block so one failure cannot mask the other's work.
   */
  private async propagateAndRebuild(args: {
    baseDir: string
    preState: Map<string, import('../../core/domain/entities/context-tree-snapshot.js').FileState> | undefined
    snapshotService: FileContextTreeSnapshotService
  }): Promise<void> {
    const {baseDir, preState, snapshotService} = args
    if (!preState) return

    let changedPaths: string[] = []
    try {
      const postState = await snapshotService.getCurrentState(baseDir)
      changedPaths = diffStates(preState, postState)
    } catch {
      // Fail-open: snapshot errors leave changedPaths empty → no enqueue,
      // no manifest rebuild. Next curate's snapshot will pick up the diff.
    }

    if (changedPaths.length === 0) return

    try {
      const dreamStateService = new DreamStateService({baseDir: path.join(baseDir, BRV_DIR)})
      await dreamStateService.enqueueStaleSummaryPaths(changedPaths)
    } catch {
      // Fail-open: queue write errors never block curation. If this write
      // fails the changed paths are lost from the deferred queue; they will
      // only be re-captured if the same files are modified in a later curate
      // (diffStates compares a fresh pre/post snapshot pair, not a persistent
      // accumulator) or picked up by dream's own snapshot diff if dream
      // touches them.
    }

    try {
      const manifestService = new FileContextTreeManifestService({baseDirectory: baseDir})
      await manifestService.buildManifest(baseDir)
    } catch {
      // Fail-open: manifest rebuild is best-effort pre-warming.
    }
  }

  /**
   * Roll up the executor's per-task telemetry and hand it to
   * {@link CurateExecuteOptions.onTelemetry}. Best-effort: a thrown callback
   * doesn't propagate (logging must never block curate).
   *
   * `format` is `'html'` because the curate path emits HTML topic
   * documents end-to-end. Legacy markdown topics are still readable via
   * the query path's extension-based dispatcher, but no curate run
   * produces them.
   */
  private reportTelemetry(options: CurateExecuteOptions, startedAt: number): void {
    if (!options.onTelemetry) return
    const totalMs = Date.now() - startedAt
    const totals = options.usageAggregator?.getTotals()
    const llmMs = options.usageAggregator?.getLlmMs() ?? 0
    const usage = totals && (totals.inputTokens > 0 || totals.outputTokens > 0) ? totals : undefined
    try {
      options.onTelemetry({
        format: 'html',
        timing: {
          ...(llmMs > 0 && {llmMs}),
          totalMs,
        },
        ...(usage !== undefined && {usage}),
      })
    } catch {
      // best-effort — telemetry must never block curate
    }
  }
}
