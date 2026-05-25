import {existsSync} from 'node:fs'
import {chmod, mkdir, readFile, rename, writeFile} from 'node:fs/promises'
import {dirname} from 'node:path'

import {isValidPeerIdString} from './peer-id.js'
import {withProcessLock} from './process-lock.js'

/**
 * Phase 9 / Slice 9.5 — local alias store.
 *
 * Maps a short human-friendly name (e.g. `alice`) to a libp2p
 * `peer_id`. Backing file: `<storeDir>/aliases.json`, mode 0600
 * (operator-private). Cross-process flock via `process-lock.ts`.
 *
 * The store is intentionally narrow:
 *   - aliases are local-only (NOT shared / published)
 *   - the file holds ONLY `{alias, peerId}` pairs — no metadata,
 *     no timestamps, no display names. Operators can re-derive
 *     those from the TOFU store via `peer_id`
 *   - on-disk form is sorted by alias so the file diffs cleanly
 *     when committed to a personal dotfile repo
 *
 * Invariants:
 *   - alias names are trimmed and non-empty
 *   - alias names match `ALIAS_NAME_PATTERN` (alphanumeric + `_-.`)
 *     so they CANNOT begin with `@` (the orchestrator strips that
 *     sigil before lookup — see kimi round-1 MED) and won't break
 *     CLI tabular rendering with newlines / control characters
 *   - `peer_id` MUST pass `isValidPeerIdString` at write time
 *   - lookups trim whitespace from the input
 */

// kimi round-1 NIT — restrict charset + length so aliases can't
// contain the `@` sigil, whitespace, newlines, or pathological
// unicode that would break downstream rendering.
export const ALIAS_NAME_PATTERN = /^[\w.-]{1,64}$/

const ALIAS_NAME_MAX_LENGTH = 64

const LOCK_SUFFIX = '.lock'

export type AliasEntry = {
  readonly alias: string
  readonly peerId: string
}

export interface AliasStoreDeps {
  readonly storePath: string
}

interface AliasFileShape {
  entries: AliasEntry[]
}

const NOOP = (): void => {}

const inProcessLocks = new Map<string, Promise<void>>()

export class AliasStore {
  private readonly lockPath: string
  private readonly storePath: string

  public constructor(deps: AliasStoreDeps) {
    this.storePath = deps.storePath
    this.lockPath = `${deps.storePath}${LOCK_SUFFIX}`
  }

  /**
   * Reverse lookup — return the alias mapped to a peer_id, or
   * undefined. kimi round-1 LOW — defensively trims input so a
   * copy-pasted peer_id with surrounding whitespace still matches.
   */
  public async findAliasForPeerId(peerId: string): Promise<string | undefined> {
    const trimmed = peerId.trim()
    const entries = await this.list()
    return entries.find((e) => e.peerId === trimmed)?.alias
  }

  /** Resolve an alias to its peer_id, or undefined when unknown. */
  public async get(alias: string): Promise<string | undefined> {
    const trimmed = alias.trim()
    const entries = await this.list()
    return entries.find((e) => e.alias === trimmed)?.peerId
  }

  /** Return every alias entry sorted by alias name. */
  public async list(): Promise<AliasEntry[]> {
    if (!existsSync(this.storePath)) return []
    const raw = await readFile(this.storePath, 'utf8')
    if (raw.trim() === '') return []
    let parsed: unknown
    try {
      parsed = JSON.parse(raw)
    } catch {
      // Corrupt JSON — treat as empty so a broken file doesn't wedge
      // the CLI; the next `set` will rewrite cleanly.
      return []
    }

    if (typeof parsed !== 'object' || parsed === null) return []
    const {entries} = (parsed as {entries?: unknown})
    if (!Array.isArray(entries)) return []
    // kimi round-1 MED — deeper structural validation: skip
    // malformed entries (non-object, missing/empty alias, missing
    // peerId) so a hand-edited or partially-corrupted file doesn't
    // crash list() at runtime. Unknown extra fields are IGNORED so
    // future schema additions are backward-compatible (kimi NIT).
    return entries
      .filter((e): e is AliasEntry => {
        if (typeof e !== 'object' || e === null) return false
        const candidate = e as {alias?: unknown; peerId?: unknown}
        return (
          typeof candidate.alias === 'string' &&
          candidate.alias.length > 0 &&
          typeof candidate.peerId === 'string' &&
          candidate.peerId.length > 0
        )
      })
      .sort((a, b) => a.alias.localeCompare(b.alias))
  }

  /** Remove an alias. Idempotent. */
  public async remove(alias: string): Promise<void> {
    const trimmed = alias.trim()
    if (trimmed === '') return
    return this.runExclusive(async () => {
      const entries = await this.list()
      const next = entries.filter((e) => e.alias !== trimmed)
      if (next.length === entries.length) return
      await this.writeAtomic(next)
    })
  }

  /**
   * Upsert an alias → peer_id mapping. Throws on empty alias or
   * malformed peer_id.
   */
  public async set(alias: string, peerId: string): Promise<void> {
    const trimmed = alias.trim()
    if (trimmed === '') {
      throw new Error('ALIAS_NAME_EMPTY: alias must be non-empty after trimming whitespace')
    }

    // kimi round-1 MED + NIT — reject names that contain the `@`
    // sigil, whitespace, newlines, or unsupported unicode. The
    // orchestrator strips a leading `@` from mentions before alias
    // lookup, so storing `@bob` would silently miss; the charset
    // restriction prevents the entire class of footguns.
    if (trimmed.length > ALIAS_NAME_MAX_LENGTH) {
      throw new Error(`ALIAS_NAME_TOO_LONG: "${trimmed}" exceeds ${ALIAS_NAME_MAX_LENGTH} chars`)
    }

    if (!ALIAS_NAME_PATTERN.test(trimmed)) {
      throw new Error(
        `ALIAS_NAME_INVALID: "${trimmed}" must match ${ALIAS_NAME_PATTERN.source} ` +
          '(alphanumeric, underscore, dot, dash; no `@`, whitespace, or punctuation)',
      )
    }

    if (!isValidPeerIdString(peerId)) {
      throw new Error(`ALIAS_PEER_ID_INVALID: "${peerId}" is not a valid Ed25519 libp2p peer_id`)
    }

    return this.runExclusive(async () => {
      const entries = await this.list()
      const filtered = entries.filter((e) => e.alias !== trimmed)
      filtered.push({alias: trimmed, peerId})
      filtered.sort((a, b) => a.alias.localeCompare(b.alias))
      await this.writeAtomic(filtered)
    })
  }

  private async runExclusive<T>(body: () => Promise<T>): Promise<T> {
    const previous = inProcessLocks.get(this.storePath) ?? Promise.resolve()
    let resolveSelf: () => void = NOOP
    const current = new Promise<void>((r) => {
      resolveSelf = r
    })
    inProcessLocks.set(this.storePath, current)
    try {
      await previous
      await mkdir(dirname(this.storePath), {mode: 0o700, recursive: true})
      return await withProcessLock(this.lockPath, body)
    } finally {
      resolveSelf()
      if (inProcessLocks.get(this.storePath) === current) {
        inProcessLocks.delete(this.storePath)
      }
    }
  }

  private async writeAtomic(entries: AliasEntry[]): Promise<void> {
    const payload: AliasFileShape = {entries}
    const tmp = `${this.storePath}.tmp`
    await writeFile(tmp, `${JSON.stringify(payload, undefined, 2)}\n`, {encoding: 'utf8'})
    await chmod(tmp, 0o600)
    await rename(tmp, this.storePath)
  }
}
