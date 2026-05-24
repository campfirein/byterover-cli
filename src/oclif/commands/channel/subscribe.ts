import {Args, Command, Flags} from '@oclif/core'

import type {
  ChannelGetTurnRequest,
  ChannelGetTurnResponse,
} from '../../../shared/transport/events/channel-events.js'
import type {TurnEvent} from '../../../shared/types/channel.js'

import {ChannelEvents} from '../../../shared/transport/events/channel-events.js'
import {ChannelClientError, connectChannelClient} from '../../lib/channel-client.js'
import {parseCommaSet} from '../../lib/channel-subscribe-helpers.js'
import {ChannelSubscribeRouter} from '../../lib/channel-subscribe-router.js'

/**
 * Phase 9.5.7 §3.4 — resolve the replay cursor for a subscribe run.
 *
 * When `--turn` is set but `--after-seq` is not, default `afterSeq=0` so the
 * existing replay path re-delivers all stored events for the turn. This closes
 * the lost-wakeup race when subscribe connects AFTER the terminal event was
 * broadcast (BUG_REPORT §2.4): without the default, `willReplay` is false and
 * the already-recorded terminal event is never delivered.
 *
 * Preserves listener-before-replay ordering: the caller must register the live
 * listener BEFORE invoking replay. This function only resolves the cursor
 * values; it does not touch the listener registration order.
 *
 * Exported for unit testing.
 */
export function resolveReplayCursor(args: {
  readonly afterSeq: number | undefined
  readonly turn: string | undefined
}): {readonly afterSeq: number | undefined; readonly turn: string | undefined} {
  if (args.turn !== undefined && args.afterSeq === undefined) {
    // Default --after-seq=0 triggers the existing replay path which deduplicates
    // against live events via (turnId, seq), avoiding a fetch-vs-listener race.
    return {afterSeq: 0, turn: args.turn}
  }

  return {afterSeq: args.afterSeq, turn: args.turn}
}

// Slice 8.9 — push-model pub/sub command. Host LLMs (Claude Code, Codex, kimi,
// opencode, pi) spawn this as a long-lived subprocess; it streams filtered
// TurnEvents as newline-delimited JSON to stdout and exits when a bounded
// trigger fires (--count, --exit-on-terminal, --timeout, SIGINT, or socket
// disconnect). MetaGPT-style subscribe-by-interest via --roles / --kinds.
//
// Ordering (codex plan-review P1 + impl-review high-2):
//   connect → register listener → join room → replay → drain live-buffer → live
// The live listener is registered BEFORE the room is joined so no broadcast is
// lost in the join-ack/listener-register gap. While replay is walking history,
// live events are queued in a buffer instead of being emitted directly — this
// guarantees stdout (and lastSeen) is monotonic per-turn even when live events
// arrive mid-replay. After replay finishes, the buffer is drained (each event
// deduped against `printed` via replayDedupKey), and subsequent live events
// flow through directly.

export default class ChannelSubscribe extends Command {
  public static args = {
    channelId: Args.string({description: 'Channel handle', required: true}),
  }
public static description = `Subscribe to a channel and stream filtered events as newline-delimited JSON.

Push-model alternative to polling 'brv channel show'. Host LLMs read stdout
line by line in a tool-call loop — no polling. Exits when --count matching
terminal delivery events have arrived, --exit-on-terminal fires on any turn
reaching completed/cancelled, --timeout elapses, or SIGINT/SIGTERM is
received.

Ordering: the live listener is registered before the channel room is joined,
so no broadcast is lost in the gap between join-ack and listener-register.
When --turn + --after-seq are provided, historical events (seq > afterSeq)
are replayed AFTER joining the room; live events received during replay are
buffered and drained after replay completes. (turnId, seq) dedups events seen
via both paths.

--exit-on-terminal fires on ANY turn reaching a terminal state — turn-level
events (turn_state_change) bypass the --roles filter by design. To wait for
one specific member to finish their delivery, use:
  --roles @member --kinds delivery_state_change --count 1`
public static examples = [
    {
      command: '<%= config.bin %> <%= command.id %> my-review --exit-on-terminal',
      description: 'Wait for the next turn in this channel to reach completed/cancelled',
    },
    {
      command: '<%= config.bin %> <%= command.id %> my-review --roles @codex --kinds delivery_state_change --count 1',
      description: 'Wait specifically for @codex to finish one delivery (role-scoped completion)',
    },
    {
      command: '<%= config.bin %> <%= command.id %> my-review --roles @codex,@kimi --count 2 --kinds delivery_state_change',
      description: 'Quorum: wait for both reviewers to each finish, then exit',
    },
    {
      command: '<%= config.bin %> <%= command.id %> my-review --turn 28gdBaj... --after-seq 12',
      description: 'Crash-recovery: replay events for one turn with seq > 12, then continue live',
    },
  ]
public static flags = {
    'after-seq': Flags.integer({
      description: 'Skip events with seq <= this value within --turn (exclusive crash cursor)',
    }),
    'all-kinds': Flags.boolean({
      default: false,
      description: 'Disable kind filtering — emit every event kind (diagnostics). When set, --kinds is ignored.',
    }),
    // Phase 10 follow-up A3 (V6 evaluation) — auto-reconnect on
    // `io server disconnect` so a daemon hiccup mid-stream doesn't abort
    // the gather. Each retry replays from the last-seen seq under --turn,
    // and rejoins the room under multi-turn mode.
    'auto-reconnect': Flags.boolean({
      allowNo: true,
      default: true,
      description: 'Auto-reconnect on `io server disconnect` up to --max-reconnects. --no-auto-reconnect preserves the legacy fail-on-disconnect behaviour.',
    }),
    count: Flags.integer({
      description: 'Exit after N unique (turnId, memberHandle) terminal delivery events',
      min: 1,
    }),
    // Phase 10 Tier B1b (V6 run-2 §3a) — exit when no tracked delivery
    // can make progress without a permission decision. Lets autonomous
    // orchestrators detect "human needed" without polling. Pairs well
    // with --include-blocked.
    'exit-on-permission-quorum': Flags.boolean({
      default: false,
      description: 'Exit when every tracked delivery is in `awaiting_permission` and none are active — i.e. the gather is structurally stuck waiting for human permission decisions. Pairs with --include-blocked for autonomous orchestrators.',
    }),
    'exit-on-terminal': Flags.boolean({
      default: false,
      description: 'Exit when ANY turn reaches completed/cancelled (turn-level; ignores --roles)',
    }),
    // Phase 10 Tier B1a (V6 run-2 §3a) — `awaiting_permission` counts toward --count.
    'include-blocked': Flags.boolean({
      default: false,
      description: 'Count `awaiting_permission` deliveries toward --count (default: only terminal completed/cancelled/errored count). Use when autonomous gather should not deadlock on permission gates.',
    }),
    json: Flags.boolean({
      allowNo: true,
      default: true,
      description: 'Emit one JSON object per line (default; --no-json renders a terse trace)',
    }),
    kinds: Flags.string({
      description: 'Comma-separated event kinds (e.g. turn_state_change,delivery_state_change)',
    }),
    'max-reconnects': Flags.integer({
      default: 3,
      description: 'Maximum reconnect attempts when --auto-reconnect is on. Each retry uses 1s exponential backoff.',
      min: 0,
    }),
    roles: Flags.string({
      description: 'Comma-separated member handles (e.g. @codex,@kimi); omit to receive all members',
    }),
    timeout: Flags.integer({
      default: 300_000,
      description: 'Hard timeout in ms; exit non-zero on timeout',
      min: 1,
    }),
    turn: Flags.string({
      description: 'Scope to a specific turnId (required when --after-seq is set)',
    }),
  }

  // eslint-disable-next-line complexity
  public async run(): Promise<void> {
    const {args, flags} = await this.parse(ChannelSubscribe)

    if (flags['after-seq'] !== undefined && flags.turn === undefined) {
      this.logToStderr('[CHANNEL_INVALID_FLAGS] --after-seq requires --turn (seq is per-turn monotonic)')
      this.exit(1)
    }

    // Phase 9.5 §3.5 — `--all-kinds` disables kind filtering entirely.
    // When set, `--kinds` is ignored and the router receives every event.
    const filter = {
      kinds: flags['all-kinds'] ? undefined : parseCommaSet(flags.kinds),
      roles: parseCommaSet(flags.roles),
      turn: flags.turn,
    }
    // Phase 9.5.7 §3.4 — default afterSeq=0 when --turn is set without an
    // explicit --after-seq, so subscribe replays already-recorded events for
    // the turn (closes lost-wakeup race for connect-after-terminal-broadcast).
    const {afterSeq} = resolveReplayCursor({
      afterSeq: flags['after-seq'],
      turn: flags.turn,
    })
    const willReplay = flags.turn !== undefined && afterSeq !== undefined

    // Router is shared across reconnects — Phase 10 follow-up A3 (V6 eval).
    // `count` progress, dedup state, and per-turn lastSeen carry over so a
    // mid-stream `io server disconnect` doesn't reset partial gather state.
    let resolveDone: ((reason: 'count' | 'disconnect' | 'permission-quorum' | 'signal' | 'terminal' | 'timeout') => void) | undefined
    let resolved = false
    let resolvedReason: 'count' | 'disconnect' | 'permission-quorum' | 'signal' | 'terminal' | 'timeout' | undefined
    const done = new Promise<'count' | 'disconnect' | 'permission-quorum' | 'signal' | 'terminal' | 'timeout'>((resolve) => {
      resolveDone = (reason) => {
        if (resolved) return
        resolved = true
        resolvedReason = reason
        resolve(reason)
      }
    })
    let disconnectReason: string | undefined

    // Per-attempt resolver that the router's onTerminate forwards to. Each
    // outer-loop iteration swaps it via the `attemptResolveDoneRef` cell.
    const attemptResolveDoneRef: {current: ((reason: 'count' | 'disconnect' | 'permission-quorum' | 'signal' | 'terminal' | 'timeout') => void) | undefined} = {current: undefined}

    const router = new ChannelSubscribeRouter({
      count: flags.count,
      exitOnPermissionQuorum: flags['exit-on-permission-quorum'],
      exitOnTerminal: flags['exit-on-terminal'],
      filter,
      includeBlocked: flags['include-blocked'],
      onEmit: (event) => {
        if (flags.json) {
          this.log(JSON.stringify(event))
        } else {
          this.log(
            `[${event.turnId}#${event.seq}] ${event.memberHandle ?? '@you'} ${event.kind}`,
          )
        }
      },
      onTerminate(reason) {
        attemptResolveDoneRef.current?.(reason)
        resolveDone?.(reason)
      },
    })

    let client = await connectChannelClient()
    let attemptReplayTurn = willReplay ? flags.turn : undefined
    let attemptAfterSeq = willReplay ? afterSeq : undefined
    let reconnectsRemaining = flags['auto-reconnect'] ? flags['max-reconnects'] : 0

    const sleep = (ms: number): Promise<void> => new Promise<void>(r => {
      setTimeout(r, ms)
    })

    const onSignal = (): void => resolveDone?.('signal')
    process.once('SIGINT', onSignal)
    process.once('SIGTERM', onSignal)
    const timeoutTimer = setTimeout(() => resolveDone?.('timeout'), flags.timeout)

    try {
      // Outer reconnect loop. Each iteration registers listeners, joins the
      // room, replays (if cursor available), and waits for a per-attempt
      // resolution. On 'disconnect' with retries remaining, we reset
      // `resolved`/`resolveDone` so the next attempt can wait again.
      //
      // `no-await-in-loop` is suppressed throughout — by design, each retry
      // must serialise (sleep → reconnect → register → wait → on-disconnect-loop).
      let attempt = 0
      /* eslint-disable no-await-in-loop, max-depth */
      while (true) {
        if (attempt > 0) {
          // Backoff: 1s × attempt (1s, 2s, 3s ...).
          await sleep(1000 * attempt)
          client = await connectChannelClient()
          // Reset per-attempt resolution: the previous attempt's
          // 'disconnect' resolved `done`, but we want the loop to keep
          // running. Build a fresh resolution path.
          resolved = false
          resolveDone?.('disconnect')  // satisfy type-checker; immediately re-armed below
        }

        // Re-arm `done` for this attempt unless already terminated.
        // Reuse: router triggers onTerminate (count/terminal); disconnect
        // sets resolved synchronously below; otherwise the timer or signal
        // already fired and we exit.
        let attemptResolved = false
        let attemptResolveDone: ((reason: 'count' | 'disconnect' | 'permission-quorum' | 'signal' | 'terminal' | 'timeout') => void) | undefined
        const attemptDone = new Promise<'count' | 'disconnect' | 'permission-quorum' | 'signal' | 'terminal' | 'timeout'>((resolve) => {
          attemptResolveDone = (reason) => {
            if (attemptResolved) return
            attemptResolved = true
            resolve(reason)
          }
        })
        // Re-wire the shared router→attempt forwarder: this attempt's
        // resolver is what fires when the router terminates.
        attemptResolveDoneRef.current = attemptResolveDone

        if (willReplay) router.beginReplay()
        const offTurnEvent = client.on<{channelId: string; event: TurnEvent}>(
          ChannelEvents.TURN_EVENT,
          (data) => {
            if (data.channelId !== args.channelId) return
            router.pushLive(data.event)
          },
        )
        const offDisconnect = client.on<string>('disconnect', (reason) => {
          disconnectReason = typeof reason === 'string' ? reason : 'unknown'
          attemptResolveDone?.('disconnect')
        })

        await client.subscribe(args.channelId)

        // Replay (initial: from --after-seq; on reconnect: from lastSeen).
        if (attemptReplayTurn !== undefined && attemptAfterSeq !== undefined) {
          const turn = await client.request<ChannelGetTurnRequest, ChannelGetTurnResponse>(
            ChannelEvents.GET_TURN,
            {channelId: args.channelId, turnId: attemptReplayTurn},
          )
          for (const event of turn.events) {
            if (router.isTerminated()) break
            if (event.seq <= attemptAfterSeq) continue
            router.pushReplay(event)
          }
        }

        router.finishReplay()

        // Wait for this attempt's resolution: terminal, disconnect,
        // signal, or timeout. Signal/timeout resolve both `done` (final)
        // and `attemptDone` via the shared `resolveDone` reference; we
        // forward those.
        // Tie signal + timeout to attemptResolveDone via the resolveDone
        // closure — when resolveDone fires for 'signal' or 'timeout', we
        // need attemptResolveDone to fire too so we leave this attempt.
        const reasonForwarder = setInterval(() => {
          if (resolvedReason === 'signal' || resolvedReason === 'timeout') {
            attemptResolveDone?.(resolvedReason)
          }
        }, 50)

        const attemptReason = await attemptDone
        clearInterval(reasonForwarder)
        offTurnEvent()
        offDisconnect()
        await client.unsubscribe(args.channelId).catch(() => {})

        if (attemptReason === 'disconnect' && reconnectsRemaining > 0 && !router.isTerminated()) {
          reconnectsRemaining -= 1
          attempt += 1
          // Seed replay cursor from router's lastSeen so the next attempt
          // picks up where we left off (single-turn streams only — router
          // tracks lastSeen as a single per-stream cursor).
          const cursor = router.lastSeen()
          if (cursor !== undefined) {
            attemptReplayTurn = cursor.turnId
            attemptAfterSeq = cursor.seq
          }

          // Don't disconnect the OLD client here — we may still hold a
          // reference; the new attempt will spin up a fresh connection.
          client.disconnect()
          continue
        }

        // Final resolution for this run.
        resolveDone?.(attemptReason)
        break
      }
      /* eslint-enable no-await-in-loop, max-depth */

      const finalReason = await done
      clearTimeout(timeoutTimer)
      process.off('SIGINT', onSignal)
      process.off('SIGTERM', onSignal)

      if (finalReason === 'disconnect') {
        this.log(
          JSON.stringify({
            control: 'disconnected',
            lastSeen: router.lastSeen(),
            reason: disconnectReason ?? 'unknown',
            reconnectsExhausted: reconnectsRemaining === 0 && flags['auto-reconnect'],
          }),
        )
        this.exit(1)
      }

      if (finalReason === 'timeout') {
        this.logToStderr(`[CHANNEL_SUBSCRIBE_TIMEOUT] No terminal trigger within ${flags.timeout}ms`)
        this.exit(1)
      }

      // Phase 10 Tier B1b — clean exit, but with code 2 (distinct from
      // ok/error) so autonomous orchestrators can detect "human needed".
      if (finalReason === 'permission-quorum') {
        this.log(
          JSON.stringify({
            control: 'permission-quorum',
            lastSeen: router.lastSeen(),
            reason: 'all tracked deliveries are blocked on permission decisions; nothing is making progress',
          }),
        )
        this.exit(2)
      }
    } catch (error) {
      this.handleError(error, flags.json)
    } finally {
      client.disconnect()
    }
  }

  private handleError(error: unknown, asJson: boolean): never {
    if (error instanceof ChannelClientError) {
      if (asJson) {
        this.log(JSON.stringify({code: error.code, error: error.message, success: false}))
      } else {
        this.logToStderr(`[${error.code}] ${error.message}`)
      }

      this.exit(1)
    }

    throw error
  }
}
