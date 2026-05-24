/**
 * Helper for rejecting flags that have been removed from a CLI command,
 * with a clear migration message instead of oclif's default `Nonexistent
 * flag` error.
 *
 * Usage in a command's `run()`:
 *
 *   const removedMsg = findRemovedFlagMessage(process.argv.slice(2), CURATE_REMOVED_FLAGS)
 *   if (removedMsg) {
 *     // Emit JSON envelope when the caller asked for --format json,
 *     // otherwise fall through to this.error(removedMsg).
 *   }
 *
 * The scan runs before `this.parse()` so the user sees the migration
 * text regardless of strict / permissive parse mode. `--` is honored as
 * a hard terminator (anything after is treated as positional content,
 * not flags). Unquoted-positional collisions on permissive-parse
 * commands (e.g. `brv query what does --timeout do`) are an accepted
 * limitation — quote the query or pass `--` to disambiguate.
 */

export type RemovedFlag = {
  /** Flag tokens to detect (long form first, then any short aliases). */
  flags: string[]
  /** One-sentence guidance the user should follow instead. */
  migration: string
}

const formatRejection = (token: string, migration: string): string =>
  `Flag '${token}' was removed in tool-mode. ${migration}`

/**
 * Scan an argv slice for any removed flag. Returns the migration
 * message on the first hit, or `undefined` when none of the removed
 * flags appear. Recognises `--flag value`, `--flag=value`, and short
 * aliases. Stops scanning at the standard `--` terminator.
 */
export function findRemovedFlagMessage(argv: string[], removed: RemovedFlag[]): string | undefined {
  for (const token of argv) {
    if (token === '--') return undefined
    for (const {flags, migration} of removed) {
      const matched = flags.find((f) => token === f || token.startsWith(`${f}=`))
      if (matched) return formatRejection(matched, migration)
    }
  }

  return undefined
}

/**
 * Inspect argv for the `--format json` selector so the caller can
 * choose between emitting a JSON error envelope and surfacing a plain
 * `this.error(...)` message. Mirrors the recognised forms
 * (`--format json` and `--format=json`).
 */
export function argvRequestsJsonFormat(argv: string[]): boolean {
  for (let i = 0; i < argv.length; i++) {
    const token = argv[i]
    if (token === '--') return false
    if (token === '--format' && argv[i + 1] === 'json') return true
    if (token === '--format=json') return true
  }

  return false
}

/**
 * Flags removed from `brv curate` as of the tool-mode cleanup
 * (see Linear ENG-2880). All four were no-ops in tool-mode — kept as
 * dead declarations until the cleanup; surfaced here so any agent or
 * script still passing them gets a clear migration message.
 */
export const CURATE_REMOVED_FLAGS: RemovedFlag[] = [
  {
    flags: ['--folder', '-d'],
    migration:
      'Pack the folder content into the <bv-topic> HTML directly before calling brv curate.',
  },
  {
    flags: ['--files', '-f'],
    migration:
      'Read the files and inline the relevant content into the <bv-topic> HTML directly.',
  },
  {
    flags: ['--detach'],
    migration:
      'Tool-mode curate runs as two cheap RPCs (kickoff + continuation); --detach is unnecessary.',
  },
  {
    flags: ['--timeout'],
    migration:
      'Tool-mode curate has no long-running daemon LLM call; --timeout is unnecessary.',
  },
]

/**
 * Flags removed from `brv query` as of the tool-mode cleanup
 * (see Linear ENG-2880).
 */
export const QUERY_REMOVED_FLAGS: RemovedFlag[] = [
  {
    flags: ['--timeout'],
    migration:
      'Tool-mode query is a deterministic local BM25 lookup; --timeout is unnecessary.',
  },
]

/**
 * Flags removed from `brv dream` (see Linear ENG-2884). `--timeout`
 * had been kept as a no-op with a deprecation warning since M6; this
 * finalises the removal and lets us delete the dead
 * `timeout-deprecation.ts` helper.
 */
export const DREAM_REMOVED_FLAGS: RemovedFlag[] = [
  {
    flags: ['--timeout'],
    migration:
      'Dream completion is heartbeat-driven; --timeout had no effect and is removed.',
  },
]
