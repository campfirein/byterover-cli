/**
 * Soft-drop helpers for the legacy `--timeout` flag on `brv curate`,
 * `brv query`, and `brv dream`. The flag is kept accepted so existing
 * scripts and CI jobs continue to run; passing it prints a one-line
 * deprecation warning and no longer influences the wait-for-task
 * wall-clock (M6 T3 removes the timer entirely).
 */

/**
 * Help text that replaces the old per-flag description so `--help`
 * surfaces the deprecation without breaking flag parsing.
 */
export const TIMEOUT_DEPRECATION_HELP = '(deprecated, no effect, kept for compatibility)'

/**
 * One-line stderr-friendly notice printed once per invocation when the
 * user explicitly passed `--timeout`. Wording deliberately omits any
 * specific setting key so M6 ships independently of M1/M2/M3 and
 * survives setting renames (per M6 T2 AC).
 */
export const TIMEOUT_DEPRECATION_MESSAGE =
  '--timeout is deprecated and has no effect.'

/**
 * Calls `log(TIMEOUT_DEPRECATION_MESSAGE)` exactly once iff the user
 * supplied a non-default value for `--timeout`. The flag's oclif
 * `default:` populates `userValue` even when omitted, so the cheapest
 * way to distinguish "user-passed" from "default-filled" is value
 * comparison against the registered default.
 */
export function warnIfTimeoutFlagUsed(options: {
  readonly defaultValue: number
  readonly log: (message: string) => void
  readonly userValue: number | undefined
}): void {
  if (options.userValue === undefined) return
  if (options.userValue === options.defaultValue) return
  options.log(TIMEOUT_DEPRECATION_MESSAGE)
}
