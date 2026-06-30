/* eslint-disable camelcase */
import {z} from 'zod'

/**
 * Per-event schema for `migrate_run`.
 *
 * Emitted by the daemon's `MigrateHandler` once per `brv migrate` invocation
 * (forward or rollback, success or failure). Counts mirror the orchestrator's
 * `MigrationReport` and `RollbackReport` shapes:
 *
 *   forward:  migrated / archived / skipped / failed come from `summary.*`
 *   rollback: restored / deleted_html / preserved_html come from `restored`,
 *             `deletedHtml.length`, `preservedHtml.length`
 *
 * The wire schema is a discriminated union on `mode` so a `rollback` payload
 * structurally cannot carry forward-only counters (`migrated`, `archived`,
 * `skipped`, `failed`) and vice versa. Downstream warehouse queries can rely
 * on the schema to enforce per-mode counter separation rather than filtering
 * by `mode` after the fact.
 *
 * Per-mode counters stay optional because failure paths surface before counts
 * can be computed.
 *
 * `failure_kind` is populated only when `outcome === 'failure'`. Free-form
 * short string (caller-classified, e.g. `archive_exists`, `no_archive`,
 * `unknown`) so the producer can taxonomize without a schema migration.
 */

const failureKindSchema = z.string().min(1).max(64).optional()
const countSchema = z.number().int().nonnegative().optional()

const MigrateRunForwardSchema = z
  .object({
    archived: countSchema,
    dry_run: z.boolean(),
    failed: countSchema,
    failure_kind: failureKindSchema,
    migrated: countSchema,
    mode: z.literal('forward'),
    outcome: z.enum(['success', 'failure']),
    skipped: countSchema,
  })
  .strict()

const MigrateRunRollbackSchema = z
  .object({
    deleted_html: countSchema,
    dry_run: z.boolean(),
    failure_kind: failureKindSchema,
    mode: z.literal('rollback'),
    outcome: z.enum(['success', 'failure']),
    preserved_html: countSchema,
    restored: countSchema,
  })
  .strict()

export const MigrateRunSchema = z.discriminatedUnion('mode', [
  MigrateRunForwardSchema,
  MigrateRunRollbackSchema,
])

export type MigrateRunProps = z.infer<typeof MigrateRunSchema>
