# Changelog

All notable user-facing changes to ByteRover CLI will be documented in this file.

## [3.16.1]

### Fixed
- **Stay signed in across restarts.** A valid login could be misread at startup, dropping you into the provider picker and asking you to run `brv login` again on every launch. The CLI now reads your auth state correctly, so a signed-in session stays signed in.

## [3.16.0]

### Added
- **Cancel a running task with `--cancel <id>`.** `brv curate`, `brv query`, and `brv dream` now accept `--cancel <taskId>` to stop a task started from another terminal or from a detached background run. In the foreground, Ctrl+C sends the cancel before exiting (a second press hard-exits with code 130). In the REPL, Ctrl+Q cancels the active curate or query task, and a footer hint shows when it's armed. `brv webui` also adds a Cancel button on task list rows and the task detail header.
- **Opt out of update checks with `update.checkForUpdates`.** New setting (boolean, default `true`). Running `brv settings set update.checkForUpdates false` silences the y/n update prompt at startup and stops the background auto-update from running. Manual `brv update` still works when you want to upgrade on your own schedule.

### Fixed
- **Custom models accepted on more OpenAI-compatible providers.** Connecting DeepSeek, GLM, Moonshot, Cerebras, Cohere, DeepInfra, Together AI, MiniMax, Perplexity, or another OpenAI-compatible endpoint with a non-default `--model` no longer fails with a "Model X is not supported for provider 'gemini'" error. The registry now routes all OpenAI-compatible providers through the right model whitelist, so any model your endpoint exposes is accepted.
- **Security dependency update.** Patched npm dependencies to clear several `npm audit` advisories.

## [3.15.1]

### Fixed
- **Review settings panel restored in `brv webui`.** The on/off toggle for review-before-changes (Configuration → Version Control) went missing in 3.15.0. It is back in the same spot, alongside Identity and Remotes.
- **`brv update` tidies up old versions.** Each upgrade used to leave previous CLI versions sitting in the plugin cache, slowly eating disk space. The cache now keeps only the version you just installed.

## [3.15.0]

### Added
- **Tune BRV with `brv settings`.** Adjust knobs like agent pool size, concurrent tasks per project, LLM iteration budget, and task-history retention without editing source or rebuilding. `brv settings` lists every option by category (concurrency, LLM, task history); `brv settings get/set/reset <key>` operates on a single value. Use plain numbers for count keys (e.g. `agentPool.maxSize 25`) and duration strings for time keys (e.g. `llm.iterationBudgetMs 30m` or `1h 30m` or raw ms). Every subcommand also accepts `--format json`. Values persist at `<BRV_DATA_DIR>/settings.json` and can be browsed from the Configuration page in `brv webui`. Run `brv restart` after a change.
- **Folder metadata in `brv webui` Contexts.** Folders in the context tree now render their title, summary, tags, and related links in the detail panel, the same way files already did.

### Changed
- **Configuration page in `brv webui` reorganized.** Settings now live under three sections (General, Connectors, Version Control) instead of one long page, so the new agent-pool and task-history controls have room alongside the existing identity, provider, and remote settings.
- **`--timeout` flag is deprecated.** Passing `--timeout` on commands that accepted it now logs a one-line deprecation notice and has no effect. Use `brv settings set llm.iterationBudgetMs <duration>` (e.g. `30m`, `1h`, or raw ms) to change the LLM iteration budget instead, then run `brv restart`.

## [3.14.0]

### Added
- **Review pending changes from `brv webui`.** The human-in-the-loop review queue now lives inside the Changes tab, with a Configuration toggle to turn review on or off per project. Approve, reject, or inspect pending curate operations next to your other diffs. The `brv review` CLI commands still work, and dashboard links deep-link straight to the right project's Changes tab.

### Fixed
- **`brv vc checkout` works on a freshly initialized project.** Right after `brv vc init` and `brv vc fetch`, checking out a remote-only branch used to fail with a misleading "no commits yet" error. The fetched ref now resolves correctly, so the init, fetch, checkout sequence works as expected. A typoed branch name also reports "branch not found" instead of "no commits yet."
- **MCP server no longer pegs the CPU after the daemon disconnects.** When the daemon dropped, the MCP server used by Claude Desktop, Cursor, and other MCP-aware clients could spin into a high-CPU loop and hang on shutdown. It now installs one-shot crash guards, exits cleanly within 2 seconds, and lets pending tool calls return a real error before the connection closes.

## [3.13.0]

### Added
- **ByteRover credits in the header and billing team picker.** The REPL and web header now show your remaining ByteRover credits, and when you connect a provider you can pick which billing team to charge per project. Your choice is remembered until you change it. Configurable via `BRV_BILLING_BASE_URL`.
- **Clear "out of credits" message with a top-up link.** When a request fails because your ByteRover credits run out, the CLI now shows a direct top-up URL instead of a generic failure.

### Changed
- **Duplicate models filtered from OpenAI-compatible providers.** Some upstream endpoints (e.g. NVIDIA NIM) return the same model under multiple aliases. `brv providers connect` now dedupes by model ID so the picker shows clean rows.
- **Simpler OpenClaw installer.** `scripts/openclaw-setup.sh` now auto-installs the `brv` CLI if it is missing, installs the skill via `npx clawhub@latest`, and points to "connect a provider" as the post-install next step. Daily Knowledge Mining cron and the onboarding plugin scaffold were removed.

### Fixed
- **Shared rules connectors no longer collide.** When several agents share a single `AGENTS.md` or `CLAUDE.md` (e.g. Amp, Codex, OpenCode, or Claude Code + OpenClaude), `brv connectors list` reads the footer marker inside the BRV section so only the installed agent's rules connector is shown.
- **OpenClaw installer no longer crashes under strict shell mode.** Fixed an unbound-variable error in `scripts/openclaw-setup.sh` and cleaned up orphan onboarding-plugin code paths.

## [3.12.0]

### Added
- **Tasks history in `brv webui`.** Past curate, query, and review tasks now persist per project across daemon restarts (up to 1000 entries), with filters (status, date, duration), pagination, per-task event log, bulk delete, and provider/model attribution.

### Changed
- **Synthesized files get full semantic frontmatter.** `brv dream synthesize` now writes title, summary, tags, related, keywords, createdAt, updatedAt alongside its synthesis fields, so dashboard context cards no longer render empty.
- **Consistent flow-style YAML in dream writes.** `brv dream`'s synthesize and consolidate steps now emit `tags: [a, b, c]` arrays like `brv curate`, so `brv vc` diffs stop reflowing brackets each consolidate pass.

### Fixed
- **`brv push` no longer ships dangling `related:` links.** `*.abstract.md` and `*.overview.md` entries (excluded from sync) are now stripped from `related:` on write; `brv curate` updates also clean pre-existing stale entries.
- **Security dependency update.** Refreshed `package-lock.json` to clear several `npm audit` advisories.

## [3.11.0]

### Added
- **DeepSeek and GLM Coding Plan as LLM providers.** Pick DeepSeek (`deepseek-chat`, `deepseek-reasoner`) or Z.AI's GLM Coding Plan subscription tier in `brv providers connect` or the web provider picker. The existing `glm` provider stays for pay-per-token users so subscription and pay-as-you-go tiers don't collide.
- **Recall metadata in `brv query --format json`.** The JSON envelope now includes `matchedDocs`, `tier`, `durationMs`, and `topScore`, so scripts and IDE bridges can show evidence of what the answer was drawn from.

### Fixed
- **Reasoning shows up for DeepSeek-R1 and Reasoner.** Thinking output now streams correctly and is carried back into follow-up turns. Previously the second turn of any multi-step query failed with a "reasoning_content must be passed back" error from DeepSeek.
- **Claude Opus 4.7 no longer fails with a 400 error.** Opus 4.7 rejects `temperature`, `top_p`, and `top_k`; the CLI now drops those before sending to Anthropic and OpenRouter (and warns once). Opus 4.6 and other Claude models are unchanged.
- **GLM Coding Plan API-key validation works on the coding-plan tier.** Validation now tries each known model in turn instead of giving up after the first model-not-found, so a valid key is no longer reported as invalid. The "Get your API key" link also points straight to the key page in both the TUI and the web UI.
- **OpenClaude icon shows in `brv webui`.** The LocalWebUI agent grid used to render OpenClaude as a missing icon; it now uses a monochrome SVG that matches the other connectors.
- **Security dependency update.** Refreshed `package-lock.json` to clear several `npm audit` advisories.

## [3.10.3]

### Fixed
- **No more silent daemon-version mismatches.** After upgrading `brv`, the background daemon could keep running on the older version and you'd have no way to tell, leading to confusing "why doesn't this new feature work?" moments. The REPL header now shows `[outdated, daemon vX.Y.Z]` next to the version when this happens, and replies from the MCP tools (`brv-query`, `brv-curate`) include a short note when the daemon and CLI are mismatched. Run `brv restart` to align, or restart your IDE for the MCP side.

## [3.10.2]

### Changed
- **`brv curate` is faster and cheaper.** Curate now batches its smaller LLM calls together and reuses the unchanging parts of the prompt across calls. Anthropic users save 21-30% on token cost, OpenAI users around 8%, and big-folder curates finish noticeably sooner.
- **Clearer sign-in error for ByteRover.** When you try to use ByteRover without being signed in, the error now lists every option: `brv login` for interactive shells, plus a signup URL, an API-key URL, and `brv login --api-key` for headless or CI environments.

### Fixed
- **ByteRover provider activates on connect.** Picking ByteRover used to leave it "connected but inactive", so `brv curate` would still say "no provider connected". Activation now happens right away.
- **No more spurious "signed out" on slow networks.** The startup auth check timed out after 500 ms, well below a real round-trip on home Wi-Fi, mobile, or VPN. Timeout is now 4 seconds with a single retry, so transient blips no longer look like a logout.

## [3.10.1]

### Added
- **`brv review --disable` / `--enable` per project.** Opt a project out of the human-in-the-loop review prompts and backups, or turn them back on. Run `brv review` with no flags to see the current state. Existing `brv review pending / approve / reject` are unchanged.

### Changed
- **`brv curate` returns to your prompt right away.** The final summary-rebuild step now runs in the background instead of making you wait. Nothing is skipped, just moved off your wait time (about 18 seconds saved on a typical run).

### Fixed
- **Clearer `brv vc status` and `brv vc pull` errors.** Status now catches a few staged-then-edited file states it used to hide. When a pull, checkout, or merge would overwrite local changes, the error now lists the affected files instead of just saying "local changes would be overwritten."
- **OpenAI-compatible providers fail loudly when the URL is wrong.** First-time setup for Ollama, LM Studio, and similar providers now checks the base URL up front and shows the error inline. Bad URLs no longer pre-select a placeholder `llama3` model or hang the REPL on disconnect / reconnect.

## [3.10.0]

### Added
- **Connect OpenClaude as an agent.** Run `brv connectors install "OpenClaude"` or pick it in `/connectors`.

### Changed
- **Prettier `brv login` confirmation page.** The browser tab after sign-in now matches the brv dark theme, with a styled error page if sign-in fails.
- **Faster, more reliable first-run startup.** The first `brv` command after install or restart connects more consistently, and no longer hangs when the sign-in provider is slow.

### Fixed
- **`brv restart` works inside nested shell wrappers.** Used to leave the daemon stuck when `brv` was launched through several wrapper scripts (a shell alias, an npm script, or a CI runner). Fixed on macOS, Linux, and Windows.
- **`brv curate` counts as one operation, not many.** Curating many folders at once was being billed once per folder, which could push fresh free-tier accounts past their limit in a single run. Grouped correctly now.
- **Security update.** Patched `postcss` and several other dependencies to address a high-severity advisory.

## [3.9.0]

### Added
- **`brv vc diff` shows what changed in your context tree.** See staged and unstaged changes against HEAD, or compare branches and commits. Also available as `/vc-diff` in the REPL and with `--format json`.
- **`brv vc remote remove` deletes a git remote.** Available from the CLI and from a new Delete button (with confirmation) in the web UI Remotes panel.
- **Configuration page in `brv webui`.** Manage your context-tree git identity (user.name, user.email) and the `origin` remote from the browser. One click seeds your identity from your signed-in ByteRover account; a status dot is amber when identity is unset and green once it is. Provider and remote error toasts deep-link back to the relevant section.

### Changed
- **First-run tour teaches by clicking through.** Instead of auto-opening the composer, the tour highlights the Tasks tab and "New task" button with a glowing arrow and dims the rest of the page. Failed tasks during the tour now offer a "Try again" action that prefills the composer.
- **ByteRover pinned at the top of the provider picker.** In `brv webui`, ByteRover sits first with a "Native" badge and opens the sign-in popup directly, with no extra confirmation step.

### Fixed
- **Google default model updated to `gemini-3-flash-preview`** (was `gemini-3.1-flash-lite-preview`).
- **`brv dream` no longer pollutes `brv vc` diffs.** Synthesis used to reorder context-file frontmatter fields (`title`, `summary`, `tags`, `keywords`, `related`, `createdAt`, `updatedAt`); field order is now preserved.

## [3.8.3]

### Changed
- **`brv login` opens your browser by default** — Just run `brv login` and sign in in your browser. On CI or a remote shell, use `--api-key <key>` instead (get one at https://app.byterover.dev/settings/keys). SSH and non-interactive shells are detected automatically and skip the browser step.
- **Provider picker shows what each provider is** — `brv providers list` and the web provider picker now show a short description under each name, so you can pick by what a provider does instead of guessing from the brand.

### Fixed
- **No more "Logged in as undefined"** — `brv login` now says "Logged in successfully" when the server doesn't return your email.
- **`brv webui` works when installed under a hidden folder** — Reloading a page like `/contexts` no longer 404s when `brv` lives under a dotfile path such as `~/.nvm/...` or `~/.asdf/...`.

## [3.8.2]

### Fixed
- **Web UI styles missing in the published-package build** — `brv webui` from the installed CLI used to render shared components (dialogs, sheets) unstyled because the Tailwind `@source` glob didn't match the installed layout of `@campfirein/byterover-packages`.

## [3.8.0]

### Added
- **`brv webui` — a browser dashboard for ByteRover** — Run `brv webui` to open a local dashboard at `http://localhost:7700`. Browse and edit your context tree, review and commit changes, run curate and query, manage LLM providers and connected agents, and switch between projects — all from the browser. Still loads when the daemon isn't running, with a clear recovery screen. Use `--port <n>` to pick a different port (remembered across runs).
- **Guided first-run tour** — The web UI walks new users through setting up a provider, running their first curate and query, and connecting an agent. "Restart the tour" lives in the Help menu if you skip it.

### Changed
- **Connected agents now wait for `brv curate` by default** — The agent skill installed by `brv connectors install` tells Claude Code, Cursor, Codex, Copilot, and other connected agents to let `brv curate` finish before moving on, so follow-up queries see the new data. Agents only fire-and-forget (`--detach`) when you explicitly say so. Re-run `brv connectors install <agent>` to update.
- **Updated default models** — OpenAI via OAuth now defaults to `gpt-5.4-mini`; MiniMax now defaults to `MiniMax-M2.7`.
- **Complete frontmatter on context files** — Context-tree markdown files written by `brv curate` and `brv dream` now always include all seven semantic fields (title, summary, tags, related, keywords, createdAt, updatedAt). Older files without them still load fine.

### Fixed
- **ByteRover OAuth login now resumes provider setup** — Picking ByteRover while signed out used to bounce you back to the provider list after login; it now continues the setup automatically.
- **No more "Connecting to ByteRover…" hang after a fresh login** — Provider connect sees new credentials immediately instead of waiting up to 5 seconds for a cache refresh.
- **Security dependency update** — Patched `@hono/node-server` and `hono` to address a high-severity npm advisory.

## [3.7.1]

### Changed
- **Agent skill template — dedicated "Query and Curate History" section** — The bundled `SKILL.md` installed via `brv connectors install` (for Claude Code, Cursor, Codex, Copilot, and other skill-based agents) now has a dedicated Section 11 covering `brv curate view`, `brv query-log view`, and `brv query-log summary` — including the resolution-tier taxonomy (0=exact cache … 4=full agentic) and time/status filters. Connected agents will now reach for history and recall metrics when debugging knowledge gaps instead of guessing. Re-run `brv connectors install <agent>` to regenerate the skill for an existing connector.

### Fixed
- **`brv vc status` stays clean after queries and curates** — Runtime ranking signals (hotness, recency, access counts, maturity) used to live in markdown frontmatter, so every `brv search`, `brv query`, or agent curate silently dirtied context files and polluted `brv vc status` / `brv vc diff`. Those signals now live in a per-project sidecar outside the context tree; markdown keeps only semantic fields (title, tags, keywords, summary, related, createdAt, updatedAt). Older context trees with legacy signal fields in frontmatter continue to parse — stale fields are ignored on read, so no migration is needed.
- **Synthesis files no longer leak `maturity: draft` into frontmatter** — `brv dream synthesize` previously wrote `maturity: draft` into the YAML frontmatter of each new synthesis file; that field now seeds the sidecar instead, leaving the synthesis markdown body and frontmatter free of ranking state.
- **`brv vc` diffs no longer show OS / editor noise** — Added the following patterns to the context-tree `.gitignore` so they're excluded from `brv vc` tracking: `.DS_Store`, `._*` (macOS); `Thumbs.db`, `ehthumbs.db`, `Desktop.ini` (Windows); `.directory`, `.fuse_hidden*`, `.nfs*` (Linux); and editor swap/backup/temp patterns `*.swp`, `*.swo`, `*~`, `.#*`, `*.bak`, `*.tmp`. Patterns auto-sync into existing projects on the next `brv vc` command — no manual `.gitignore` edit required.

## [3.7.0]

### Added
- **Intel Mac (darwin-x64) install support** — `curl -fsSL https://byterover.dev/install.sh | sh` now installs on Intel Macs. Previously the installer rejected `darwin-x64` with an Apple-Silicon-only error. CI also publishes a `darwin-x64` tarball alongside the existing `darwin-arm64`, `linux-x64`, and `linux-arm64` builds.

### Fixed
- **Security dependency update** — Updated `basic-ftp` and `hono` to patch a high-severity npm advisory.

## [3.6.0]

### Added
- **`brv dream` — tidy up your context tree** — A new command that cleans up your memory in the background: merges related notes, writes short summaries that connect ideas across topics, and archives stale entries. It runs on its own when the CLI has been idle for a while, or you can run it yourself. Changes the model is unsure about are held for you to review with `brv review pending`, and `brv dream --undo` reverts the last run. Flags: `--force` / `-f` to skip the time and activity gates, `--detach` to queue and exit without waiting, `--undo`, `--timeout <seconds>`, `--format json`.
- **`brv query-log` — see what you've asked before** — Every `brv query` is now saved locally so you can look back at past questions and how they were answered. `brv query-log view` lists recent queries with filters `--status`, `--tier`, `--since`, `--before`, and `--limit`, plus `--detail` to also show the matched docs for each entry, and `--format json`. `brv query-log summary` shows aggregated metrics — coverage, cache hit rate, and top topics — over a window set by `--last`, `--since`, or `--before`, with `--format` options `text`, `json`, or `narrative` for a plain-English recap.

## [3.5.1]

### Changed
- **Clearer MCP tool descriptions** — The `cwd` parameter on `brv-curate` and `brv-query` MCP tools now tells the calling LLM exactly when the project path is required (Claude Desktop, hosted MCP) vs. optional (Cursor, Cline, Zed, Claude Code). This reduces failed tool calls from clients that omitted the path or guessed a relative one.

## [3.5.0]

### Added
- **Claude Desktop support** — Connect ByteRover to the Claude Desktop app with `brv connectors install "Claude Desktop"` (or pick it in `/connectors`). Works on macOS, Windows (including Store installs), and Linux. After installing, fully quit Claude Desktop from the tray or menu bar and reopen it to apply.

### Changed
- **Cleaner install layout** — The `install.sh` installer now keeps its bundled Node.js tucked away so it won't conflict with the `node` already on your system. Just reinstall to pick up the new layout.

### Fixed
- **Security dependency update** — Updated `basic-ftp` to patch a high-severity vulnerability.

## [3.4.0]

### Added
- **`brv swarm` — unified memory swarm** — Connect multiple memory providers (ByteRover context tree, Obsidian vaults, local markdown folders, GBrain, OpenClaw Memory Wiki) into a single query and storage layer. `brv swarm onboard` walks through an interactive setup wizard; `brv swarm status` shows provider health, write targets, and enrichment topology. `brv swarm query <question>` runs intelligent routing, parallel provider execution, and Reciprocal Rank Fusion merging — add `--explain` for classification reasoning and provider selection details. `brv swarm curate <content>` stores to the best writable provider based on content classification (`--provider` to override), falling back to ByteRover context-tree curation when no external target is available. Control how providers feed context to each other via `enrichment.edges` in `swarm.config.yaml` — the engine validates cycles, self-edges, and missing providers, and disabled-provider edges produce warnings instead of errors so partial setups degrade gracefully. The agent also gains `swarm_query` and `swarm_store` tools, and sandboxed code can call `tools.swarmQuery()` / `tools.swarmStore()`.
- **GPT-5.4 Mini support** — Added `gpt-5.4-mini` to the Codex allowed models list.

### Fixed
- **Context-tree `.gitignore` auto-sync** — The context-tree `.gitignore` now stays up to date automatically. When any `brv vc` command runs, missing patterns are appended to the existing file instead of only being written on first init. This prevents derived artifacts from polluting `brv vc` diffs after CLI updates.
- **Stale knowledge locations** — Knowledge entries whose source files were deleted are now cleaned up, preventing dead references in search and query results.
- **Security dependency update** — Pinned axios to 1.15.0 to address a critical vulnerability.

## [3.3.0]

### Added
- **`brv search` — BM25 context tree search** — New command for pure BM25 retrieval over the context tree (no LLM, no provider, no token cost). Returns ranked paths, scores, and excerpts. Flags: `--limit` (1–50), `--scope <prefix>`, `--format json`. Use `brv search` for structured results and `brv query` for synthesized answers.
- **`--timeout` flag for `brv curate` and `brv query`** — Override the previous hardcoded 5-minute limit so slow local models can finish. Accepts seconds (default 300, max 3600); no effect with `--detach`.

### Fixed
- **Misleading "no space configured" error on `brv push` / `brv pull`** — Legacy sync now shows a clear deprecation message pointing at `brv vc init` instead of the deprecated `brv space switch` flow. TUI also links to the [version control docs](https://docs.byterover.dev/git-semantic/overview).
- **`brv status` auto-created `.snapshot.json` without team/space config** — VC-managed projects no longer get a stray legacy-sync snapshot file; status now reports `Managed by Byterover version control` instead.
- **Adaptive `*.abstract.md` / `*.overview.md` files polluting `brv vc` diffs** — These derived artifacts are now in the context-tree `.gitignore` and excluded from version control.

## [3.2.0]

### Added
- **`brv worktree` — git-style worktree links** — Register a subdirectory (or sibling) as a worktree of a parent project without creating a nested `.brv/`. `brv worktree add [path]` writes a `.brv` pointer file in the target that redirects to the parent — the same pattern as `git worktree` (path defaults to the current directory for auto-detect from a subdirectory). `brv worktree list` shows the current link state and registered worktrees; `brv worktree remove [path]` unregisters (also defaults to cwd). `--force` lets `add` convert an existing `.brv/` directory into a pointer by backing it up to `.brv-backup/`; `remove` restores that backup automatically if present. Also available as `/worktree` in the REPL.
- **`brv source` — cross-project knowledge sources** — Link another project's context tree as a read-only knowledge source. `brv source add <path> [--alias <name>]` attaches a source; `brv source list` shows linked sources with validity; `brv source remove <alias-or-path>` detaches. Linked sources are write-protected, and query results pulled from them are tagged with a `shared` origin and their alias so you can tell which project an answer came from. Also available as `/source` in the REPL.
- **Resolver-aware `brv status`** — `brv status` now surfaces the resolved project root, the linked worktree root (when different), knowledge-source validity, and actionable warnings for broken or malformed worktree pointers and sources. `--verbose` adds the resolution source (`direct` / `linked` / `flag`). A new `--project-root <path>` flag on `brv status` overrides auto-detection and fails loudly when the path is not a ByteRover project instead of silently falling back to the current directory.

### Changed
- **Workspace-aware curate and query** — `brv curate` and `brv query` now automatically detect when you're inside a linked worktree and pass the worktree root to the daemon alongside the project root. Explicit relative paths you pass yourself (e.g. `brv curate -f ./src/auth.ts`, `brv curate -d ./packages/api/src`) still resolve from your shell cwd to match normal shell behavior.

## [3.1.0]

### Added
- **Adaptive knowledge scoring** — The knowledge base now prioritizes content based on usage patterns. Frequently accessed knowledge ranks higher in search results through hotness scoring and hierarchical score propagation.
- **Knowledge abstracts** — Knowledge entries automatically generate compressed summaries (abstracts and overviews), reducing token usage while preserving key information for the agent.
- **Session learning** — The agent extracts patterns, preferences, decisions, and skills from your sessions and stores them as durable knowledge, improving responses over time.
- **Resource ingestion tool** — The agent can now ingest external files and resources directly into your knowledge base.

### Fixed
- **Stale CLI cache after upgrades** — Install and uninstall scripts now clean the oclif client cache, preventing issues caused by cached data from previous versions.
- **Knowledge search accuracy** — Fixed double compound scoring in parent propagation, improved maturity filtering, and corrected result truncation for more relevant search results.

## [3.0.0]

### Added
- **`brv vc` — Git version control commands** — A full suite of Git-like commands (`init`, `clone`, `status`, `commit`, `push`, `pull`, `branch`, `checkout`, `merge`, `reset`, `remote`, `log`, `fetch`) that sync context alongside code through ByteRover's remote.
- **Human-in-the-loop review system** — Review pending curate operations before they are applied. Use `brv review pending` to list, `brv review approve` to accept, and `brv review reject` to discard.

### Changed
- **Legacy commands show `brv vc` hints** — Running `brv status`, `brv pull`, or `brv push` now displays a tip about the corresponding `brv vc` command.
- **Name-based remote URLs** — Remote URLs now use human-readable names.
- **Team and space persisted on remote add** — `brv vc remote add` and `brv vc remote set-url` now persist team and space identifiers to `config.json`.
- **(Deprecated) `brv space list` and `brv space switch`** — These commands still work but show a deprecation notice directing users to the web dashboard.

### Fixed
- **Provider error messages** — CLI text-mode commands now show the actual backend error message instead of a misleading "API key is missing or invalid" fallback.
- **Security dependency updates** — Patched `hono`, `@hono/node-server`, `@xmldom/xmldom`, `lodash`, and `lodash-es` to address known vulnerabilities.

## [2.6.0]

### Changed
- Refactor and major code cleanup.

## [2.5.2]

### Fixed
- **Pinned axios to exact version 1.14.0** — Locked the axios dependency to an exact known-good version to mitigate supply-chain security risks. Previously used a caret range (`^1.12.2`) that could pull in untrusted future releases.

## [2.5.1]

### Fixed
- **Provider connect/switch showed false success on auth errors** — `brv providers connect` and `brv providers switch` now correctly detect when the server rejects the request and display the actual error message (e.g., authentication required) instead of falsely reporting success.

## [2.5.0]

### Added
- **Inline login for ByteRover provider** — When selecting or activating ByteRover without being logged in, the CLI now shows an inline login prompt instead of failing. Users authenticate through the browser without leaving the provider setup flow. Tasks also validate authentication before execution and show a clear message if login is needed.

### Fixed
- **Proxy double-routing on corporate networks** — Fixed an issue where HTTP requests could be routed through a proxy twice when `HTTPS_PROXY` was set, causing connection failures. Axios's built-in proxy is now explicitly disabled in favor of the custom `proxy-agent` already in use.
- **Security dependency updates** — Patched npm dependencies to address high-severity vulnerabilities.

## [2.4.1]

### Fixed
- **Agent startup reliability improved** — Increased the timeout for agent child processes to become ready from 15 to 30 seconds, reducing timeout failures on slower machines or under heavy load.
- **Console window flash on Windows** — Agent child processes no longer briefly flash a console window when spawned on Windows.
- **Security dependency updates** — Patched npm dependencies to address high-severity vulnerabilities.

## [2.4.0]

### Added
- **Enterprise proxy support** — All HTTP traffic now automatically routes through corporate proxies when standard environment variables are set (`HTTPS_PROXY`, `HTTP_PROXY`, `NO_PROXY`). For environments with SSL inspection, set `NODE_EXTRA_CA_CERTS` to your corporate CA certificate. The CLI provides clear error messages when proxy or certificate issues are detected.

## [2.3.4]

### Changed
- **ByteRover provider request format simplified** — Reduced unnecessary fields sent to the server for cleaner request handling.

## [2.3.3]

### Fixed
- **Streaming errors from OAuth providers showed `[object Object]`** — Error messages from LLM provider streaming failures (e.g. OpenAI via OAuth) now display the actual error detail instead of an unhelpful `[object Object]` string.

## [2.3.2]

### Removed
- **`better-sqlite3` dependency** — Removed the unused native SQLite package that was left over after the migration to file-based storage in 2.1.0. This reduces install size and eliminates native compilation requirements on some platforms.

## [2.3.1]

### Fixed
- **OpenRouter provider name format** — OpenRouter models now display as `OpenRouter (<provider>)` instead of a capitalized provider name, making it easier to identify when using an OpenRouter-routed model.
- **`brv update` blocked for npm installations** — Running `brv update` when installed via npm now shows a clear error directing users to run `npm update -g byterover-cli` instead. Previously produced confusing errors.
- **`brv restart` no longer kills itself or triggers daemon respawn** — Rewrote restart with a 4-phase shutdown sequence (kill clients, graceful daemon stop, clean orphans, clean state files).
- **Security dependency updates** — Patched `socket.io` and `@campfirein/brv-transport-client` to address high-severity vulnerabilities.

## [2.3.0]

### Added

- **OAuth provider authentication** — Connect to LLM providers by signing in via your browser instead of manually entering API keys. OpenAI is the first supported OAuth provider. Run `/providers` in the REPL or `brv providers connect openai --oauth` from the command line to authenticate through the browser. Tokens are securely stored and automatically refreshed by the daemon.

### Changed

- **Provider list shows authentication method** — `brv providers list` now displays `[OAuth]` or `[API Key]` badges next to connected providers indicating how they were authenticated.
- **Reconnect option for OAuth providers** — Already-connected OAuth providers show a "Reconnect OAuth" option in `/providers` to re-authenticate or switch accounts.

## [2.2.0]

### Added

- **`brv locations` command** — List all registered projects and their context tree status. Shows which projects are initialized, which is current, and which have active connections. Supports `--format json` for automation. Also available as `/locations` in the REPL.

## [2.1.5]

### Added

- **`brv logout` command** — Disconnect from ByteRover cloud and clear stored credentials from the CLI. Supports `--format json` for headless/automation use cases.

### Fixed

- **Security dependency updates** — Patched `flatted`, `hono`, and `yauzl` to address security vulnerabilities.

## [2.1.4]

### Fixed

- **Local Ollama and OpenAI-compatible providers work without an API key** — Providers that do not require an API key (e.g. local Ollama) no longer trigger a "provider key missing" error. Only providers that actually require a key are flagged when one is absent.

## [2.1.3]

### Fixed

- **`brv restart` killing itself and hanging terminal** — Fixed an issue where `brv restart` could kill its own parent shell wrapper process (used by native binary installations via `install.sh`), causing garbled terminal output and hangs. The restart command now also force-exits after completion to prevent stale oclif plugin handles from blocking the process.

## [2.1.2]

### Changed

- **Default LLM model switched to Gemini 3.1 Flash Lite** — The default model for the ByteRover provider is now `gemini-3.1-flash-lite-preview`, replacing `gemini-3-flash-preview`, for improved performance and cost efficiency.

## [2.1.1]

### Changed

- **Skip update notifier for non-npm installations** - Update notifications are now suppressed when the CLI is not installed via `npm install -g`, preventing irrelevant update prompts for tarball and native binary users.
- **Auto-update frequency for native installations** - Configured oclif autoupdate with 1-day debounce for more reliable update checks on non-npm installations.

### Fixed

- **Security dependency updates** - Patched `fast-xml-parser`, `@aws-sdk/xml-builder`, and `@hono/node-server` to address security vulnerabilities.

## [2.1.0]

### Added

- **Agentic map system** - A new LLM-powered context map organizes knowledge hierarchically and enables smarter retrieval. Includes escalated compression strategies that adapt when context grows large, keeping responses accurate even for very large codebases.
- **`/exit` command** - Type `/exit` in the REPL to gracefully close the session (alternative to Ctrl+C).

### Changed

- **File-based storage** - Internal storage migrated from SQLite to plain files. Eliminates the native SQLite dependency for a simpler, more portable installation.

### Removed

- **Google Vertex AI provider** - The Vertex AI integration has been removed. Users relying on Google models should use Gemini via Gemini_API_key.

## [2.0.0]

### Added

- **Local-first mode** - CLI works without cloud authentication. A `.brv` directory is auto-created in the project root, and `/curate` and `/query` work fully offline.
- **Native binary installer** - Install on macOS and Linux without Node.js via `curl -fsSL https://byterover.dev/install.sh | sh`. Uninstaller script also available.
- **Multi-provider LLM support** - Connect to 20+ LLM providers via `/providers connect`: Anthropic, OpenAI, Google, Groq, Mistral, Perplexity, Cerebras, xAI, Together AI, and more.
- **OpenAI-compatible provider** - Use `--base-url` to connect custom endpoints such as Ollama, LM Studio, llama.cpp, vLLM, and LocalAI.
- **Google Vertex AI support** - Service account credential support via `-f` flag in `brv providers connect`.
- **Hub registry** - Browse, install, and manage skills and bundles from registries. Add custom registries with auth support via `brv hub registry add`.
- **Knowledge scoring** - Compound scoring system (BM25 + importance + recency) with maturity tiers (draft, validated, core). Frequently used knowledge rises; neglected knowledge decays.
- **YAML frontmatter for context files** - Context files now use structured YAML frontmatter (title, tags, related, keywords) instead of `## Relations` sections.
- **New agent connectors** - Added OpenClaw, OpenCode, and Auggie CLI integrations, bringing total supported agents to 22.
- **Consolidated skill connector** - Single `SKILL.md` file for agent skill integration replaces multi-file approach.
- **Daemon architecture** - A global background daemon enables fast CLI startup and shared connections. Use `brv restart` to restart the daemon.
- **Parallel task execution** - Concurrent curate and query operations (up to 5 tasks) via per-task child sessions.
- **API key login** - Authenticate with `brv login -k <key>` for non-interactive or headless environments.
- **Knowledge attribution** - Query responses include a footer showing which context tree sources contributed to the answer.
- **Linux ARM64 support** - Native binary builds now available for Linux aarch64.
- **Context tree merge improvements** - Backup and conflict directories created during sync. Auto-pull on space switch with local change preservation.
- **Fact extraction** - Automatic facts extraction from content during curation.

### Changed

- **(Breaking) Provider command renamed** - `/provider` is now `/providers` for both the TUI slash command and the oclif command.
- **(Breaking) Model switch command renamed** - `model set` is now `model switch`.
- **(Breaking) Default provider changed** - The default LLM provider is now ByteRover instead of OpenRouter.
- **(Breaking) Provider config cleared on upgrade** - Existing provider configurations are cleared; re-setup is required after upgrading.
- **Provider management restructured** - Provider commands are now `brv providers list/connect/disconnect/switch` subcommands.
- **Model management restructured** - Model commands are now `brv model list/switch` subcommands.
- **Context-window-aware token management** - Compaction and truncation thresholds now adapt to the active model's context window size.
- **Config structure simplified** - Cloud fields (spaceId, teamId, etc.) are now optional, supporting local-first usage.
- **Documentation moved** - Detailed docs moved to docs.byterover.dev; README simplified.

### Fixed

- **Agent pool race condition** - Fixed concurrent agent session management causing intermittent failures.
- **Cross-project context writes** - Agent process working directory now correctly scoped to prevent writing context to wrong project.
- **Hub list timeouts** - Fixed first-run timeout when loading hub registry.
- **Rate limit handling** - Provider-aware retry delays prevent excessive retries on rate-limited requests.
- **Input paste corruption** - Replaced ink-text-input with direct input handling to fix paste-related text corruption.
- **Stale data in TUI commands** - Disabled React Query cache for TUI commands to ensure fresh data.

### Removed

- **(Breaking) Keychain/Keytar support** - API key storage moved from system keychain to encrypted file-based storage. Re-entry of API keys required after upgrade.
- **Legacy OpenRouter content generator** - Replaced by the unified multi-provider AI SDK.
- **Old TUI views** - Removed init-view, login-view, main-view, and Tab bar in favor of page-based routing.

## [1.8.0]

### Added

- **Faster query responses** - Three-tiered response system: fuzzy cache matching for repeated queries (~50ms), direct search for high-confidence matches (~100-200ms), and optimized LLM responses with prompt caching and smart routing.
- **Out-of-domain detection** - Multi-layer detection prevents confidently wrong answers for topics not covered in the context tree, with AND-first search matching and relevance guards.
- **Diagram and visual content preservation** - Structured diagrams (Mermaid, PlantUML, ASCII art) are preserved verbatim during curation instead of being summarized.

### Changed

- **Improved folder curation** - New iterative extraction strategy for large directories avoids token limits. Default suggestion of `./` added in slash completion for curating current directory.
- **System prompt improvements** - Updated to be more general purpose and better respect source files instead of suggesting imports.

### Fixed

- **NPM security vulnerability** - Addressed high severity npm security issue.
- **File validator for text files** - Fixed rejection of known text file extensions (e.g., .md with UTF-16 encoding). Office documents (docx, xlsx, pptx) now pass validation.
- **Markdown newline formatting** - Fixed literal `\n` strings being rendered instead of actual newlines in generated markdown content.

## [1.7.2]

### Fixed

- **Sandbox TypeScript execution** - Added `esbuild` as a direct dependency to ensure TypeScript transpilation works reliably in the sandboxed code execution environment.

## [1.7.1]

### Fixed

- **Installation reliability** - Bundled `brv-transport-client` dependency to prevent installation failures when the GitHub-hosted package is unreachable.

## [1.7.0]

### Added

- **Folder reference support** - Use `@folder_path` syntax in `/curate` command to include entire directories. Files are packed into a structured format for comprehensive context curation. Also available in MCP `brv-curate` tool.
- **Escape key to cancel** - Press Esc to cancel streaming responses and long-running commands with timestamped cancellation feedback.
- **Improved onboarding flow** - Streamlined first-time setup with server-side onboarding state, auto-selection of default team/space, and clearer "What's Next" guidance for connector setup.
- **Query command alias** - Use `/q` as a shorthand for `/query` command.
- **Enhanced activity logs** - Activity logs now display code descriptions and file references for better traceability.

### Changed

- **Faster update checks** - Update notifier now checks every hour instead of every 24 hours for quicker access to new releases.
- **Improved query performance** - Query operations now use optimized programmatic search with sandboxed code execution for reduced latency.
- **Simplified agent architecture** - Removed subagent task delegation for more direct and responsive command execution.

### Fixed

- **NPM security vulnerabilities** - Addressed critical security issues identified in dependency audit.
- **Orphaned connector migration** - Fixed connector configuration migration when switching between connector types.
- **TUI layout stability** - Removed stray console output that could disrupt terminal UI rendering.
- **Context relation paths** - Relation paths in context.md files are now consistently normalized to lowercase with underscores.

## [1.6.0]

### Added

- **Headless mode for automation** - New `--headless` flag enables non-interactive CLI execution for CI/CD pipelines and automation. Supported commands: `init`, `status`, `curate`, `query`, `push`, `pull`.
- **JSON output format** - New `--format json` flag outputs structured newline-delimited JSON (NDJSON) for machine-readable results. Includes action lifecycle events, logs, warnings, errors, and structured results with timestamps.
- **Enhanced `brv init` flags** - New `--team`, `--space`, and `--force` flags for non-interactive project initialization. Team and space can be specified by name or ID.
- **File-based token storage for headless Linux** - Automatic fallback to file-based token storage when system keychain is unavailable (SSH sessions, containers, missing D-Bus). Enables seamless operation on headless Linux servers.

## [1.5.0]

### Added

- **External LLM provider support** - Connect to external providers like OpenRouter to access 200+ models. New `/provider` (aliases: `/providers`, `/connect`) command to connect and switch providers, and `/model` (aliases: `/models`) command to browse and select models with pricing, context window, favorites, and recent usage tracking. API keys stored securely in system keychain.
- **Reasoning/thinking display** - LLM reasoning and thinking content now appears in the execution progress view with an animated "Thinking..." indicator during streaming. Supports multiple model formats including Claude, OpenAI, Gemini, and DeepSeek.
- **Improved execution progress** - Custom status indicators (checkmark, blinking dot, X) for completed, running, and failed tool calls. Running items are prioritized to stay visible, and long tool commands are cleanly truncated.

### Changed

- **Model cost display** - Accurate input/output pricing shown separately (e.g., "$3.00/$15.00/M") with model descriptions displayed inline for better scannability.

### Fixed

- **OpenRouter streaming reliability** - Fixed TUI getting stuck on results and duplicate thinking entries when using OpenRouter models. Tool execution now runs in parallel for faster completion.
- **Directory listing path validation** - Fixed failures caused by double-resolved paths.
- **Task queue notifications** - Queued tasks now receive proper error notifications when dropped during reinitialization, instead of timing out silently.
- **Reasoning streaming states** - Fixed thinking indicator incorrectly reappearing when text response starts streaming.
- **NPM security vulnerabilities** - Updated dependencies to address moderate severity vulnerability.

## [1.4.0]

### Added

- **Antigravity agent support** - New coding agent integration using rules-based connector by default. Joins the 19 supported agents including Amp, Claude Code, Cursor, Windsurf, and others.
- **Improved PDF text extraction** - Increased default PDF page limit from 50 to 100 pages (max 200) with more efficient page-by-page processing for better handling of large documents.
- **Optional prompt for file references** - Made prompt optional when using `@file_path` references in `/curate` command and MCP `brv-curate` tool. The system infers context from referenced files when no explicit prompt is provided.

### Changed

- **Streamlined space switching** - Existing connector configuration is now preserved when switching spaces via `/space switch`, removing the redundant agent selection prompt.
- **Removed Node.js version warning** - Startup no longer displays Node.js version warnings. The Node.js >= 20.0.0 requirement remains enforced in package.json.

## [1.3.0]

### Added

- **Skill-based agent integration** - New integration method providing discoverable, markdown-based guidance for AI coding agents. Skills install as three comprehensive files (SKILL.md, TROUBLESHOOTING.md, WORKFLOWS.md) in your agent's skill directory, offering quick reference, troubleshooting guides, and detailed workflows. Available for Claude Code, Cursor, Codex, and GitHub Copilot.

### Changed

- **Claude Code default connector** - Changed from hook-based to skill-based integration for better discoverability and maintainability. Skills no longer modify IDE settings and provide more comprehensive guidance. Hook connector remains available for users who prefer it.
- **Cursor default connector** - Changed from MCP to skill-based integration for native skill support. Provides better integration through Cursor's skill system.
- **Task execution reliability** - Unified task queue with sequential processing (FIFO) prevents conflicts during concurrent curate and query operations. Tasks now execute predictably in order with improved cancellation and deduplication support.

### Fixed

- **Authentication error handling** - Improved error messages and recovery during OAuth token exchange and refresh flows
- **Windsurf rule file formatting** - Fixed YAML frontmatter ordering in generated rule files for correct parsing

## [1.2.1]

### Changed

- **Simplified command reference** - Generated rule files now include concise command list with `--help` guidance instead of detailed inline documentation

### Fixed

- **Socket connection stability** - Fixed duplicate event listeners accumulating after system wake-up, improving connection reliability
- **Sub-agent task display** - Fixed premature "Result:" message appearing during sub-agent task execution
- **NPM security vulnerabilities** - Updated dependencies to address security issues

## [1.2.0]

### Added

- **MCP server integration** - Model Context Protocol server enabling ByteRover context queries and curation from Claude Code, Cursor, Windsurf, and other coding agents via `brv-query` and `brv-curate` tools
- **Expandable message view** - Press Ctrl+O to expand any message to full-screen view with vim-style navigation (j/k for scrolling, g/G to jump to top/bottom)
- **Expandable log view** - Full-screen log inspection with scrollable output and keyboard navigation
- **Auto-create domain context files** - Domains automatically get context.md files created at multiple levels (domain, topic, subtopic) for better knowledge organization
- **Markdown rendering** - Improved formatting support for agent output with proper rendering of headings, lists, blockquotes, and code blocks

### Changed

- **Connector setup flow** - `/connectors` command now provides clearer MCP configuration instructions for supported coding agents
- **Increased suggestion visibility** - CLI suggestions list displays 7 items with improved scroll indicators
- **Version display** - Version number shows "(latest)" indicator when running the most current version

### Fixed

- **MCP connection stability** - Added auto-reconnect logic with exponential backoff and health checks to handle temporary socket disconnections
- **`/new` command session handling** - Fixed `/new` command to properly update agent's internal session ID, preventing messages from routing to old sessions
- **Task isolation** - Fixed taskId propagation in session events for proper concurrent task handling
- **`/curate` usage string** - Aligned `/curate` usage description with actual flag behavior
- **Context overflow handling** - Added token-based message compression for handling large conversation contexts

## [1.1.0]

### Added

- **IDE hook integration** - Support for injecting ByteRover context directly into Claude Code via hooks
- **PDF file reading** - Read and analyze PDF files with proper validation and magic byte detection
- **Knowledge search tool** - New `search_knowledge` tool for querying the context tree programmatically
- **System sleep/wake detection** - Improved reliability when user's machines sleep and wake

### Changed

- **Increased curation concurrency** - Curation tasks now run with concurrency of 3 (up from 1)
- **Improved query search** - Multi-perspective search strategy with few-shot examples and stop-word filtering
- **Better curate responses** - Curate agent now includes subtopic names in generated context
- **REPL-first error messages** - All error messages now reference REPL slash commands (e.g., `/init` instead of `brv init`)
- **Updated documentation URL** - Docs now point to production URL instead of beta

### Fixed

- **Binary file detection** - Replaced byte-level heuristics with UTF-8 aware detection; fixes false positives for files with emojis, CJK text, and box-drawing characters
- **PDF validation** - Reject fake PDFs (binary files with .pdf extension) using magic byte validation
- **Process reconnection** - Fixed race conditions in agent restart and improved transport reconnection with exponential backoff
- **Topic naming** - Fixed `_md` suffix appearing in topic and sub-topic names during curation
- **Pull sync filtering** - README.md at context-tree root is now filtered during pull to avoid syncing incorrect files
- **NPM security vulnerabilities** - Updated dependencies to address security issues

## [1.0.5]

### Added

- Stateful sessions with auto-resume - sessions now persist and can be resumed after restart
- `/new` command to start a fresh session (clears conversation history while preserving context tree)
- Two-part context model for curation - contexts now include both raw concept and narrative sections

### Changed

- `/clear` command renamed to `/reset` to avoid confusion with Unix `clear` command
- Upgraded default LLM to Gemini 3 Flash with thinking visualization support
- Improved curate prompt quality and handling of empty code snippets
- Knowledge relations now enforce consistent path format (`domain/topic/title.md`)

### Fixed

- File extension preserved correctly in knowledge relation paths
- Relation parser now handles file extensions and pattern matching more reliably
- Question marks removed from confirmation prompts for cleaner UI
- File paths now resolve correctly relative to project root (not working directory)
- Concurrent curation no longer gets stuck in queue state
- Improved stability during concurrent task execution

## [1.0.4]

### Added

- Task lifecycle status display in header showing active/completed tasks
- Initialization status indicator in header
- Dynamic domain creation for context tree - create new knowledge domains on the fly
- Step-based initialization UI with improved onboarding flow
- Actionable welcome prompt with quick-start suggestions
- Randomized example prompts in welcome screen
- WSL (Windows Subsystem for Linux) support with file-based token storage fallback
- Read-file tool pagination and line truncation for handling large files

### Changed

- Switched internal LLM service from gRPC to HTTP for improved reliability
- Sequential execution for `brv curate` commands to prevent conflicts

### Fixed

- Security vulnerability in query string parsing
- Double `@` prefix appearing in knowledge relations
- File validation when running `brv curate` from different directories
- Auth token validation now properly handles network errors
- SQLite database connection cleanup
- Agent initialization reliability improvements

## [1.0.2]

### Added

- Long-living agent with persistent task execution and restart support
- Responsive terminal UI with dynamic sizing and small-screen warnings
- Cross-platform path normalization for context tree
- Context tree structure injection into agent prompts
- Multimodal file reading support (images)
- Visual feedback when copying text
- Unified session logging across processes
- System sleep/wake detection for reliability

### Changed

- Updated onboarding UI with new visual design
- Context files use title-based naming with snake_case
- Improved `/query` accuracy with mtime sorting

### Removed

- `/chat` command removed (use `/curate` and `/query` instead)

### Fixed

- `/status` command now correctly detects changes
- Agent restart during onboarding
- Path duplication in read_file tool
- Empty directory creation during curation
- Application resizing issues
- Tab characters breaking terminal UI

## [0.4.1]

### Fixed

- `/status` command now correctly displays CLI version

### Changed

- Minimum Node.js version requirement increased from 18 to 20
- Simplified welcome banner by removing verbose onboarding instructions

## [0.4.0]

### Added

- **Interactive REPL mode**: Running `brv` with no arguments now starts an interactive terminal UI with a persistent session
- **Slash commands**: All core functionality is now available via slash commands in REPL mode:
  - `/login`, `/logout` - Authentication
  - `/init` - Project setup with team/space selection
  - `/status` - Show auth, config, and context tree state
  - `/curate` - Add context to context tree
  - `/push [--branch <name>]`, `/pull [--branch <name>]` - Cloud sync (default branch: `main`)
  - `/space list`, `/space switch` - Space management
  - `/gen-rules` - Generate agent-specific rule files
  - `/clear` - Reset context tree
  - `/query` - Query context tree
- **File references in curate**: Use `--files` flag to include file references in autonomous curation
- **Interactive onboarding**: New guided onboarding flow for first-time users (press Esc to skip)

### Changed

- **Command renamed**: `reset` command is now `/clear` in REPL mode

### Fixed

- Improved UI responsiveness and layout
- Fixed terminal scrolling issues
- Fixed UI flickering during long-running operations
- Fixed tool error display showing 'undefined'

## [0.3.5]

### Added

- **Auto-update notification**: CLI now checks for updates every 24 hours and offers to update automatically via `npm update -g byterover-cli`
- **Legacy rule migration**: `brv gen-rules` now detects existing agent rules and creates backups before updating

### Fixed

- Fixed file write errors when parent directories don't exist
- Improved reliability of AI function calling
- Resolved security vulnerability
- Fixed race condition between update notification and welcome message display
