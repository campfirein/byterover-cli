import type {TurnEvent} from '../../shared/types/channel.js'

import {
  countDedupKey,
  isActiveDeliveryState,
  isBlockedDeliveryEvent,
  isTerminalDeliveryEvent,
  isTerminalTurnEvent,
  matchesFilter,
  replayDedupKey,
  type SubscribeFilter,
} from './channel-subscribe-helpers.js'

// Slice 8.9 — extracted from `channel subscribe` so the
// buffer / dedup / termination orchestration is unit-testable without
// spinning up a daemon. Codex impl-review R5 specifically asked for a
// fake-client test covering ordering, dedup, and lastSeen monotonicity.

// Phase 10 Tier B1 (V6 run-2) — `permission-quorum` fires when every
// delivery the router has tracked is in `awaiting_permission` and none are
// in an active state; the gather is structurally unable to progress
// without a human permission decision.
export type TerminationReason = 'count' | 'permission-quorum' | 'terminal'

export type RouterOptions = {
  count?: number
  // Phase 10 Tier B1b — terminate when no tracked delivery is making
  // progress AND at least one is blocked on permission. Defaults off
  // (legacy behaviour: wait indefinitely for terminal events).
  exitOnPermissionQuorum?: boolean
  exitOnTerminal: boolean
  filter: SubscribeFilter
  // Phase 10 Tier B1a — `awaiting_permission` deliveries count toward
  // `--count`. Defaults off (legacy: only terminal counts).
  includeBlocked?: boolean
  onEmit: (event: TurnEvent) => void
  onTerminate?: (reason: TerminationReason) => void
}

export class ChannelSubscribeRouter {
  private cursor: undefined | {seq: number; turnId: string}
  // Phase 10 Tier B1b — latest known state per (turnId, memberHandle).
  // Updated on every delivery_state_change so `checkPermissionQuorumExit`
  // can answer "is anything still active?" without re-walking events.
  private readonly deliveryStates = new Map<string, string>()
  // Live events that arrive while replay is in progress are buffered here and
  // drained after replay completes. Codex impl-review high-2: without the
  // buffer, a live seq=7 could be emitted before a replayed seq=4 and
  // lastSeen.seq would regress.
  private readonly liveBuffer: TurnEvent[] = []
  private readonly opts: RouterOptions
  private readonly printed = new Set<string>()
  private readonly quorumSeen = new Set<string>()
  private replaying = false
  private terminated = false

  public constructor(opts: RouterOptions) {
    this.opts = opts
  }

  public beginReplay(): void {
    this.replaying = true
  }

  // Drain buffered live events in arrival order, then flip out of replay mode
  // so subsequent live events emit directly.
  public finishReplay(): void {
    for (const event of this.liveBuffer) {
      if (this.terminated) break
      this.processEvent(event)
    }

    this.liveBuffer.length = 0
    this.replaying = false
  }

  public isTerminated(): boolean {
    return this.terminated
  }

  public lastSeen(): undefined | {seq: number; turnId: string} {
    return this.cursor
  }

  // Live event from the Socket.IO listener.
  public pushLive(event: TurnEvent): void {
    if (this.terminated) return
    if (this.replaying) {
      this.liveBuffer.push(event)
      return
    }

    this.processEvent(event)
  }

  // Historical event from a `channel:get-turn` request during replay.
  public pushReplay(event: TurnEvent): void {
    if (this.terminated) return
    this.processEvent(event)
  }

  // Phase 10 Tier B1b — fire when the gather is structurally stuck.
  // Heuristic:
  //   * `--count N` is set (so we know how many deliveries to expect)
  //   * we've tracked at least N delivery states
  //   * NO tracked delivery is in an active state (queued/dispatched/streaming)
  //   * at least one tracked delivery is in `awaiting_permission`
  // Under those conditions, the only way to make progress is a human
  // permission decision. An autonomous orchestrator can exit cleanly with
  // reason `'permission-quorum'` and surface the blocked deliveries.
  //
  // Coupling to --count is intentional: without it, the router cannot
  // distinguish "premature blocked (more deliveries still in queue)" from
  // "structurally stuck (everything that's going to arrive has arrived)."
  // --count is the user's explicit declaration of expected fan-out.
  private checkPermissionQuorumExit(): void {
    if (this.opts.exitOnPermissionQuorum !== true) return
    if (this.opts.count === undefined) return
    if (this.deliveryStates.size < this.opts.count) return
    let hasActive = false
    let hasBlocked = false
    for (const state of this.deliveryStates.values()) {
      if (isActiveDeliveryState(state)) hasActive = true
      if (state === 'awaiting_permission') hasBlocked = true
    }

    if (!hasActive && hasBlocked) this.terminate('permission-quorum')
  }

  private checkQuorumCount(event: TurnEvent): void {
    if (this.opts.count === undefined) return
    // Phase 10 Tier B1a — under `--include-blocked`, awaiting_permission
    // deliveries also count toward the quorum threshold. Legacy default
    // (terminal-only) is preserved.
    const eligible = isTerminalDeliveryEvent(event)
      || (this.opts.includeBlocked === true && isBlockedDeliveryEvent(event))
    if (!eligible) return
    const key = countDedupKey(event)
    if (key === undefined) return
    const memberOk =
      this.opts.filter.roles === undefined || this.opts.filter.roles.has(event.memberHandle ?? '')
    if (!memberOk) return
    this.quorumSeen.add(key)
    if (this.quorumSeen.size >= this.opts.count) this.terminate('count')
  }

  // Terminal-turn exit ignores --kinds/--roles by design (a turn either reached
  // terminal or it didn't). Still gated by --turn so an unrelated turn doesn't
  // fire it.
  private checkTurnTerminalExit(event: TurnEvent): void {
    if (!this.opts.exitOnTerminal) return
    if (!isTerminalTurnEvent(event)) return
    if (this.opts.filter.turn !== undefined && event.turnId !== this.opts.filter.turn) return
    this.terminate('terminal')
  }

  private emit(event: TurnEvent): boolean {
    if (!matchesFilter(event, this.opts.filter)) return false
    const key = replayDedupKey(event)
    if (this.printed.has(key)) return false
    this.printed.add(key)
    this.cursor = {seq: event.seq, turnId: event.turnId}
    this.opts.onEmit(event)
    return true
  }

  // Single entry point for both live and replay events post-buffering. Emits
  // first (so an event that passes the filter still appears in stdout even
  // when it triggers terminate), then runs termination checks. Quorum-count
  // is gated by the filter (it counts emitted terminal deliveries). Terminal
  // turn-exit bypasses --kinds/--roles by design (codex impl-review-2 medium)
  // but still respects --turn.
  private processEvent(event: TurnEvent): void {
    // Phase 10 Tier B1b — track per-delivery state on EVERY delivery_state_change
    // (regardless of filter) so `checkPermissionQuorumExit` sees a complete
    // picture even when --kinds/--roles exclude the event from stdout emission.
    if (
      event.kind === 'delivery_state_change'
      && event.memberHandle !== null
      && event.memberHandle !== undefined
    ) {
      const key = countDedupKey(event)
      if (key !== undefined) this.deliveryStates.set(key, event.to)
    }

    const emitted = this.emit(event)
    if (emitted) this.checkQuorumCount(event)
    this.checkTurnTerminalExit(event)
    this.checkPermissionQuorumExit()
  }

  private terminate(reason: TerminationReason): void {
    if (this.terminated) return
    this.terminated = true
    this.opts.onTerminate?.(reason)
  }
}
