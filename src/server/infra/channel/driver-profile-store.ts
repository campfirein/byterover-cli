import {promises as fs} from 'node:fs'
import {dirname, join} from 'node:path'
import {z} from 'zod'

import type {AgentDriverProfile} from '../../../shared/types/index.js'
import type {IDriverProfileStore} from '../../core/interfaces/channel/i-driver-profile-store.js'

import {AgentDriverProfileSchema} from '../../../shared/types/index.js'

/**
 * File-backed {@link IDriverProfileStore}. Persists every profile in a single
 * JSON document under `<dataDir>/state/agent-driver-profiles.json`.
 *
 * Concurrency model: every mutation is a read-modify-atomic-rename-write
 * cycle. Concurrent writers may race; the last `fs.rename` wins. Profile
 * upserts are idempotent enough that this is acceptable here.
 *
 * Permissions: mode 0600 on the registry file. Atomic rename can inherit the
 * destination's prior mode on some filesystems, so we chmod after each rename
 * to be defensive.
 */
export type FileDriverProfileStoreOptions = {
  /** Data-dir root — the registry lives at `<dataDir>/state/agent-driver-profiles.json`. */
  readonly dataDir: string
}

const REGISTRY_SUBPATH = ['state', 'agent-driver-profiles.json'] as const

type RegistryDoc = {
  profiles: AgentDriverProfile[]
}

/** Loose doc shape — entries are validated one-by-one against the profile schema. */
const RegistryDocSchema = z.object({profiles: z.array(z.unknown())})

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
    // Re-validate via the canonical schema so the persisted shape is always
    // conformant regardless of caller laxness.
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
      const doc = RegistryDocSchema.safeParse(parsed)
      if (!doc.success) return []
      const out: AgentDriverProfile[] = []
      for (const entry of doc.data.profiles) {
        const result = AgentDriverProfileSchema.safeParse(entry)
        if (result.success) out.push(result.data)
      }

      return out
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []
      // Corrupt JSON or unreadable file → treat as empty so the surface keeps
      // working; the next upsert overwrites the corruption with a valid doc.
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
    try {
      await fs.chmod(target, 0o600)
    } catch {
      // Best-effort on platforms without chmod; the writeFile mode is primary.
    }
  }
}
