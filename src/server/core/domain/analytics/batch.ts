/* eslint-disable camelcase */
import {z} from 'zod'

import type {AnalyticsEvent} from './event.js'
import type {Identity} from './identity.js'

/**
 * An analytics event after identity stamping. This is the unit of work
 * that flows through the queue and ultimately ends up on the wire.
 */
export type AnalyticsEventWithIdentity = AnalyticsEvent & Readonly<{identity: Identity}>

/**
 * Wire shape for a batch of analytics events. `schema_version: 1` is the
 * only currently-supported value.
 */
export type AnalyticsBatchJson = Readonly<{
  events: ReadonlyArray<AnalyticsEventWithIdentity>
  schema_version: 1
}>

/**
 * Wire-validation Zod schemas. Used by `fromJson` to deserialize untrusted
 * JSON. Zod replaces the previous hand-rolled type guards (which relied on
 * `as Record<string, unknown>` casts that violate CLAUDE.md's
 * "avoid `as Type` assertions" rule).
 */
const IdentityWireSchema = z.object({
  device_id: z.string().refine((s) => s.trim().length > 0, {
    message: 'device_id must be non-empty',
  }),
  email: z.string().optional(),
  name: z.string().optional(),
  user_id: z.string().optional(),
})

const AnalyticsEventWithIdentityWireSchema = z.object({
  identity: IdentityWireSchema,
  name: z.string(),
  properties: z.record(z.string(), z.unknown()),
  timestamp: z.number(),
})

const AnalyticsBatchJsonSchema = z.object({
  events: z.array(AnalyticsEventWithIdentityWireSchema),
  schema_version: z.literal(1),
})

/**
 * A batch of identity-stamped analytics events. Immutable. Constructed
 * via `create()` in-process or `fromJson()` at the wire boundary;
 * `toJson()` produces the canonical `AnalyticsBatchJson` shape.
 */
export class AnalyticsBatch {
  public readonly events: ReadonlyArray<AnalyticsEventWithIdentity>
  public readonly schema_version: 1

  private constructor(events: ReadonlyArray<AnalyticsEventWithIdentity>) {
    this.events = events
    this.schema_version = 1
  }

  /**
   * Constructs a batch from a list of identity-stamped events.
   */
  public static create(events: ReadonlyArray<AnalyticsEventWithIdentity>): AnalyticsBatch {
    return new AnalyticsBatch(events)
  }

  /**
   * Deserializes a batch from JSON. Returns `undefined` for any malformed
   * input (graceful failure — the caller can drop the batch and log).
   */
  public static fromJson(json: unknown): AnalyticsBatch | undefined {
    const parsed = AnalyticsBatchJsonSchema.safeParse(json)
    if (!parsed.success) return undefined
    // Zod's inferred event shape structurally matches AnalyticsEventWithIdentity
    // (z.string().optional() is `string | undefined`, equivalent to optional
    // properties on Identity). TypeScript widens the inferred mutable shape
    // into the Readonly wrapper without an `as` cast.
    return new AnalyticsBatch(parsed.data.events)
  }

  /**
   * Serializes the batch to its wire shape.
   */
  public toJson(): AnalyticsBatchJson {
    return {events: this.events, schema_version: this.schema_version}
  }
}
