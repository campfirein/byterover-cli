/**
 * Phase 9.5.4 — per-peer auto-create quota enforcer.
 *
 * Caps the number of channels a single peer can auto-create on Bob's side
 * within a rolling 1-hour window. Default cap: 5 (or
 * `BRV_BRIDGE_AUTO_CREATE_QUOTA` env var override).
 *
 * In-memory only; resets on daemon restart. Operator-side `brv channel
 * uninvite` calls `quota.reset(peerId)` to clear a peer's counter.
 */

const ONE_HOUR_MS = 60 * 60 * 1000

export interface AutoCreateQuota {
  /**
   * Clears all recorded timestamps for `peerId`. Called on operator-side
   * `brv channel uninvite`.
   */
  reset(peerId: string): void

  /**
   * Attempts to consume one slot for `peerId` at `now`.
   * Returns `true` (and records the timestamp) if the peer is under the cap.
   * Returns `false` (and does NOT record) if the peer is at or over the cap.
   */
  tryConsume(args: {readonly now: Date; readonly peerId: string}): boolean
}

export function createAutoCreateQuota(args: {
  readonly log: (msg: string) => void
  /**
   * Maximum auto-creates per peer per rolling 1-hour window.
   * Reads `BRV_BRIDGE_AUTO_CREATE_QUOTA` from the environment if this
   * argument is not provided. Falls back to 5 if the env var is absent
   * or non-positive.
   */
  readonly maxPerHour?: number
}): AutoCreateQuota {
  const envRaw = process.env.BRV_BRIDGE_AUTO_CREATE_QUOTA
  let resolvedMax = args.maxPerHour
  if (resolvedMax === undefined) {
    if (envRaw !== undefined && envRaw !== '') {
      const parsed = Number.parseInt(envRaw, 10)
      resolvedMax = Number.isFinite(parsed) && parsed > 0 ? parsed : 5
    } else {
      resolvedMax = 5
    }
  }

  const maxPerHour: number = resolvedMax

  // Map<peerId, sorted array of ISO timestamps (ascending)>
  const windows = new Map<string, number[]>()

  const prunedWindow = (peerId: string, now: Date): number[] => {
    const cutoff = now.getTime() - ONE_HOUR_MS
    const existing = windows.get(peerId) ?? []
    return existing.filter((ts) => ts > cutoff)
  }

  return {
    reset(peerId: string): void {
      windows.delete(peerId)
    },

    tryConsume({now, peerId}: {readonly now: Date; readonly peerId: string}): boolean {
      const current = prunedWindow(peerId, now)
      if (current.length >= maxPerHour) {
        args.log(
          `[Bridge] auto-create RATE_LIMITED for peerId=${peerId}: ${current.length}/${maxPerHour} used in 1h`,
        )
        return false
      }

      current.push(now.getTime())
      windows.set(peerId, current)
      return true
    },
  }
}
