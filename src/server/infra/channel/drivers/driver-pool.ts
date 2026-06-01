import type {IAgentDriver} from '../../../core/interfaces/channel/i-agent-driver.js'
import type {
  DriverPoolAcquireArgs,
  DriverPoolRegisterArgs,
  DriverPoolReleaseArgs,
  IDriverPool,
} from '../../../core/interfaces/channel/i-driver-pool.js'

/**
 * In-memory {@link IDriverPool}: a two-level registry of live {@link IAgentDriver}
 * instances, keyed `channelId → memberHandle → driver`.
 *
 * Pure lifecycle bookkeeping — it NEVER constructs, starts, or warms a driver. The
 * orchestrator builds + starts a driver and hands it over via {@link DriverPool.register};
 * the `release*` methods call `driver.stop()` so subprocess agents never leak. All three
 * `release*` methods evict synchronously and propagate `stop()` failures — the single-key
 * `release` rethrows directly; the bulk `releaseAll`/`releaseChannel` throw an
 * `AggregateError` after attempting every driver.
 *
 * Channel membership is held structurally (a nested map), not as a flat composite
 * string key, because `channelId` is unconstrained and may contain any character:
 * string-prefix matching on a joined key would let `releaseChannel('a')` wrongly evict
 * channel `'a:b'` (and a separator-less prefix would collide `'chan1'` with `'chan10'`).
 * An exact top-level `Map` lookup sidesteps both hazards.
 */
export class DriverPool implements IDriverPool {
  private readonly channels: Map<string, Map<string, IAgentDriver>> = new Map()

  /** Returns the registered driver for the key, or `undefined` if none. Never spawns. */
  acquire({channelId, memberHandle}: DriverPoolAcquireArgs): IAgentDriver | undefined {
    return this.channels.get(channelId)?.get(memberHandle)
  }

  /**
   * Stores an already-started driver under its key, replacing any prior slot.
   *
   * Synchronous: the new driver is installed before the replaced one is stopped, so a
   * concurrent `acquire` never observes a gap. The old driver's `stop()` is
   * fire-and-forget; re-registering the identical instance is a no-op and never stops
   * the live driver.
   */
  register({channelId, driver, memberHandle}: DriverPoolRegisterArgs): void {
    const members = this.channels.get(channelId) ?? new Map<string, IAgentDriver>()
    const previous = members.get(memberHandle)
    members.set(memberHandle, driver)
    this.channels.set(channelId, members)

    if (previous !== undefined && previous !== driver) {
      previous.stop().catch(() => {})
    }
  }

  /**
   * Stops and evicts the driver for a single key. No-op when absent.
   *
   * The slot is evicted synchronously before awaiting `stop()`, so the pool stays
   * consistent even if teardown rejects; the rejection (if any) propagates to the
   * caller, who explicitly awaited this targeted release.
   */
  async release({channelId, memberHandle}: DriverPoolReleaseArgs): Promise<void> {
    const members = this.channels.get(channelId)
    const driver = members?.get(memberHandle)
    if (members === undefined || driver === undefined) return

    members.delete(memberHandle)
    if (members.size === 0) this.channels.delete(channelId)

    await driver.stop()
  }

  /**
   * Stops and evicts every driver in the pool (daemon shutdown).
   *
   * Snapshots all drivers and clears the registry before awaiting, so a driver
   * registered mid-shutdown is untouched. Every driver is stopped even if some reject;
   * after all settle, throws an `AggregateError` of the failures if any `stop()` rejected.
   */
  async releaseAll(): Promise<void> {
    const drivers = [...this.channels.values()].flatMap((members) => [...members.values()])
    this.channels.clear()
    await this.stopAll(drivers)
  }

  /**
   * Stops and evicts all drivers belonging to a channel (channel close / archive).
   *
   * Matches the channel by exact id (never a string prefix) and detaches the whole
   * sub-map before awaiting, so a driver re-registered mid-release lands in a fresh
   * sub-map and is not stopped by this call. Every driver is stopped even if some reject;
   * after all settle, throws an `AggregateError` of the failures if any `stop()` rejected.
   */
  async releaseChannel(channelId: string): Promise<void> {
    const members = this.channels.get(channelId)
    if (members === undefined) return

    this.channels.delete(channelId)
    await this.stopAll([...members.values()])
  }

  /**
   * Stops every driver concurrently, then — once all attempts settle — throws an
   * `AggregateError` of the failures if any `stop()` rejected. Every driver is still
   * attempted (and the caller has already evicted them), so the throw is a pure signal
   * that some subprocess teardown failed; it never aborts the sweep.
   */
  private async stopAll(drivers: IAgentDriver[]): Promise<void> {
    const results = await Promise.allSettled(drivers.map((driver) => driver.stop()))
    const failures: unknown[] = []
    for (const result of results) {
      if (result.status === 'rejected') failures.push(result.reason)
    }

    if (failures.length > 0) {
      throw new AggregateError(failures, `DriverPool: ${failures.length} driver(s) failed to stop`)
    }
  }
}
