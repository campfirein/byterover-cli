import type {IAcpDriver} from './i-acp-driver.js'

/**
 * Driver pool contract (Slice 2.4). Tracks one {@link IAcpDriver} per
 * `(channelId, memberHandle)`. The pool does NOT spawn or start drivers
 * itself — the orchestrator's `inviteMember` is responsible for spawning,
 * running ACP `initialize`, and then handing the started driver to the
 * pool via {@link IAcpDriverPool.register}.
 *
 *  - `register` adds the driver. If a driver already exists for that
 *    `(channelId, memberHandle)`, the previous driver is stopped and
 *    replaced.
 *  - `acquire` returns the registered driver, or `undefined` when no
 *    driver is registered for that pair (the orchestrator translates the
 *    absence into `CHANNEL_MEMBER_NOT_FOUND` at dispatch time).
 *  - `release` / `releaseChannel` / `releaseAll` call `driver.stop()` so
 *    subprocess agents do not leak.
 */
export type DriverPoolRegisterArgs = {
  readonly channelId: string
  readonly driver: IAcpDriver
}

export type DriverPoolAcquireArgs = {
  readonly channelId: string
  readonly memberHandle: string
}

export type DriverPoolReleaseArgs = DriverPoolAcquireArgs

export interface IAcpDriverPool {
  acquire(args: DriverPoolAcquireArgs): IAcpDriver | undefined
  register(args: DriverPoolRegisterArgs): void
  release(args: DriverPoolReleaseArgs): Promise<void>
  releaseAll(): Promise<void>
  releaseChannel(channelId: string): Promise<void>
}
