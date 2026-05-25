import type {TurnDelivery, TurnEvent, TurnState} from '../../../../shared/types/channel.js'
import type {IAcpDriverPool} from '../../../core/interfaces/channel/i-driver-pool.js'
import type {ITurnSequenceAllocator} from '../../../core/interfaces/channel/i-turn-sequence-allocator.js'

import {IPermissionBroker} from './permission-broker.js'

/**
 * CHANNEL_PROTOCOL.md §7.2 cancel-ordering coordinator (Slice 2.4).
 *
 * Drives the precise event sequence that on-disk replay (and live
 * broadcasts) depend on:
 *
 *   1. For every pending permission in scope: emit
 *      `permission_decision { outcome: 'cancelled' }` (broker resolves the
 *      ACP-side request with the cancellation outcome).
 *   2. For every non-terminal delivery in scope: send ACP `session/cancel`
 *      to the driver, then emit `delivery_state_change { to: 'cancelled' }`.
 *   3. (full-turn only) emit `turn_state_change { to: 'cancelled' }`.
 *
 * Per-delivery cancel skips step 3; the turn finalises via the normal
 * path once every delivery reaches a terminal state.
 *
 * The coordinator does NOT persist any state outside of writeEvent +
 * the broker. The orchestrator owns the in-memory state machine and
 * snapshot writes.
 */
export type CancelDeliveryRef = {
  deliveryId: string
  memberHandle: string
  state: TurnDelivery['state']
}

export type CancelCoordinatorDeps = {
  broker: IPermissionBroker
  pool: IAcpDriverPool
  seqAllocator: ITurnSequenceAllocator
  writeEvent(event: TurnEvent, ctx: {channelId: string; projectRoot: string; turnId: string}): Promise<void>
}

export type CancelTurnArgs = {
  channelId: string
  inFlightDeliveries: CancelDeliveryRef[]
  projectRoot: string
  turnId: string
  turnState: TurnState
}

export type CancelDeliveryArgs = {
  channelId: string
  delivery: CancelDeliveryRef
  projectRoot: string
  turnId: string
}

const nowIso = (): string => new Date().toISOString()

const TERMINAL_DELIVERY_STATES = new Set<TurnDelivery['state']>(['cancelled', 'completed', 'errored'])

export class CancelCoordinator {
  private readonly deps: CancelCoordinatorDeps

  public constructor(deps: CancelCoordinatorDeps) {
    this.deps = deps
  }

  async cancelDelivery(args: CancelDeliveryArgs): Promise<void> {
    if (TERMINAL_DELIVERY_STATES.has(args.delivery.state)) return

    // Step 1: drain pending permissions for this delivery.
    const drained = await this.deps.broker.drainDelivery({
      channelId: args.channelId,
      deliveryId: args.delivery.deliveryId,
      turnId: args.turnId,
    })
    for (const d of drained) {
      // eslint-disable-next-line no-await-in-loop
      await this.emitPermissionCancelled({
        channelId: args.channelId,
        deliveryId: d.deliveryId,
        memberHandle: args.delivery.memberHandle,
        permissionRequestId: d.permissionRequestId,
        projectRoot: args.projectRoot,
        turnId: args.turnId,
      })
    }

    // Step 2: cancel + delivery_state_change.
    await this.cancelOneDelivery({
      channelId: args.channelId,
      delivery: args.delivery,
      projectRoot: args.projectRoot,
      turnId: args.turnId,
    })

    // Per-delivery cancel does NOT emit turn_state_change.
  }

  async cancelTurn(args: CancelTurnArgs): Promise<void> {
    // Step 1: drain every pending permission in the turn.
    const drained = await this.deps.broker.drainTurn({
      channelId: args.channelId,
      turnId: args.turnId,
    })
    for (const d of drained) {
      const owner = args.inFlightDeliveries.find((x) => x.deliveryId === d.deliveryId)
      // eslint-disable-next-line no-await-in-loop
      await this.emitPermissionCancelled({
        channelId: args.channelId,
        deliveryId: d.deliveryId,
        memberHandle: owner?.memberHandle ?? '@unknown',
        permissionRequestId: d.permissionRequestId,
        projectRoot: args.projectRoot,
        turnId: args.turnId,
      })
    }

    // Step 2: cancel + delivery_state_change for every non-terminal delivery.
    for (const delivery of args.inFlightDeliveries) {
      if (TERMINAL_DELIVERY_STATES.has(delivery.state)) continue
      // eslint-disable-next-line no-await-in-loop
      await this.cancelOneDelivery({
        channelId: args.channelId,
        delivery,
        projectRoot: args.projectRoot,
        turnId: args.turnId,
      })
    }

    // Step 3: turn_state_change.
    const seq = this.deps.seqAllocator.next({channelId: args.channelId, turnId: args.turnId})
    const event: TurnEvent = {
      channelId: args.channelId,
      deliveryId: null,
      emittedAt: nowIso(),
      from: args.turnState,
      kind: 'turn_state_change',
      memberHandle: null,
      seq,
      to: 'cancelled',
      turnId: args.turnId,
    }
    await this.deps.writeEvent(event, {channelId: args.channelId, projectRoot: args.projectRoot, turnId: args.turnId})
  }

  private async cancelOneDelivery(args: CancelDeliveryArgs): Promise<void> {
    const driver = this.deps.pool.acquire({channelId: args.channelId, memberHandle: args.delivery.memberHandle})
    if (driver !== undefined) {
      try {
        await driver.cancel(args.turnId)
      } catch {
        // session/cancel is best-effort; the driver may already be exiting.
      }
    }

    const seq = this.deps.seqAllocator.next({channelId: args.channelId, turnId: args.turnId})
    const event: TurnEvent = {
      channelId: args.channelId,
      deliveryId: args.delivery.deliveryId,
      emittedAt: nowIso(),
      from: args.delivery.state,
      kind: 'delivery_state_change',
      memberHandle: args.delivery.memberHandle,
      seq,
      to: 'cancelled',
      turnId: args.turnId,
    }
    await this.deps.writeEvent(event, {channelId: args.channelId, projectRoot: args.projectRoot, turnId: args.turnId})
  }

  private async emitPermissionCancelled(args: {
    channelId: string
    deliveryId: string
    memberHandle: string
    permissionRequestId: string
    projectRoot: string
    turnId: string
  }): Promise<void> {
    const seq = this.deps.seqAllocator.next({channelId: args.channelId, turnId: args.turnId})
    const event: TurnEvent = {
      channelId: args.channelId,
      deliveryId: args.deliveryId,
      emittedAt: nowIso(),
      kind: 'permission_decision',
      memberHandle: args.memberHandle,
      outcome: {outcome: 'cancelled'},
      permissionRequestId: args.permissionRequestId,
      seq,
      turnId: args.turnId,
    }
    await this.deps.writeEvent(event, {channelId: args.channelId, projectRoot: args.projectRoot, turnId: args.turnId})
  }
}
