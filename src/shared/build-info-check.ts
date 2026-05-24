
import {readFileSync} from 'node:fs'

/**
 * Phase 9.5.9 §2.1 — build-info shared utilities.
 *
 * Pure module: no transport types, no oclif imports, no server imports.
 * Keeps shared/ clean per codex round-2 layering rules.
 *
 * `dist/build-info.json` is written by `scripts/generate-build-info.ts`
 * at build time (AFTER `shx rm -rf dist`). Both daemon and CLI read it
 * at process start to detect stale-daemon mismatch.
 */

export interface BuildInfo {
  readonly buildAtIso: string
  readonly buildId: string
  readonly gitDirty?: boolean
  readonly gitSha?: string
  readonly packageVersion: string
}

export type CompareResult =
  | {cliBuildId: string; daemonBuildId: string; match: false}
  | {match: true}

/**
 * Type guard: returns true iff `value` looks like a valid BuildInfo.
 */
export function isBuildInfo(value: unknown): value is BuildInfo {
  if (value === null || typeof value !== 'object') return false
  const v = value as Record<string, unknown>
  return typeof v.buildId === 'string' && v.buildId.length > 0 &&
    typeof v.buildAtIso === 'string' &&
    typeof v.packageVersion === 'string'
}

/**
 * Synchronously read and parse `dist/build-info.json`.
 * Returns `undefined` on any error (file missing, bad JSON, bad shape).
 * Intentionally non-throwing: a missing build-info.json must degrade
 * gracefully rather than crash the CLI/daemon startup.
 */
export function readBuildInfoSync(filePath: string): BuildInfo | undefined {
  try {
    const raw = readFileSync(filePath, 'utf8')
    const parsed = JSON.parse(raw) as unknown
    return isBuildInfo(parsed) ? parsed : undefined
  } catch {
    return undefined
  }
}

/**
 * Compare two buildId strings (daemon vs CLI). Exact-string comparison.
 * Returns a discriminated union so callers can pattern-match cleanly.
 */
export function compareBuildIds(daemonBuildId: string, cliBuildId: string): CompareResult {
  if (daemonBuildId === cliBuildId) return {match: true}
  return {cliBuildId, daemonBuildId, match: false}
}

/**
 * Format the human-readable staleness warning printed to stderr exactly
 * once per CLI process. The message is opinionated but stays factual:
 * it never claims the daemon "has bugs" — only that the in-memory module
 * cache differs from the on-disk dist.
 */
export function formatMismatchWarning(args: {cliBuildId: string; daemonBuildId: string}): string {
  return [
    '',
    '⚠  Daemon is running an older build than your CLI.',
    `   Daemon buildId: ${args.daemonBuildId}`,
    `   CLI buildId:    ${args.cliBuildId}`,
    '',
    "   Node's require() cache holds the daemon's in-memory modules; rebuilt",
    '   dist files do NOT take effect until the daemon restarts. Run:',
    '',
    '       brv restart',
    '',
    '   to pick up the latest code. Until then, daemon behavior may not match',
    '   the code you can read in src/ or dist/.',
    '',
  ].join('\n')
}

/**
 * Phase 9.5.9 Issue 5 — the shape returned by the daemon's
 * `system:build-info` transport event. Only `buildId` is required for
 * the comparison; the rest are informational.
 */
export interface BuildInfoResponse {
  readonly buildAtIso?: string
  readonly buildId: string
  readonly gitDirty?: boolean
  readonly gitSha?: string
  readonly packageVersion?: string
}

/**
 * Phase 9.5.9 Issue 5 — compare the daemon's build-info (obtained via
 * `system:build-info` transport call) against the CLI's own
 * `dist/build-info.json`.
 *
 * Prints a staleness warning via `printWarning` when buildIds differ.
 * Degrades gracefully when either side is missing (no throw, no warning).
 *
 * This is the centralized check called from every first-connection entry
 * point (daemon-client, channel-client, MCP boot, webui boot, REPL).
 */
export async function assertBuildVersionMatch(args: {
  readonly buildInfoPath: string
  readonly daemonBuildInfo: BuildInfoResponse | undefined
  readonly printWarning: (msg: string) => void
}): Promise<void> {
  // Degrade gracefully when daemon doesn't return a buildId.
  if (args.daemonBuildInfo?.buildId === undefined) return

  const cliBuildInfo = readBuildInfoSync(args.buildInfoPath)
  // Degrade gracefully when CLI's build-info.json is absent.
  if (cliBuildInfo === undefined) return

  const result = compareBuildIds(args.daemonBuildInfo.buildId, cliBuildInfo.buildId)
  if (!result.match) {
    args.printWarning(
      formatMismatchWarning({cliBuildId: result.cliBuildId, daemonBuildId: result.daemonBuildId}),
    )
  }
}
