/* eslint-disable camelcase */
import {formatISO} from 'date-fns'
import {z} from 'zod'

/**
 * Maximum number of send attempts before a record terminates as `'failed'`.
 *
 * Consumed inside `JsonlAnalyticsStore.updateStatus` (M9.2): on a `'failed'`
 * update the store increments `attempts`; the row only transitions to
 * terminal `status='failed'` when `attempts >= MAX_ATTEMPTS`. Otherwise it
 * stays at `status='pending'` so the next flush cycle re-attempts it.
 *
 * M10.3 verifies the composition end-to-end.
 */
export const MAX_ATTEMPTS = 3

/**
 * Local-only status enum for daemon-side persistence. Never serialized to
 * the wire — see `toWireEvent` for the strip path.
 */
const StoredStatusSchema = z.enum(['pending', 'sent', 'failed'])

export type StoredStatus = z.infer<typeof StoredStatusSchema>

/**
 * Wire-format identity, snake_case per the analytics spec. `device_id` is
 * always present; the rest are optional and only stamped when the user is
 * authenticated. Kept here so the stored-record schema is self-contained
 * and importable from any layer (no cross-layer reach into server/).
 */
const IdentityWireSchema = z.object({
  device_id: z.string().refine((s) => s.trim().length > 0, {
    message: 'device_id must be non-empty',
  }),
  email: z.string().optional(),
  name: z.string().optional(),
  user_id: z.string().optional(),
})

/**
 * A local-only stored record. Extends the wire-format analytics event
 * shape with three daemon-internal fields:
 *
 * - `id`: stable per-row identifier (uuid v4) for `updateStatus` mutations
 * - `status`: `'pending' | 'sent' | 'failed'`
 * - `attempts`: number of send attempts (0..MAX_ATTEMPTS)
 *
 * The wire format that goes to the backend (M3+) stays unchanged — these
 * extra fields are local metadata and NEVER leave the daemon. `toWireEvent`
 * is the strip helper M4's HTTP sender uses when shipping a batch.
 */
export const StoredAnalyticsRecordSchema = z.object({
  attempts: z.number().int().min(0),
  // Wire-bound ISO 8601 string with timezone designator. Optional so pre-
  // upgrade rows on disk (which carry only the numeric `timestamp`) continue
  // to parse. `toWireEvent` derives a value from `timestamp` when this is
  // absent so the wire payload is always complete.
  created_at: z.string().datetime({offset: true}).optional(),
  id: z.string().min(1),
  identity: IdentityWireSchema,
  name: z.string(),
  properties: z.record(z.string(), z.unknown()),
  status: StoredStatusSchema,
  // Local-only sort key (epoch ms). Required: see `JsonlAnalyticsStore.list`
  // which sorts on numeric subtraction. NEVER emitted on the wire.
  timestamp: z.number(),
})

/**
 * `Readonly<>` wrapper aligns with the rest of the analytics domain
 * (`Identity`, `AnalyticsEvent`, `AnalyticsEventWithIdentity` are all
 * `Readonly<>`). A stored row is a frozen-in-time snapshot of the disk
 * state; M9.2 mutates by spread + rewrite, never in-place.
 */
export type StoredAnalyticsRecord = Readonly<z.infer<typeof StoredAnalyticsRecordSchema>>

/**
 * The wire-shape view of a stored record (no `id` / `status` / `attempts` /
 * `timestamp`). Structurally identical to the daemon-side
 * `AnalyticsEventWithIdentity` type; declared here as a `Pick` so this
 * module has no dependency on server-side domain code and can be imported
 * by `shared/`.
 *
 * `created_at` is required on the wire even though it is optional on
 * `StoredAnalyticsRecord` (pre-upgrade rows derive it from `timestamp` at
 * send time via `toWireEvent`).
 */
export type WireAnalyticsEvent = Pick<StoredAnalyticsRecord, 'identity' | 'name' | 'properties'> & {
  created_at: string
}

/**
 * Strips local-only fields (`id`, `status`, `attempts`, `timestamp`) from a
 * stored record and returns the wire-format event shape that can be shipped
 * to the backend. M4's HTTP sender uses this on the way out; M9.3
 * (in-process) and M11.2 (over transport) both keep the local fields for
 * their own purposes.
 *
 * Emits `created_at` (ISO 8601 with offset). For pre-upgrade rows that lack
 * a stored `created_at`, derives one from the numeric `timestamp` so the
 * wire payload is always complete. The UTC instant is exact, but the offset
 * in the derived string reflects the daemon's local timezone at send time,
 * not the user's timezone at original capture.
 *
 * Note: `formatISO` (date-fns) emits second precision and drops the
 * millisecond component, so a derived `created_at` reparses to an instant
 * up to 999ms earlier than the stored `timestamp`. The backend's UTC
 * normalization tolerates this; the local `timestamp` remains the
 * authoritative sub-second sort key on disk.
 *
 * The backend stores the normalized UTC instant, so both the offset drift
 * and the second-precision truncation are informational only.
 */
export function toWireEvent(record: StoredAnalyticsRecord): WireAnalyticsEvent {
  return {
    created_at: record.created_at ?? formatISO(new Date(record.timestamp)),
    identity: record.identity,
    name: record.name,
    properties: record.properties,
  }
}
