/* eslint-disable camelcase */
import {z} from 'zod'

/**
 * Per-event schema for `swarm_onboarded`.
 *
 * Activation entry point for `brv swarm onboard` — fires when the wizard
 * completes (success path) or aborts (failure path). Swarm counterpart
 * to M15.2's brv-init / onboarding-completed activation events.
 *
 * `swarm_kind` is a short producer-taxonomized string (e.g. `'new'` when
 * the user scaffolded a fresh config, `'joined'` when they pointed at an
 * existing swarm). Kept as `z.string().min(1).max(64)` so future flows
 * plug in without a schema migration.
 *
 * `member_count` captures the active-provider count from the resulting
 * swarm config (e.g. `byterover`, `obsidian`, `gbrain`). Optional —
 * failure paths may surface before the count is computed.
 *
 * SCHEMA-ONLY REGISTRATION TODAY: the swarm onboard surface lives in the
 * agent process (`src/agent/infra/swarm/wizard/swarm-wizard.ts`), not in
 * a daemon transport handler. The producer requires either a new daemon
 * handler that the CLI command calls, or a synthetic-emit pattern (cf.
 * M17). That wiring is deferred to a follow-up. See ENG-2770 for the
 * schema-only precedent.
 */
const failureKindSchema = z.string().min(1).max(64).optional()

export const SwarmOnboardedSchema = z
  .object({
    duration_ms: z.number().int().nonnegative().optional(),
    failure_kind: failureKindSchema,
    /** Number of active providers in the resulting swarm config. */
    member_count: z.number().int().nonnegative().optional(),
    outcome: z.enum(['success', 'failure']),
    /** Onboarding flow taxonomy (e.g. 'new', 'joined'). Producer-taxonomized. */
    swarm_kind: z.string().min(1).max(64).optional(),
  })
  .strict()

export type SwarmOnboardedProps = z.infer<typeof SwarmOnboardedSchema>
