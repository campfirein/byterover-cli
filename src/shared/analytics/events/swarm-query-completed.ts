/* eslint-disable camelcase */
import {z} from 'zod'

/**
 * Per-event schema for `swarm_query_completed`.
 *
 * Swarm counterpart to `query_completed` (ENG-2770 / M12) — fires once
 * per `brv swarm query` invocation OR per `swarm_query` LLM tool call,
 * covering the read loop across federated memory providers (byterover,
 * obsidian, gbrain, …) coordinated by `swarm-coordinator.ts`.
 *
 * `swarm_scope` is a short producer-taxonomized string describing which
 * provider set the query spanned: `'local'` (current project only),
 * `'remote'` (external providers only), or `'mixed'` (both). Kept as
 * `z.string().min(1).max(64)` so future scope kinds plug in without a
 * schema migration; the producer is responsible for the taxonomy.
 *
 * `tags` / `keywords` / `related` mirror the M12.3 frontmatter-harvest
 * precedent — when the query fuses results from a Memory-Wiki adapter
 * that carries those fields, surface them so the funnel stays comparable
 * to the in-project `query_completed` events.
 *
 * Per the M15.1 outcome taxonomy: `outcome: 'success' | 'failure'`,
 * `failure_kind` populated only on failure. `duration_ms` is required
 * because the coordinator always knows it by terminal time.
 *
 * SCHEMA-ONLY REGISTRATION TODAY: the swarm query surface lives in the
 * agent process (`src/agent/infra/swarm/swarm-coordinator.ts`), not in
 * a daemon transport handler. Emit wiring deferred per plan flag #2.
 */
const failureKindSchema = z.string().min(1).max(64).optional()
const stringArraySchema = z.array(z.string().max(256)).max(50).optional()

export const SwarmQueryCompletedSchema = z
  .object({
    duration_ms: z.number().int().nonnegative(),
    failure_kind: failureKindSchema,
    /** Optional frontmatter harvest (M12.3 parity) for the top-N fused results. */
    keywords: stringArraySchema,
    outcome: z.enum(['success', 'failure']),
    related: stringArraySchema,
    /** Number of fused results returned to the caller. */
    result_count: z.number().int().nonnegative().optional(),
    /** Provider-set kind ('local' | 'remote' | 'mixed' | …). Producer-taxonomized. */
    swarm_scope: z.string().min(1).max(64).optional(),
    tags: stringArraySchema,
  })
  .strict()

export type SwarmQueryCompletedProps = z.infer<typeof SwarmQueryCompletedSchema>
