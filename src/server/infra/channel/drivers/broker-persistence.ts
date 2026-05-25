import {promises as fs} from 'node:fs'
import {dirname, join} from 'node:path'

/**
 * Phase-3 broker persistence (Slice 3.5c).
 *
 * Append-only JSONL log of permission lifecycle events:
 *   {"type":"track", ...}     when PermissionBroker.track is called
 *   {"type":"resolve", ...}   when PermissionBroker.resolve / drain runs
 *
 * On daemon bootstrap, broker-recovery reads the file, computes live
 * entries (track without matching resolve), and surfaces them as
 * `delivery_state_change → errored` events. After replay the file is
 * truncated (atomic rename of an empty file in its place).
 *
 * File location: `<dataDir>/state/pending-permissions.jsonl` (mode 0600).
 */

export type TrackRecord = {
  channelId: string
  deliveryId: string
  memberHandle: string
  permissionRequestId: string
  projectRoot: string
  turnId: string
  type: 'track'
}

export type ResolveRecord = {
  permissionRequestId: string
  type: 'resolve'
}

export type BrokerPersistedRecord = ResolveRecord | TrackRecord

export type FileBrokerPersistenceOptions = {
  readonly dataDir: string
}

export interface IBrokerPersistence {
  appendResolve(args: {permissionRequestId: string}): Promise<void>
  appendTrack(record: Omit<TrackRecord, 'type'>): Promise<void>
  /** Read the file and return every line that parses (tolerates trailing partial writes). */
  readAll(): Promise<BrokerPersistedRecord[]>
  /** Truncate the file (atomic rename of empty content). */
  truncate(): Promise<void>
}

const PERSISTENCE_PATH = ['state', 'pending-permissions.jsonl'] as const

export class FileBrokerPersistence implements IBrokerPersistence {
  /**
   * Review fix #7: serialize appends against the JSONL log. Node's
   * `fs.appendFile` does not guarantee atomic line-level interleaving
   * between concurrent calls (POSIX PIPE_BUF helps for small records on
   * local filesystems, but the contract isn't ours to rely on). A
   * simple promise-chain Mutex ensures every track/resolve append
   * completes before the next one starts.
   */
  private appendChain: Promise<void> = Promise.resolve()
  private readonly dataDir: string

  public constructor(options: FileBrokerPersistenceOptions) {
    this.dataDir = options.dataDir
  }

  async appendResolve(args: {permissionRequestId: string}): Promise<void> {
    await this.appendLine({permissionRequestId: args.permissionRequestId, type: 'resolve'})
  }

  async appendTrack(record: Omit<TrackRecord, 'type'>): Promise<void> {
    await this.appendLine({type: 'track', ...record})
  }

  async readAll(): Promise<BrokerPersistedRecord[]> {
    let raw: string
    try {
      raw = await fs.readFile(this.path(), 'utf8')
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []
      throw error
    }

    const out: BrokerPersistedRecord[] = []
    for (const line of raw.split('\n')) {
      if (line.trim() === '') continue
      try {
        const parsed = JSON.parse(line) as BrokerPersistedRecord
        if (parsed.type === 'track' || parsed.type === 'resolve') {
          out.push(parsed)
        }
      } catch {
        // Tolerate a corrupt trailing line (crash mid-write).
      }
    }

    return out
  }

  async truncate(): Promise<void> {
    const target = this.path()
    await fs.mkdir(dirname(target), {recursive: true})
    const tmp = `${target}.tmp.${process.pid}.${Date.now()}.${Math.random().toString(36).slice(2)}`
    await fs.writeFile(tmp, '', {encoding: 'utf8', mode: 0o600})
    await fs.rename(tmp, target)
    try {
      await fs.chmod(target, 0o600)
    } catch {
      // best-effort across platforms
    }
  }

  private appendLine(record: BrokerPersistedRecord): Promise<void> {
    // Review fix #7: chain on the previous append so concurrent callers
    // serialize. We capture `previous` BEFORE replacing the chain so each
    // caller awaits the prior in-flight write but doesn't accidentally
    // await its own.
    const previous = this.appendChain
    const next = previous.then(() => this.writeAppendLine(record))
    // Swallow rejections from the chain itself — each caller still sees
    // its own throw via the returned `next` promise.
    this.appendChain = next.catch(() => {})
    return next
  }

  private path(): string {
    return join(this.dataDir, ...PERSISTENCE_PATH)
  }

  private async writeAppendLine(record: BrokerPersistedRecord): Promise<void> {
    const target = this.path()
    await fs.mkdir(dirname(target), {recursive: true})
    // The file is open for append; if it doesn't exist, Node creates it
    // with the supplied mode. JSON.stringify guarantees a single line.
    await fs.appendFile(target, `${JSON.stringify(record)}\n`, {encoding: 'utf8', mode: 0o600})
  }
}

/**
 * Pure: fold tracks + resolves into the set of live permissions on disk.
 * `track` records whose matching `resolve` line appears later in the log
 * are filtered out; orphan tracks remain. Order matters per file order.
 */
export const computeLivePending = (records: readonly BrokerPersistedRecord[]): TrackRecord[] => {
  const resolved = new Set<string>()
  for (const r of records) {
    if (r.type === 'resolve') resolved.add(r.permissionRequestId)
  }

  const out: TrackRecord[] = []
  const seenTracks = new Set<string>()
  for (const r of records) {
    if (r.type !== 'track') continue
    if (resolved.has(r.permissionRequestId)) continue
    // Last-track-wins for the same permissionRequestId (shouldn't happen in
    // practice; defensive against malformed logs).
    if (seenTracks.has(r.permissionRequestId)) {
      const idx = out.findIndex((t) => t.permissionRequestId === r.permissionRequestId)
      if (idx !== -1) out.splice(idx, 1)
    }

    seenTracks.add(r.permissionRequestId)
    out.push(r)
  }

  return out
}
