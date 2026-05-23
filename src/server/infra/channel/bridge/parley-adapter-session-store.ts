/**
 * Phase 9.5.3 — Persistent session-id sidecar for parley adapters that
 * maintain per-turn state (e.g. `ClaudeCodeHeadlessAdapter`).
 *
 * Stores session IDs in a JSON file keyed by the composite
 * `${projectRoot}\0${channelId}\0${senderPeerId}\0${adapterProfile}`.
 *
 * Hard requirements per plan §2.5 (codex round-2):
 *   - `0600` permissions on creation; re-chmod on every `set()`.
 *   - Atomic writes via temp-file + `renameSync` (same pattern as
 *     `BridgeConfigStore`).
 *   - In-process write mutex: all writes serialised through a single
 *     promise chain so concurrent `set()` calls don't race.
 *   - Composite key derived from the verified `senderPeerId` (not the
 *     display handle).
 *   - Schema-validated on read; invalid file → log + treat as empty.
 *   - `gc()` removes entries whose `channelId` is not in the known-set.
 */

import {chmodSync, existsSync, mkdirSync, readFileSync, renameSync, statSync, writeFileSync} from 'node:fs'
import {dirname} from 'node:path'
import {z} from 'zod'

/** Composite identity key for a per-adapter session. */
export interface ParleyAdapterSessionKey {
  readonly adapterProfile: string
  readonly channelId: string
  readonly projectRoot: string
  readonly senderPeerId: string
}

export interface ParleyAdapterSessionStore {
  /** Removes the session ID for the given key. */
  delete(key: ParleyAdapterSessionKey): Promise<void>

  /**
   * Removes all entries whose `channelId` is not in `knownChannelIds`.
   * Called at daemon startup and on `channel uninvite` to prune stale
   * entries left over after a channel is deleted.
   *
   * @returns Number of entries deleted.
   */
  gc(args: {readonly knownChannelIds: ReadonlySet<string>}): Promise<number>

  /** Returns the stored session ID, or `undefined` if none. */
  get(key: ParleyAdapterSessionKey): string | undefined

  /** Persists a new session ID for the given key. */
  set(key: ParleyAdapterSessionKey, sessionId: string): Promise<void>
}

/** Null-byte joiner prevents ambiguity between key components. */
function serializeKey(key: ParleyAdapterSessionKey): string {
  return `${key.projectRoot}\0${key.channelId}\0${key.senderPeerId}\0${key.adapterProfile}`
}

/** Extract the channelId segment from a serialised composite key. */
function channelIdFromKey(compositeKey: string): string {
  const parts = compositeKey.split('\0')
  // parts[0]=projectRoot, parts[1]=channelId, parts[2]=senderPeerId, parts[3]=adapterProfile
  return parts[1] ?? ''
}

const SessionFileSchema = z.record(z.string(), z.string())
type SessionFile = z.infer<typeof SessionFileSchema>

const FILE_MODE = 0o600

export interface CreateFileBackedSessionStoreArgs {
  readonly filePath: string
  readonly log: (msg: string) => void
}

export function createFileBackedSessionStore(
  args: CreateFileBackedSessionStoreArgs,
): ParleyAdapterSessionStore {
  const {filePath, log} = args

  // In-process write mutex — all mutations are chained here.
  let writeChain: Promise<void> = Promise.resolve()

  // In-memory cache: loaded lazily on first get, kept in sync by writes.
  let cache: SessionFile | undefined

  function loadFromDisk(): SessionFile {
    if (!existsSync(filePath)) return {}
    try {
      const raw = readFileSync(filePath, 'utf8')
      const parsed = SessionFileSchema.safeParse(JSON.parse(raw))
      if (!parsed.success) {
        log(`[ParleyAdapterSessionStore] invalid schema in ${filePath}; treating as empty`)
        return {}
      }

      return parsed.data
    } catch {
      log(`[ParleyAdapterSessionStore] failed to read ${filePath}; treating as empty`)
      return {}
    }
  }

  function ensureCache(): SessionFile {
    if (cache === undefined) {
      cache = loadFromDisk()
    }

    return cache
  }

  function ensurePermissions(): void {
    if (!existsSync(filePath)) return
    try {
      const stat = statSync(filePath)
      // Compare only the permission bits.
      // eslint-disable-next-line no-bitwise
      if ((stat.mode & 0o777) !== FILE_MODE) {
        chmodSync(filePath, FILE_MODE)
      }
    } catch {
      // Best-effort — do not throw on permission check failure.
    }
  }

  function writeToDisk(data: SessionFile): void {
    mkdirSync(dirname(filePath), {recursive: true})
    const tmp = `${filePath}.tmp`
    writeFileSync(tmp, JSON.stringify(data, null, 2), {encoding: 'utf8', mode: FILE_MODE})
    renameSync(tmp, filePath)
    ensurePermissions()
  }

  return {
    delete(key: ParleyAdapterSessionKey): Promise<void> {
      const p = writeChain
        .then(() => {
          const data = ensureCache()
          delete data[serializeKey(key)]
          writeToDisk(data)
        })
        .catch((error) => {
          const msg = error instanceof Error ? error.message : String(error)
          log(`[ParleyAdapterSessionStore] delete error: ${msg}`)
        })
      writeChain = p
      return p
    },

    gc(gcArgs: {readonly knownChannelIds: ReadonlySet<string>}): Promise<number> {
      return new Promise<number>((resolve) => {
        const p: Promise<void> = writeChain
          .then(() => {
            const data = ensureCache()
            let deleted = 0
            for (const compositeKey of Object.keys(data)) {
              const channelId = channelIdFromKey(compositeKey)
              if (!gcArgs.knownChannelIds.has(channelId)) {
                delete data[compositeKey]
                deleted++
              }
            }

            if (deleted > 0) {
              writeToDisk(data)
              log(`[ParleyAdapterSessionStore] gc removed ${deleted} stale entries`)
            }

            resolve(deleted)
          })
          .catch((error) => {
            const msg = error instanceof Error ? error.message : String(error)
            log(`[ParleyAdapterSessionStore] gc error: ${msg}`)
            resolve(0)
          })
        writeChain = p
      })
    },

    get(key: ParleyAdapterSessionKey): string | undefined {
      return ensureCache()[serializeKey(key)]
    },

    set(key: ParleyAdapterSessionKey, sessionId: string): Promise<void> {
      const p = writeChain
        .then(() => {
          const data = ensureCache()
          data[serializeKey(key)] = sessionId
          writeToDisk(data)
        })
        .catch((error) => {
          const msg = error instanceof Error ? error.message : String(error)
          log(`[ParleyAdapterSessionStore] write error: ${msg}`)
        })
      writeChain = p
      return p
    },
  }
}
