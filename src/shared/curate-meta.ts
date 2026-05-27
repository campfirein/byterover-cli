import {z} from 'zod'

/**
 * Operation metadata the calling agent supplies alongside curate HTML.
 *
 * The legacy `case 'curate'` path used byterover's internal LLM to emit
 * `type`/`impact`/`needsReview` via tool-call output, which surfaced
 * curate operations for HITL review. Tool mode removed that LLM, leaving
 * `case 'curate-tool-mode'` and the CLI session protocol with no source
 * of operation judgment — so `brv review pending` stayed empty for any
 * user-initiated curate.
 *
 * `CurateMeta` is the calling agent's hook into the HITL pipeline: the
 * agent that authored the HTML is also best-positioned to assert what
 * kind of operation it is and whether it's load-bearing enough to need
 * review. All fields are optional — agents that don't supply meta still
 * curate successfully, just without review surfacing.
 *
 * Lives in `src/shared/` because the wire-payload encoder
 * (`shared/transport/curate-html-content.ts`) must import it; placing
 * the type under `src/server/` would force `shared → server` direction.
 */
export type CurateMeta = {
  /** Agent's certainty in the curation. Optional — review pipeline does not gate on this in v1. */
  confidence?: 'high' | 'low'
  /**
   * High = load-bearing decision, must-rule, architectural pattern,
   * or new domain knowledge that the team needs to review before it
   * propagates. Low = refinement, addition, or clarification.
   *
   * Has no fallback. `undefined` means "agent did not assert; don't
   * surface for review" — silent omission is honest, defaulting to
   * `'low'` would hide high-impact curates, defaulting to `'high'`
   * would flood review.
   */
  impact?: 'high' | 'low'
  /** Semantic summary of what existed before. Set on UPDATE / MERGE only. */
  previousSummary?: string
  /** One short sentence shown to human reviewers explaining why this curation matters. */
  reason?: string
  /** One-line semantic summary of the topic after this operation. */
  summary?: string
  /**
   * Operation type, asserted by the agent. When absent, the log-entry
   * builder falls back to `existedBefore ? 'UPDATE' : 'ADD'` based on
   * what the writer observed on disk.
   */
  type?: 'ADD' | 'MERGE' | 'UPDATE'
}

/**
 * Zod schema for `CurateMeta`. `.strict()` rejects unknown keys so typos
 * (`importance` vs `impact`, `severity` vs `impact`) fail loudly at the
 * MCP boundary instead of silently dropping into the void.
 *
 * Forward-incompatible payloads are graceful at the transport-decode
 * layer: `decodeCurateHtmlContent` catches schema failures and returns
 * `meta: undefined` so a future MCP client emitting newer fields against
 * an older daemon downgrades to "no review surfacing" instead of failing
 * the entire curate.
 */
export const CurateMetaSchema = z
  .object({
    confidence: z.enum(['high', 'low']).optional(),
    impact: z.enum(['high', 'low']).optional(),
    previousSummary: z.string().optional(),
    reason: z.string().optional(),
    summary: z.string().optional(),
    type: z.enum(['ADD', 'MERGE', 'UPDATE']).optional(),
  })
  .strict()
