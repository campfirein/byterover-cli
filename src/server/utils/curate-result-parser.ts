import {z} from 'zod'

import type {CurateLogOperation, ReviewIntegrity} from '../core/domain/entities/curate-log-entry.js'
import type {LlmToolResultEvent} from '../core/domain/transport/schemas.js'

// ── Zod schemas ──────────────────────────────────────────────────────────────

export const CurateOperationSchema = z.object({
  additionalFilePaths: z.array(z.string()).optional(),
  confidence: z.enum(['high', 'low']).optional(),
  filePath: z.string().optional(),
  impact: z.enum(['high', 'low']).optional(),
  message: z.string().optional(),
  needsReview: z.boolean().optional(),
  path: z.string(),
  previousSummary: z.string().optional(),
  reason: z.string().optional(),
  reviewStatus: z.enum(['approved', 'pending', 'rejected']).optional(),
  status: z.enum(['failed', 'success']),
  summary: z.string().optional(),
  type: z.enum(['ADD', 'DELETE', 'MERGE', 'UPDATE', 'UPSERT']),
})

export const CurateResultSchema = z.object({
  applied: z.array(CurateOperationSchema).optional(),
  summary: z
    .object({
      added: z.number().optional(),
      deleted: z.number().optional(),
      failed: z.number().optional(),
      merged: z.number().optional(),
      updated: z.number().optional(),
    })
    .optional(),
})

const CapturedCurateOperationSchema = CurateOperationSchema.extend({
  confidence: z.enum(['high', 'low']),
  impact: z.enum(['high', 'low']),
  needsReview: z.boolean(),
  reason: z.string(),
}).superRefine((operation, context) => {
  if (operation.status !== 'success') return
  const policyRequiresReview = operation.type === 'DELETE' || operation.impact === 'high'
  if (operation.needsReview !== policyRequiresReview) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      message: 'needsReview contradicts ByteRover 3.16.1 review policy',
      path: ['needsReview'],
    })
  }
})

const CapturedCurateResultSchema = z.object({
  applied: z.array(CapturedCurateOperationSchema),
})

const CapturedCodeExecResultSchema = z.object({
  curateResults: z.array(CapturedCurateResultSchema).min(1),
})

export type CurateOperationCapture = {
  operations: CurateLogOperation[]
  reviewIntegrity?: ReviewIntegrity
}

// ── Internal helpers ──────────────────────────────────────────────────────────

/**
 * Extract a curate result from a code_exec sandbox result.
 *
 * Supports 4 patterns in order of priority:
 *  0. `curateResults` — injected by SandboxService accumulator (most reliable)
 *                       captures ALL tools.curate() calls regardless of how
 *                       the LLM stores the result (const, var, return, etc.)
 *  1. `returnValue`   — when the LLM code uses `return await tools.curate(...)`
 *  2. `stdout`        — when the LLM code uses `console.log(JSON.stringify(...))`
 *  3. `locals`        — when the LLM code uses `var r = await tools.curate(...)`
 *                       (var declarations end up in locals; const/let do not)
 *
 * For the `locals` strategy, all local values are scanned and any arrays named
 * `applied` are merged, supporting multiple curate() calls in a single code block.
 */
export function extractCurateResultFromCodeExec(resultData: Record<string, unknown>): unknown {
  // Strategy 0: SandboxService curate accumulator (most reliable — works for any LLM code pattern).
  // Only present when SandboxService.setCurateService() has been called (i.e. curate tasks, not query tasks).
  if (Array.isArray(resultData.curateResults) && resultData.curateResults.length > 0) {
    const appliedItems: unknown[] = []
    for (const curateResult of resultData.curateResults) {
      const parsed = CurateResultSchema.safeParse(curateResult)
      if (parsed.success && Array.isArray(parsed.data.applied)) {
        appliedItems.push(...parsed.data.applied)
      }
    }

    if (appliedItems.length > 0) return {applied: appliedItems}
  }

  // Strategy 1: explicit return value
  if (resultData.returnValue !== undefined && resultData.returnValue !== null) {
    return resultData.returnValue
  }

  // Strategy 2: JSON-serialized stdout
  if (typeof resultData.stdout === 'string' && resultData.stdout.trim()) {
    try {
      return JSON.parse(resultData.stdout.trim())
    } catch {
      // Not JSON — fall through to locals
    }
  }

  // Strategy 3: scan locals for CurateOutput-shaped objects (var declarations only)
  const {locals} = resultData
  if (!locals || typeof locals !== 'object' || Array.isArray(locals)) {
    return undefined
  }

  const appliedItems: unknown[] = []
  for (const value of Object.values(locals as Record<string, unknown>)) {
    const parsed = CurateResultSchema.safeParse(value)
    if (parsed.success && Array.isArray(parsed.data.applied) && parsed.data.applied.length > 0) {
      appliedItems.push(...parsed.data.applied)
    }
  }

  if (appliedItems.length === 0) return undefined

  return {applied: appliedItems}
}

// ── Public API ────────────────────────────────────────────────────────────────

/**
 * Extract curate operations from an llmservice:toolResult event.
 *
 * Only processes `toolName === 'curate'` or `toolName === 'code_exec'`.
 * Returns an empty array for all other tools.
 *
 * The `result` field is always a JSON string (ToolOutputProcessor stringifies all tool
 * output before emitting the event). We JSON-parse it before extracting operations.
 *
 * @param payload - The tool result event payload
 * @param filter - Optional predicate to filter individual operations (e.g. success-only)
 */
export function extractCurateOperations(
  payload: Pick<LlmToolResultEvent, 'lifecycleResult' | 'result' | 'toolName'>,
  filter?: (op: CurateLogOperation) => boolean,
): CurateLogOperation[] {
  const {lifecycleResult, result: rawPayload, toolName} = payload

  if (lifecycleResult !== undefined) {
    const capture = extractCurateOperationCapture(payload)
    return filter ? capture.operations.filter((op) => filter(op)) : capture.operations
  }

  // ToolOutputProcessor always stringifies tool output — parse if string
  let result: unknown = rawPayload
  if (typeof rawPayload === 'string') {
    try {
      result = JSON.parse(rawPayload)
    } catch {
      return []
    }
  }

  let rawResult: unknown = result

  if (toolName === 'code_exec') {
    if (!result || typeof result !== 'object') return []
    rawResult = extractCurateResultFromCodeExec(result as Record<string, unknown>)
  } else if (toolName !== 'curate') {
    return []
  }

  const parsed = CurateResultSchema.safeParse(rawResult)
  if (!parsed.success || !parsed.data.applied) return []

  const ops: CurateLogOperation[] = parsed.data.applied
  return filter ? ops.filter((op) => filter(op)) : ops
}

/** Validate the internal, pre-truncation curation operation channel. */
export function extractCurateOperationCapture(
  payload: Pick<LlmToolResultEvent, 'lifecycleResult' | 'toolName'>,
): CurateOperationCapture {
  const {lifecycleResult, toolName} = payload

  if (toolName === 'curate') {
    const parsed = CapturedCurateResultSchema.safeParse(lifecycleResult)
    if (!parsed.success) {
      return {
        operations: [],
        reviewIntegrity: {reason: 'Invalid direct curate lifecycle result', status: 'unresolved'},
      }
    }

    return {operations: parsed.data.applied, reviewIntegrity: {status: 'verified'}}
  }

  if (toolName === 'code_exec') {
    if (lifecycleResult === undefined) return {operations: []}
    const parsed = CapturedCodeExecResultSchema.safeParse(lifecycleResult)
    if (!parsed.success) {
      return {
        operations: [],
        reviewIntegrity: {reason: 'Invalid code_exec curate lifecycle result', status: 'unresolved'},
      }
    }

    return {
      operations: parsed.data.curateResults.flatMap((curateResult) => curateResult.applied),
      reviewIntegrity: {status: 'verified'},
    }
  }

  return {operations: []}
}
