# brv channel — internal test guide

**Audience:** byterover team members trying out the channel-protocol cut on `proj/channel-protocol`.

**What you're testing:** end-to-end multi-agent collaboration via `brv channel`, including cross-machine bridge between two laptops.

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
brv --version            # 3.14.0
brv channel --help       # lists subcommands
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

**Pre-requisite: get on the same network.** The Phase-9 bridge ships without NAT-traversal wiring (libp2p AutoNAT/DCUtR/Circuit-Relay are deferred). For internal test:

> **Recommended: install [Tailscale](https://tailscale.com)** on every team member's laptop, join the same tailnet. Each peer gets a stable IP that punches through every NAT. Free tier covers ≤3 users; team plan is cheap and works for any size.
>
> Without Tailscale: same LAN works; bare-internet across two NATs WILL NOT WORK in v1.

### 3.1 Each peer: start the bridge listener

In one terminal that stays open for the session:

```bash
# Suggested: export the env vars in your shell rc so daemons inherit them.
# (Bridge config now persists to <dataDir>/state/bridge-config.json on
#  first use, so subsequent respawns inherit even without env. But
#  setting the env once is harmless and makes the first run cleaner.)
export BRV_BRIDGE_PARLEY_PROFILE=codex                          # or kimi/opencode — whichever agent answers parley calls
export BRV_BRIDGE_AUTO_PROVISION=auto                           # accept first-contact peers
export BRV_BRIDGE_MAX_CONCURRENT_PER_PROFILE=2                  # 2 concurrent in-flight prompts per profile

# CROSS-MACHINE bridge: bind the daemon-integrated libp2p host on a
# routable interface. Default is loopback-only — fine for local testing,
# but a peer on another machine (LAN, Tailscale, VPN) cannot reach it
# until you set this. Comma-separated multiaddrs.
#
# Tailscale-friendly: bind on 0.0.0.0 so any interface (incl. the
# `100.x.x.x` Tailscale virtual NIC) accepts inbound.
export BRV_BRIDGE_LISTEN_ADDRS=/ip4/0.0.0.0/tcp/60001
# Or pin to a specific Tailscale-IP'd multiaddr:
# export BRV_BRIDGE_LISTEN_ADDRS=/ip4/100.84.167.73/tcp/60001
# Or multiple interfaces:
# export BRV_BRIDGE_LISTEN_ADDRS=/ip4/0.0.0.0/tcp/60001,/ip6/::/tcp/60001
#
# This setting persists to <dataDir>/state/bridge-config.json on first
# use, so subsequent daemon respawns inherit it without re-exporting.

brv bridge listen      # keeps running; ctrl-C to stop
```

In another terminal, grab your identity:

```bash
brv bridge whoami --format json | python3 -c 'import json,sys; print(json.load(sys.stdin)["data"]["multiaddrs"][0])'
# /ip4/100.x.x.x/tcp/61234/p2p/12D3KooW...
```

Share that line with the peer you want to bridge with.

### 3.2 Each peer: pin the other side

Once you have the peer's multiaddr (from step 3.1):

```bash
brv trust pin <THEIR-PEER-ID> --multiaddr <THEIR-MULTIADDR> --alias <short-name>
# e.g.
brv trust pin 12D3KooWAbc... --multiaddr /ip4/100.x.x.x/tcp/61234/p2p/12D3KooWAbc... --alias bob
```

Verify with `brv trust list`.

### 3.3 One side: create the channel + invite the other

```bash
brv channel new team-review
brv channel invite team-review @<local-agent> --profile codex                              # local member
brv channel invite team-review @bob --multiaddr <BOB-MULTIADDR> --peer <BOB-PEER-ID>      # remote
```

### 3.4 Handshake

```bash
brv channel mention team-review "@bob handshake — reply OK" \
  --mode sync --suppress-thoughts --json --timeout 60000
```

Expect `"finalAnswer": "OK"` within ~5–10s. If you get `PARLEY_REJECTED [CHANNEL_AUTO_PROVISION_DECLINED]`, the receiving daemon has the wrong policy — see §5.1 below.

## 4. What works across the bridge

| Use case | Status | Notes |
|---|---|---|
| **Q&A across machines** — Alice asks Bob's agent a question, Bob's agent uses its OWN local context tree (via `brv search` / `brv query` from its bash tool) and replies with text | ✅ **works** | The flagship Phase-9 use case. See `byterover-cli/.agents/skills/byterover/SKILL.md` for the skill that drives Bob's agent. |
| **Context-tree exchange** — Alice mentions Bob asking for design notes; Bob replies inline; Alice locally runs `brv curate` to ingest the reply into her own tree | ✅ **works** | Verified live on 2026-05-20. ~20–150s per round-trip depending on agent latency. |
| **Multi-turn conversations** — sequential mentions on the same channel | ✅ **works** | ACP session reuses across turns per channel-membership. |
| **Cancellation mid-stream** — Ctrl-C the `brv channel mention` command | ✅ **works** | Sends signed cancel to remote; cleans up cleanly. |
| **Long-running turns** (codex / kimi waiting on slow LLM API) | ✅ **works** | Fixed 2026-05-20 in `75b6c58b5` — bridge emits `heartbeat_ping` every 10s during idle gaps so the libp2p substream stays alive. Previously timed out at ~120s. |

## 5. What does NOT work yet (don't waste your time)

| Limitation | Workaround |
|---|---|
| **Cross-bridge tool calls** — Bob's agent cannot call `Write`/`Bash`/etc. with Alice's permission flow. If you ask "@bob, write code into Bob's repo" it works (Bob runs his own tools locally). If you ask "@bob, write code into ALICE's repo from across the bridge" — not implemented. | Stick to Q&A / context-exchange. The `/brv/parley/delegate/v1` wire ships in a follow-up slice. |
| **NAT traversal** without VPN/Tailscale | Use Tailscale (see §3) |
| **Discovery by handle** — you can't just type `@alice@example.com` and have the daemon find them | Manual `brv trust pin` once per peer. Then aliases (`brv trust pin … --alias alice`) make subsequent use feel like `@alice`. |
| **DHT multiaddr refresh** — if a peer's IP rotates (laptop sleep/wake, change networks), the cached multiaddr in `~/.brv/identity/known-peers.jsonl` breaks | Re-pin: `brv trust pin <peer-id> --multiaddr <new-addr>` |
| **Web UI** for channels | CLI / agent-driven only in v1. |
| **Native `/channel:*` slash commands** in other CLIs (claude-code, opencode, etc.) | Install the byterover skill: `brv connectors install Codex --type skill` (or Claude Code, etc.). The skill teaches the host agent to call `brv channel mention` from its shell tool — no native slash command, but it composes naturally. |

### 5.1 Operational tips you'll need

**Daemon respawn config persistence (fixed in this cut):**
Bridge config now lives at `<dataDir>/state/bridge-config.json`. First time you run with `BRV_BRIDGE_PARLEY_PROFILE` in env, it persists. Subsequent respawns inherit. If a daemon ever falls back to `mock-echo` (visible in `brv channel doctor`), check the file — env vars override file values, so an explicit `BRV_BRIDGE_PARLEY_PROFILE=` (empty) in the env will FORCE mock-echo.

To **revert** the persisted config (e.g. you tested with `BRV_BRIDGE_PARLEY_PROFILE=codex` and now want to clear it for an experiment): `rm <dataDir>/state/bridge-config.json`. The daemon recreates the file the next time env vars supply values, or stays bare-defaults if env stays empty.

**Daemon restart re-randomises libp2p port.** If you (or auto-spawn) kill the daemon and a peer was holding your previous multiaddr, they'll see ECONNREFUSED until they re-invite. Fix: `brv channel uninvite <channel> @<stale-handle>` to drop the stale member (cancels in-flight deliveries + releases the pool driver cleanly), then `brv channel invite <channel> @<handle> --peer ... --multiaddr ...` with the fresh multiaddr from the other side's `brv bridge whoami`. No need to recreate the whole channel.

**`brv channel doctor` is your friend.** Run it on either side when things look weird. It surfaces parley dispatcher mode, auto-provision policy, pinned peers, and reachability classification.

**Sleep/wake.** The bridge heartbeat keeps the stream alive across idle gaps, but if your laptop fully suspends, the libp2p TCP connection itself dies. After waking, re-issue the `brv channel mention` — the daemon re-dials the peer's last-known multiaddr automatically.

## 6. Reporting bugs

Each report should include:

1. **Repro:** the exact `brv` commands you ran, in order.
2. **Symptom:** what you expected vs what happened, including any error codes (e.g. `CHANNEL_DELIVERY_FAILED`, `TRANSCRIPT_TERMINAL_MISSING`, `PARLEY_REJECTED [code]`).
3. **Daemon log:** the last ~200 lines of `<dataDir>/logs/server-<latest>.log` from BOTH sides if it's a cross-machine issue.
4. **Turn id** if it's a per-turn issue — `brv channel show <channel> <turnId> --json | gzip > turn.json.gz` attaches the full transcript.

Known pre-existing test failures (don't report these): see the `it.skip` annotations on `test/integration/channel-phase2-cancel-ordering.test.ts`, `test/integration/channel-phase2-multi-mention-rejection.test.ts`, and `test/integration/channel-phase3-origin-rejection.test.ts`.

## 7. What we want feedback on

- **Setup pain.** How long did §3 take? Where did you get stuck?
- **Manual pinning UX.** Tolerable? Or do we need DHT-based discovery sooner than planned?
- **What you actually used the bridge for.** Q&A? Context-tree exchange? Multi-agent code review? Something we didn't anticipate?
- **What you tried to use it for but couldn't.** Especially: did you hit the cross-bridge tool-call gap (§5) and how badly did it bite?

Drop comments in the team channel or file a GitHub issue tagged `internal-test`.
