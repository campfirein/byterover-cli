import {promises as fs} from 'node:fs'
import {dirname} from 'node:path'

import type {MergedQuorum} from '../../../core/domain/channel/quorum.js'

import {channelPaths} from '../storage/paths.js'

// Phase 10 Slice 10.7 Phase A — persistent quorum store.
//
// One NDJSON file per (channelId, dispatchId). Each line is a snapshot of
// the merged result at write time. `readQuorum` returns the LAST line so
// `brv channel show-quorum <ch> <dispatchId>` always surfaces the latest
// state. Phase B will append additional snapshots as late-arriving
// findings backfill into the quorum.

export type QuorumSnapshot = {
  readonly channelId: string
  readonly dispatchId: string
  readonly escalated?: boolean
  readonly escalationError?: string
  readonly escalationReason?: 'contradicted' | 'empty' | 'low-confidence'
  // Per-pool outcomes (parallel mode only).
  readonly localPoolOutcome?: 'completed' | 'errored' | 'skipped' | 'timed-out'
  readonly localTimeoutMs?: number
  readonly merged: MergedQuorum
  readonly poolMode?: 'local-first' | 'parallel'
  readonly poolSizes?: {readonly local: number; readonly remote: number}
  readonly remotePoolOutcome?: 'completed' | 'errored' | 'skipped' | 'timed-out'
  readonly remoteTimeoutMs?: number
  // Phase A: provenance — when the snapshot was written.
  readonly snapshottedAt: string
}

export type WriteQuorumArgs = {
  readonly channelId: string
  readonly dispatchId: string
  readonly now?: () => Date
  readonly projectRoot: string
  readonly snapshot: Omit<QuorumSnapshot, 'snapshottedAt'>
}

export type ReadQuorumArgs = {
  readonly channelId: string
  readonly dispatchId: string
  readonly projectRoot: string
}

export async function writeQuorumSnapshot(args: WriteQuorumArgs): Promise<void> {
  const file = channelPaths.quorumFile(args.projectRoot, args.channelId, args.dispatchId)
  await fs.mkdir(dirname(file), {recursive: true})
  const stampedAt = (args.now ?? (() => new Date()))().toISOString()
  const snapshot: QuorumSnapshot = {...args.snapshot, snapshottedAt: stampedAt}
  await fs.appendFile(file, `${JSON.stringify(snapshot)}\n`, 'utf8')
}

export async function readLatestQuorum(args: ReadQuorumArgs): Promise<QuorumSnapshot | undefined> {
  const file = channelPaths.quorumFile(args.projectRoot, args.channelId, args.dispatchId)
  let content: string
  try {
    content = await fs.readFile(file, 'utf8')
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined
    throw error
  }

  const lines = content.split('\n').filter(l => l.length > 0)
  if (lines.length === 0) return undefined
  const lastLine = lines.at(-1)!
  return JSON.parse(lastLine) as QuorumSnapshot
}

export async function listQuorumDispatchIds(args: {
  readonly channelId: string
  readonly projectRoot: string
}): Promise<string[]> {
  const dir = channelPaths.quorumDir(args.projectRoot, args.channelId)
  try {
    const entries = await fs.readdir(dir)
    return entries
      .filter(e => e.endsWith('.ndjson'))
      .map(e => e.replace(/\.ndjson$/, ''))
      .sort()
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []
    throw error
  }
}
