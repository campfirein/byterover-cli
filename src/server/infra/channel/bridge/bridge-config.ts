/* eslint-disable camelcase */
// Config field names mirror IMPLEMENTATION_PHASE_9_CLOUD_BRIDGE.md §6.5
// on-disk JSON shape and are intentionally snake_case.

import {multiaddr} from '@multiformats/multiaddr'
import {z} from 'zod'

// Multiaddr validation — opencode round-3 MINOR. Libp2p rejects invalid
// multiaddrs at runtime with opaque errors; failing at config-parse time
// gives the user a useful pointer.
const multiaddrString = z.string().refine(
  (s) => {
    try { multiaddr(s); return true } catch { return false }
  },
  {message: 'must be a valid libp2p multiaddr (e.g. /ip4/1.2.3.4/tcp/4001/p2p/12D3KooW...)'},
)

// 1 year = 8760 hours. Anything beyond this effectively disables
// announcement, which the user should opt into via discovery_mode flags,
// not by setting a 1000-year interval. opencode round-3 MINOR.
const ONE_YEAR_IN_HOURS = 8760

/**
 * Phase 9 / IMPLEMENTATION_PHASE_9_CLOUD_BRIDGE.md §6.5 — bridge config.
 *
 * v1 (this slice — 9.1b) ships only the shape + defaults. The config-
 * file loader lands in a later slice. Tests + callers pass a
 * `BridgeConfig` object directly; `parseBridgeConfig` validates a
 * partial input over defaults.
 *
 * Defaults are intentionally conservative:
 *   - `listen_addrs`: loopback only with ephemeral port. Users opt into
 *     wider listening (e.g. `/ip4/0.0.0.0/tcp/4001`) explicitly. This
 *     means a fresh `brv install` does NOT advertise itself on the
 *     local network until configured.
 *   - `discovery_mode: 'manual-only'` — no DHT participation, no
 *     registry announce. DHT (9.6) and registry (9.7) flip this default
 *     to `'hybrid'` when they land.
 *   - `dht_bootstrap: []` — no ByteRover anchors baked in. Phase 9 §6.4
 *     specifies user-configurable bootstrap so the P2P story doesn't
 *     hard-depend on ByteRover infra.
 *   - `accept_modes: ['peer-tree', 'ca-issued-tree']` — accept both
 *     identity modes inbound. Org-only deployments can narrow to
 *     `['ca-issued-tree']`.
 */

const DiscoveryModeSchema = z.enum(['manual-only', 'registry-only', 'dht-only', 'hybrid'])
const CertKindSchema = z.enum(['peer-tree', 'ca-issued-tree'])

export const BridgeConfigSchema = z.object({
  accept_modes: z.array(CertKindSchema).min(1).default(['peer-tree', 'ca-issued-tree']),
  announce_interval_hours: z.number().int().positive().max(ONE_YEAR_IN_HOURS).default(24),
  announce_to_dht: z.boolean().default(false),
  announce_to_registry: z.boolean().default(false),
  // Slice 9.9 — delegate policy. Default `prompt` per §9 codex
  // round-1 MAJOR-5 fix: Alice's signed `permission_response_intent`
  // is INPUT to Bob's decision, never the decision itself. Operators
  // can set `auto` for trusted automation or `deny` for read-only
  // Bob installs.
  delegate_policy: z.enum(['auto', 'deny', 'prompt']).default('prompt'),
  dht_bootstrap: z.array(multiaddrString).default([]),
  discovery_mode: DiscoveryModeSchema.default('manual-only'),
  listen_addrs: z.array(multiaddrString).default(['/ip4/127.0.0.1/tcp/0']),
  // URL validation (opencode round-3 MEDIUM) — reject malformed schemes
  // like `file:///etc/passwd` at config-parse time.
  registry_url: z.string().url().nullable().default(null),
  // Slice 9.8 — Circuit Relay v2 fallback multiaddrs. Default empty
  // (no relay) so a fresh `brv install` doesn't accidentally route
  // traffic through a relay. Operators behind strict NAT add their
  // own relay multiaddr(s) here. Real ByteRover-hosted relay
  // bootstrap list ships in a future operator-side commit.
  relays: z.array(multiaddrString).default([]),
}).strict()

export type BridgeConfig = z.infer<typeof BridgeConfigSchema>
export type BridgeConfigInput = z.input<typeof BridgeConfigSchema>

export const DEFAULT_BRIDGE_CONFIG: BridgeConfig = BridgeConfigSchema.parse({})

/**
 * Parse a (possibly partial) bridge config over defaults.
 * Throws on unknown fields, invalid enum values, or wrong shapes.
 */
export function parseBridgeConfig(input?: unknown): BridgeConfig {
  if (input === undefined || input === null) return DEFAULT_BRIDGE_CONFIG
  return BridgeConfigSchema.parse(input)
}
