# @brv/pi-channel-extension

A [Pi](https://github.com/earendil-works/pi) extension that exposes `/channel ...` slash commands so you can drive a [brv channel](../../plan/channel-protocol/CHANNEL_PROTOCOL.md) from inside the Pi REPL.

## Install

```bash
npm install -g @brv/pi-channel-extension
pi-channel-extension install
```

The `install` step copies `dist/extension.js` to `~/.pi/agent/extensions/brv-channel.js`. Override the target with `PI_EXTENSIONS_DIR`. Restart `pi` to load the extension.

## Usage

Pi REPL:

```text
> /channel new pi-review
✓ Channel #pi-review created
> /channel invite pi-review @echo --profile echo
✓ @echo joined #pi-review
> /channel mention pi-review "@echo hi"
turn 01HX… started — streaming…
[@echo] you said: @echo hi
turn 01HX… completed
```

Subcommands:

| Command | Wire event |
|---|---|
| `/channel new <id>` | `channel:create` |
| `/channel list` | `channel:list` |
| `/channel invite <ch> @<handle> --profile <name>` | `channel:invite` |
| `/channel mention <ch> "<text>"` | `channel:mention` + streams the turn |
| `/channel approve <ch> <turnId> <permissionId>` | `channel:permission-decision` (allow) |
| `/channel deny <ch> <turnId> <permissionId>` | `channel:permission-decision` (reject) |
| `/channel show <ch> <turnId>` | `channel:get-turn` |
| `/channel doctor [--profile <name>]` | `channel:doctor` |

## Prereqs

A running `brv` daemon. Run any `brv` command once (e.g. `brv channel list`) to boot it. The extension reads `~/.brv/daemon.json` + `~/.brv/state/daemon-auth-token` for its connection details.

## Status

Slice 7.1a of the channel-protocol implementation. First user-facing Phase-7 deliverable. See `plan/channel-protocol/IMPLEMENTATION_PHASE_7.md`.
