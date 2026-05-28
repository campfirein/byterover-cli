/* eslint-disable camelcase */
import {z} from 'zod'

/**
 * Per-event schema for `swarm_store_completed`.
 *
 * Swarm counterpart to `curate_operation_applied` / `curate_run_completed`
 * (ENG-2770 / M12). Fires once per `brv swarm curate` invocation OR per
 * `swarm_store` LLM tool call — covering the write loop that fans curated
 * knowledge out to federated memory providers via `swarm-coordinator.store()`.
 *
 * `operation` is a short producer-taxonomized string naming the write
 * shape (`'add'`, `'update'`, `'merge'`, …). Kept as `z.string().min(1).max(64)`
 * so future operation kinds plug in without a schema migration.
 *
 * Counters mirror the M12 curate-aggregation idiom:
 *   - `stored` — providers that accepted a new write
 *   - `updated` — providers that updated an existing entry
 *   - `skipped` — providers that no-op'd (already up to date, declined, etc.)
 *
 * `tags` / `keywords` / `related` mirror the M12.3 frontmatter-harvest
 * precedent for parity with the in-project curate events.
 *
 * Per the M15.1 outcome taxonomy: `outcome: 'success' | 'failure'`,
 * `failure_kind` populated only on failure. `duration_ms` is required.
 *
 * SCHEMA-ONLY REGISTRATION TODAY: the swarm store surface lives in the
 * agent process (`src/agent/infra/swarm/swarm-coordinator.ts` +
 * `src/agent/infra/swarm/adapters/memory-wiki-adapter.ts`), not in a
 * daemon transport handler. Emit wiring deferred per plan flag #2.
 */
const failureKindSchema = z.string().min(1).max(64).optional()
const countSchema = z.number().int().nonnegative().optional()
const stringArraySchema = z.array(z.string().max(256)).max(50).optional()

export const SwarmStoreCompletedSchema = z
  .object({
    duration_ms: z.number().int().nonnegative(),
    failure_kind: failureKindSchema,
    keywords: stringArraySchema,
    /** Write-operation kind ('add' | 'update' | 'merge' | …). Producer-taxonomized. */
    operation: z.string().min(1).max(64),
    outcome: z.enum(['success', 'failure']),
    related: stringArraySchema,
    /** Per-outcome provider counts; optional because failure can surface before they're computed. */
    skipped: countSchema,
    stored: countSchema,
    tags: stringArraySchema,
    updated: countSchema,
  })
  .strict()

export type SwarmStoreCompletedProps = z.infer<typeof SwarmStoreCompletedSchema>
