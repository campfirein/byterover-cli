# @brv/channel-skill

Agent-Skills `SKILL.md` teaching host agents (Claude Code, Codex, kimi-cli, opencode, Pi) **when** and **how** to invoke brv channel.

The skill directs the host's LLM to run `brv channel mention --mode sync --suppress-thoughts --json …` via its existing shell tool (Bash / `ctx.exec` / etc.). No MCP server, no per-host MCP config — just the skill file + an absolute `brv` binary path baked in at install time. Works in every host with a shell-exec tool.

> **Historical note:** earlier Phase-8 drafts paired this skill with an `@brv/channel-mcp` MCP server. The MCP path hit per-host config divergence and tool-call timeout problems in the manual E2E and was removed during the 2026-05-13 pivot. The skill body now uses verbatim `brv channel …` bash invocations.

## Install

```bash
node packages/channel-skill/bin/install.js
```

The default install writes the same `SKILL.md` to **three** paths, which between them cover all five Phase-8 hosts:

| Path | Hosts that read it |
|---|---|
| `~/.claude/skills/brv-channel/SKILL.md` | Claude Code (native); kimi-cli + opencode via cross-brand fallback |
| `~/.codex/skills/brv-channel/SKILL.md` | Codex CLI (no fallback — needs its own path) |
| `~/.agents/skills/brv-channel/SKILL.md` | Pi (cross-brand fallback); kimi-cli additional fallback |

Restart each host after install so the skill is picked up at startup.

### `{{BRV_BIN}}` substitution

The source `SKILL.md` template contains `{{BRV_BIN}}` placeholders. The install CLI resolves a usable brv path and bakes it into every installed copy so the host LLM sees a verbatim command path that works on this machine.

Resolution priority:

1. `--brv-bin <path>` flag
2. `BRV_BIN` env var
3. First `brv` executable on `PATH`
4. Fallback: literal `brv` (works only if `brv` is on the host's PATH at run time)

To override (e.g. when running from a development workspace):

```bash
node packages/channel-skill/bin/install.js install \
  --brv-bin "node /abs/path/to/byterover-cli/bin/dev.js" \
  --force
```

The install CLI prints the resolved path it baked in so you can sanity-check.

## Flags

```bash
brv-channel-skill install [options]

  --target <host>   claude | codex | kimi | opencode | pi | all   (default 'all')
  --path <abs>      override target with an explicit absolute path
  --brv-bin <path>  override the brv binary path baked into the skill
  --force           overwrite an existing SKILL.md that differs
  --dry-run         print planned writes without touching disk
  --help            show help
```

`--target kimi` and `--target opencode` map onto `~/.claude/skills/` since those hosts read it via cross-brand fallback. Pass `--path` for hosts whose discovery dir doesn't fit the canonical three (e.g. a project-local `.claude/skills/<repo>`).

Idempotent: re-running with identical content (same resolved brv path included) prints `= unchanged <path>`. Differing content errors out unless `--force` is supplied — this protects manual edits, and means that changing `--brv-bin` between installs requires `--force`.

## How the skill drives the host

When the user types a natural-language request like *"ask kimi to review src/auth.py"*, the host's LLM:

1. Reads the skill description on startup; recognises the trigger.
2. Runs `<BRV_BIN> channel list --json` via its shell tool to confirm the channel + member.
3. Runs `<BRV_BIN> channel mention <channelId> "<prompt>" --mode sync --suppress-thoughts --json --timeout 300000`.
4. Parses the JSON output's `finalAnswer` field.
5. Weaves the answer into its reply, attributing it to the target agent.

No MCP. No daemon-management dance. The host's shell tool is the only host integration needed.

## What the skill says (summary)

- **Use brv channel for heterogeneous multi-agent collab** (kimi reviewing what Claude Code wrote, etc.). For Claude-Code-to-Claude-Code use **agent teams** instead.
- **Always pass `--mode sync --suppress-thoughts --json`** — those flags make the CLI return a single structured response and skip the (slow, noisy) reasoning trace.
- **Don't silently create channels or invite members** — those are human ops; ask the user.
- **Don't call mention to get an answer you could give** — the user asked for a peer's opinion.

Full body: [SKILL.md](./SKILL.md). ~180 lines after expansion, structured: principle → when-to-use → steps → red flags → quick-ref → common misapplications → worked example.

## Status

Slice 8.2 of the channel-protocol implementation (post-2026-05-13 pivot — skill-only). See `plan/channel-protocol/IMPLEMENTATION_PHASE_8.md` §8.2 for the full plan.
