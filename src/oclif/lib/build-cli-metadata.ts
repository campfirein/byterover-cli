/* eslint-disable camelcase */
import type {CliMetadata} from '../../shared/analytics/cli-metadata-schema.js'

type PackageManager = 'bun' | 'npm' | 'pnpm' | 'unknown' | 'yarn'

/**
 * Shape of the oclif `Command.parse()` result fields this helper consumes.
 * Both top-level fields are accepted defensively (test fixtures may pass
 * a `flags`-only shape without metadata).
 */
export type OclifParseResultLike = {
  flags: Record<string, unknown>
  metadata?: {
    flags?: Record<string, undefined | {setFromDefault?: boolean}>
  }
}

/**
 * Detect the package manager that launched this `brv` process.
 *
 * `npm`, `yarn`, `pnpm`, and `bun` all set `npm_config_user_agent` when
 * they spawn a child script (e.g. `npm install` → `npm/X.Y.Z node/Z os`).
 * Direct `node bin/run.js` invocations or unknown package managers fall
 * through to `'unknown'`.
 */
function detectPackageManager(): PackageManager {
  const userAgent = process.env.npm_config_user_agent ?? ''
  if (userAgent.startsWith('npm/')) return 'npm'
  if (userAgent.startsWith('yarn/')) return 'yarn'
  if (userAgent.startsWith('pnpm/')) return 'pnpm'
  if (userAgent.startsWith('bun/')) return 'bun'
  return 'unknown'
}

/**
 * `process.versions.bun` is `string` under Bun, absent under Node. The
 * `in` operator narrows without needing an explicit cast on `process.versions`.
 */
function detectRuntime(): 'bun' | 'node' {
  return 'bun' in process.versions ? 'bun' : 'node'
}

/**
 * Strict CI detection: only treat the standard `CI=true` / `CI=1` as CI.
 * Many tools set `CI=false` to opt out — we honour that by returning false.
 */
function detectIsCi(): boolean {
  const ci = process.env.CI
  return ci === '1' || ci === 'true'
}

function detectIsTty(): boolean {
  return Boolean(process.stdout.isTTY)
}

function detectTerminalProgram(): string | undefined {
  const term = process.env.TERM_PROGRAM
  return typeof term === 'string' && term.length > 0 ? term : undefined
}

/**
 * Compose the `cli_metadata` block from CLI-process detections. Pure
 * function: no transport calls, no async work, no side effects beyond
 * reading `process.env` / `process.stdout`. Returns a fresh object per call.
 *
 * The helper is called ONCE per `run()` so a single `client_sent_at` value
 * identifies one CLI invocation across multi-request commands (per M13.3).
 *
 * `flag_names` captures ONLY the flag KEY names the user actually typed
 * on the command line. Flags whose value came from oclif's static-default
 * machinery (i.e. `metadata.flags[name].setFromDefault === true`) are
 * excluded — otherwise every invocation would look like the user passed
 * every flag, since oclif fills the entire flag object regardless of argv.
 * Flag VALUES are NEVER captured — they may carry paths, query text, or
 * secrets.
 */
export function buildCliMetadata(commandId: string, parsed: OclifParseResultLike): CliMetadata {
  const flagMeta = parsed.metadata?.flags ?? {}
  const flagNames = Object.keys(parsed.flags).filter((name) => flagMeta[name]?.setFromDefault !== true)
  const terminalProgram = detectTerminalProgram()
  const metadata: CliMetadata = {
    client_sent_at: Date.now(),
    command_id: commandId,
    flag_names: flagNames,
    is_ci: detectIsCi(),
    is_tty: detectIsTty(),
    package_manager: detectPackageManager(),
    runtime: detectRuntime(),
    ...(terminalProgram === undefined ? {} : {terminal_program: terminalProgram}),
  }
  return metadata
}
