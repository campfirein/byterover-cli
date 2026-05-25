import {promises as fs} from 'node:fs'
import {dirname, join} from 'node:path'

import type {AgentDriverProfile} from '../../../shared/types/channel.js'
import type {IDriverProfileStore} from '../../core/interfaces/channel/i-driver-profile-store.js'

import {AgentDriverProfileSchema} from '../../../shared/types/channel.js'

/**
 * File-backed {@link IDriverProfileStore}. Persists every profile in a single
 * JSON document under `<dataDir>/state/agent-driver-profiles.json`.
 *
 * Concurrency model: every mutation is a read-modify-atomic-rename-write
 * cycle. Concurrent writers MAY race; the last `fs.rename` wins. Profile
 * upserts are idempotent enough that this is acceptable for Phase 3 — a
 * future hardening pass could add an in-process write lock if necessary.
 *
 * Permissions: mode 0600 on the registry file. Atomic rename inherits mode
 * from the tmp file, so we chmod after each rename to be defensive across
 * filesystems where the rename target preserves the prior file's mode.
 */
export type FileDriverProfileStoreOptions = {
  /** `BRV_DATA_DIR` root — the registry lives at `<dataDir>/state/agent-driver-profiles.json`. */
  readonly dataDir: string
}

const REGISTRY_SUBPATH = ['state', 'agent-driver-profiles.json'] as const

type RegistryDoc = {
  profiles: AgentDriverProfile[]
}

const isRegistryDoc = (value: unknown): value is RegistryDoc =>
  typeof value === 'object' && value !== null && Array.isArray((value as {profiles?: unknown}).profiles)

export class FileDriverProfileStore implements IDriverProfileStore {
  private readonly dataDir: string

  public constructor(options: FileDriverProfileStoreOptions) {
    this.dataDir = options.dataDir
  }

  async get(name: string): Promise<AgentDriverProfile | undefined> {
    const profiles = await this.readDoc()
    return profiles.find((p) => p.name === name)
  }

  async list(): Promise<AgentDriverProfile[]> {
    const profiles = await this.readDoc()
    return [...profiles].sort((a, b) => a.name.localeCompare(b.name))
  }

  async remove(name: string): Promise<boolean> {
    const profiles = await this.readDoc()
    const next = profiles.filter((p) => p.name !== name)
    if (next.length === profiles.length) return false
    await this.writeAtomic(next)
    return true
  }

  async upsert(profile: AgentDriverProfile): Promise<void> {
    // Re-validate via the canonical zod schema so the persisted shape is
    // always v0.1+ conformant regardless of caller laxness.
    const valid = AgentDriverProfileSchema.parse(profile)
    const profiles = await this.readDoc()
    const next = profiles.filter((p) => p.name !== valid.name)
    next.push(valid)
    await this.writeAtomic(next)
  }

  private filePath(): string {
    return join(this.dataDir, ...REGISTRY_SUBPATH)
  }

  private async readDoc(): Promise<AgentDriverProfile[]> {
    try {
      const raw = await fs.readFile(this.filePath(), 'utf8')
      const parsed: unknown = JSON.parse(raw)
      if (!isRegistryDoc(parsed)) return []
      const out: AgentDriverProfile[] = []
      for (const entry of parsed.profiles) {
        const result = AgentDriverProfileSchema.safeParse(entry)
        if (result.success) out.push(result.data)
      }

      return out
    } catch (error) {
      const {code} = (error as NodeJS.ErrnoException)
      if (code === 'ENOENT') return []
      // Corrupt JSON or unreadable file → treat as empty. The next upsert
      // overwrites the corruption with a valid document. We deliberately
      // don't throw because the doctor surface needs to keep working even
      // if a previous write was interrupted.
      return []
    }
  }

  private async writeAtomic(profiles: AgentDriverProfile[]): Promise<void> {
    const target = this.filePath()
    await fs.mkdir(dirname(target), {recursive: true})
    const tmp = `${target}.tmp.${process.pid}.${Date.now()}`
    const doc: RegistryDoc = {profiles}
    await fs.writeFile(tmp, JSON.stringify(doc, undefined, 2), {encoding: 'utf8', mode: 0o600})
    await fs.rename(tmp, target)
    // Defensive chmod: rename may inherit the destination's previous mode
    // bits on some filesystems. Force 0600.
    try {
      await fs.chmod(target, 0o600)
    } catch {
      // Best-effort on platforms that don't support chmod (e.g. some Windows
      // filesystems). The mode 0600 supplied at writeFile time is the
      // primary mechanism.
    }
  }
}
