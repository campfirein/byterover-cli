---
name: byterover-troubleshooting
description: "Use when a brv command fails with an auth, connection, token, or billing error, or when you need ByteRover data-handling and file-input limits."
---

# ByteRover Troubleshooting

Use this when a `brv` command errors, so you either guide the user or fix the call and retry. Do not silently swallow ByteRover errors.

## When To Use

- A `brv` command returns an authentication, connection, token, or billing error.
- A `brv curate` call is rejected for bad arguments or unsupported files.
- You need to explain ByteRover's data-handling or `-f` file-input limits.

## Errors The User Must Resolve

You cannot fix these yourself. Show the user the exact fix instead of looping.

| Error | Tell the user |
|---|---|
| `Not authenticated` | Run `brv login` (see `brv login --help` for options). |
| `Connection failed` / `Instance crashed` | Run `brv restart` to stop everything and start fresh, then retry. |
| `Token has expired` / `Token is invalid` | Run `brv logout` then `brv login` to reset credentials. |
| `Billing error` / `Rate limit exceeded` | Check account credits or wait before retrying. |
| `command not found` / unexpected CLI mismatch | Run `brv update` to install the latest CLI, then retry. |

## Errors You Should Fix And Retry

Handle these yourself, then re-run the command.

| Error | Fix |
|---|---|
| `Missing required argument(s).` | Run `brv <command> --help` and supply the argument. |
| `Maximum 5 files allowed` | Reduce to 5 or fewer `-f` files per `brv curate`. |
| `File does not exist` | Verify with `ls`; use paths relative to the project root. |
| `File type not supported` | Use only text, image, PDF, or office files. |

## Data Handling

- **Storage**: knowledge is human-readable Markdown in `.brv/context-tree/`, version-controllable via `brv vc`.
- **File access**: `-f` on `brv curate` reads only inside the current project; outside paths are rejected; max 5 files, text/document formats only.
- **LLM usage**: ByteRover does NOT invoke any LLM of its own on `brv query` or `brv curate`. The calling agent's own LLM is the only model that sees query text, curate intent, or file contents. Nothing is sent to ByteRover servers unless you run `brv vc push`.
- **Cloud sync**: `brv vc push` / `brv vc pull` require `brv login`; every other command works without authentication.

## Quick Diagnosis

```bash
brv status                                       # auth state + project info + context tree
brv connectors                                   # which agent connectors are installed
brv vc status                                    # context-tree VC state (clean / dirty / merge in progress)
```

Run `brv status` first to check authentication and project state. Use `brv connectors` when the user reports the skill or MCP isn't loading in their agent. Use `brv vc status` when the user reports stuck commits, pull failures, or unresolved merges.

## Recovery Commands

```bash
brv restart                                      # stop everything + start fresh (kills daemon)
brv logout                                       # clear stored credentials
brv login                                        # re-authenticate (after logout or token expiry)
brv update                                       # install the latest CLI
```

Use `brv restart` when the daemon is stuck, hung, or responding strangely. Use `brv logout` + `brv login` to fully reset auth state (preferred over `brv login` alone when tokens are corrupted, not just expired). Run `brv update` when CLI behavior contradicts documented commands — likely the local install is out of date.

## Common Mistakes

| Mistake | Correct behavior |
|---|---|
| Silently failing on an auth error | Show the user the exact fix from the table above |
| Retrying a user-resolvable error in a loop | Stop and tell the user what to do |
| Passing more than 5 `-f` files | Trim to 5 or fewer and retry |
| Assuming local data left the machine | Local commands send nothing to ByteRover servers |
