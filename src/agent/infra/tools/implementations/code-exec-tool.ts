import { z } from 'zod'

import type { Tool, ToolExecutionContext } from '../../../core/domain/tools/types.js'
import type { ISandboxService } from '../../../core/interfaces/i-sandbox-service.js'

import { DEFAULT_SANDBOX_TIMEOUT, MAX_SANDBOX_TIMEOUT } from '../../../core/domain/sandbox/constants.js'
import { ToolName } from '../../../core/domain/tools/constants.js'

/**
 * Input schema for code_exec tool.
 */
const CodeExecInputSchema = z
  .object({
    /**
     * JavaScript or TypeScript code to execute.
     */
    code: z.string().describe('JavaScript or TypeScript code to execute'),

    /**
     * Context data available as "context" variable in the sandbox.
     */
    context: z
      .union([z.string(), z.record(z.unknown()), z.array(z.unknown())])
      .optional()
      .describe('Context data available as "context" variable'),

    /**
     * Language: "javascript" or "typescript" (default: auto-detect).
     */
    language: z
      .enum(['javascript', 'typescript'])
      .optional()
      .describe('Language: "javascript" or "typescript" (default: auto-detect)'),

    /**
     * If true, stdout is suppressed from the result (stderr still returned).
     * Use for variable assignments or mutations where output is not needed.
     */
    silent: z
      .boolean()
      .optional()
      .describe('If true, stdout is suppressed from the result. Use for variable assignments where output is not needed.'),

    /**
     * Timeout in milliseconds (max: 300000, default: 30000 = 30 seconds).
     */
    timeout: z
      .number()
      .int()
      .positive()
      .max(MAX_SANDBOX_TIMEOUT)
      .optional()
      .default(DEFAULT_SANDBOX_TIMEOUT)
      .describe('Timeout in milliseconds (default: 30 seconds, max: 5 minutes)'),
  })
  .strict()

/**
 * Input type for code_exec tool.
 */
type CodeExecInput = z.infer<typeof CodeExecInputSchema>

/**
 * Create code_exec tool.
 *
 * Executes JavaScript/TypeScript code in a sandboxed REPL environment.
 * Features:
 * - Auto-detects and transpiles TypeScript
 * - State persists within the same agent session
 * - Pre-loaded utility packages (lodash, date-fns, zod, etc.)
 * - Security: blocks eval, Function, require, process, etc.
 *
 * @param sandboxService - Sandbox service for code execution
 * @returns code_exec tool instance
 */
export function createCodeExecTool(sandboxService: ISandboxService): Tool {
  return {
    description: 'Execute JavaScript or TypeScript code in a sandboxed REPL environment.',

    async execute(input: unknown, context?: ToolExecutionContext) {
      const { code, context: contextPayload, language, silent, timeout } = input as CodeExecInput

      // Get sessionId from execution context (automatic - no user input needed)
      const sessionId = context?.sessionId ?? 'default'

      // Stream initial status via metadata callback if available
      if (context?.metadata) {
        context.metadata({
          description: 'Executing code...',
          output: '',
          progress: 0,
        })
      }

      // Cap stdout per command type to prevent context overflow
      // curate: 5K (heavy processing, context in variables), query: 8K (results in variables)
      const maxStdoutChars = context?.commandType === 'curate' ? 5000
        : context?.commandType === 'query' ? 8000
        : undefined

      const result = await sandboxService.executeCode(code, sessionId, {
        commandType: context?.commandType,
        contextPayload,
        language,
        maxStdoutChars,
        timeout,
      })

      // Auto-redirect large outputs to sandbox variable for RLM commands.
      // This prevents large tool results from bloating conversation history.
      const AUTO_REDIRECT_THRESHOLD = 2000
      if (
        !silent
        && result.stdout.length > AUTO_REDIRECT_THRESHOLD
        && (context?.commandType === 'curate' || context?.commandType === 'query')
      ) {
        const overflowVar = `__stdout_${Date.now()}`
        sandboxService.setSandboxVariable(sessionId, overflowVar, result.stdout)

        // Stream completion via metadata callback if available
        if (context?.metadata) {
          context.metadata({
            description: result.stderr ? 'Execution completed with errors' : 'Execution completed (output stored in variable)',
            output: `[Output stored in ${overflowVar}]` + (result.stderr ? `\n[stderr]\n${result.stderr}` : ''),
            progress: 100,
          })
        }

        return {
          ...(result.curateResults === undefined ? {} : {curateResults: result.curateResults}),
          executionTime: result.executionTime,
          finalResult: result.finalResult,
          locals: result.locals,
          returnValue: result.returnValue,
          stderr: result.stderr,
          stdout: `[Output (${result.stdout.length} chars) stored in variable: ${overflowVar}. Access via code_exec.]`,
        }
      }

      // Stream completion via metadata callback if available
      if (context?.metadata) {
        context.metadata({
          description: result.stderr ? 'Execution completed with errors' : 'Execution completed',
          output: result.stdout + (result.stderr ? `\n[stderr]\n${result.stderr}` : ''),
          progress: 100,
        })
      }

      return {
        ...(result.curateResults === undefined ? {} : {curateResults: result.curateResults}),
        executionTime: result.executionTime,
        finalResult: result.finalResult,
        locals: result.locals,
        returnValue: result.returnValue,
        stderr: result.stderr,
        stdout: silent ? '' : result.stdout,
      }
    },

    id: ToolName.CODE_EXEC,
    inputSchema: CodeExecInputSchema,
  }
}
