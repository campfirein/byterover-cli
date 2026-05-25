import type {IAcpDriver} from '../../../core/interfaces/channel/i-acp-driver.js'
import type {
  DriverPoolAcquireArgs,
  DriverPoolRegisterArgs,
  DriverPoolReleaseArgs,
  IAcpDriverPool,
} from '../../../core/interfaces/channel/i-driver-pool.js'

/**
 * In-memory {@link IAcpDriverPool}. Holds one driver per
 * `(channelId, memberHandle)`. The pool does not spawn drivers; the
 * orchestrator's `inviteMember` spawns + starts and then registers.
 */
export class AcpDriverPool implements IAcpDriverPool {
  private readonly drivers = new Map<string, IAcpDriver>()

  private static keyFor(channelId: string, memberHandle: string): string {
    return `${channelId}\0${memberHandle}`
  }

  acquire(args: DriverPoolAcquireArgs): IAcpDriver | undefined {
    return this.drivers.get(AcpDriverPool.keyFor(args.channelId, args.memberHandle))
  }

  register(args: DriverPoolRegisterArgs): void {
    const key = AcpDriverPool.keyFor(args.channelId, args.driver.handle)
    const existing = this.drivers.get(key)
    this.drivers.set(key, args.driver)
    if (existing !== undefined) {
      // Stop the displaced driver but do not block the caller.
      existing.stop().catch(() => {})
    }
  }

  async release(args: DriverPoolReleaseArgs): Promise<void> {
    const key = AcpDriverPool.keyFor(args.channelId, args.memberHandle)
    const driver = this.drivers.get(key)
    if (driver === undefined) return
    this.drivers.delete(key)
    await driver.stop()
  }

  async releaseAll(): Promise<void> {
    const drivers = [...this.drivers.values()]
    this.drivers.clear()
    await Promise.all(drivers.map((d) => d.stop()))
  }

  async releaseChannel(channelId: string): Promise<void> {
    const prefix = `${channelId}\0`
    const targets: Array<[string, IAcpDriver]> = []
    for (const [key, driver] of this.drivers) {
      if (key.startsWith(prefix)) targets.push([key, driver])
    }

    for (const [key] of targets) this.drivers.delete(key)
    await Promise.all(targets.map(([, d]) => d.stop()))
  }
}
