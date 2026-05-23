# brv channel — internal test guide

**Audience:** byterover team members trying out the channel-protocol cut on `proj/channel-protocol`.

**What you're testing:** end-to-end multi-agent collaboration via `brv channel`, including cross-machine bridge between two laptops. As of Phase 9.5 (HEAD `1e23de6c7`) you can run **Claude Code itself** as the parley dispatcher on the receiving side — a real Claude session per inbound turn, with `--resume`-backed session continuity. No more mock-echo.

**File bugs:** GitHub issues against `campfirein/byterover-cli`, tag `internal-test`. Attach `~/Library/Application Support/brv/logs/server-<ts>.log` (macOS) or `~/.local/share/brv/logs/...` (Linux) when reporting cross-machine issues.

---

## 1. Install

```bash
git clone git@github.com:campfirein/byterover-cli.git
cd byterover-cli
git checkout proj/channel-protocol
npm install
npm run build
npm install -g .   # or: alias brv="$PWD/bin/run.js"
```

Verify:

```bash
brv --version            # 3.15.0
brv channel --help       # lists subcommands
brv bridge --help        # listen / pin / verify / ping / whoami / connect
```

## 2. Single-machine smoke test (5 min)

This proves the local channel surface works before you touch the bridge. Skip if you've already used `brv channel` locally.

```bash
# In any project directory
brv channel onboard codex -- codex-acp          # one-time per agent
brv channel new smoke
brv channel invite smoke @codex --profile codex
brv channel mention smoke "@codex what is 2+2? reply in one short sentence." --mode sync --suppress-thoughts --json --timeout 60000
```

Expect a JSON envelope with `"endedState": "completed"` and `"finalAnswer": "<codex's reply>"`. If it hangs, kill with Ctrl-C and check `brv channel show smoke <turnId>` — likely a missing codex-acp install (`npm i -g @zed-industries/codex-acp`).

## 3. Cross-machine bridge — two-laptop setup

**Pre-requisite: get on the same network.** The Phase 9 bridge ships without NAT-traversal wiring (libp2p AutoNAT/DCUtR/Circuit-Relay are deferred). For internal test:

> **Recommended: install [Tailscale](https://tailscale.com)** on every team member's laptop, join the same tailnet. Each peer gets a stable IP that punches through every NAT. Free tier covers ≤3 users; team plan is cheap and works for any size.
>
> Without Tailscale: same LAN works; bare-internet across two NATs WILL NOT WORK in v1.

### 3.1 Each peer: start the bridge listener

Set these env vars in your shell rc so the daemon inherits them across respawns. The defaults below are right for cross-machine work; you can tighten `BRV_BRIDGE_AUTO_PROVISION` later.

```bash
# In ~/.zshrc (macOS) or ~/.bashrc (Linux):
export BRV_BRIDGE_AUTO_PROVISION=auto                           # accept first-contact peers
export BRV_BRIDGE_MAX_CONCURRENT_PER_PROFILE=2                  # 2 concurrent in-flight prompts per profile
export BRV_BRIDGE_LISTEN_ADDRS=/ip4/0.0.0.0/tcp/60001           # bind on all interfaces (Tailscale picks one up)

# Optional — only set on the side that will be the responder for inbound parley.
# Choose ONE of:
#   - export BRV_BRIDGE_PARLEY_PROFILE=codex          # use codex-acp (`npm i -g @zed-industries/codex-acp`)
#   - export BRV_BRIDGE_PARLEY_PROFILE=claude-code    # use Claude Code headless (see §3.5)
# If unset, the bridge falls back to mock-echo (echoes the prompt verbatim — fine for protocol tests, useless for real work).
```

Pull the latest dist and kick the daemon to pick up the env:

```bash
pkill -f brv-server || true
sleep 2
brv bridge whoami --format text
```

The bridge starts at daemon boot (Phase 9.5.1 — no more lazy-init drops). Your output should include lines annotated with their network interface:

```text
/ip4/127.0.0.1/tcp/60001/p2p/12D3KooW...   (loopback, lo0)
/ip4/192.168.1.x/tcp/60001/p2p/12D3KooW... (lan, en0)
/ip4/100.x.x.x/tcp/60001/p2p/12D3KooW...   (tailscale, utun8)  ← recommended for cross-machine
```

**Use the line marked `(tailscale, ...) ← recommended`** — that's the one your peer can reach over the tailnet without NAT punching.

### 3.2 One command on each side: `brv bridge connect`

The flagship of Phase 9.5.6. Bundles **pin → verify → channel new → channel invite** into a single idempotent command. Re-running on an already-connected peer is a no-op + `[OK already pinned]` for each step.

From the **laptop**, given the VM's Tailscale multiaddr (you got it from `brv bridge whoami` on the VM):

```bash
brv bridge connect /ip4/100.68.28.21/tcp/60001/p2p/12D3KooWKLAM... \
  --alias gcp-cc \
  --verify \
  --channel laptop-vm-cc
```

From the **VM**, given the laptop's Tailscale multiaddr:

```bash
brv bridge connect /ip4/100.120.188.62/tcp/60001/p2p/12D3KooWRyJD... \
  --alias laptop \
  --verify \
  --channel laptop-vm-cc
```

Expected output (per side):

```text
[OK pin] pinned (new)         ← or "already pinned"
[OK verify] promoted to user-confirmed
[OK channel] created          ← or "already exists"
[OK invite] added as @<alias>

✓ Connected to peer 12D3KooW... (@<alias>)
   Channel: #laptop-vm-cc
   Ready to mention: brv channel mention laptop-vm-cc "@<alias> ..."
```

**Both sides must run `--verify`.** Phase 9.5.4 tightened the trust gate: channel auto-create requires `user-confirmed` or `ca-bound` pin state. A bare `bridge pin` (without `--verify`) leaves the peer at `auto-tofu`, and inbound parley from that peer will be declined with `CHANNEL_AUTO_PROVISION_DECLINED: sender pinState=auto-tofu requires user-confirmed`. The error message includes the exact recovery command.

**Partial-failure recovery.** If e.g. step 3 (channel create) fails after pin + verify already succeeded, the output emits a `retryHint` that omits already-done flags:

```text
[OK pin]
[OK verify]
[FAIL channel create] CHANNEL_REQUEST_FAILED: ...

To retry just the remaining steps, run:
  brv bridge connect /ip4/.../tcp/60001/p2p/12D3... --channel laptop-vm-cc --alias gcp-cc
```

(Notice `--verify` is dropped — verify already succeeded, no need to re-prompt for fingerprint confirmation.)

### 3.3 Handshake

```bash
brv channel mention laptop-vm-cc "@gcp-cc handshake — reply OK" \
  --mode sync --suppress-thoughts --json --timeout 60000
```

With `BRV_BRIDGE_PARLEY_PROFILE` unset on the VM, expect mock-echo to echo the prompt as `finalAnswer`. With `BRV_BRIDGE_PARLEY_PROFILE=claude-code` (§3.5), expect a real Claude reply.

## 3.5 Run Claude Code as the parley dispatcher (Phase 9.5.3)

This is the flagship use case for Phase 9.5. The receiving side's daemon spawns a fresh `claude -p ...` headless process per inbound turn, parses its `stream-json` output, and ships the response back across the bridge. Session continuity within a channel-member pair is preserved via `--resume <sessionId>`.

**On the side that will be the responder** (e.g. the VM):

```bash
# Prerequisite: Claude Code on PATH.
which claude
claude --version    # any 2.x

# Set these in ~/.bashrc and source it (env must propagate to the daemon at startup).
export BRV_BRIDGE_CLAUDE_UNSAFE=1                # required opt-in — see security note below
export BRV_BRIDGE_PARLEY_PROFILE=claude-code
source ~/.bashrc

# Restart the daemon so it inherits the env.
pkill -f brv-server || true
sleep 2
brv bridge whoami --format json >/dev/null

# Confirm the adapter loaded.
LATEST=$(ls -t ~/.local/share/brv/logs/server-*.log | head -1)
grep "Parley adapter" "$LATEST" | tail -3
```

Expect two log lines:

```text
[Daemon] Parley adapter registered: claude-code (kind=sdk-headless, UNSAFE — no permission gate)
[Daemon] Parley adapter: claude-code (kind=sdk-headless) (pool cap=1 per profile)
```

If `claude` is missing on PATH, the daemon FAILS-FAST at startup with `claude binary not on PATH` — the adapter's `warm()` runs synchronously before the daemon accepts traffic.

**⚠️ Security: `BRV_BRIDGE_CLAUDE_UNSAFE=1` is required**

The adapter spawns `claude -p --output-format stream-json --verbose --dangerously-skip-permissions`. Until cross-bridge permission passthrough lands, a verified peer's prompt can drive Bob's local Claude Code with Bob's filesystem and process permissions. The env gate is the explicit "yes, I know what this means" opt-in. Run this **only** on a dedicated VM/sandbox you are willing to hand to a verified peer. Default-off prevents demos from accidentally shipping the security hole.

**Try a real coding task across the bridge:**

```bash
brv channel mention laptop-vm-cc "@gcp-cc Create /home/<user>/workspace/dummy_algo/quicksort.py with an idiomatic functional quicksort that sorts [3,6,8,10,1,2,1] in its __main__ block, run it, and reply with the file path, line count, algorithm variant, and exact stdout." \
  --mode sync --suppress-thoughts --json --timeout 300000
```

Live test on 2026-05-23 (turnId `vDx1kNW2efV46KuRhfbR8`, 11s including warm session-resume):

```text
file=/home/andy_byterover_dev/workspace/dummy_algo/quicksort.py
lines=14
variant=functional
stdout:
[3, 6, 8, 10, 1, 2, 1]
[1, 1, 2, 3, 6, 8, 10]
```

**Session-resume verified.** A two-turn test on the same channel-member pair correctly recalled state from turn 1 (a `date +%N`-derived secret) in turn 2 without the secret being re-prompted from the laptop side. The session-id sidecar lives at `<dataDir>/state/parley-adapter-sessions.json` (0600 perms, atomic writes, keyed on `${projectRoot}\0${channelId}\0${senderPeerId}\0${adapterProfile}`).

**Skill note for the responder side:** install the byterover skill on the responder Claude Code so it understands the `brv channel` surface from inside its bash tool:

```bash
brv connectors install "Claude Code" --type skill
ls .claude/skills/byterover/SKILL.md   # confirm
```

When Claude Code is running headless as the dispatcher, the assistant's stream-json `assistant` message body IS the channel post — **do not** call `brv channel mention` from inside the subprocess to "also post" the reply (Claude sometimes wants to do this). The streamed response is the response.

## 4. What works across the bridge

| Use case | Status | Notes |
|---|---|---|
| **Q&A across machines** — Alice asks the responder agent a question; the agent uses local tools and replies with text | ✅ **works** | Phase-9.4 flagship. ~10–45s per round-trip depending on agent model / cold-start. |
| **Multi-agent cross-runtime collaboration** — codex/kimi/opencode/gemini on the responder, claude on the requester (or vice-versa) | ✅ **works** | Each adapter is registered alongside the others; pick via `BRV_BRIDGE_PARLEY_PROFILE`. |
| **Claude Code as parley dispatcher** (Phase 9.5.3) | ✅ **works** | Behind `BRV_BRIDGE_CLAUDE_UNSAFE=1` opt-in. Session-resume preserved within `(channel, member)`. |
| **One-command setup** (Phase 9.5.6) | ✅ **works** | `brv bridge connect <multiaddr> --alias X --verify --channel Y` collapses the 4-step ceremony. Idempotent re-run. |
| **Channel-mirror auto-create** (Phase 9.5.4) | ✅ **works** | When a `user-confirmed` peer dispatches with a new channelId, the receiver's mirror auto-creates the channel + member (subject to `BRV_BRIDGE_AUTO_CREATE_QUOTA` — default 5/peer/hour). |
| **Context-tree exchange** — Alice asks the agent for design notes; locally runs `brv curate` to ingest the reply into her own tree | ✅ **works** | |
| **Multi-turn conversations** — sequential mentions on the same channel | ✅ **works** | Session continuity preserved per-adapter (codex via ACP session reuse, Claude Code via `--resume`). |
| **Cancellation mid-stream** — Ctrl-C the `brv channel mention` command | ✅ **works** | Cancels in-flight subprocess via `SIGTERM`. Phase 9.5.3 plumbs the abort signal early — heartbeat-send failure also aborts so a dead-stream subprocess doesn't linger. |
| **Long-running turns** (codex / kimi waiting on slow LLM API) | ✅ **works** | Fixed 2026-05-20 in `75b6c58b5` — bridge emits `heartbeat_ping` every 10s during idle gaps so the libp2p substream stays alive. |
| **Coding tasks across the bridge** — ask responder agent to write + run code locally | ✅ **works** | Live-tested 2026-05-23 with the quicksort task above. Real filesystem writes, real subprocess execution on the responder, results streamed back. |

## 5. What does NOT work yet (don't waste your time)

| Limitation | Workaround |
|---|---|
| **Cross-bridge permission flow** — when Bob's Claude Code runs `Bash` / `Write` against Bob's filesystem, Alice cannot approve/deny. Bob's adapter runs with `--dangerously-skip-permissions`. | Don't host the Claude Code adapter on a machine you don't fully trust the peer with. Pin the receiver to a dedicated VM/sandbox. Permission passthrough is the next major slice. |
| **Cross-bridge tool calls into the REQUESTER's repo** — if you ask "@bob, write code into ALICE's repo from across the bridge," that's not implemented. | Stick to "do work on YOUR side and report" patterns. The `/brv/parley/delegate/v1` wire ships in a follow-up slice. |
| **NAT traversal** without VPN/Tailscale | Use Tailscale (see §3) |
| **Discovery by handle** — you can't just type `@alice@example.com` and have the daemon find them | Manual `brv bridge connect` once per peer. Then aliases make subsequent use feel like `@alice`. |
| **Multiaddr refresh after peer reboot on new port** — auto-created channel mirrors store `addressability: 'bootstrap-only'`. If the peer rebinds, the orchestrator surfaces `BRIDGE_MULTIADDR_STALE` with a copy-paste `brv bridge connect <fresh-multiaddr>` hint in the error message. | Re-run `brv bridge connect` with the new multiaddr. The pin record is keyed on peer-id, not multiaddr, so the re-dial silently picks up the new addr — status will be `[OK pin] already pinned`. |
| **Web UI** for channels | CLI / agent-driven only in v1. |
| **Native `/channel:*` slash commands** in other CLIs (claude-code, opencode, etc.) | Install the byterover skill: `brv connectors install "Claude Code" --type skill` (or Codex, etc.). The skill teaches the host agent to call `brv channel mention` from its shell tool — no native slash command, but it composes naturally. |

### 5.1 Operational tips you'll need

**Daemon startup is idempotent (Phase 9.5.1).** The bridge listener re-binds to persisted `BRV_BRIDGE_LISTEN_ADDRS` unconditionally at daemon boot — no more silent-drop-after-respawn (we saw this twice during 2026-05-22 testing). `brv channel doctor` shows the current bind state if you suspect drift.

**Bridge config persistence:** `<dataDir>/state/bridge-config.json` captures env-supplied values on first daemon run. Subsequent respawns inherit even if env vars are missing. If you ever want to revert, delete the file — the daemon recreates it on next env-driven boot.

**Session sidecars** (Claude Code adapter only): `<dataDir>/state/parley-adapter-sessions.json` (0600 perms). If you uninvite a remote-peer member, the daemon auto-resets the auto-create quota for that peer; the session-id entry persists until the channel is deleted. Safe to delete the file manually — Claude Code will start a fresh session on the next inbound.

**`brv channel doctor` is your friend.** Run it on either side when things look weird. It surfaces parley dispatcher mode, auto-provision policy, pinned peers, channel membership, and adapter health.

**Sleep/wake.** The bridge heartbeat keeps the libp2p substream alive across idle gaps. If your laptop fully suspends, the underlying TCP connection itself dies; after waking, re-issue the `brv channel mention` — the daemon re-dials the peer's last-known multiaddr automatically.

**Subscribe diagnostics:** `brv channel subscribe <channel> --all-kinds --json` disables kind filtering and emits every event. Useful when you suspect a filter-mismatch bug. See `docs/channel-events.md` for the canonical kinds table.

## 6. Reporting bugs

Each report should include:

1. **Repro:** the exact `brv` commands you ran, in order.
2. **Symptom:** what you expected vs what happened, including any error codes (e.g. `CHANNEL_DELIVERY_FAILED`, `PARLEY_REJECTED [<code>]`, `BRIDGE_MULTIADDR_STALE`, `ADAPTER_SUBPROCESS_FAILED`).
3. **Daemon log:** the last ~200 lines of `<dataDir>/logs/server-<latest>.log` from BOTH sides if it's a cross-machine issue. macOS: `~/Library/Application Support/brv/logs/`. Linux: `~/.local/share/brv/logs/`.
4. **Turn id** if it's a per-turn issue — `brv channel show <channel> <turnId> --json | gzip > turn.json.gz` attaches the full transcript.
5. **Adapter env** (for Phase 9.5.3 issues): `env | grep BRV_BRIDGE_` from both sides.

Known pre-existing test failures (don't report these): see the `it.skip` annotations on `test/integration/channel-phase2-cancel-ordering.test.ts`, `test/integration/channel-phase2-multi-mention-rejection.test.ts`, and `test/integration/channel-phase3-origin-rejection.test.ts`.

## 7. What we want feedback on

- **Setup pain.** How long did §3.1–§3.2 take? Did `brv bridge connect` actually save you commands or did you fall back to the old `bridge pin` + `bridge verify` + `channel new` + `channel invite` ceremony?
- **Claude Code adapter UX (§3.5).** Did the env-var dance feel right, or do you want `brv connectors install "Claude Code"` to set those for you?
- **Trust gate (§3.2 verify step).** Was the symmetric `--verify` requirement obvious from the doc, or did you only discover it when the first cross-bridge mention failed with `CHANNEL_AUTO_PROVISION_DECLINED`? The error message tries to tell you what to do — does that work in practice?
- **What you actually used the bridge for.** Q&A? Coding tasks (like the §3.5 quicksort)? Context-tree exchange? Multi-agent code review? Something we didn't anticipate?
- **What you tried to use it for but couldn't.** Especially: did you hit the cross-bridge permission gap (§5) and how badly did it bite?

Drop comments in the team channel or file a GitHub issue tagged `internal-test`.
