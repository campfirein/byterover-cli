import type {IAgentDriver} from './i-agent-driver.js'

/** Composite key identifying one member's driver slot within a channel. */
export type DriverPoolKey = {
  readonly channelId: string
  readonly memberHandle: string
}

/** Look up the driver registered for a `{channelId, memberHandle}`. */
export type DriverPoolAcquireArgs = DriverPoolKey

/** Register an already-started driver under its `{channelId, memberHandle}` key. */
export type DriverPoolRegisterArgs = DriverPoolKey & {
  readonly driver: IAgentDriver
}

/** Release (stop + evict) the driver for a `{channelId, memberHandle}`. */
export type DriverPoolReleaseArgs = DriverPoolKey

/**
 * Keyed registry of live {@link IAgentDriver} instances — one slot per
 * `{channelId, memberHandle}`. The pool is pure lifecycle bookkeeping: it does
 * NOT spawn drivers. The orchestrator constructs + starts a driver and hands it
 * over via {@link IDriverPool.register}; `acquire` is a non-blocking lookup; the
 * `release*` methods call `driver.stop()` so subprocess agents never leak.
 *
 * Pre-warming is intentionally absent: it has no consumer at this layer yet, and
 * the pool's "never constructs drivers" invariant means warming belongs to the
 * orchestrator (which owns driver construction) when a consumer needs it.
 */
export interface IDriverPool {
  /** Returns the registered driver for the key, or `undefined` if none. Never spawns. */
  acquire(args: DriverPoolAcquireArgs): IAgentDriver | undefined

  /** Stores an already-started driver under its key, replacing any prior slot. */
  register(args: DriverPoolRegisterArgs): void

  /** Stops and evict the driver for a single key. No-op when absent. */
  release(args: DriverPoolReleaseArgs): Promise<void>

  /** Stops and evict every driver in the pool (daemon shutdown). */
  releaseAll(): Promise<void>

  /** Stops and evict all drivers belonging to a channel (channel close / archive). */
  releaseChannel(channelId: string): Promise<void>
}
