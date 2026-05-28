/* eslint-disable camelcase */
import {z} from 'zod'

/**
 * Per-event schema for `content_migrated`.
 *
 * Admin-op content migration between scopes (e.g. moving curated knowledge
 * between sources, spaces, or projects). Distinct from `migrate_run`
 * (ENG-3008 / `migrate-run.ts`) which covers the `brv migrate` MD→HTML
 * one-shot — that operation lives in `MigrateHandler` and its semantics
 * are file-format-conversion, not scope-aware data movement.
 *
 * `source_kind` / `target_kind` are short enum strings naming the
 * abstract scope on each side (e.g. `'local'`, `'space'`, `'shared'`).
 * Kept as `z.string().min(1).max(64)` rather than a closed enum so future
 * scopes can plug in without a schema migration; the producer is
 * responsible for taxonomizing.
 *
 * Per the M15.1 outcome taxonomy: `outcome: 'success' | 'failure'`,
 * `failure_kind` populated only on failure. Counts are optional so a
 * failure path that surfaces before counts are known still emits a
 * well-formed event.
 *
 * SCHEMA-ONLY REGISTRATION TODAY: no daemon-handler emit site exists in
 * this codebase yet. The producer will land alongside the admin op when
 * its handler is built. See ENG-2770 for the precedent.
 */
const failureKindSchema = z.string().min(1).max(64).optional()
const countSchema = z.number().int().nonnegative().optional()

export const ContentMigratedSchema = z
  .object({
    /** True when the run was a no-write dry run. */
    dry_run: z.boolean().optional(),
    /** Counts — optional because failure can surface before they're computed. */
    duration_ms: z.number().int().nonnegative().optional(),
    failed: countSchema,
    failure_kind: failureKindSchema,
    migrated: countSchema,
    outcome: z.enum(['success', 'failure']),
    skipped: countSchema,
    /** Abstract scope identifiers (e.g. 'local', 'space', 'shared'). Producer-taxonomized. */
    source_kind: z.string().min(1).max(64),
    target_kind: z.string().min(1).max(64),
  })
  .strict()

export type ContentMigratedProps = z.infer<typeof ContentMigratedSchema>
