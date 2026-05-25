import {Command} from '@oclif/core'

// Slice 8.8 — `brv channel --help` (and bare `brv channel`) renders this
// rich onboarding guide. A host LLM that runs `--help` cold (no skill
// loaded) has enough info here to onboard any of the four reviewer
// agents, create a channel, invite, and run a structured mention.
//
// Plan: plan/channel-protocol/IMPLEMENTATION_PHASE_8_FOLLOWUPS.md §"Slice 8.8".

export default class ChannelTopic extends Command {
  public static description = `Multi-agent channel orchestration — invite ACP agents into a shared transcript and route work between them.

Set up a channel from scratch in four steps:

  1. ONBOARD each reviewer agent as a driver profile (one-time per agent):
       brv channel onboard kimi -- kimi acp
       brv channel onboard opencode -- opencode acp
       brv channel onboard codex -- codex-acp     # requires: npm i -g @zed-industries/codex-acp
       brv channel onboard pi -- pi-acp           # requires: npm i -g pi-acp

  2. CREATE a channel:
       brv channel new my-review

  3. INVITE one or more onboarded agents:
       brv channel invite my-review @kimi --profile kimi
       brv channel invite my-review @codex --profile codex

  4. MENTION an agent to get a response:
       brv channel mention my-review "@kimi please review src/auth.py" \\
         --mode sync --suppress-thoughts --json --timeout 300000

  5. ORCHESTRATE multiple agents (fan-out + gather without polling):
       # Dispatch to each agent in parallel; capture each turnId from --json:
       brv channel mention my-review "@kimi review src/auth.py" --no-wait --json
       brv channel mention my-review "@codex review src/auth.py" --no-wait --json
       # Wait for both terminal deliveries (count=2 is the quorum exit;
       # do NOT add --exit-on-terminal here — it would exit on the first
       # turn_state_change → completed before the slower turn lands):
       brv channel subscribe my-review --roles @kimi,@codex \\
         --kinds delivery_state_change --count 2 --json
       # Then read each turn's finalAnswer:
       brv channel show my-review <turnId-kimi> --json
       brv channel show my-review <turnId-codex> --json

  6. QUORUM (Phase 10) — fan-out the same prompt to K agents and merge
     their findings under the CRDT-union policy. Use for cross-checking
     risky operations (audits, migrations, second opinions):
       brv channel mention my-review "@kimi @codex review src/auth.py" \\
         --quorum 2 --json
       # Output: a MergedQuorum {agreed, pending, contradicted,
       # missingAgents, partial} — claims agreed by ≥2 agents land in
       # 'agreed'; singletons go to 'pending'.

     Stake-graded sizing (--stake low|medium|high|critical) lets the
     dispatcher size the local + remote pools automatically — override
     per-grade with BRV_QUORUM_STAKE_<STAKE>_<LOCAL|REMOTE>:
       brv channel mention my-review "@kimi @codex @opencode audit migration" \\
         --quorum 2 --stake high --escalate-on empty-or-contradiction --json
       # high = 2 local + 1 remote; auto-falls-back to remote when local
       # consensus is empty OR positions contradict.

     Pool overrides: --local-only / --remote-only bypass the local-first
     escalation. --escalate-on never keeps execution strictly local.

     Strategy (Slice 10.5): --pool-mode local-first (default) is cost-
     optimal (only pay remote latency when local consensus fails).
     --pool-mode parallel dispatches local + remote concurrently with
     per-pool timeouts (--local-timeout-ms default 5000,
     --remote-timeout-ms default 30000); use when wall-clock predictability
     matters more than remote cost.

     Matchmaking (Slice 10.6): --needs tag1,tag2 scores agents by their
     strength profile so review prompts target the right reviewer. Default
     profiles: kimi=integration-bugs/multi-agent-coordination/protocol-
     correctness, codex=api-design/concurrency/static-analysis/type-safety,
     opencode=rendering/ux/visual-design, pi=concurrency/reasoning/systems-
     design, claude-code=planning/design-review/cross-cutting-refactor.

  When an agent requests a permission mid-turn, respond with:
       brv channel approve my-review <turnId> <permissionRequestId> --json
       brv channel deny    my-review <turnId> <permissionRequestId> --json

  Recovery: if a mention returns CHANNEL_DRIVER_NOT_REGISTERED,
  CHANNEL_PERMISSION_LOST_ON_RESTART, or another error code — install the
  brv-channel skill (below) for the full per-code recovery playbook.

For the natural-language host-LLM flow (Claude Code / Codex / kimi / opencode
/ Pi reads the brv-channel skill and runs 'brv channel mention …' for you
when you ask), install the skill once with:
       brv channel skill install

Common follow-ups: 'brv channel list' to see channels, 'brv channel doctor'
to check member health, 'brv channel show <ch> <turnId>' to inspect a past
turn, 'brv channel watch <ch>' to live-tail, or
'brv channel subscribe <ch> --roles @kimi --exit-on-terminal' for a bounded,
filtered push stream that exits when the named reviewer finishes a turn.

Codex and Pi require separate ACP adapter packages — both are external
npm packages:
  - @zed-industries/codex-acp — Codex doesn't ship an ACP server natively
  - pi-acp                    — Pi's --mode rpc is a Pi-specific protocol
Kimi and opencode have native 'kimi acp' / 'opencode acp' subcommands and
need no adapter package beyond the agent CLI itself.`
public static examples = [
    {
      command: '<%= config.bin %> channel onboard kimi -- kimi acp',
      description: 'Register kimi as a driver profile (one-time)',
    },
    {
      command: '<%= config.bin %> channel new review-2026 && <%= config.bin %> channel invite review-2026 @kimi --profile kimi',
      description: 'Create a channel and invite kimi as @kimi',
    },
    {
      command: '<%= config.bin %> channel mention review-2026 "@kimi please review auth.py" --mode sync --suppress-thoughts --json --timeout 300000',
      description: 'Ask @kimi a question and block for a structured response',
    },
    {
      command: '<%= config.bin %> channel skill install',
      description: 'Install the brv-channel skill so host LLMs (Claude Code, Codex, kimi, opencode, Pi) drive channel mentions automatically',
    },
    {
      command: '<%= config.bin %> channel subscribe my-review --roles @kimi,@codex --kinds delivery_state_change --count 2 --json',
      description: 'Quorum gather: exit when 2 unique terminal deliveries land (do NOT add --exit-on-terminal here — it would short-circuit when the first turn completes)',
    },
    {
      command: '<%= config.bin %> channel mention my-review "@kimi review src/auth.py" --no-wait --json && <%= config.bin %> channel subscribe my-review --roles @kimi --kinds delivery_state_change --count 1 --json',
      description: 'Fan-out + gather pattern: dispatch async, then subscribe to wait for one terminal delivery without polling',
    },
    {
      command: '<%= config.bin %> channel mention review-2026 "@kimi @codex review src/auth.py" --quorum 2 --json',
      description: 'Phase 10 quorum: K=2 — claims agreed by both kimi and codex land in `agreed`',
    },
    {
      command: '<%= config.bin %> channel mention review-2026 "@kimi @codex @opencode audit migration" --quorum 2 --stake high --escalate-on empty-or-contradiction --json',
      description: 'Stake=high (2 local + 1 remote); auto-escalate to remote when local consensus fails',
    },
  ]

  public async run(): Promise<void> {
    await this.config.runCommand('help', ['channel'])
  }
}
