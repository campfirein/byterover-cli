import {confirm} from '@inquirer/prompts'

import {loadAnalyticsDisclosureText} from '../../shared/utils/load-analytics-disclosure.js'

/**
 * Disclosure markdown lives in `src/shared/assets/analytics-disclosure.md`
 * so the same canonical text is consumed by oclif (CLI consent prompt),
 * TUI (settings-page inline confirm), and any future WebUI render.
 */
export async function loadDisclosure(): Promise<string> {
  return loadAnalyticsDisclosureText()
}

export async function confirmDisclosure(): Promise<boolean> {
  return confirm({default: false, message: 'Enable analytics with the terms above?'})
}

export function isInteractive(): boolean {
  return process.stdin.isTTY === true && process.stdout.isTTY === true
}

export interface CollectConsentDeps {
  /**
   * Optional override for `loadDisclosure`. Subclass tests in
   * `brv analytics enable` stub this to inject a fixture string.
   * Defaults to the lib's `loadDisclosure` (reads from disk).
   */
  readonly loadFn?: () => Promise<string>
  /**
   * Called when consent cannot be collected (non-TTY without `--yes`).
   * Implementations are expected to throw — oclif's `this.error()`
   * surfaces a non-zero exit code via `CLIError`. Typed `never` so
   * callers cannot forget to terminate.
   */
  readonly onError: (message: string) => never
  /** Receives the disclosure markdown text. Typically `this.log` from a Command. */
  readonly onLog: (message: string) => void
  /**
   * The prompt function. Defaults to `confirmDisclosure` (inquirer).
   * Tests inject a stub to avoid mounting an interactive TTY.
   */
  readonly promptFn?: () => Promise<boolean>
  /**
   * TTY check. Defaults to `isInteractive`. Tests inject a stub to
   * exercise both the TTY and non-TTY branches.
   */
  readonly ttyCheck?: () => boolean
  /** When true, skip the prompt and accept silently. CI / non-interactive use. */
  readonly yesFlag: boolean
}

/**
 * M1.4 disclosure consent flow.
 *
 * 1. Load and print the disclosure markdown (via `loadFn` if provided,
 *    else the default `loadDisclosure`).
 * 2. If `--yes` is set, accept silently.
 * 3. If the session is non-interactive (no TTY), call `onError` (which
 *    throws — non-zero exit). Re-running in a terminal or passing `--yes`
 *    is the documented escape.
 * 4. Otherwise, prompt and return the user's choice.
 *
 * Extracted from the legacy `brv analytics enable` command in M16.2 so
 * `brv settings set analytics.enabled true` can reuse the exact same
 * consent gate. The legacy command is preserved until M16.4 deletes it.
 */
export async function collectConsent(deps: CollectConsentDeps): Promise<boolean> {
  const load = deps.loadFn ?? loadDisclosure
  const disclosure = await load()
  deps.onLog(disclosure)

  if (deps.yesFlag) return true

  const tty = deps.ttyCheck ?? isInteractive
  if (!tty()) {
    deps.onError(
      'Cannot enable analytics in non-interactive mode without confirmation.\n' +
        'Re-run in a terminal, or pass --yes to accept the disclosure non-interactively.',
    )
  }

  const prompt = deps.promptFn ?? confirmDisclosure
  return prompt()
}
