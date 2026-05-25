import {promises as fs} from 'node:fs'
import {dirname, join} from 'node:path'

/**
 * Local-only metadata for driver profiles (Slice 4.2).
 *
 * `AgentDriverProfileSchema` in `src/shared/types/channel.ts` is the wire
 * spec — adding fields requires a `CHANNEL_PROTOCOL.md` amendment. The
 * AUTH_REQUIRED probe-failure state is host-local diagnostic information,
 * not protocol state, so it lives in this sibling file:
 *
 *   `<dataDir>/state/agent-driver-profile-metadata.json`
 *
 * Schema (intentionally narrow — extend only when a new local-only datum
 * is genuinely needed and clearly off the wire):
 *
 *   {
 *     "<profileName>": {
 *       "lastProbeError"?: "AUTH_REQUIRED",
 *       "lastProbeAt"?: "<ISO 8601>"
 *     }
 *   }
 *
 * Concurrency: atomic-rename writes, mode 0600. Last writer wins on
 * concurrent updates — acceptable for diagnostic-only state.
 */

export type ProfileLastProbeError = 'AUTH_REQUIRED'

// Phase 10 Tier B3 (V6 run-3 §4a) — per-profile drift telemetry. When a
// review identifies an agent reproducing the same spec deviation in the
// same `<file>:<line>` location across runs, recording it here lets a
// future `channel profile show <name>` surface "known drift" upfront so
// the orchestrator can tighten the contract before re-dispatching. V6
// run-3 specifically caught @pi reproducing the `-100` vs spec `-50`
// cull deviation at `systems.js:159` across run-2 + run-3.
export type DriftObservation = {
  readonly description: string
  readonly file: string
  readonly line?: number
  readonly observedAt: string
}

// Phase 10 Tier C #4 (V6 run-4 §4b) — per-profile wall-clock variance
// telemetry. V6 surfaced pi running ~60s → ~90s → ~12min on the same
// prompt template across four runs. A short ring buffer of recent
// completed-turn durations lets `channel profile show` surface that
// spread so the orchestrator can choose a faster member or set a
// tighter timeout next time.
export type TurnDurationEntry = {
  readonly completedAt: string
  readonly durationMs: number
  readonly endedState: 'cancelled' | 'completed' | 'errored'
}

// Buffer ceiling — 10 entries gives a stable median + visible
// max/min without bloating the metadata file. Tunable here only;
// not part of the wire contract.
export const RECENT_TURN_DURATIONS_LIMIT = 10

export type ProfileMetadataRecord = {
  readonly driftObservations?: ReadonlyArray<DriftObservation>
  readonly lastProbeAt?: string
  readonly lastProbeError?: ProfileLastProbeError
  readonly recentTurnDurations?: ReadonlyArray<TurnDurationEntry>
}

export type SetLastProbeErrorArgs = {
  readonly at: string
  readonly error: ProfileLastProbeError
  readonly name: string
}

export type AddDriftObservationArgs = {
  readonly description: string
  readonly file: string
  readonly line?: number
  readonly name: string
  readonly observedAt: string
}

export type RecordTurnDurationArgs = {
  readonly completedAt: string
  readonly durationMs: number
  readonly endedState: 'cancelled' | 'completed' | 'errored'
  readonly name: string
}

export interface IProfileMetadataStore {
  addDriftObservation(args: AddDriftObservationArgs): Promise<void>
  clearDriftObservations(name: string): Promise<void>
  clearLastProbeError(name: string): Promise<void>
  get(name: string): Promise<ProfileMetadataRecord | undefined>
  recordTurnDuration(args: RecordTurnDurationArgs): Promise<void>
  setLastProbeError(args: SetLastProbeErrorArgs): Promise<void>
}

export type FileProfileMetadataStoreOptions = {
  readonly dataDir: string
}

const METADATA_SUBPATH = ['state', 'agent-driver-profile-metadata.json'] as const

type RegistryDoc = Record<string, ProfileMetadataRecord>

const isRegistryDoc = (value: unknown): value is RegistryDoc =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

export class FileProfileMetadataStore implements IProfileMetadataStore {
  private readonly dataDir: string

  public constructor(options: FileProfileMetadataStoreOptions) {
    this.dataDir = options.dataDir
  }

  async addDriftObservation(args: AddDriftObservationArgs): Promise<void> {
    const doc = await this.readDoc()
    const existing: ProfileMetadataRecord = doc[args.name] ?? {}
    const prior = existing.driftObservations ?? []
    const next: DriftObservation = {
      description: args.description,
      file: args.file,
      observedAt: args.observedAt,
      ...(args.line === undefined ? {} : {line: args.line}),
    }
    doc[args.name] = {...existing, driftObservations: [...prior, next]}
    await this.writeAtomic(doc)
  }

  async clearDriftObservations(name: string): Promise<void> {
    const doc = await this.readDoc()
    const existing = doc[name]
    if (existing === undefined || existing.driftObservations === undefined) return
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    const {driftObservations, ...rest} = existing
    if (Object.keys(rest).length === 0) {
      delete doc[name]
    } else {
      doc[name] = rest
    }

    await this.writeAtomic(doc)
  }

  async clearLastProbeError(name: string): Promise<void> {
    const doc = await this.readDoc()
    const existing = doc[name]
    if (existing === undefined) return
    // B3: preserve driftObservations + other future fields; clear ONLY
    // the probe-error fields.
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    const {lastProbeAt, lastProbeError, ...rest} = existing
    if (Object.keys(rest).length === 0) {
      delete doc[name]
    } else {
      doc[name] = rest
    }

    await this.writeAtomic(doc)
  }

  async get(name: string): Promise<ProfileMetadataRecord | undefined> {
    const doc = await this.readDoc()
    return doc[name]
  }

  async recordTurnDuration(args: RecordTurnDurationArgs): Promise<void> {
    const doc = await this.readDoc()
    const existing: ProfileMetadataRecord = doc[args.name] ?? {}
    const prior = existing.recentTurnDurations ?? []
    const entry: TurnDurationEntry = {
      completedAt: args.completedAt,
      durationMs: args.durationMs,
      endedState: args.endedState,
    }
    const appended = [...prior, entry]
    // Truncate to the most recent RECENT_TURN_DURATIONS_LIMIT entries
    // so the metadata file stays small on busy profiles.
    const next = appended.length > RECENT_TURN_DURATIONS_LIMIT
      ? appended.slice(appended.length - RECENT_TURN_DURATIONS_LIMIT)
      : appended
    doc[args.name] = {...existing, recentTurnDurations: next}
    await this.writeAtomic(doc)
  }

  async setLastProbeError(args: SetLastProbeErrorArgs): Promise<void> {
    const doc = await this.readDoc()
    // B3: preserve driftObservations (and any future sibling fields)
    // when overwriting the probe state.
    const existing: ProfileMetadataRecord = doc[args.name] ?? {}
    doc[args.name] = {...existing, lastProbeAt: args.at, lastProbeError: args.error}
    await this.writeAtomic(doc)
  }

  private filePath(): string {
    return join(this.dataDir, ...METADATA_SUBPATH)
  }

  private async readDoc(): Promise<RegistryDoc> {
    try {
      const raw = await fs.readFile(this.filePath(), 'utf8')
      const parsed: unknown = JSON.parse(raw)
      if (!isRegistryDoc(parsed)) return {}
      return parsed
    } catch (error) {
      const {code} = error as NodeJS.ErrnoException
      if (code === 'ENOENT') return {}
      // Corrupt JSON → recover by treating as empty. Subsequent writes
      // overwrite the corruption.
      return {}
    }
  }

  private async writeAtomic(doc: RegistryDoc): Promise<void> {
    const target = this.filePath()
    await fs.mkdir(dirname(target), {recursive: true})
    const tmp = `${target}.tmp.${process.pid}.${Date.now()}`
    await fs.writeFile(tmp, JSON.stringify(doc, undefined, 2), {encoding: 'utf8', mode: 0o600})
    await fs.rename(tmp, target)
    try {
      await fs.chmod(target, 0o600)
    } catch {
      // Best-effort on filesystems that don't support chmod.
    }
  }
}
