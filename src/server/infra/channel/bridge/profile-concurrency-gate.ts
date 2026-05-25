/**
 * Phase 9.5.3 — per-profile concurrency semaphore for spawn-per-turn
 * adapters (e.g. `ClaudeCodeHeadlessAdapter`).
 *
 * `BridgeDriverPool` is typed for `IAcpDriver` warm-process reuse and
 * does NOT generalise to subprocess-per-turn adapters (plan §2.5,
 * codex round-1 HIGH-2). This gate provides the same
 * `BRV_BRIDGE_MAX_CONCURRENT_PER_PROFILE` cap for headless adapters
 * without coupling to the ACP driver lifecycle.
 *
 * Both knobs share the same env var so operators don't see a
 * behavioural split between ACP (pool-based) and headless (gate-based)
 * adapters.
 */

export interface ProfileConcurrencyGate {
  /**
   * Acquire a concurrency slot for `profile`. Resolves immediately if
   * a slot is available; otherwise waits until one is released.
   *
   * @returns A release function the caller MUST invoke in a `finally`
   *   block. Calling it multiple times is a no-op.
   */
  acquire(profile: string): Promise<() => void>
}

export interface CreateProfileConcurrencyGateArgs {
  /**
   * Maximum number of concurrent in-flight `acquire` slots per profile.
   * Default is 1. Mirrors `BRV_BRIDGE_MAX_CONCURRENT_PER_PROFILE`.
   */
  readonly maxConcurrent: number
}

interface ProfileSlot {
  inFlight: number
  /** FIFO queue of resolve functions waiting for a free slot. */
  queue: Array<() => void>
}

export function createProfileConcurrencyGate(
  args: CreateProfileConcurrencyGateArgs,
): ProfileConcurrencyGate {
  const {maxConcurrent} = args
  const slots = new Map<string, ProfileSlot>()

  function getSlot(profile: string): ProfileSlot {
    let slot = slots.get(profile)
    if (slot === undefined) {
      slot = {inFlight: 0, queue: []}
      slots.set(profile, slot)
    }

    return slot
  }

  return {
    acquire(profile: string): Promise<() => void> {
      const slot = getSlot(profile)

      if (slot.inFlight < maxConcurrent) {
        // Fast path: slot available immediately.
        slot.inFlight++
        let released = false
        const release = (): void => {
          if (released) return
          released = true
          slot.inFlight--
          // Unblock the next waiter if any.
          const next = slot.queue.shift()
          if (next !== undefined) {
            slot.inFlight++
            next()
          }
        }

        return Promise.resolve(release)
      }

      // Slow path: enqueue and wait for a release.
      return new Promise<() => void>((resolve) => {
        slot.queue.push(() => {
          let released = false
          const release = (): void => {
            if (released) return
            released = true
            slot.inFlight--
            const next = slot.queue.shift()
            if (next !== undefined) {
              slot.inFlight++
              next()
            }
          }

          resolve(release)
        })
      })
    },
  }
}
