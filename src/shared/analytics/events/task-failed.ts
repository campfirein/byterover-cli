/* eslint-disable camelcase */
import {z} from 'zod'

import {TASK_TYPE_VALUES} from '../task-types.js'

/**
 * Coarse-vocabulary classification of why a task ended in a non-success
 * state. Strictly enumerated so consumers can group failures without
 * having to parse raw error messages. Every value is ≤64 chars and
 * carries no PII.
 *
 * - `cancelled` — onTaskCancelled lifecycle path; user-initiated abort.
 * - `timeout` — error message indicates the agent / LLM exceeded a budget.
 * - `agent_error` — error message indicates a recognised agent-side fault
 *   (provider rejection, tool failure, schema reject, etc.).
 * - `unknown` — anything else; the hook MUST default here rather than
 *   widening the enum on a hunch.
 */
export const FailureKindValues = ['cancelled', 'timeout', 'agent_error', 'unknown'] as const
export type FailureKind = (typeof FailureKindValues)[number]

/**
 * Per-event schema for `task_failed`.
 *
 * Error path. The error message and stack trace are intentionally NOT
 * captured here: they may contain file paths, secrets, or user content.
 * Strict mode rejects any attempt to add `error_message` / `stack` later.
 *
 * `failure_kind` (M15.6) is a coarse-vocabulary tag the daemon classifies
 * the error into. Producers MUST emit one of the canonical values; the
 * hook never forwards raw `error.message` text under any field name.
 */
export const TaskFailedSchema = z
  .object({
    duration_ms: z.number().int().nonnegative(),
    failure_kind: z.enum(FailureKindValues),
    /** M17 follow-up: see task-created.ts for the rationale. */
    project_path_hash: z.string().regex(/^[0-9a-f]{64}$/).optional(),
    task_id: z.string().min(1),
    task_type: z.enum(TASK_TYPE_VALUES),
  })
  .strict()

export type TaskFailedProps = z.infer<typeof TaskFailedSchema>
