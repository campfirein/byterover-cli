import type {RequestPermissionOutcome} from '../../../../shared/types/channel.js'
import type {IAcpDriver} from '../../../core/interfaces/channel/i-acp-driver.js'
import type {IBrokerPersistence} from './broker-persistence.js'

import {
  ChannelPermissionAlreadyResolvedError,
  ChannelPermissionNotFoundError,
} from '../../../core/domain/channel/errors.js'

/**
 * Bridges ACP-side `session/request_permission` to the channel-event
 * surface (Slice 2.4).
 *
 * The broker is a pure registry:
 *  - {@link PermissionBroker.track} records the pending permission when the
 *    driver yields a `permission_request` payload.
 *  - {@link PermissionBroker.resolve} forwards the host's decision to the
 *    driver via `driver.respondToPermission` and returns the metadata the
 *    orchestrator needs to emit `delivery_state_change` +
 *    `permission_decision` events (with seq values from the per-turn
 *    sequence allocator).
 *  - {@link PermissionBroker.drainTurn} / {@link PermissionBroker.drainDelivery}
 *    cancel all pending permissions in scope (used by the cancel
 *    coordinator).
 *
 * Permissions are tracked in-memory; daemon restart loses them and the
 * orchestrator marks the affected delivery `errored`. Phase 3 hardens
 * this with persisted permission state.
 */
type PendingPermission = {
  channelId: string
  deliveryId: string
  driver: IAcpDriver
  turnId: string
}

export type PermissionBrokerTrackArgs = {
  channelId: string
  deliveryId: string
  driver: IAcpDriver
  /**
   * Phase-3 broker persistence (Slice 3.5c). The orchestrator passes this
   * alongside the track so daemon recovery can re-emit a
   * `delivery_state_change → errored` for the right delivery on cold
   * start.
   */
  memberHandle?: string
  permissionRequestId: string
  projectRoot?: string
  turnId: string
}

export type PermissionBrokerResolveArgs = {
  channelId: string
  outcome: RequestPermissionOutcome
  permissionRequestId: string
  turnId: string
}

export type PermissionBrokerResolveResult = {
  deliveryId: string
  isCancellation: boolean
}

export type PermissionBrokerDrainTurnArgs = {
  channelId: string
  turnId: string
}

export type PermissionBrokerDrainDeliveryArgs = {
  channelId: string
  deliveryId: string
  turnId: string
}

export type PermissionBrokerDrainResult = {
  deliveryId: string
  permissionRequestId: string
}

export type PermissionBrokerInspectEntry = {
  channelId: string
  deliveryId: string
  permissionRequestId: string
  turnId: string
}

export interface IPermissionBroker {
  drainDelivery(args: PermissionBrokerDrainDeliveryArgs): Promise<PermissionBrokerDrainResult[]>
  drainTurn(args: PermissionBrokerDrainTurnArgs): Promise<PermissionBrokerDrainResult[]>
  /**
   * Phase-3 doctor support: enumerate every pending permission. Read-only —
   * does not mutate broker state.
   */
  inspect(): PermissionBrokerInspectEntry[]
  resolve(args: PermissionBrokerResolveArgs): Promise<PermissionBrokerResolveResult>
  track(args: PermissionBrokerTrackArgs): void
}

export type PermissionBrokerOptions = {
  /**
   * Optional persistence layer. When supplied, every `track` is appended
   * as a `{"type":"track", ...}` line and every resolve/drain appends a
   * matching `{"type":"resolve", ...}` tombstone. On daemon restart,
   * broker-recovery reads the file and re-emits orphaned permissions as
   * `delivery_state_change → errored`.
   */
  readonly persistence?: IBrokerPersistence
}

/**
 * Review fix #8: cap the `resolved` tombstone set so a long-running
 * daemon doesn't accumulate every permission ID it has ever seen. The
 * set exists purely to distinguish `ALREADY_RESOLVED` vs `NOT_FOUND` in
 * the `resolve()` error path; once a permission falls out of the set,
 * subsequent late `permission-decision` calls surface as `NOT_FOUND`
 * instead — equally informative for the caller.
 */
const RESOLVED_TOMBSTONE_CAP = 10_000

export class PermissionBroker implements IPermissionBroker {
  private readonly pending = new Map<string, PendingPermission>()
  private readonly persistence: IBrokerPersistence | undefined
  /**
   * Insertion-ordered Map used as an LRU. Values are unused; the keys
   * are the permission IDs. When `size > RESOLVED_TOMBSTONE_CAP`, the
   * oldest entry is evicted via `keys().next()`.
   */
  private readonly resolved = new Map<string, true>()

  public constructor(options: PermissionBrokerOptions = {}) {
    this.persistence = options.persistence
  }

  async drainDelivery(args: PermissionBrokerDrainDeliveryArgs): Promise<PermissionBrokerDrainResult[]> {
    const targets: Array<[string, PendingPermission]> = []
    for (const [id, p] of this.pending) {
      if (p.channelId === args.channelId && p.turnId === args.turnId && p.deliveryId === args.deliveryId) {
        targets.push([id, p])
      }
    }

    return this.cancelPending(targets)
  }

  async drainTurn(args: PermissionBrokerDrainTurnArgs): Promise<PermissionBrokerDrainResult[]> {
    const targets: Array<[string, PendingPermission]> = []
    for (const [id, p] of this.pending) {
      if (p.channelId === args.channelId && p.turnId === args.turnId) targets.push([id, p])
    }

    return this.cancelPending(targets)
  }

  inspect(): PermissionBrokerInspectEntry[] {
    const out: PermissionBrokerInspectEntry[] = []
    for (const [permissionRequestId, p] of this.pending) {
      out.push({
        channelId: p.channelId,
        deliveryId: p.deliveryId,
        permissionRequestId,
        turnId: p.turnId,
      })
    }

    return out
  }

  async resolve(args: PermissionBrokerResolveArgs): Promise<PermissionBrokerResolveResult> {
    const pending = this.pending.get(args.permissionRequestId)
    if (pending === undefined) {
      if (this.resolved.has(args.permissionRequestId)) {
        throw new ChannelPermissionAlreadyResolvedError(args.permissionRequestId)
      }

      throw new ChannelPermissionNotFoundError(args.permissionRequestId)
    }

    if (
      pending.channelId !== args.channelId ||
      pending.turnId !== args.turnId
    ) {
      throw new ChannelPermissionNotFoundError(args.permissionRequestId)
    }

    this.pending.delete(args.permissionRequestId)
    this.addResolved(args.permissionRequestId)
    await pending.driver.respondToPermission(args.permissionRequestId, {outcome: args.outcome})
    // Best-effort tombstone for recovery; failure leaves the entry as
    // "live" in the file, which the recovery path treats as errored.
    if (this.persistence !== undefined) {
      this.persistence.appendResolve({permissionRequestId: args.permissionRequestId}).catch(() => {})
    }

    return {
      deliveryId: pending.deliveryId,
      isCancellation: args.outcome.outcome === 'cancelled',
    }
  }

  track(args: PermissionBrokerTrackArgs): void {
    this.pending.set(args.permissionRequestId, {
      channelId: args.channelId,
      deliveryId: args.deliveryId,
      driver: args.driver,
      turnId: args.turnId,
    })
    // Phase-3 persistence: append a `track` line so daemon-restart
    // recovery can re-emit `delivery_state_change → errored` for any
    // permission that was in-flight when the daemon went down. The
    // `memberHandle` + `projectRoot` are required for recovery to address
    // the right delivery + locate its events.jsonl.
    if (this.persistence !== undefined && args.memberHandle !== undefined && args.projectRoot !== undefined) {
      this.persistence
        .appendTrack({
          channelId: args.channelId,
          deliveryId: args.deliveryId,
          memberHandle: args.memberHandle,
          permissionRequestId: args.permissionRequestId,
          projectRoot: args.projectRoot,
          turnId: args.turnId,
        })
        .catch(() => {
          // Persistence is best-effort; failures fall back to in-memory
          // only (lost on restart). Phase-3.5c's broker-recovery is the
          // production safety net.
        })
    }
  }

  private addResolved(permissionRequestId: string): void {
    this.resolved.set(permissionRequestId, true)
    while (this.resolved.size > RESOLVED_TOMBSTONE_CAP) {
      const oldest = this.resolved.keys().next().value
      if (oldest === undefined) break
      this.resolved.delete(oldest)
    }
  }

  private async cancelPending(
    targets: Array<[string, PendingPermission]>,
  ): Promise<PermissionBrokerDrainResult[]> {
    const cancelled: PermissionBrokerDrainResult[] = []
    for (const [id, p] of targets) {
      this.pending.delete(id)
      this.addResolved(id)
      // eslint-disable-next-line no-await-in-loop
      await p.driver.respondToPermission(id, {outcome: {outcome: 'cancelled'}})
      if (this.persistence !== undefined) {
        this.persistence.appendResolve({permissionRequestId: id}).catch(() => {})
      }

      cancelled.push({deliveryId: p.deliveryId, permissionRequestId: id})
    }

    return cancelled
  }
}
