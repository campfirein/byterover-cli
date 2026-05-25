/**
 * Phase 9.5.7 §3.3 Layer A — parley timeout configuration.
 *
 * Two separate timeouts, two separate concerns:
 *
 * 1. `dialTimeoutMs` — short dial/protocol setup timeout. Defends against dead
 *    peers and NAT failures. Default 30s; configurable via
 *    `BRV_BRIDGE_PARLEY_DIAL_TIMEOUT_MS`.
 *
 * 2. `idleTimeoutMs` — long idle/no-progress timeout. RESETS on every frame
 *    received from the responder (any chunk, heartbeat, thought, tool_use, etc.).
 *    Default 60 min; configurable via `BRV_BRIDGE_PARLEY_TURN_IDLE_TIMEOUT_MS`.
 *    No hard wall-clock cap by default — long agentic turns proceed indefinitely
 *    as long as the responder keeps emitting frames (heartbeats count).
 *
 * Parsed via the bridge-config-store.ts pattern (readPositiveIntEnv).
 */

export interface ParleyTimeoutConfig {
  /** Dial + protocol negotiation timeout in milliseconds. Default 30s. */
  readonly dialTimeoutMs: number
  /**
   * Per-turn idle timeout in milliseconds. Resets on any responder frame.
   * Default 60 min. 0 is not a valid value (defaults apply for 0 or negative).
   */
  readonly idleTimeoutMs: number
}

const DEFAULT_DIAL_TIMEOUT_MS = 30_000
const DEFAULT_IDLE_TIMEOUT_MS = 60 * 60_000  // 60 minutes

/**
 * Parse parley timeout values from an env-like object.
 * Follows the `readPositiveIntEnv` pattern from `bridge-config-store.ts`:
 * invalid values (non-numeric, zero, negative) are silently ignored and
 * the default is returned.
 *
 * Exported for unit testing.
 */
export function parseParleyTimeoutEnv(env: Record<string, string | undefined>): ParleyTimeoutConfig {
  const dialTimeoutMs = readPositiveIntEnv(env.BRV_BRIDGE_PARLEY_DIAL_TIMEOUT_MS) ?? DEFAULT_DIAL_TIMEOUT_MS
  const idleTimeoutMs = readPositiveIntEnv(env.BRV_BRIDGE_PARLEY_TURN_IDLE_TIMEOUT_MS) ?? DEFAULT_IDLE_TIMEOUT_MS
  return {dialTimeoutMs, idleTimeoutMs}
}

function readPositiveIntEnv(raw: string | undefined): number | undefined {
  if (raw === undefined) return undefined
  const trimmed = raw.trim()
  if (trimmed === '') return undefined
  const parsed = Number.parseInt(trimmed, 10)
  if (Number.isNaN(parsed) || parsed < 1) return undefined
  return parsed
}
