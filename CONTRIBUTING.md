# Contributing to ByteRover CLI

Thank you for your interest in contributing to ByteRover CLI! Whether you're fixing a bug, adding a feature, improving documentation, or reporting an issue — every contribution is valued.

## Quick Start

### Prerequisites

- [Node.js](https://nodejs.org/) >= 20
- npm
- Git

### Setup

```bash
# Fork the repo on GitHub, then clone your fork
git clone https://github.com/YOUR_USERNAME/byterover-cli.git
cd byterover-cli

# Install dependencies
npm ci

# Build
npm run build

# Run tests
npm run test
```

### Development Mode

```bash
# Copy .env.example to .env.development
cp .env.example .env.development

# Run in dev mode (ts-node, BRV_ENV=development)
./bin/dev.js

# Run a specific command in dev mode
./bin/dev.js status
./bin/dev.js curate "some context" @src/file.ts
```

### Create a Branch

```bash
git checkout -b feature/your-descriptive-branch-name
```

Branch naming conventions:
- `feature/*` — New features
- `fix/*` — Bug fixes
- `docs/*` — Documentation changes
- `test/*` — Test additions or improvements
- `refactor/*` — Code refactoring

## Development Workflow

### Commands

```bash
npm run build        # Full build (clean + tsc + copy templates/resources)
npm run lint         # ESLint
npm run lint:fix     # ESLint with auto-fix
npm run typecheck    # TypeScript type checking (tsc --noEmit)
npm test             # All tests (mocha --forbid-only)
```

Run a single test file:

```bash
npx mocha --forbid-only "test/path/to/file.test.ts"
```

> **Note:** Always run tests from the project root, not from within test directories.

### Git Hooks

- **Pre-commit**: Runs `lint-staged` (ESLint on staged `.ts`/`.tsx` files)
- **Pre-push**: Runs `npm run typecheck`

### Web UI Development

The web UI supports a local-first development flow for the shared component library. `npm run dev:ui` uses the git submodule at `packages/byterover-packages/ui` so edits to shared UI components hot-reload immediately in Vite.

```bash
# Clone with submodules, or initialize them after clone
git clone --recurse-submodules <repo-url>
# or
git submodule update --init --recursive

# Install dependencies
npm ci

# Start or restart the daemon
./bin/dev.js restart

# Start the web UI in local development mode
npm run dev:ui
```

Notes:

- Edit shared components in `packages/byterover-packages/ui/src`.
- `npm run dev:ui` uses the submodule source.
- `npm run build:ui` uses the installed package path.
- If `/api/ui/config` or transport bootstrap fails, restart the Vite dev server after restarting the daemon.

## Project Structure

```
src/
├── agent/       # LLM agent system
│   ├── core/    #   Domain interfaces
│   ├── infra/   #   Implementations (tools, LLM providers, system-prompt, map, memory)
│   └── resources/ # Tool definitions (.txt), prompt templates (.yaml)
├── server/      # Daemon infrastructure
│   ├── core/    #   Domain interfaces
│   └── infra/   #   Implementations (daemon, process, session, storage)
├── shared/      # Cross-module constants, types, transport events, utils
├── tui/         # React/Ink TUI
│   ├── app/     #   Router and pages
│   ├── components/ # Reusable UI components
│   ├── features/   # Feature modules (commands, auth, curate, query, etc.)
│   ├── hooks/      # React hooks
│   └── stores/     # Zustand state stores
└── oclif/       # CLI commands and hooks
    ├── commands/ #   oclif command definitions
    └── hooks/    #   oclif lifecycle hooks

test/
├── commands/     # Command integration tests
├── unit/         # Unit tests (fast, in-memory)
├── integration/  # Integration tests
├── helpers/      # Test utilities
├── hooks/        # Hook tests
└── shared/       # Shared test utilities
```

**Import boundary** (ESLint-enforced): `tui/` must not import from `server/`, `agent/`, or `oclif/`. Use transport events or `shared/` for cross-module communication.

## Code Style and Conventions

### TypeScript

- **ES modules** with `.js` import extensions required (Node16 module resolution)
- **No `as Type` assertions** — use type guards or proper typing instead
- **No `any`** — use `unknown` with type narrowing or proper generics
- **Object parameters** for functions with more than 3 parameters
- **`type`** for data-only shapes (DTOs, payloads, configs)
- **`interface`** for behavioral contracts with method signatures (services, repositories)
- **`I` prefix** for interfaces (e.g., `IAuthService`, `IStorageProvider`)
- **`toJson()` / `fromJson()`** (capital J) for serialization methods
- **Snake_case APIs**: use `/* eslint-disable camelcase */` where external APIs require it

### Architecture

- oclif v4 commands live in `src/oclif/commands/`
- Services in `src/server/infra/` and `src/agent/infra/`
- Follow **Outside-In** feature development: start from the consumer (command/TUI component), define the minimal interface it needs, then implement the service

## Testing Standards

**Test-Driven Development (TDD) is mandatory.** Follow this cycle for every change:

1. **Write failing tests first** — before writing any implementation code, write tests that describe the expected behavior
2. **Run tests to confirm they fail** — verify the tests fail for the right reason (missing implementation, not a syntax error)
3. **Write the minimal implementation** — write only enough code to make the failing tests pass
4. **Run tests to confirm they pass** — verify all tests are green
5. **Refactor if needed** — clean up while keeping tests green

### Testing Rules

- **50% coverage minimum**, critical paths must be fully covered
- **Suppress console logging** in tests to keep output clean
- **Unit tests must be fast** and run completely in-memory with proper stubbing and mocking
- **Stack**: Mocha + Chai + Sinon + Nock

### Testing Gotchas

- **HTTP mocking (nock)**: Always verify both `authorization` and `x-byterover-session-id` headers with `.matchHeader()`
- **ES Modules**: Cannot stub ES module exports with sinon. Test utilities using the real filesystem via `tmpdir()` instead

## Commit Message Format

Use [Conventional Commits](https://www.conventionalcommits.org/):

```
<type>: <description>
```

### Types

| Type | Purpose |
|------|---------|
| `feat` | New feature |
| `fix` | Bug fix |
| `docs` | Documentation only |
| `test` | Adding or updating tests |
| `refactor` | Code change that neither fixes a bug nor adds a feature |
| `chore` | Build process, dependencies, or tooling changes |

### Examples

```
feat: add persistent memory layer for agent sessions
fix: resolve MCP connection timeout on slow networks
docs: update LLM provider setup instructions
test: add integration tests for cloud sync
refactor: extract shared auth logic into service
chore: update dependencies
```

## Pull Request Process

### Before Submitting

Run all checks locally:

```bash
npm run lint && npm run typecheck && npm run build && npm test
```

### Submitting

1. Push your branch and open a PR against `main`
2. Fill in the PR template with:
   - A clear title describing the change
   - Description explaining **what** and **why**
   - Link to related issues

#### CI for fork PRs

CI does not run automatically on PRs from forks because some build steps need access to a private dependency. A maintainer will review the diff and apply the `safe-to-test` label to trigger validation. The label is automatically removed when you push new commits — a maintainer will re-review and re-apply it. No action from you is required; this is just a heads-up so the initial absence of checks isn't surprising.

### PR Checklist

- [ ] Code follows the project's style guidelines
- [ ] Tests added or updated and passing
- [ ] Documentation updated if needed
- [ ] No breaking changes (or clearly documented if unavoidable)
- [ ] Commits follow conventional format
- [ ] Branch is up to date with `main`

## Reporting Issues

When reporting bugs, please include:

1. **Environment**: Node.js version, OS, npm version, `brv --version`
2. **Steps to reproduce** (minimal)
3. **Expected behavior** vs **actual behavior**
4. **Error messages** or relevant logs

## License

By contributing to ByteRover CLI, you agree that your contributions will be licensed under the [Elastic License 2.0](LICENSE).
