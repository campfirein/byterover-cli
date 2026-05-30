import {z} from 'zod'

import {RuntimeSignalsSchema} from '../../core/domain/knowledge/runtime-signals-schema.js'

// ── Operation schemas (discriminated on type) ────────────────────────────────

const ConsolidateOperationSchema = z.object({
  action: z.enum(['MERGE', 'TEMPORAL_UPDATE', 'CROSS_REFERENCE']),
  inputFiles: z.array(z.string()),
  needsReview: z.boolean(),
  outputFile: z.string().optional(),
  previousTexts: z.record(z.string(), z.string()).optional(),
  reason: z.string(),
  type: z.literal('CONSOLIDATE'),
})

const SynthesizeOperationSchema = z.object({
  action: z.enum(['CREATE', 'UPDATE']),
  confidence: z.number().min(0).max(1),
  needsReview: z.boolean(),
  outputFile: z.string(),
  sources: z.array(z.string()),
  type: z.literal('SYNTHESIZE'),
})

const PruneOperationSchema = z.object({
  action: z.enum(['ARCHIVE', 'KEEP', 'SUGGEST_MERGE']),
  file: z.string(),
  mergeTarget: z.string().optional(),
  needsReview: z.boolean(),
  /**
   * mtime (ms since epoch) of each archived file captured before the
   * rename, so undo can restore the original mtime via `utimes()`
   * rather than letting `writeFile` stamp the restore wall-clock. Keys
   * are relative paths under `.brv/context-tree/`. Backward-compat
   * optional — older log entries written before this field existed
   * still undo cleanly (file restored, mtime reset to now).
   */
  previousMtimes: z.record(z.string(), z.number()).optional(),
  /**
   * Snapshot of each archived file's runtime signals (importance,
   * maturity, accessCount, etc.) captured before the sidecar entry is
   * deleted. Restored by undo so prune-candidate signals (e.g.
   * `importance: 15`) survive an archive→undo round-trip. Without this,
   * a topic archived as `low-importance` returns with default
   * `importance=50` and won't re-surface on the next prune scan.
   * Backward-compat optional — older logs still undo with default signals.
   */
  previousSignals: z.record(z.string(), RuntimeSignalsSchema).optional(),
  // Tool-mode finalize captures the file's content before archiving so undo
  // can restore from the log alone (no archive-service / stub indirection).
  // Legacy LLM-driven prune still uses stubPath; both forms are supported by
  // dream-undo at runtime.
  previousTexts: z.record(z.string(), z.string()).optional(),
  reason: z.string(),
  stubPath: z.string().optional(),
  type: z.literal('PRUNE'),
})

export const DreamOperationSchema = z.discriminatedUnion('type', [
  ConsolidateOperationSchema,
  SynthesizeOperationSchema,
  PruneOperationSchema,
])

export type DreamOperation = z.infer<typeof DreamOperationSchema>

// ── Summary schema ───────────────────────────────────────────────────────────

export const DreamLogSummarySchema = z.object({
  consolidated: z.number().int().min(0),
  errors: z.number().int().min(0),
  flaggedForReview: z.number().int().min(0),
  pruned: z.number().int().min(0),
  synthesized: z.number().int().min(0),
})

export type DreamLogSummary = z.infer<typeof DreamLogSummarySchema>

// ── Entry schema (discriminated on status) ───────────────────────────────────

const DreamLogEntryBaseSchema = z.object({
  id: z.string().regex(/^drm-\d+$/),
  operations: z.array(DreamOperationSchema),
  startedAt: z.number(),
  summary: DreamLogSummarySchema,
  taskId: z.string().optional(),
  trigger: z.enum(['agent-idle', 'manual', 'cli']),
})

export const DreamLogEntrySchema = z.discriminatedUnion('status', [
  DreamLogEntryBaseSchema.extend({completedAt: z.number(), status: z.literal('completed')}),
  DreamLogEntryBaseSchema.extend({abortReason: z.string(), completedAt: z.number(), status: z.literal('partial')}),
  DreamLogEntryBaseSchema.extend({completedAt: z.number(), error: z.string(), status: z.literal('error')}),
  DreamLogEntryBaseSchema.extend({status: z.literal('processing')}),
  DreamLogEntryBaseSchema.extend({completedAt: z.number(), status: z.literal('undone'), undoneAt: z.number()}),
])

export type DreamLogEntry = z.infer<typeof DreamLogEntrySchema>
export type DreamLogStatus = DreamLogEntry['status']
