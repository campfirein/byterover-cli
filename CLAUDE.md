# CLAUDE.md

ByteRover CLI (`brv`) - Interactive REPL with React/Ink TUI

## Commands

```bash
npm run build                        # Compile to dist/
npm run dev                          # Kill daemon + build + run dev mode
npm test                             # All tests
npx mocha --forbid-only "test/path/to/file.test.ts"  # Single test
npm run lint                         # ESLint
npm run typecheck                    # TypeScript (root + src/webui/tsconfig.json)
npm run build:ui                     # Build the web UI bundle (Vite); runs automatically as part of `build`
npm run dev:ui                       # Vite dev server for the web UI
npm run dev:kill                     # Kill the running daemon (re-run before `npm run dev`)
npm run lint:fix                     # ESLint with --fix
npm run build:ui:submodule           # Build web UI from the local submodule (vs default published package)
npm run dev:ui:package               # Vite dev server resolving shared UI from the installed package
./bin/dev.js [command]               # Dev mode (ts-node)
./bin/run.js [command]               # Prod mode
```

**Test dirs**: `test/commands/`, `test/unit/`, `test/integration/`, `test/hooks/`, `test/learning/`, `test/helpers/`, `test/shared/`
**Note**: Run tests from project root, not within test directories

## Development Standards

**TypeScript**:
- Avoid `as Type` assertions - use type guards or proper typing instead
- Avoid `any` type - use `unknown` with type narrowing or proper generics
- Functions with >3 parameters must use object parameters
- Prefer `type` for data-only shapes (DTOs, payloads, configs); prefer `interface` for behavioral contracts with method signatures (services, repositories, strategies)
- Default to `undefined` over `null`; reserve `null` only for external boundaries (storage, HTTP APIs) that force it — normalize to `undefined` before the value flows into internal modules
- Avoid `!` non-null assertions — narrow with type guards or throw explicitly. Lazy-initialized singletons (e.g. `this.services!.foo` after a guaranteed init step) are the only acceptable exception
- Use `??` for nullish defaults (not `||`, which also triggers on `0`/`''`/`false`) and `?.` for safe property access
- Prefer optional properties (`foo?: T`) over `foo: T | undefined` when a key may legitimately be absent

**Testing (Strict TDD — MANDATORY)**:
- You MUST follow Test-Driven Development. This is non-negotiable.
  - **Step 1 — Write failing tests FIRST**: Before writing ANY implementation code, write or update tests that describe the expected behavior. Do NOT write implementation and tests together or in reverse order.
  - **Step 2 — Run tests to confirm they fail**: Execute the relevant test file to verify the new tests fail for the right reason (missing implementation, not a syntax error).
  - **Step 3 — Write the minimal implementation**: Write only enough code to make the failing tests pass. Do not add untested behavior.
  - **Step 4 — Run tests to confirm they pass**: Execute tests again to verify all tests pass.
  - **Step 5 — Refactor if needed**: Clean up while keeping tests green.
  - If you catch yourself writing implementation code without a failing test, STOP and write the test first.
- 80% coverage minimum, critical paths must be covered.
- Suppress console logging in tests to keep output clean.
- Unit tests must run fast and run completely in memory. Proper stubbing and mocking must be implemented.

**Feature Development (Outside-In Approach — applies to ALL work: planning, reviewing, coding, and auditing)**:
- This is a foundational principle, not just a coding guideline. Apply it when writing code, reviewing plans, designing milestones, evaluating project structure, or auditing existing work. If a plan, project, or milestone ordering violates Outside-In, flag it.
- Start from the consumer (oclif command, REPL command, or TUI component) — understand what it needs
- Define the minimal interface — only what the consumer actually requires
- Implement the service — fulfill the interface contract
- Extract entities only if needed — when shared structure emerges across multiple consumers
- Avoid designing in isolation — always have a concrete consumer driving requirements
- When reviewing or planning: if entities, types, or store interfaces are designed before any consumer exists to validate them, that is Inside-Out and must be flagged

## Architecture

### Source Layout (`src/`)

- `agent/` — LLM agent: `core/` (interfaces/domain), `infra/` (modules including llm, memory, map, swarm, sandbox, session, tools, document-parser), `resources/` (prompts YAML, tool `.txt` descriptions)
- `server/` — Daemon infrastructure: `config/`, `core/` (domain/interfaces), `infra/` (modules including vc, git, hub, mcp, cogit, connectors, project, provider-oauth, session, space, dream, webui, billing, transport, executor, storage, context-tree), `templates/`, `utils/`
- `shared/` — Cross-module: constants, types, transport events, utils
- `tui/` — React/Ink TUI: app (router/pages), components, features (24 modules, including vc, worktree, source, hub, curate, settings), hooks, lib, providers, stores
- `webui/` — Browser dashboard (React/Vite). Entry `src/webui/index.tsx`; `features/` (16 panels), `pages/` (8 pages: home, changes, configuration, contexts, tasks, analytics, project-selector, not-found — configuration sub-routes live under `pages/configuration/`: layout, general, connectors, version-control), `layouts/`, `stores/`. Connects to the daemon via Socket.IO; no imports from `server/`, `agent/`, or `tui/` (same boundary rule)
- `oclif/` — Commands grouped by topic (`vc/`, `hub/`, `worktree/`, `source/`, `space/`, `review/`, `connectors/`, `curate/`, `model/`, `providers/`, `swarm/`, `query-log/`, `settings/`) + top-level `.ts` commands (`webui`, `dream`, `review`, `search`, `locations`, `query`, `login`, `logout`, `init`, `mcp`, `pull`, `push`, `restart`, `status`, `debug`) + hidden internals (`main` — default `brv` REPL entry; `hook-prompt-submit` — emits `brv-instructions` template for coding-agent pre-prompt hooks, e.g. Claude Code `UserPromptSubmit`); hooks, lib (daemon-client, task-client, json-response)

**Import boundary** (ESLint-enforced): `tui/` must not import from `server/`, `agent/`, or `oclif/`. Use transport events or `shared/`.

### REPL + TUI

- `brv` (no args) starts REPL (`src/tui/repl-startup.tsx`)
- Esc cancels streaming responses and long-running commands
- Slash commands in `src/tui/features/commands/definitions/` (order in `index.ts` = suggestion order)

### Daemon

- Global daemon (`server/infra/daemon/`) hosts Socket.IO transport; clients connect via `@campfirein/brv-transport-client`
- Agent pool manages forked child processes per project; task routing in `server/infra/process/`
- MCP server in `server/infra/mcp/` exposes tools via Model Context Protocol; `tools/` subdir has dedicated implementations (`brv-query-tool`, `brv-curate-tool`)
- Connector subsystem (`server/infra/connectors/`): `rules/`, `skill/`, `mcp/`, `hook/`, `shared/`. Shared rules files (e.g. `AGENTS.md` shared by Amp/Codex/OpenCode) embed an agent-name footer inside `<!-- BEGIN/END BYTEROVER RULES -->` markers — see `shared/constants.ts` (`BRV_RULE_MARKERS`, `BRV_RULE_TAG`, `extractInstalledAgentFromBrvSection`) — so each agent owns its own segment. Preserve the footer when editing rule-section logic

### Task Cancellation

- `brv curate | query | dream --cancel <taskId>` — emits `TaskEvents.CANCEL`; shared CLI helper `src/oclif/lib/cancel-task.ts` formats text or JSON envelope. SIGINT in the foreground command triggers the same cancel path (`task-client-sigint`)
- Daemon: `server/infra/daemon/agent-cancel-listener.ts` routes the cancel into the running agent process; `agent-executor-error.ts` distinguishes user-cancel from real failures so cancelled tasks aren't recorded as errors in billing/history
- TUI: Esc cancels streaming (covered in REPL section); Tasks tab supports cancel keybind via `tui/features/tasks/hooks/use-cancel-running-task-keybind.ts` + `select-cancel-target.ts`, mounted through `cancel-keybind-initializer.tsx` in app providers
- WebUI: cancel button in `webui/features/tasks/components/task-list-table.tsx` + `task-detail-header.tsx`, wired via `webui/features/tasks/api/cancel-task.ts` and `utils/row-action-kind.ts`

### Web UI (`src/webui/`, `src/server/infra/webui/`)

- `brv webui [-p, --port <n>]` opens the dashboard in the default browser. Port is persisted via daemon events (`webui:getPort` / `webui:setPort`); first-run default is 7700
- Server side: `server/infra/webui/` — `webui-server.ts` (standalone HTTP server), `webui-middleware.ts` (Express static files + `/api/ui/config`), `webui-state.ts` (port persistence). CSP headers applied
- Browser bootstraps by fetching `/api/ui/config` to discover the daemon's dynamic Socket.IO port, then connects cross-origin
- Daemon `ClientType` includes `'webui'` alongside `'tui' | 'cli' | 'agent' | 'mcp' | 'extension'`
- Build/dev: `npm run build:ui` (Vite, runs as part of `npm run build`); `npm run dev:ui` for live reload. `typecheck` runs both the root and `src/webui/tsconfig.json`
- Shared UI components live in a git submodule at `packages/byterover-packages/` (published as `@campfirein/byterover-packages`). `dev:ui` / `build:ui:submodule` read from the submodule; `build:ui` / `dev:ui:package` read from the installed `node_modules` copy. Override Vite's resolution with `BRV_UI_SOURCE=submodule|package`. Fresh clones have an empty submodule dir — run `git submodule update --init --recursive` before using submodule mode or Vite resolution will fail

### VC, Worktrees & Knowledge Sources

- `brv vc` — isomorphic-git version control (add, branch, checkout, clone, commit, config, diff, fetch, init, log, merge, pull, push, `remote add|remove|set-url`, reset, status); git plumbing in `server/infra/git/` (`isomorphic-git-service.ts`), VC config store in `server/infra/vc/`
- `brv worktree` (add/list/remove) — git-style worktree pointer model: `.brv/` is either a real project directory OR a pointer file to a parent project; parent stores registry in `.brv/worktrees/<name>/link.json`
- `brv source` (add/list/remove) — link another project's context tree as a read-only knowledge source with write isolation
- `brv search <query>` — pure BM25 retrieval over the context tree (minisearch, no LLM, no token cost); structured results with paths/scores. Pairs with `brv query` (LLM-synthesized answer). Engine: `server/infra/executor/search-executor.ts`
- `brv locations` — lists all registered projects with context-tree status (text or `--format json`); reads from `LocationsEvents` over the daemon transport
- `brv query-log view [id]` / `brv query-log summary` — inspect query history and recall metrics (coverage, cache hit rate, top topics); store: `server/infra/storage/file-query-log-store.ts`, summary use-case in `server/infra/usecase/`
- `brv dream [--force] [--undo] [--detach]` — background context-tree consolidation; operations in `server/infra/dream/operations/` (synthesize, consolidate, prune); lock/state via `dream-lock-service.ts` + `dream-state-service.ts`
- Runtime signals sidecar — file-level usage/maturity data lives in `RuntimeSignalStore` (`server/infra/context-tree/runtime-signal-store.ts`, `IKeyStorage` keys `["signals", ...pathSegments]`), NOT in synthesized markdown frontmatter. Read: search-knowledge + manifest service; write: curate-service + dream-executor synthesize. Schema: `server/core/domain/knowledge/runtime-signals-schema.ts`
- `parentTaskId` threading — `generateSummary` / `propagateStaleness` on `file-context-tree-summary-service.ts` take an optional `parentTaskId`. Curate, dream, and folder-pack executors (`server/infra/executor/`) MUST thread the operation's `taskId` through so child summary regenerations roll up under one parent task instead of N detached billing rows
- Canonical project resolver: `resolveProject()` in `server/infra/project/` — priority `flag > direct > linked > walked-up > null`. `projectRoot` and `worktreeRoot` are threaded through transport schemas, task routing, and all executors
- All commands are daemon-routed: `oclif/` and `tui/` never import from `server/`
- Oclif: `src/oclif/commands/{vc,worktree,source}/`; TUI: `src/tui/features/{vc,worktree,source}/`; slash commands (`vc-*`, `worktree`, `source`) in `src/tui/features/commands/definitions/`
- `brv curate` runs Phases 1–3 in the foreground and detaches Phase 4 (post-curate finalization: summary regeneration, manifest rebuild) to the daemon's `PostWorkRegistry`, which serializes per project and coordinates with `dream-lock-service.ts` to prevent concurrent `_index.md` writes. `--detach` makes the entire run background. Overlapping curate runs for the same project are still rejected. Behavioral contract lives in `src/server/templates/sections/` (`brv-instructions.md`, `workflow.md`, `skill/SKILL.md`) — the in-daemon agent reads these at runtime
- `brv review [--disable | --enable]` — toggle the project-scoped HITL review log; `brv review pending` lists items, `brv review approve <id>` / `brv review reject <id>` resolve them. When disabled, sync curate skips the "X operations require review" prompt, detached curate stops emitting per-operation review markers, and `brv dream` no longer surfaces `needsReview` operations. The flag is snapshotted at task creation and propagated via `AsyncLocalStorage` (`resolveReviewDisabled`) so mid-task toggles do not race
- HITL WebUI: pending operations render in the Changes tab (`webui/features/vc/`); the on/off toggle (`hitl-settings-panel.tsx`) is mounted on the Configuration → Version Control sub-page (`webui/pages/configuration/version-control.tsx`). Reject restores the pre-operation file snapshot from `file-review-backup-store.ts` (`server/infra/storage/`); transport via `review-handler.ts` + `shared/transport/events/review-events.ts`
- `brv login` defaults to OAuth (interactive provider picker); pass `--api-key` only for CI. `brv logout` clears credentials

### LLM Billing

- Paid LLM operations (`brv query`, `brv curate`, status checks) call `ensureBillingFunds()` (`src/oclif/lib/insufficient-credits.ts`) before dispatching, throwing `InsufficientCreditsError` if no paid team has credits
- Server: `server/infra/billing/` — `http-billing-service.ts` (HTTP client against `BRV_BILLING_BASE_URL`), `resolve-billing-source.ts` (priority: project-pinned team > org default), `resolve-billing-team.ts`, `build-status-billing.ts` (status payload), `paid-organizations-endpoint.ts`, `billing-state-endpoint.ts`. Pinned-team selection persisted via `server/infra/storage/file-billing-config-store.ts`
- Transport: `BillingEvents` / `TeamEvents` in `shared/transport/events/` (resolve, get/list usage, get/set pinned team, get free-user limit, list teams). Handlers: `billing-handler.ts`, `team-handler.ts`, `status-handler.ts`
- CLI status line: `brv status` / `brv providers list` render credits via `oclif/lib/billing-line.ts` + `format-billing-line.ts`
- `brv providers connect` (byterover provider) runs a team-select step that emits `BillingEvents.SET_PINNED_TEAM`
- WebUI: credits pill (`webui/features/provider/components/credits-pill.tsx`), team-select step in `provider-flow-dialog.tsx`, billing API wrappers in `webui/features/provider/api/` (`list-billing-usage`, `list-teams`, `get-pinned-team`, `set-pinned-team`, `get-free-user-limit`)

### Settings

- `brv settings` (bare = list) / `brv settings get <key>` / `set <key> <value>` / `reset <key>` — user-configurable settings persisted at `<BRV_DATA_DIR>/settings.json`. Most settings need `brv restart` to take effect; boolean settings like `update.checkForUpdates` apply live (`restartRequired: false` on the descriptor)
- Categories: `concurrency`, `llm`, `task-history`, `updates`. Keys: `agentPool.maxSize`, `agentPool.maxConcurrentTasksPerProject`, `llm.iterationBudgetMs`, `llm.requestTimeoutMs`, `taskHistory.maxEntries`, `update.checkForUpdates`. Descriptors in `server/core/domain/entities/settings.ts` are discriminated on `type: 'integer' | 'boolean'` and reference `src/constants.ts` so a constant change updates the setting's default automatically. `update.checkForUpdates` gates the `update-notifier` init hook and the `block-autoupdate-when-off` init hook (which rejects `brv update` when the user has opted out). Agent process consumes settings via `agent/infra/settings/agent-settings-snapshot.ts` forwarded by `server/infra/daemon/agent-process.ts`
- Server: `server/infra/storage/file-settings-store.ts` + `settings-validator.ts`; `server/infra/daemon/settings-bootstrap.ts` reads settings at boot and feeds AgentPool (maxSize, maxConcurrentTasks) + task-history cache. Transport: `shared/transport/events/settings-events.ts` + `server/infra/transport/handlers/settings-handler.ts`
- UI: TUI `tui/features/settings/`, WebUI `webui/features/settings/` (rendered under `pages/configuration/` sub-routes). Task heartbeat (`server/infra/process/task-heartbeat-manager.ts`) and task-history cache (`server/infra/process/task-history-store-cache.ts`) are tuned via these keys; oclif task-client uses heartbeats — explicit task timeouts are deprecated

### Other oclif topic groups

- `brv hub install | list | registry (add|list|remove)` — Context Hub (npm-style package manager for context); registry config is per-project
- `brv space list | switch` — Context Hub spaces (team/space scoping)
- `brv connectors install | list` — agent-side connector plugins (e.g., OpenClaude registered as a connector)
- `brv model list | switch` — pick the LLM model for the active provider
- `brv providers connect | disconnect | list | switch` — provider OAuth / API-key management
- `brv curate view` — read-only inspect of a curate operation; the main curate entry is the REPL slash command

### Agent (`src/agent/`)

- Tools: definitions in `resources/tools/*.txt`, implementations in `infra/tools/implementations/`, registry in `infra/tools/tool-registry.ts`
- Tool categories: file ops (read/write/edit/glob/grep/list-dir), bash (exec/output), knowledge (create/expand/search), memory (read/write/edit/delete/list), swarm (query/store), todos (read/write), curate, code exec, batch, detect domains, kill process, search history
- LLM: 20 providers in `infra/llm/providers/` (incl. deepseek, glm, glm-coding-plan, xai); compression strategies in `infra/llm/context/compression/`
- System prompts: contributor pattern (XML sections) in `infra/system-prompt/`
- Map/memory: `infra/map/` (agentic map, context-tree store, LLM map memory, worker pool); `infra/memory/` (memory-manager, deduplicator)
- Storage: file-based blob (`infra/blob/`) and key storage (`infra/storage/`) — no SQLite

### Swarm (`src/agent/infra/swarm/`, `src/oclif/commands/swarm/`)

- Multi-provider memory/knowledge federation: routes queries and writes across pluggable adapters (byterover, gbrain, local-markdown, memory-wiki, obsidian)
- `brv swarm query` — RRF-fused search across providers; flags: `--explain`, `--format`, `-n`
- `brv swarm curate` — auto-routes content to best provider; flags: `--provider`, `--format`
- `brv swarm onboard` — interactive wizard (`@inquirer/prompts`) to scaffold swarm config; uses snake_case YAML keys (`eslint-disable camelcase`)
- `brv swarm status` — pre-flight health check for configured providers
- Agent tools: `swarm_query.txt`, `swarm_store.txt` in `resources/tools/`
- Config: `swarm/config/` (loader + schema), `swarm/validation/` (config validator)
- CLI-only (oclif) — no TUI feature dir; swarm queries flow through existing `tui/features/query/`

## Testing Gotchas

- **HTTP (nock)**: Must verify `.matchHeader('authorization', ...)` + `.matchHeader('x-byterover-session-id', ...)`
- **ES Modules**: Cannot stub ES exports with sinon; test utils with real filesystem (`tmpdir()`)

## Conventions

- ES modules with `.js` import extensions required
- `I` prefix for interfaces; `toJson()`/`fromJson()` (capital J) for serialization
- Snake_case APIs: `/* eslint-disable camelcase */`

## Environment

- `BRV_ENV` — `development` | `production` (dev-only commands require `development`, set by `bin/dev.js` and `bin/run.js`)
- Required service base URLs (loaded from `.env.development` / `.env.production`, see `.env.example`): `BRV_IAM_BASE_URL`, `BRV_COGIT_BASE_URL`, `BRV_LLM_BASE_URL`, `BRV_BILLING_BASE_URL`, `BRV_WEB_APP_URL`, `BRV_GIT_REMOTE_BASE_URL`. Loaded in `server/config/environment.ts`; IAM/COGIT/BILLING are additionally validated by `assertRootDomain` (no paths allowed). All are normalized to strip trailing slashes
- `BRV_WEBUI_PORT` — override the web UI port (default `7700`)
- `BRV_UI_SOURCE` — `submodule` | `package` — forces Vite's shared-UI resolution mode
- `BRV_DATA_DIR` — override the global data dir (default `~/.brv`)
- `BRV_GIT_REMOTE_BASE_URL` — override git remote base URL (beta vs prod testing)
- `BRV_QUEUE_TRACE` — set to `1` to log queue/agent map traces (cipher-agent, abstract-queue)
- `BRV_SESSION_LOG` — file path for daemon/agent session logs (auto-set by `brv-server`; can override for debugging)
- `BRV_E2E_MODE` — `true` switches the daemon to e2e-friendly stdio handling
- `BRV_AGENT_PROCESS_PATH` / `BRV_AGENT_PORT` / `BRV_AGENT_PROJECT_PATH` — auto-set by the daemon when forking agent child processes; do not set manually

## Stack

oclif v4, TypeScript (ES2022, Node16 modules, strict), React/Ink (TUI), Zustand, axios, socket.io, isomorphic-git, Mocha + Chai + Sinon + Nock
