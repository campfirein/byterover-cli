/**
 * Per-key text formatter registry for `readonly-info` settings descriptors.
 *
 * Both the oclif CLI (`brv settings list` / `get`) and the TUI settings
 * page read live operational snapshots through this registry. The default
 * formatter renders `undefined` as `(unavailable)`, strings as-is, and
 * everything else via `JSON.stringify`. Consumers (e.g. t3's
 * `analytics.status` module) call `registerReadonlyInfoFormatter` at
 * module load time to install a human-friendly view for their key.
 *
 * The registry lives in `shared/` so neither surface crosses the
 * `tui/` <-> `oclif/` boundary; both import the same singleton.
 *
 * Type asymmetry note: `ReadonlyInfoSnapshot` (in
 * `server/infra/transport/handlers/settings-handler.ts`) tightly
 * constrains what an info PROVIDER may return. `ReadonlyInfoFormatter`
 * deliberately accepts `unknown` so a formatter can stay robust against
 * unexpected wire shapes (e.g. legacy clients, hand-edited fixtures).
 * The default formatter even handles `string`, which the snapshot type
 * does not allow — both layers are correct: the snapshot guards the
 * write boundary, the formatter guards the read boundary.
 */

export type ReadonlyInfoFormatter = (value: unknown) => string

const FORMATTERS = new Map<string, ReadonlyInfoFormatter>()

/**
 * Installs a per-key formatter. Idempotent on the same function reference.
 * Throws when a DIFFERENT function is registered for an already-registered
 * key, to surface accidental overrides that would otherwise silently
 * mask the canonical formatter.
 */
export function registerReadonlyInfoFormatter(key: string, fn: ReadonlyInfoFormatter): void {
  const existing = FORMATTERS.get(key)
  if (existing !== undefined && existing !== fn) {
    throw new Error(
      `Readonly-info formatter for '${key}' is already registered. Call unregisterReadonlyInfoFormatter first, or reuse the same function reference.`,
    )
  }

  FORMATTERS.set(key, fn)
}

export function unregisterReadonlyInfoFormatter(key: string): void {
  FORMATTERS.delete(key)
}

export function formatReadonlyInfoValue(key: string, value: unknown): string {
  const fn = FORMATTERS.get(key)
  if (fn) return fn(value)
  return defaultFormat(value)
}

function defaultFormat(value: unknown): string {
  if (value === undefined) return '(unavailable)'
  if (typeof value === 'string') return value
  return JSON.stringify(value)
}
