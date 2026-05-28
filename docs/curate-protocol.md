# `brv curate` tool-mode session protocol

The session protocol lets a calling agent (Claude Code, Cursor, etc.) drive `brv curate` without byterover holding any LLM provider config. ByteRover orchestrates the multi-step flow; the calling agent supplies LLM completions across multiple CLI invocations.

This document defines the wire contract: CLI surface, JSON envelope, lifecycle. SKILL.md authors and other tool consumers key off the shapes documented here.

## CLI surface

### Kickoff

```bash
brv curate "<user intent>" --format json
```

Tool mode is the only path for `brv curate` — no provider configuration, no env-var opt-in.

### Continuation — `--session` carries the prior call's id

```bash
brv curate --session <sessionId> --response "<calling agent's output>" --format json
```

Presence of `--session` resumes an in-flight session created by a prior kickoff.

### Overwrite intent — `--overwrite` on continuation

```bash
brv curate --session <sessionId> --response "<calling agent's output>" --overwrite --format json
```

Default behavior: the writer refuses to clobber an existing topic at the resolved path and returns a `path-exists` correction step carrying the prior file's content. Pass `--overwrite` only when the calling agent has consciously decided to replace prior content. The flag is consumed on the continuation it appears on; subsequent continuations in the same session must repeat it if they still want to overwrite.

### `--format text` fallback

Both kickoff and continuation accept `--format text` for shell users. The output is a terse human digest. The primary consumer (the calling agent) uses `--format json`.

## Wire envelope

Every kickoff and continuation call returns the same JSON envelope under the standard CLI wrapper:

```json
{
  "command": "curate",
  "success": <ok>,
  "data": {
    "ok": <bool>,
    "status": "done" | "needs-llm-step" | "failed",
    "sessionId": "<uuid>",       // present on needs-llm-step AND on transient failed (see below)
    "step": "generate-html" | "correct-html",
    "prompt": "<free-text>",      // free-text instruction for the calling agent's LLM
    "schema": { ... },            // optional per-step schema slice
    "errors": [                   // present on correct-html and on failed
      {
        "kind": "<machine-readable>",
        "tag": "<bv-element>?",
        "attribute": "<attribute-name>?",
        "message": "<human-readable>"
      }
    ],
    "filePath": "<relative-path>"  // relative to .brv/context-tree/; present when status = done
  },
  "timestamp": "<iso>"
}
```

### Status values

| `status` | Meaning | Next action for calling agent |
|---|---|---|
| `needs-llm-step` | Byterover wants an LLM completion. `prompt` + `step` describe what. | Run the calling agent's own LLM on `prompt`, then `brv curate --session <sessionId> --response "<output>"`. |
| `done` | Curate complete. `filePath` is the location of the written topic. | Report success to user. Session is cleaned up. |
| `failed` | Terminal error. `errors[]` explains why. | Report failure to user; abandon session. |

### `step` values (when `status === 'needs-llm-step'`)

| `step` | Meaning | Expected `--response` payload |
|---|---|---|
| `generate-html` | First call asking the calling agent to author a `<bv-topic>` document. | The generated HTML. |
| `correct-html` | A previous response failed validation. `errors[]` enumerates what to fix. | Corrected HTML. |

### Error `kind` values

| `kind` | Lifecycle | Terminal? | Notes |
|---|---|---|---|
| `missing-content` | Kickoff | **terminal** | Kickoff invoked without a context argument; no session created |
| `missing-response` | Continuation | **terminal** | `--session` invoked without `--response`; session unaffected |
| `invalid-flag-combination` | Continuation | **terminal** | Emitted before any session lookup when a flag is used outside its supported call shape. Today the only producer is `--overwrite` passed without `--session` (legacy curate path does not honour `--overwrite`). |
| `unknown-session` | Continuation | **terminal** | Session id doesn't exist, was already completed, or fails uuid validation |
| `empty-response` | Continuation | **transient** (session kept live) | Continuation received an empty `--response`; caller retries with the same `sessionId` |
| `retry-cap-exceeded` | Continuation | **terminal** | `MAX_ATTEMPTS = 4` (1 generate + 3 corrections) reached without valid HTML; session cleared. Accompanied by the validation errors that pushed the session over the cap. |
| `missing-bv-topic` | Continuation | **transient** (correction) | Response had zero `<bv-topic>` root elements |
| `multiple-bv-topic` | Continuation | **transient** (correction) | Response had more than one `<bv-topic>` root |
| `missing-path-attribute` | Continuation | **transient** (correction) | `<bv-topic>` is missing a non-empty `path` attribute |
| `unsafe-path` | Continuation | **transient** (correction) | `<bv-topic path>` contains `..` or `.` segments |
| `unknown-element` | Continuation | **transient** (correction) | Response contains a `<bv-*>` tag outside the closed registry; `tag` field carries the offending name |
| `attribute-validation` | Continuation | **transient** (correction) | An element's attributes failed its registered validator. `tag` carries the element, `attribute` the offending field. |
| `path-exists` | Continuation | **transient** (correction) | A topic already exists at the resolved path and `--overwrite` was not passed. The envelope error carries `existingContent` (the prior file's bytes); the correction prompt inlines the same content inside an `<existing-topic path="…">…</existing-topic>` block so the calling agent can merge new content into existing structure. The guard does not clear by re-emitting different content — `--overwrite` is required to write at this path. Default workflow: merge `existingContent` with the new content and re-emit with `--overwrite`. Alternative: choose a different `<bv-topic path>` (no `--overwrite` needed). |

**Terminal vs transient.** Terminal failures end the session — the caller cannot retry the same `sessionId` and must start a new kickoff. Transient failures keep the session alive on disk; the envelope echoes the `sessionId` back and the caller is expected to issue a corrected continuation against it.

**Retry cap.** Each transient correction increments an internal `attempts` counter on the session. After `MAX_ATTEMPTS = 4` consecutive invalid responses (the initial generate plus three corrections) the orchestrator terminates with `retry-cap-exceeded` and clears the session. Calling agents should surface this as "I couldn't produce valid HTML after several attempts; want to try a different framing?".

Calling agents should switch on `kind`, fall back gracefully on unknown kinds, and surface the `message` text to the user.

## Lifecycle — worked example

A complete tool-mode curate session, end-to-end:

### 1. Kickoff

```bash
brv curate "remember we decided to use RS256" --format json
```

Response (placeholder):

```json
{
  "command": "curate",
  "success": true,
  "data": {
    "ok": true,
    "status": "needs-llm-step",
    "sessionId": "8c3f9e2a-...",
    "step": "generate-html",
    "prompt": "Generate a <bv-topic>...</bv-topic> HTML document for the following user intent:\n\nremember we decided to use RS256\n\n..."
  },
  "timestamp": "2026-05-11T12:00:00.000Z"
}
```

### 2. Calling agent's LLM produces HTML

```html
<bv-topic path="security/auth" title="JWT signing algorithm">
  <bv-decision id="d-rs256">Use RS256 over HS256.</bv-decision>
</bv-topic>
```

### 3. Continuation

```bash
brv curate --session 8c3f9e2a-... --response "<bv-topic ...>...</bv-topic>" --format json
```

Response on a valid HTML topic:

```json
{
  "command": "curate",
  "success": true,
  "data": {
    "ok": true,
    "status": "done",
    "filePath": "security/auth.html"
  },
  "timestamp": "2026-05-11T12:00:01.000Z"
}
```

If validation fails (e.g. the agent forgot `path=` on `<bv-topic>`), the envelope instead carries `status: "needs-llm-step"`, `step: "correct-html"`, and `errors[]` for the calling agent to fix. Up to 3 corrections (MAX_ATTEMPTS = 4 total) before terminal `status: "failed"` with `kind: retry-cap-exceeded`.

## Session storage

CLI-side. Per-project, on disk at `<projectRoot>/.brv/sessions/curate-<sessionId>/state.json`. State carries `attempts`, `step` (`awaiting-generate` vs `awaiting-correct`), and the last response (for the correction prompt). State is removed when the session reaches terminal `done` or terminal `failed` (including `retry-cap-exceeded`).

Abandoned sessions are not yet pruned — a 1-hour TTL is a planned follow-up that pairs with moving state into the daemon's existing task-session lifecycle.

## Stability promise

SKILL.md ships against this envelope, so renaming any key here is a breaking change. New error kinds and new step values can be added without breaking existing consumers — calling agents are expected to gracefully ignore unknown values.

## What's not the protocol's job

- **HTML generation.** Calling agent's LLM authors the HTML per the `prompt`. Byterover never touches an LLM in tool mode.
- **Schema knowledge.** Embedded in the `prompt` (the prompt builder condenses the bv-* spec). Calling agent doesn't pre-load any schema.
- **Retry strategy beyond the protocol's correct-html loop.** If the calling agent's LLM keeps producing invalid HTML for 3 rounds, the session terminates `failed` — the calling agent surfaces this and falls back to asking the user for clarification.
