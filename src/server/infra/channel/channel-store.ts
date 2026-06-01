import {randomUUID} from 'node:crypto'
import {mkdir, readdir, readFile, rename, rm, writeFile} from 'node:fs/promises'
import {dirname, resolve} from 'node:path'
import {z} from 'zod'

import type {Channel, ChannelMember, ChannelMemberSummary} from '../../../shared/types/channel.js'
import type {
  ChannelStoreAddMemberArgs,
  ChannelStoreCreateArgs,
  ChannelStoreRemoveMemberArgs,
  ChannelStoreUpdateArgs,
  IChannelStore,
} from '../../core/interfaces/channel/i-channel-store.js'

import {AsyncMutex} from '../../../agent/infra/llm/context/async-mutex.js'
import {ChannelMemberSchema, ChannelSchema} from '../../../shared/types/channel.js'
import {channelPaths} from './storage/channel-paths.js'

/**
 * On-disk channel document. The durable record holds the FULL member records
 * (unlike the {@link Channel} projection, whose `members` are summaries and
 * whose `memberCount` is derived). Built by subtracting the projected fields
 * from {@link ChannelSchema} and re-adding `members` as full records so the doc
 * and the wire type can never drift.
 */
const ChannelDocSchema = ChannelSchema.omit({memberCount: true, members: true})
  .extend({members: z.array(ChannelMemberSchema)})
  .strict()

type ChannelDoc = z.infer<typeof ChannelDocSchema>

/** Current timestamp as an ISO-8601 string (the on-disk time format). */
const nowIso = (): string => new Date().toISOString()

/** Writes `contents` to `file` via a temp file + rename so a reader never sees a partial write. */
const writeAtomically = async (file: string, contents: string): Promise<void> => {
  await mkdir(dirname(file), {recursive: true})
  const tmp = `${file}.${randomUUID()}.tmp`
  try {
    await writeFile(tmp, contents, 'utf8')
    await rename(tmp, file)
  } catch (error) {
    await rm(tmp, {force: true}).catch(() => {})
    throw error
  }
}

/** Reads and validates a channel doc; returns `undefined` for missing, corrupt, or schema-invalid files. */
const readDoc = async (file: string): Promise<ChannelDoc | undefined> => {
  let raw: string
  try {
    raw = await readFile(file, 'utf8')
  } catch {
    return undefined
  }

  let json: unknown
  try {
    json = JSON.parse(raw)
  } catch {
    return undefined
  }

  const parsed = ChannelDocSchema.safeParse(json)
  return parsed.success ? parsed.data : undefined
}

/** Projects a full member record down to the lightweight summary used in {@link Channel.members}. */
const toMemberSummary = (member: ChannelMember): ChannelMemberSummary => ({
  displayName: member.agentName,
  handle: member.handle,
  memberKind: member.memberKind,
  status: member.status,
  ...(member.memberKind === 'acp-agent' ? {capabilities: member.capabilities} : {}),
})

/** Projects a stored doc into the {@link Channel} wire shape (summary members + derived count). */
const toChannelProjection = (doc: ChannelDoc): Channel => {
  const {members, ...rest} = doc
  return {
    ...rest,
    memberCount: members.length,
    members: members.map((member) => toMemberSummary(member)),
  }
}

/** Options for {@link FileChannelStore}. */
export type FileChannelStoreOptions = {
  /** Project the channels live under; meta files resolve from `<projectRoot>/.brv/channel-history`. */
  readonly projectRoot: string
}

/**
 * File-backed {@link IChannelStore}: one `meta.json` per channel under
 * `<projectRoot>/.brv/channel-history/<channelId>/`. Owns channel + full member
 * metadata only — transcripts belong to `ITranscriptStore`.
 *
 * Every mutation runs as a read-modify-write under a per-channel lock so
 * concurrent invites can't lose a member, and persists via temp-file + rename so
 * a crash never leaves a half-written meta. `listChannels` is skip-not-fail: a
 * single corrupt meta is skipped rather than failing the whole listing.
 */
export class FileChannelStore implements IChannelStore {
  // One mutex per resolved meta-file path, serializing that channel's RMW.
  private readonly locksByPath = new Map<string, AsyncMutex>()
  private readonly projectRoot: string

  public constructor(options: FileChannelStoreOptions) {
    this.projectRoot = options.projectRoot
  }

  public async addMember(args: ChannelStoreAddMemberArgs): Promise<void> {
    const {channelId, member} = args
    await this.withChannelLock(channelId, async () => {
      const doc = await this.readDocOrThrow(channelId)
      // Upsert by handle so a repeated invite is idempotent (no double-count).
      const members = [...doc.members.filter((existing) => existing.handle !== member.handle), member]
      await this.persist({...doc, members, updatedAt: nowIso()})
    })
  }

  public async createChannel(args: ChannelStoreCreateArgs): Promise<Channel> {
    const {channelId, settings, title} = args
    return this.withChannelLock(channelId, async () => {
      if ((await readDoc(this.metaFile(channelId))) !== undefined) {
        throw new Error(`channel ${channelId} already exists`)
      }

      const createdAt = nowIso()
      const doc: ChannelDoc = {
        channelId,
        createdAt,
        members: [],
        updatedAt: createdAt,
        ...(settings === undefined ? {} : {settings}),
        ...(title === undefined ? {} : {title}),
      }
      return toChannelProjection(await this.persist(doc))
    })
  }

  public async listChannels(): Promise<Channel[]> {
    let entries: string[]
    try {
      entries = await readdir(channelPaths.channelHistoryRoot(this.projectRoot))
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []
      throw error
    }

    const docs = await Promise.all(entries.map((channelId) => readDoc(this.metaFile(channelId))))
    return docs
      .filter((doc): doc is ChannelDoc => doc !== undefined)
      .map((doc) => toChannelProjection(doc))
      .sort((a, b) => a.channelId.localeCompare(b.channelId))
  }

  public async listMembers(channelId: string): Promise<ChannelMember[]> {
    return (await readDoc(this.metaFile(channelId)))?.members ?? []
  }

  public async readChannel(channelId: string): Promise<Channel | undefined> {
    const doc = await readDoc(this.metaFile(channelId))
    return doc === undefined ? undefined : toChannelProjection(doc)
  }

  public async removeMember(args: ChannelStoreRemoveMemberArgs): Promise<void> {
    const {channelId, memberHandle} = args
    await this.withChannelLock(channelId, async () => {
      const doc = await readDoc(this.metaFile(channelId))
      if (doc === undefined) return

      const members = doc.members.filter((member) => member.handle !== memberHandle)
      if (members.length === doc.members.length) return

      await this.persist({...doc, members, updatedAt: nowIso()})
    })
  }

  public async updateChannel(args: ChannelStoreUpdateArgs): Promise<Channel> {
    const {archivedAt, channelId, settings, title} = args
    return this.withChannelLock(channelId, async () => {
      const doc = await this.readDocOrThrow(channelId)
      const next: ChannelDoc = {
        ...doc,
        updatedAt: nowIso(),
        ...(archivedAt === undefined ? {} : {archivedAt}),
        ...(settings === undefined ? {} : {settings}),
        ...(title === undefined ? {} : {title}),
      }
      return toChannelProjection(await this.persist(next))
    })
  }

  private lockFor(key: string): AsyncMutex {
    let mutex = this.locksByPath.get(key)
    if (mutex === undefined) {
      mutex = new AsyncMutex()
      this.locksByPath.set(key, mutex)
    }

    return mutex
  }

  private metaFile(channelId: string): string {
    return channelPaths.metaFile(this.projectRoot, channelId)
  }

  /** Validates then atomically writes a doc, returning the validated record. */
  private async persist(doc: ChannelDoc): Promise<ChannelDoc> {
    const validated = ChannelDocSchema.parse(doc)
    await writeAtomically(this.metaFile(validated.channelId), JSON.stringify(validated, undefined, 2))
    return validated
  }

  private async readDocOrThrow(channelId: string): Promise<ChannelDoc> {
    const doc = await readDoc(this.metaFile(channelId))
    if (doc === undefined) {
      throw new Error(`channel ${channelId} not found`)
    }

    return doc
  }

  private withChannelLock<T>(channelId: string, fn: () => Promise<T>): Promise<T> {
    return this.lockFor(resolve(this.metaFile(channelId))).withLock(fn)
  }
}
