
/**
 * Phase 9.5.9 §2.2 — postbuild daemon-staleness check.
 *
 * Reads <dataDir>/daemon.json. If a daemon is alive and predates this build,
 * prints a warning to stderr.
 *
 * Wired as "postbuild" in package.json. Does NOT block the build (exit 0
 * unless BRV_BUILD_STRICT=1 is set, in which case exits 1 on stale daemon).
 *
 * All I/O-dependent concerns (pid liveness, daemon.json path, clock) are
 * injectable so unit tests run without touching real files or processes.
 */

import {readFileSync} from 'node:fs'
import {homedir, platform as osPlatform} from 'node:os'
import {join} from 'node:path'

// ─── Pure library (exported for tests) ──────────────────────────────────────

export type StalenessCheckResult =
  | {pid: number; stale: true; startedAt: string}
  | {stale: false}

export interface CheckDaemonStalenessArgs {
  /** Build completion time in Unix ms. */
  readonly buildAtMs: number
  /** Path to daemon.json (injectable for tests). */
  readonly daemonJsonPath: string
  /** Pid-liveness probe (injectable for tests). */
  readonly isProcessAlive: (pid: number) => boolean
  /** Current time in Unix ms. */
  readonly nowMs: number
}

export function checkDaemonStaleness(args: CheckDaemonStalenessArgs): StalenessCheckResult {
  let raw: string
  try {
    raw = readFileSync(args.daemonJsonPath, 'utf8')
  } catch {
    return {stale: false}
  }

  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    return {stale: false}
  }

  if (parsed === null || typeof parsed !== 'object') return {stale: false}
  const obj = parsed as Record<string, unknown>

  if (typeof obj.pid !== 'number') return {stale: false}
  if (typeof obj.startedAt !== 'string') return {stale: false}

  const {pid, startedAt} = obj as {pid: number; startedAt: string}
  const startedAtMs = Date.parse(startedAt)

  if (Number.isNaN(startedAtMs)) return {stale: false}
  if (!args.isProcessAlive(pid)) return {stale: false}
  // Daemon started BEFORE the build → stale
  if (startedAtMs < args.buildAtMs) return {pid, stale: true, startedAt}

  return {stale: false}
}

// ─── CLI entry point (executed by postbuild) ─────────────────────────────────

function getGlobalDataDir(): string {
  if (process.env.BRV_DATA_DIR) return process.env.BRV_DATA_DIR
  const plat = osPlatform()
  if (plat === 'win32') {
    return join(process.env.LOCALAPPDATA ?? join(homedir(), 'AppData', 'Local'), 'brv')
  }

  if (plat === 'darwin') {
    return join(homedir(), 'Library', 'Application Support', 'brv')
  }

  // Linux: respect XDG_DATA_HOME
  const xdg = process.env.XDG_DATA_HOME
  return join(xdg ?? join(homedir(), '.local', 'share'), 'brv')
}

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

// CLI entry point — runs when invoked via `tsx scripts/check-daemon-staleness.ts`
// or `node scripts/check-daemon-staleness.js`.
// Guard: skip when imported by test runner (argv[0] ends with mocha/tsx loader).
const isDirectInvocation =
  process.argv[1] !== undefined &&
  (process.argv[1].endsWith('check-daemon-staleness.ts') ||
    process.argv[1].endsWith('check-daemon-staleness.js'))

if (isDirectInvocation) {
  const daemonJsonPath = join(getGlobalDataDir(), 'daemon.json')
  const buildAtMs = Date.now() // postbuild runs immediately after tsc; "now" ≈ build time
  const result = checkDaemonStaleness({
    buildAtMs,
    daemonJsonPath,
    isProcessAlive: isAlive,
    nowMs: Date.now(),
  })

  if (result.stale) {
    const msg = [
      '',
      `ℹ  Build complete. NOTE: daemon (PID ${result.pid}) started before this build at ${result.startedAt}.`,
      "   Daemon is still running OLD code in memory. Run 'brv restart' to apply changes.",
      '',
    ].join('\n')
    process.stderr.write(msg)

    if (process.env.BRV_BUILD_STRICT === '1') {
      // eslint-disable-next-line n/no-process-exit, unicorn/no-process-exit
      process.exit(1)
    }
  }
}
