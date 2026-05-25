---
name: brv-channel
description: Use when the user asks to consult a *different* agent (kimi, opencode, codex, pi, etc.) for a second opinion, peer review, or focused subtask — trigger phrases include "ask @<agent>", "get a second opinion from", "have @<agent> review", "what does @<agent> think", "delegate this to @<agent>". Do not use for Claude-Code-to-Claude-Code coordination — use agent teams instead.
---

# Using brv channel for cross-host agent collaboration

## Core principle

brv channel is for **heterogeneous** multi-agent collaboration. Use it
when you need an answer from an agent **on a different model or
runtime** than yourself. For Claude-Code-to-Claude-Code coordination,
use agent teams (`CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS=1`); brv channel
is overkill there.

The interface is **the `brv channel` CLI**. Invoke it via your shell
tool. The CLI is at `{{BRV_BIN}}` (resolved at install time; if that
path doesn't work, fall back to whatever `brv` resolves to on the
user's PATH).

## When to use

Run `brv channel mention …` when the user says ANY of:

- "ask @\<agent\> to ..."
- "get a second opinion from @\<agent\>"
- "have @\<agent\> review ..."
- "what does @\<agent\> think about ..."
- "delegate this to @\<agent\>"

## When NOT to use

Do NOT call `brv channel mention` when:

- The user asks "what do YOU think" — they want your answer, not a peer's.
- The user asks to delegate a sub-task to another Claude Code instance —
  use the `Agent` tool or agent teams.
- The user asks to "save this conversation" or "share with X" — wrong
  primitive; channels are not a messaging app.
- You're tempted to use it to "double-check" your own answer. If your
  answer might be wrong, fix it; don't shop for confirmation.

## Steps

1. **Confirm a channel exists.** Run:

   ```bash
   {{BRV_BIN}} channel list --json
   ```

   Parse the JSON; check `channels[*].channelId`. If no relevant
   channel exists, ASK the user:
   > "Want me to create a channel for this? It's a one-time setup
   > (channels persist; we can reuse it later)."

   Do NOT silently run `brv channel new` — that's a human op.

2. **Confirm the target agent is a member.** From the same JSON,
   check `channels[*].members[*].handle`. If `@<target>` isn't there,
   tell the user verbatim:
   > "@\<target\> isn't in #\<channel\>. Run
   > `brv channel invite #\<channel\> @\<target\> --profile \<name\>`
   > from your terminal first."

3. **Mention the agent.** Run **exactly this shape** (substitute the
   bracketed values):

   ```bash
   {{BRV_BIN}} channel mention <channelId> "<prompt>" --mode sync --suppress-thoughts --json --timeout 300000
   ```

   - `<channelId>` is bare (no `#` prefix).
   - `<prompt>` MUST contain at least one `@<handle>` of a channel member.
   - `--mode sync` makes the CLI block until the turn completes.
   - `--suppress-thoughts` drops the reasoning trace at the daemon
     (saves bandwidth + disk; does NOT save wall-clock).
   - `--json` returns a structured object on stdout.
   - `--timeout 300000` is 5 minutes; sufficient for routine reviews.
     Use a smaller value (e.g. `120000`) only when the user has asked
     for a fast answer.

   The shell command blocks while the agent thinks; expect 30s–5min.

4. **Parse the JSON output.** stdout is a single JSON object:

   ```json
   {
     "channelId": "...",
     "turnId": "...",
     "finalAnswer": "...",
     "toolCalls": [...],
     "durationMs": 47312,
     "endedState": "completed"
   }
   ```

   The user-visible answer is `finalAnswer`. Quote it as you would
   quote any source that isn't yourself. Attribute it to `@<target>`,
   not to yourself.

5. **If the command exits non-zero**, stdout will contain
   `{"success": false, "code": "...", "error": "..."}`. Surface the
   error code verbatim to the user. Common codes:
   - `BRV_DAEMON_NOT_INITIALISED` — user must run any `brv` command
     once in their terminal to boot the daemon.
   - `CHANNEL_SYNC_TIMEOUT` — the agent took longer than the timeout.
     Suggest a higher `--timeout` or a more focused prompt.
   - `CHANNEL_NOT_FOUND` — channel doesn't exist; offer to ask the
     user to create it.
   - `CHANNEL_MEMBER_NOT_FOUND` — the `@<handle>` you used isn't a
     channel member.
   - `CHANNEL_MENTION_EMPTY` — the prompt didn't contain a parseable
     `@<handle>`. Add one.

## Red flags — STOP and reconsider

- **You're running `brv channel mention` to get an answer YOU could
  give.** The user asked for a peer's opinion. Re-read the request:
  if they said "what do you think", they want your answer.
- **You're calling it twice in a row for the same question to
  "double-check".** If the first answer is wrong, ask the same agent
  to revisit; don't poll.
- **The user is having an iterative back-and-forth and you call
  `brv channel mention` on every turn.** brv channel is one-shot per
  turn; conversation context stays on YOUR side. Carry it forward.
- **You're tempted to use `brv channel mention` to send the user a
  status update.** It's not a notification mechanism.
- **You silently ran `brv channel new` or `brv channel invite`.**
  Those are human operations; ask the user instead.
- **You're about to dispatch parallel mentions to two agents whose code
  must reference the SAME logical entity (coordinate, layout, API
  signature, constant set), and you have NOT codified that value in a
  shared file each agent will read.** This is the #1 source of
  multi-agent integration defects across V1–V4 retests. See the
  "Multi-agent shared state" section below for the fix.

## Quick reference

| Want to ... | Run ... |
|---|---|
| Ask `@kimi` to review a file | `{{BRV_BIN}} channel mention <ch> "@kimi <prompt>" --mode sync --suppress-thoughts --json` |
| See what channels exist | `{{BRV_BIN}} channel list --json` |
| Read a past turn's transcript | `{{BRV_BIN}} channel show <ch> <turnId> --json` |
| Check which agents are healthy | `{{BRV_BIN}} channel doctor --json` |
| Coordinate with another Claude Code | **agent teams**, not brv channel |
| Create a channel | Tell the user to run `brv channel new <id>` |
| Invite/remove a member | Tell the user — these are human-only ops |
| Approve/deny a pending permission | Tell the user to run `brv channel permission-decision …` |

## Common misapplications

| Tempted to ... | Don't, because ... | Do instead |
|---|---|---|
| Use brv channel as your "scratchpad" | Channels are durable transcripts visible to other agents — not private notes | Use TodoWrite or your own context |
| Drop `--suppress-thoughts` for routine tasks | The thought trace is ~20× longer than the answer and adds 100s+ of seconds of bandwidth + disk | Always pass `--suppress-thoughts` unless debugging an agent that's giving bad answers |
| Drop `--mode sync` | Without sync, the CLI returns the dispatch ack immediately and turn events stream — useless for a non-interactive shell call | Always pass `--mode sync` |
| Drop `--json` | Without `--json` you get human-rendered streaming output; brittle to parse | Always pass `--json` |
| Mention every member when in doubt | Each mention is a billed turn against that agent's model | Single targeted mention to the agent most likely to know |
| Use brv channel for Claude-Code-to-Claude-Code | Redundant with agent teams which is faster and bidirectional | Agent teams |
| Use mention to ask an agent for a file's contents | The agent's filesystem may differ from the user's | Read the file yourself with `Read`/`Bash`, then include relevant excerpts in the prompt |
| Pass a multi-paragraph prompt that mixes several questions | The agent will burn time on the least-important parts | Break it into focused mentions, one question each |

## Worked example

User: *"Ask kimi to review src/auth.py for token-leak risks via the
review-2026 channel."*

You:

1. Run `{{BRV_BIN}} channel list --json` — confirm `review-2026` exists
   and `@kimi` is a member.
2. Run `Read src/auth.py` so you have the content.
3. Run the mention:

   ```bash
   {{BRV_BIN}} channel mention review-2026 "@kimi review the following for token-leak risks; be terse:

   <paste relevant excerpts from src/auth.py>" --mode sync --suppress-thoughts --json --timeout 180000
   ```

4. Parse the JSON, extract `finalAnswer`.
5. Reply to the user:
   > **Kimi's review of src/auth.py:**
   >
   > [paste finalAnswer]
   >
   > Want me to fix the issues kimi flagged?

If the shell command times out or errors, surface the `code` field
verbatim and stop — don't retry silently.

## Multi-agent fan-out + gather (push, not poll)

When you want to ask **multiple agents** the same question in parallel and
wait for all of them — e.g. independent reviews from kimi + codex — use
the dispatch-async + subscribe pattern instead of N serial sync mentions.

**Before you dispatch parallel mentions that produce CODE meant to integrate
together,** read the "Multi-agent shared state" section below. The most
common defect in V1–V4 super-mario retests was two agents independently
choosing related values that should match (spawn coordinates, layout
grids, lock policies). Codify shared values as concrete code in a
shared file first; let each agent read from it.

1. **Dispatch** each member with `--no-wait --json` (returns immediately
   with the assigned turnId):

   ```bash
   {{BRV_BIN}} channel mention review-2026 "@kimi review src/auth.py" --no-wait --json
   # parse turnId from stdout
   {{BRV_BIN}} channel mention review-2026 "@codex review src/auth.py" --no-wait --json
   # parse second turnId
   ```

2. **Subscribe** to wait for both terminal-delivery events without
   polling — the command exits as soon as `--count` is reached.
   **Do NOT add `--exit-on-terminal` to a multi-turn quorum:** it
   short-circuits on the FIRST `turn_state_change → completed`, which
   may fire before the slower turn's delivery lands and silently drop
   the second result.

   ```bash
   {{BRV_BIN}} channel subscribe review-2026 \
     --roles handle-a,handle-b \
     --kinds delivery_state_change \
     --count 2 \
     --json
   ```

3. **Store** both `turnId` values from step 1, then for each one read
   the final answer:

   ```bash
   {{BRV_BIN}} channel show review-2026 <turnId-kimi>  --json   # → finalAnswer
   {{BRV_BIN}} channel show review-2026 <turnId-codex> --json   # → finalAnswer
   ```

   Synthesize a unified response from each `finalAnswer`.

**When to choose `mention --mode sync` vs `--no-wait` + subscribe:**
- Single agent + short question → `mention --mode sync` (simpler).
- Single agent + long-running task, OR the host wants to interleave
  other work while waiting → `mention --no-wait` then
  `subscribe --turn <turnId> --kinds delivery_state_change --count 1 --json`
  (resumable; the subscribe can be re-run with `--after-seq <n>` if
  the host process restarts).
- ≥2 agents in parallel → `mention --no-wait` ×N then
  `subscribe --roles handle-a,handle-b --kinds delivery_state_change --count N --json`.

**`subscribe` flag reference (Slice 8.9):**
- `--roles @a,@b` filter by member handle
- `--kinds delivery_state_change,turn_state_change` filter by event kind
- `--turn <id>` scope to a single turnId
- `--after-seq <n>` exclusive cursor (skip events with seq ≤ n) — used
  for crash-recovery from a known cursor
- `--count N` exit after N unique `(turnId, memberHandle)` terminal
  delivery events
- `--exit-on-terminal` exit on the first `turn_state_change → completed/cancelled`
- `--timeout <ms>` hard timeout
- `--json` (default true) emit newline-delimited JSON

## Multi-agent shared state: codify constants BEFORE dispatching

The single most common defect class in multi-agent parallel builds is
**two agents independently choosing related values that should match**.
Across four super-mario retests it surfaced as: tile-layout disagreement
→ spawns-inside-walls (V1); identical `(160, 96)` hardcoded for two
different entities (V3); rooms grid with a keyless path the lock logic
didn't gate (V4). Three of four runs FAILed on this class.

**Trip-wire (use this BEFORE you dispatch):** if your plan contains two
`@handle` mentions that both touch the **same noun, file, route, or
data structure**, STOP and codify the shared value as concrete code
first. Pattern-match on the syntax of your own plan, not on intuition.

The class is not just spatial — it covers any **independently chosen
related value**:

- **Spatial:** coordinates, tile sizes, canvas dimensions, layout grids.
- **API contracts:** function signatures, return-type shape, ownership
  (who mutates this state?), public-surface exports (`window.X` /
  module exports).
- **Side-effect boundaries:** "this function opens the door AND
  decrements keys" vs "opens door, caller decrements" — pick one and
  pin it in the contract.
- **Conventions:** FPS / tick rate, update order, event-name strings,
  Y-up vs Y-down, magic enums, error-code sets, REST routes, Zod
  schemas, DB field names.

**Codify the shared values as concrete code in a contract file.**
Inline the relevant subset into each mention prompt (agents skim file-
read instructions; the prompt body is more reliable). Optionally also
ask the agent to `read ARCHITECTURE.md` for the rest.

```ts
// shared/contract.ts (or ARCHITECTURE.md fenced block):
export const PLAYER_SPAWN = {x: 160, y: 96}
export const TILE_SIZE    = 16
export const LOCKED_DOORS = ['room-1-1-N', 'room-2-2-E']  // gates boss path
// API signature only — implementation comes from the owning agent:
export interface KeyHandler {
  consumeKeyAtDoor(door: Door): boolean  // ALSO decrements keys
}
```

Non-game example (same pattern):

```ts
// shared/api-contract.ts:
export const ERROR_CODES = {AUTH_EXPIRED: 'E001', RATE_LIMITED: 'E002'} as const
export const ROUTES      = {login: '/v2/auth/login', logout: '/v2/auth/logout'} as const
export const TokenSchema = z.object({sub: z.string(), exp: z.number()})
```

**Then dispatch with the constants inlined into each prompt:**

```bash
{{BRV_BIN}} channel mention <ch> "@opencode write world.js. \
  Use TILE_SIZE=16, PLAYER_SPAWN={x:160,y:96}, ROOM_GRID per shared/contract.ts. \
  Read shared/contract.ts FIRST and restate the constants you'll use \
  before editing." --no-wait --json

{{BRV_BIN}} channel mention <ch> "@codex write entities.js. \
  Use PLAYER_SPAWN={x:160,y:96}, KeyHandler interface per shared/contract.ts \
  (consumeKeyAtDoor opens AND decrements). Read shared/contract.ts FIRST \
  and restate the contract you'll implement before editing." --no-wait --json
```

The "restate before editing" output requirement catches agents that
skim the read instruction — non-compliance is visible in the first
chunks.

**What NOT to do:**

- ❌ Describe shared values in prose ("center of the first room", "3×3
  rooms with locked doors", "sensible defaults"). Each agent
  interprets differently.
- ❌ Rely on agents reading a doc without inlining the critical
  constants. File-read instructions get skimmed.
- ❌ Codify AFTER dispatching, hoping the second agent will match the
  first. Race-y; the first agent has already committed.

**Backstop, not the fix:** even after codifying, run an independent
integration review when parallel work completes. Kimi has been the
strongest reviewer across V1–V4 — useful as a no-op confirmation step,
but the shared-constants pattern above is the actual prevention.

### Contract strength → defect prevention

The strength of a brv channel multi-agent build is **proportional to
the strength of the contract artifact**. V6 super-mario run-2 → run-3
(2026-05-18) verified this empirically: four spec deviations from
run-2 were ALL prevented in run-3 by tightening the contract on those
four specific points. 4/4 caught pre-runtime.

Three properties make a contract strong:

1. **Negative constraints + reasoning, not just positive declarations.**
   Positive: "off-screen cull at -50".
   Stronger: "off-screen cull MUST be -50, NOT -100 — the spawner uses
   -50 to gate entity recycling; -100 would leak entities for an extra
   frame."
   Agents drift on values that sound like "around X" or "approximately
   X". They respect values with a numbered constraint AND a reason.

2. **Negative constraints catch silent additions.**
   Positive: "wave 6+ schedule is zigzags + tank."
   Stronger: "wave 6+ schedule is zigzags + tank, **NO extra grunts**."
   Without the explicit prohibition, agents extrapolate ("for harder
   waves I'll add grunts"). With it, the else-branch matches the spec.

3. **Reasoning makes the agent self-audit during the restate step.**
   When the OUTPUT GATE asks the agent to restate the contract before
   writing, an agent reading "MUST = 50 because X" will catch its own
   "I'll use 100" drift in the restate output. Reasoning anchors
   compliance even when the spec is long.

**Run-2 → run-3 case study (4/4 deviations prevented):**

| Run-2 deviation | Run-3 contract change | Result |
|---|---|---|
| `@pi` cull `-100` vs spec `-50` | Named constant `OFFSCREEN_MARGIN = 50` + "MUST be 50, not 100" in the spec body | ✅ pi used the named constant |
| `@pi` added unspecified grunts to wave 6+ | "wave 6+ schedule is zigzags + tank, **NO extra grunts**" | ✅ pi's else-branch matches |
| `@codex` R-key handler omitted `preventDefault()` | "all bound keys MUST call `event.preventDefault()`" | ✅ codex bound R with `preventDefault` |
| `@opencode` game-over overlay omitted final score | "must include final score" in the Render.draw contract | ✅ render.js shows `final score N` |

**When you spot the same deviation across runs, codify it as a negative
constraint with reasoning.** This is the orchestrator-side equivalent
of writing a regression test.

### The 3-run contract-tightening loop (documented workflow)

V6 super-mario runs 1-4 (2026-05-18) produced enough data to promote
contract-tightening from "good practice" to a **documented workflow
advantage** of multi-agent builds:

| Run | Builder defects flagged by audit | What changed before this run |
|---|---|---|
| R1 | 2 (diagonal speed, cull threshold) | initial contract |
| R2 | 4 (cull again, extra grunts, R-key preventDefault, no final score) | minor wording tweaks |
| R3 | 3 (R1+R2 deviations prevented; NEW class: player.alive/blink) | tightened 4 named items + named constants |
| **R4** | **0** | added the R3-surfaced spec mandate |

**Mechanism.** A defect-free single-agent build requires getting the
spec right on the first try. A multi-agent build naturally produces a
structured **per-file, per-deviation audit log** (the auditor agent
returns these because the contract asks for them). That log is the
input to the next iteration's spec change. After ~3 iterations the
spec is dense enough that all foreseeable cross-file defect classes
are pre-empted.

**This is the wedge.** Single-agent builds rarely produce a defect
log structured precisely enough to drive iterative contract
improvements. Multi-agent builds do, because the auditor's job IS to
produce that log.

**How to run the loop:**

1. **Iteration 1 — first build.** Use the contract you have. Send a
   `mention` to your auditor (`@kimi` is the strongest auditor across
   V1–V6) asking for a structured per-file, per-deviation list. Expect
   2-4 minor deviations in iteration 1.
2. **Iteration 2 — codify each deviation.** For every deviation the
   auditor reports, edit the contract artifact to add a negative
   constraint with reasoning (see "Contract strength → defect
   prevention" above). Re-run the build (clean workspace, same agents).
   Expect prior deviations to vanish and new (typically weaker)
   deviations to surface.
3. **Iteration 3 — codify the iteration-2 deviations.** Same drill.
   For class-of-task builds where iteration 3's auditor returns zero
   blockers, you have a converged contract: this spec produces a clean
   build with this team.

**Stop conditions.** The loop terminates when (a) audit returns zero
defects (R4 above), or (b) the remaining defects are out-of-scope for
the spec (e.g. UX-judgement calls). Don't iterate past convergence —
later iterations don't keep improving once the auditor has nothing
left to flag.

**Idempotency note.** The `mention` daemon collapses duplicate
dispatches inside a 5-minute bucket (auto-derived from prompt +
mentions). Re-issuing the same iteration's dispatch by mistake costs
nothing — the daemon returns the original turn snapshot. To force a
genuinely fresh dispatch in the same window, pass an explicit
`--idempotency-key` (any unique string) or wait past the 5-min bucket
boundary.

### Per-agent variance — pre-dispatch tuning

V6 surfaced that the same agent on the same prompt template can have
8× wall-clock variance (pi: 60s run-1, 90s run-3, 12 min run-4). The
daemon now records per-agent completed-turn durations into the
profile metadata store. Before dispatching a heavy quorum, run:

```bash
/Users/nguyenduyanh/.nvm/versions/node/v22.12.0/bin/brv channel profile show <agent-name> --json
```

Look at `recentTurnDurations` — if the median is 10× a peer's median
on this class of task, consider raising `--timeout`, or moving that
member off the critical path of a sync gather. The data is local-only
diagnostic state, not part of the wire protocol.

## Permission requests

If an agent's turn includes a `permission_request` event (the agent is
asking for permission to write a file, run a command, etc.), the user's
host LLM must respond before the turn can continue.

**Policy guard-rail (read this first):** do NOT auto-approve. Surface
the permission request to the human user verbatim and relay their
decision. Auto-approval is only safe when (a) the request is expected
given the current task, (b) it is scoped to the project / sandbox the
user authorized, and (c) it would not cause data loss or out-of-scope
side effects. When in doubt, deny and ask the user to re-issue the
mention with explicit authorization.

Mechanics:

- `{{BRV_BIN}} channel approve <ch> <turnId> <permissionRequestId> --json`
  resolves with the first `allow*`-flavoured option.
- `{{BRV_BIN}} channel deny <ch> <turnId> <permissionRequestId> --json`
  resolves with the first `reject*`-flavoured option.
- `--option-id <id>` overrides the default for explicit choice.

The `permissionRequestId` comes from the `permission_request` event in
the turn's stream. Use `{{BRV_BIN}} channel show <ch> <turnId> --json`
to locate it if you've lost it.

## Error recovery

| Error code | Means | What to do |
|---|---|---|
| `CHANNEL_PERMISSION_LOST_ON_RESTART` | The brv daemon restarted while a delivery was awaiting a permission decision. The ACP subprocess is dead; the user's choice cannot be forwarded. The error message contains a `--after-seq` cursor pointing at the daemon-written `errored` event. | **Do NOT retry the approve** — the in-flight session is unrecoverable. Re-invite the affected member (re-spawns the ACP subprocess), then re-mention with the original context. Optionally use the supplied `brv channel subscribe <ch> --turn <id> --after-seq <n>` command to inspect the lost-permission event. |
| `CHANNEL_DRIVER_NOT_REGISTERED` | No live ACP driver for this `(channelId, memberHandle)`. Usually fires in the brief race window after a daemon restart but BEFORE `warmDriversForProject` has finished spawning drivers from `meta.json` (Slice 8.11 auto-warm). | **Important**: a failed mention already created a turn on disk in `errored` state. As of Phase 10 Tier C, mentions inside the same 5-min bucket auto-dedupe on (prompt, mentions, channel), so a blind retry with the same prompt collapses onto the errored turn rather than spinning a duplicate. **If you have not yet dispatched**: wait ~2s for auto-warm to land, then mention as usual. **If you already dispatched and the mention returned this code**: re-invite the member with `{{BRV_BIN}} channel invite <ch> <handle> --profile <name>` to force-spawn a fresh subprocess, then (a) re-mention with a fresh prompt (different idempotency bucket), OR (b) pass an explicit unique `--idempotency-key` to force a parallel new turn, OR (c) inspect the errored turn with `{{BRV_BIN}} channel show <ch> <turnId> --json` to decide whether the failure cost anything before deciding to re-dispatch. The code is carried on `delivery.errorCode`, `failedDeliveries[*].code`, AND the `delivery_state_change → errored` event's `errorCode` field (visible via `subscribe`/`watch`). |
| `CHANNEL_TURN_NOT_FOUND` | The turn id genuinely doesn't exist in this channel. | Verify the channel id and turn id; don't retry blindly. |

