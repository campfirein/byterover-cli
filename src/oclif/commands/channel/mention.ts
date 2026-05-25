import {Args, Command, Flags} from '@oclif/core'

import type {
  ChannelMentionQuorumRequest,
  ChannelMentionQuorumResponse,
  ChannelMentionRequest,
  ChannelMentionSyncResponse,
  ChannelTurnAcceptedResponse,
} from '../../../shared/transport/events/channel-events.js'
import type {TurnEvent} from '../../../shared/types/channel.js'

import {ChannelEvents} from '../../../shared/transport/events/channel-events.js'
import {ChannelClientError, withChannelClient} from '../../lib/channel-client.js'

// Local @mention parser — duplicates server-side `parseMentions` to avoid an
// oclif→server import edge crossing (CLAUDE.md: oclif/ must not import from
// server/). Same regex contract as `src/server/infra/channel/mention-parser.ts`.
function parseMentionsFromPrompt(text: string): string[] {
  const out: string[] = []
  const seen = new Set<string>()
  const pattern = /(?:^|\s)(@[a-zA-Z0-9_-]+)\b/g
  let match: null | RegExpExecArray
  while ((match = pattern.exec(text)) !== null) {
    const handle = match[1]
    if (!seen.has(handle)) {
      seen.add(handle)
      out.push(handle)
    }
  }

  return out
}

export default class ChannelMention extends Command {
  public static args = {
    channelId: Args.string({description: 'Channel handle', required: true}),
    text: Args.string({description: 'Prompt text (may contain @mentions)', required: true}),
  }
public static description = `Dispatch a mention to ACP agent members and stream the reply.

Two modes:

  * SINGLE-AGENT — the default. Prompt mentions one or more agents; the
    daemon dispatches and streams turn events (--mode stream) or blocks
    until terminal (--mode sync). Use this when you want one agent's
    answer.

  * QUORUM (Phase 10) — pass --quorum K to fan-out the same prompt to
    multiple agents and merge their findings via the CRDT-union policy.
    The daemon returns a serialised MergedQuorum {agreed, pending,
    contradicted, missingAgents, partial}. Optional escalation lets
    local-first dispatch fall back to remote agents when the local pool
    produces no agreement. Use this for cross-checking risky operations
    (audits, migrations, second opinions).
`
public static examples = [
    {
      command: '<%= config.bin %> <%= command.id %> pi-test "@mock please review"',
      description: 'Single-agent stream',
    },
    {
      command: '<%= config.bin %> <%= command.id %> pi-test "@mock ping" --no-wait --json',
      description: 'Single-agent dispatch + immediate ack (host LLM resumes via subscribe later)',
    },
    {
      command: '<%= config.bin %> <%= command.id %> review-2026 "@kimi @codex review src/auth.py" --quorum 2 --json',
      description: 'Quorum K=2: both agents must agree for claims to land in `agreed`',
    },
    {
      command: '<%= config.bin %> <%= command.id %> review-2026 "@kimi @codex @opencode audit migration" --quorum 2 --stake high --escalate-on empty-or-contradiction --json',
      description: 'Stake=high (2 local + 1 remote); auto-escalate to remote when local consensus fails',
    },
    {
      command: '<%= config.bin %> <%= command.id %> review-2026 "@kimi @codex @remote-peer audit" --quorum 2 --stake high --pool-mode parallel --local-timeout-ms 5000 --remote-timeout-ms 30000 --json',
      description: 'Parallel pools (Slice 10.5): local + remote concurrent under per-pool timeouts; slow remote can\'t stall local',
    },
    {
      command: '<%= config.bin %> <%= command.id %> review-2026 "@kimi @codex @opencode review integration" --quorum 2 --needs integration-bugs,type-safety --json',
      description: 'Tag-based matchmaking (Slice 10.6): picks kimi (integration-bugs) + codex (type-safety) over opencode',
    },
  ]
public static flags = {
    // Phase 10 Slice 10.3 — escalation policy for --quorum dispatch.
    'escalate-on': Flags.string({
      description: 'Local-first quorum escalation trigger. "empty" = escalate when no local consensus; "empty-or-contradiction" (default) = also escalate on positions disagreeing; "low-confidence" = escalate when min self-reported confidence falls below threshold; "never" = local pool only. Ignored unless --quorum.',
      options: ['empty', 'empty-or-contradiction', 'low-confidence', 'never'],
    }),
    'idempotency-key': Flags.string({description: 'Explicit dedupe key (CHANNEL_PROTOCOL.md §12). Omit to let the daemon auto-derive one from (channelId | prompt | mentions | 5-min bucket) — duplicate dispatches inside the same bucket collapse onto the original turn.'}),
    json: Flags.boolean({default: false, description: 'Emit JSON instead of pretty output'}),
    // Phase 10 Slice 10.3 — pool overrides for --quorum.
    'local-only': Flags.boolean({
      default: false,
      description: 'Quorum: skip remote agents entirely (mutually exclusive with --remote-only).',
    }),
    // Phase 10 Slice 10.5 — per-pool timeout budgets for --pool-mode parallel.
    'local-timeout-ms': Flags.integer({
      description: 'Local-pool timeout budget for --pool-mode parallel (default 5000). Ignored under --pool-mode local-first.',
      min: 1,
    }),
    // Phase 10 Slice 10.3 — confidence threshold for --escalate-on low-confidence.
    'low-confidence-threshold': Flags.string({
      description: 'Minimum acceptable confidence (0..1) under --escalate-on low-confidence. Default 0.6 (server side).',
    }),
    // Phase 10 Slice 10.2 — `--merge-policy` selects the merge strategy.
    // Tier 1 only ships `union`; majority + adversarial-filter are
    // scaffolds and reject at the daemon layer.
    'merge-policy': Flags.string({
      default: 'union',
      description: 'Merge policy for --quorum dispatch. Tier 1 ships only "union" (CRDT union over findings).',
      options: ['union'],
    }),
    // Slice 8.0 — sync mode + thought suppression. `--mode sync` makes
    // the daemon block the ack until the turn reaches a terminal state
    // and assemble `{finalAnswer, toolCalls, durationMs}` instead of
    // returning the immediate ChannelTurnAcceptedResponse. Default
    // 'stream' preserves Phase-1..7 behaviour. `--suppress-thoughts`
    // drops `agent_thought_chunk` events on both the wire and disk.
    mode: Flags.string({
      default: 'stream',
      description: 'Single-agent wire mode. "stream" (default) emits TURN_EVENT broadcasts; "sync" blocks the ack until terminal and returns the assembled answer. Ignored when --quorum is set.',
      options: ['stream', 'sync'],
    }),
    // Phase 10 Slice 10.6 — tag-based matchmaking. Comma-separated list of
    // strength tags. Default profiles ship for kimi/codex/opencode/pi/
    // claude-code; agents with custom strengths in their channel-member
    // override take precedence.
    needs: Flags.string({
      description: 'Comma-separated strength tags for --quorum matchmaking (e.g. "integration-bugs,type-safety"). Agents with matching strengths are picked first; ties tie-break alphabetically by handle. Tier 1 default profiles: kimi=integration-bugs/multi-agent-coordination/protocol-correctness, codex=api-design/concurrency/static-analysis/type-safety, opencode=rendering/ux/visual-design, pi=concurrency/reasoning/systems-design, claude-code=planning/design-review/cross-cutting-refactor.',
    }),
    'no-wait': Flags.boolean({
      default: false,
      description: 'Single-agent only: ack immediately after dispatch (host LLM resumes later via `brv channel subscribe --turn <id>`).',
    }),
    // Phase 10 Slice 10.5 — dispatch strategy for --quorum.
    'pool-mode': Flags.string({
      description: 'Quorum dispatch strategy: "local-first" (default; Slice 10.3 sequential, cost-optimal: only pay remote latency when local consensus fails) or "parallel" (Slice 10.5: local + remote concurrent with per-pool timeouts, latency-optimal: wall clock = max(local, remote)).',
      options: ['local-first', 'parallel'],
    }),
    // Phase 10 Slice 10.2 — `--quorum K` fans out the prompt to mentioned
    // channel members, awaits all terminal deliveries, and returns a
    // MergedQuorum JSON shape.
    quorum: Flags.integer({
      description: 'Quorum threshold: a claim lands in `agreed` only when at least K agents emit the same canonical claim. Note: singleton claims (only one agent contributed to that bucket) ALWAYS land in `pending`, even at K=1 — the merge policy treats them as too thin to call consensus. Combine with --stake to size the dispatched pool.',
      min: 1,
    }),
    'remote-only': Flags.boolean({
      default: false,
      description: 'Quorum: skip local agents entirely (mutually exclusive with --local-only).',
    }),
    'remote-timeout-ms': Flags.integer({
      description: 'Remote-pool timeout budget for --pool-mode parallel (default 30000). Ignored under --pool-mode local-first.',
      min: 1,
    }),
    // Phase 10 Slice 10.4 — stake-driven dispatch sizing.
    stake: Flags.string({
      description: 'Quorum dispatch sizing. low=1 local; medium (default)=2 local; high=2 local+1 remote; critical=3 local+2 remote. Operators tune via BRV_QUORUM_STAKE_<STAKE>_<LOCAL|REMOTE> env.',
      options: ['low', 'medium', 'high', 'critical'],
    }),
    'suppress-thoughts': Flags.boolean({
      default: false,
      description: 'Drop agent_thought_chunk events at the daemon (no broadcast, no persist). Useful for non-interactive callers — typically ~20× bandwidth/disk savings.',
    }),
    timeout: Flags.integer({
      description: 'Turn timeout in ms (default 300000). Applies to --mode sync and --quorum dispatches.',
    }),
    // Phase 10 Slice 10.3 — flips the missing-confidence default for
    // --escalate-on low-confidence.
    'treat-missing-confidence-as-high': Flags.boolean({
      default: false,
      description: 'For --escalate-on low-confidence: by default a Finding without a confidence value is treated as low (0); this flag treats it as high (1). Use when agents don\'t self-report confidence.',
    }),
  }

  public async run(): Promise<void> {
    const {args, flags} = await this.parse(ChannelMention)

    try {
      // eslint-disable-next-line complexity
      await withChannelClient(async (client) => {
        // Phase 10 Slice 10.2 — `--quorum K` routes to the daemon's quorum
        // dispatcher (NOT a recursive shell-out — codex Q4). Returns a
        // serialised MergedQuorum.
        if (flags.quorum !== undefined) {
          const mentions = parseMentionsFromPrompt(args.text)
          if (mentions.length === 0) {
            throw new ChannelClientError(
              'CHANNEL_MENTION_EMPTY',
              '--quorum requires at least one @mention in the prompt',
            )
          }

          if (flags['local-only'] === true && flags['remote-only'] === true) {
            throw new ChannelClientError(
              'CHANNEL_INVALID_REQUEST',
              '--local-only and --remote-only are mutually exclusive.',
            )
          }

          const lowConfidenceThreshold =
            flags['low-confidence-threshold'] === undefined
              ? undefined
              : Number.parseFloat(flags['low-confidence-threshold'])
          if (lowConfidenceThreshold !== undefined && (Number.isNaN(lowConfidenceThreshold) || lowConfidenceThreshold < 0 || lowConfidenceThreshold > 1)) {
            throw new ChannelClientError(
              'CHANNEL_INVALID_REQUEST',
              '--low-confidence-threshold must be a number in [0, 1]',
            )
          }

          const turnTimeoutMs = flags.timeout ?? 300_000
          const transportTimeoutMs = turnTimeoutMs + 5000
          // Kimi F3: `--idempotency-key` is intentionally NOT forwarded on the
          // quorum path until orchestrator-side dedupe lands. Non-quorum paths
          // below still pass it through.
          const stake = flags.stake as 'critical' | 'high' | 'low' | 'medium' | undefined
          const escalateOn = flags['escalate-on'] as 'empty' | 'empty-or-contradiction' | 'low-confidence' | 'never' | undefined
          const poolMode = flags['pool-mode'] as 'local-first' | 'parallel' | undefined
          const needs = flags.needs === undefined
            ? undefined
            : flags.needs.split(',').map(s => s.trim()).filter(s => s.length > 0)
          const response = await client.request<ChannelMentionQuorumRequest, ChannelMentionQuorumResponse>(
            ChannelEvents.MENTION_QUORUM,
            {
              channelId: args.channelId,
              ...(escalateOn === undefined ? {} : {escalateOn}),
              ...(flags['local-only'] === true ? {localOnly: true} : {}),
              ...(flags['local-timeout-ms'] === undefined ? {} : {localTimeoutMs: flags['local-timeout-ms']}),
              ...(lowConfidenceThreshold === undefined ? {} : {lowConfidenceThreshold}),
              mentions,
              mergePolicy: 'union',
              ...(needs === undefined || needs.length === 0 ? {} : {needs}),
              ...(poolMode === undefined ? {} : {poolMode}),
              prompt: args.text,
              quorumThreshold: flags.quorum,
              ...(flags['remote-only'] === true ? {remoteOnly: true} : {}),
              ...(flags['remote-timeout-ms'] === undefined ? {} : {remoteTimeoutMs: flags['remote-timeout-ms']}),
              ...(stake === undefined ? {} : {stake}),
              suppressThoughts: flags['suppress-thoughts'],
              timeout: turnTimeoutMs,
              ...(flags['treat-missing-confidence-as-high'] ? {treatMissingConfidenceAsHigh: true} : {}),
            },
            {timeoutMs: transportTimeoutMs},
          )

          this.log(JSON.stringify(response, undefined, flags.json ? 2 : 0))
          return
        }

        // Slice 8.0 — sync mode: the daemon buffers the turn and acks
        // with `{finalAnswer, toolCalls, ...}` when terminal. No client-side
        // stream subscription is needed.
        if (flags.mode === 'sync') {
          // Bug 1 follow-up: in sync mode the daemon holds the ack until the
          // turn settles, so the transport request-timeout MUST be ≥ the
          // daemon-side turn timeout. Otherwise the CLI sees
          // `CHANNEL_REQUEST_TIMEOUT` at the env default (60s) even when the
          // user passed `--timeout 300000`. Pass `(timeout + 5s grace)` so the
          // resolved ack has time to travel back.
          const turnTimeoutMs = flags.timeout ?? 300_000
          const transportTimeoutMs = turnTimeoutMs + 5000
          const syncResponse = await client.request<ChannelMentionRequest, ChannelMentionSyncResponse>(
            ChannelEvents.MENTION,
            {
              channelId: args.channelId,
              idempotencyKey: flags['idempotency-key'],
              mode: 'sync',
              prompt: args.text,
              suppressThoughts: flags['suppress-thoughts'],
              timeout: flags.timeout,
            },
            {timeoutMs: transportTimeoutMs},
          )
          if (flags.json) {
            this.log(JSON.stringify(syncResponse, undefined, 2))
          } else {
            this.log(syncResponse.finalAnswer)
            this.log(`turn ${syncResponse.turnId} ${syncResponse.endedState} (${syncResponse.durationMs}ms)`)
          }

          return
        }

        // Stream mode (default) — Phase 1–7 behaviour.
        // Subscribe BEFORE sending the request so the broadcast is not missed.
        if (!flags['no-wait']) await client.subscribe(args.channelId)

        let terminalResolve: ((value: 'cancelled' | 'completed') => void) | undefined
        const terminal = new Promise<'cancelled' | 'completed'>((resolve) => {
          terminalResolve = resolve
        })

        const off = flags['no-wait']
          ? undefined
          : client.on<{channelId: string; event: TurnEvent}>(ChannelEvents.TURN_EVENT, (data) => {
              if (data.channelId !== args.channelId) return
              this.renderEvent(data.event)
              if (
                data.event.kind === 'turn_state_change' &&
                (data.event.to === 'completed' || data.event.to === 'cancelled')
              ) {
                terminalResolve?.(data.event.to)
              }
            })

        const accepted = await client.request<ChannelMentionRequest, ChannelTurnAcceptedResponse>(
          ChannelEvents.MENTION,
          {
            channelId: args.channelId,
            idempotencyKey: flags['idempotency-key'],
            prompt: args.text,
            suppressThoughts: flags['suppress-thoughts'],
          },
        )

        if (flags['no-wait']) {
          if (flags.json) {
            this.log(JSON.stringify(accepted, undefined, 2))
          } else {
            this.log(`turn ${accepted.turn.turnId} dispatched (${accepted.deliveries.length} delivery)`)
          }

          return
        }

        const finalState = await terminal
        off?.()
        await client.unsubscribe(args.channelId)
        if (flags.json) {
          this.log(JSON.stringify({...accepted, state: finalState}, undefined, 2))
        } else {
          this.log(`turn ${accepted.turn.turnId} ${finalState}`)
        }
      })
    } catch (error) {
      this.handleError(error, flags.json)
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

  private renderEvent(event: TurnEvent): void {
    const tag = `[${event.memberHandle ?? '@you'}]`
    switch (event.kind) {
      case 'agent_message_chunk': {
        this.log(`${tag} ${event.content}`)
        break
      }

      case 'agent_thought_chunk': {
        if (process.stdout.isTTY) this.log(`${tag} (thinking) ${event.content}`)
        break
      }

      case 'permission_request': {
        this.log(`${tag} permission_request id=${event.permissionRequestId}`)
        break
      }

      case 'tool_call': {
        this.log(`${tag} tool_call ${event.name}`)
        break
      }

      default: {
        // delivery_state_change / turn_state_change / etc — surface terse trace.
        if (event.kind === 'delivery_state_change' || event.kind === 'turn_state_change') {
          this.log(`${tag} ${event.kind} ${event.from} → ${event.to}`)
        }
      }
    }
  }
}
