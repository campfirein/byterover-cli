
import {expect} from 'chai'
import {promises as fs} from 'node:fs'
import {join} from 'node:path'

import type {ChannelMeta} from '../../../../../src/shared/types/channel.js'

import {ChannelStore} from '../../../../../src/server/infra/channel/channel-store.js'
import {ChannelEventsWriter} from '../../../../../src/server/infra/channel/storage/events-writer.js'
import {ChannelSnapshotWriter} from '../../../../../src/server/infra/channel/storage/snapshot-writer.js'
import {ChannelTreeReader} from '../../../../../src/server/infra/channel/storage/tree-reader.js'
import {ChannelWriteSerializer} from '../../../../../src/server/infra/channel/storage/write-serializer.js'
import {makeTempContextTree} from '../../../../helpers/temp-context-tree.js'
import {removeTempDir} from '../../../../helpers/temp-dir.js'

// Phase 9.5.10 Fix A — ChannelStore.reconstructIfMissing.
//
// Reconstruction must share the same per-channel meta lock as createChannel
// so the kimi-flagged overwrite race is closed. The remaining create-vs-
// reconstruct race is intentionally resolved in favor of reconstruction
// (see Fix D in plan/bridge-smoothness/PHASE_9_5_10.md).

const CHANNEL_ID = 'ch-rim'

function makeStore(): ChannelStore {
  const serializer = new ChannelWriteSerializer()
  return new ChannelStore({
    eventsWriter: new ChannelEventsWriter({serializer}),
    snapshotWriter: new ChannelSnapshotWriter({
      eventsWriter: new ChannelEventsWriter({serializer: new ChannelWriteSerializer()}),
    }),
    treeReader: new ChannelTreeReader(),
    writeSerializer: serializer,
  })
}

function buildStub(channelId: string): ChannelMeta {
  return {
    channelId,
    createdAt: '2026-05-24T10:00:00.000Z',
    inferredHandles: ['@alice'],
    members: [],
    reconstructedAt: '2026-05-25T00:00:00.000Z',
    reconstructionStatus: 'reconstructed-from-history',
    updatedAt: '2026-05-25T00:00:00.000Z',
  } as ChannelMeta
}

describe('ChannelStore.reconstructIfMissing (Phase 9.5.10 Fix A)', () => {
  let projectRoot: string
  let store: ChannelStore

  beforeEach(async () => {
    projectRoot = await makeTempContextTree()
    store = makeStore()
  })

  afterEach(async () => {
    await removeTempDir(projectRoot)
  })

  it('returns "wrote" and persists meta when no meta.json exists', async () => {
    const meta = buildStub(CHANNEL_ID)

    const result = await store.reconstructIfMissing({meta, projectRoot})
    expect(result).to.equal('wrote')

    const persisted = await store.readChannelMeta({channelId: CHANNEL_ID, projectRoot})
    expect(persisted?.channelId).to.equal(CHANNEL_ID)
    expect(persisted?.reconstructionStatus).to.equal('reconstructed-from-history')
    expect(persisted?.inferredHandles).to.deep.equal(['@alice'])
  })

  it('returns "already-exists" and does NOT overwrite when meta is present', async () => {
    const existing: ChannelMeta = {
      channelId: CHANNEL_ID,
      createdAt: '2026-01-01T00:00:00.000Z',
      members: [],
      title: 'sentinel',
      updatedAt: '2026-01-01T00:00:00.000Z',
    }
    await store.createChannel({meta: existing, projectRoot})

    const result = await store.reconstructIfMissing({meta: buildStub(CHANNEL_ID), projectRoot})
    expect(result).to.equal('already-exists')

    // Sentinel preserved untouched.
    const after = await store.readChannelMeta({channelId: CHANNEL_ID, projectRoot})
    expect(after?.title).to.equal('sentinel')
    expect(after?.createdAt).to.equal('2026-01-01T00:00:00.000Z')
    expect(after?.reconstructionStatus).to.equal(undefined)
  })

  it('serializes concurrent reconstructIfMissing calls — exactly one writes', async () => {
    const [a, b] = await Promise.all([
      store.reconstructIfMissing({meta: buildStub(CHANNEL_ID), projectRoot}),
      store.reconstructIfMissing({meta: buildStub(CHANNEL_ID), projectRoot}),
    ])
    const outcomes = [a, b].sort()
    expect(outcomes).to.deep.equal(['already-exists', 'wrote'])

    // File on disk is parseable + sane.
    const persisted = await store.readChannelMeta({channelId: CHANNEL_ID, projectRoot})
    expect(persisted?.channelId).to.equal(CHANNEL_ID)
  })

  it('stub-wins-by-design: when reconstructIfMissing publishes first, a subsequent createChannel for the same id fails fast', async () => {
    // Reconstruction wins the lock.
    const recResult = await store.reconstructIfMissing({meta: buildStub(CHANNEL_ID), projectRoot})
    expect(recResult).to.equal('wrote')

    // Now operator (or some other code path) attempts createChannel for the
    // same id with a different intended title.
    const intended: ChannelMeta = {
      channelId: CHANNEL_ID,
      createdAt: '2026-05-25T12:00:00.000Z',
      members: [],
      title: 'fresh-channel',
      updatedAt: '2026-05-25T12:00:00.000Z',
    }
    let threw: Error | undefined
    try {
      await store.createChannel({meta: intended, projectRoot})
    } catch (error) {
      threw = error instanceof Error ? error : new Error(String(error))
    }

    // createChannel rejects loudly (existing behavior). Operator can recover
    // via doctor → invite.
    expect(threw?.message).to.match(/already exists/i)

    // Reconstructed stub is still the canonical meta; not silently clobbered.
    const persisted = await store.readChannelMeta({channelId: CHANNEL_ID, projectRoot})
    expect(persisted?.reconstructionStatus).to.equal('reconstructed-from-history')
  })

  it('schema round-trip: reconstructed meta survives a write-then-read with all fields preserved', async () => {
    const meta = buildStub(CHANNEL_ID)
    await store.reconstructIfMissing({meta, projectRoot})

    // Read raw JSON to verify zod did not strip the new fields.
    const raw = await fs.readFile(
      join(projectRoot, '.brv', 'context-tree', 'channel', CHANNEL_ID, 'meta.json'),
      'utf8',
    )
    const parsed = JSON.parse(raw) as Record<string, unknown>
    expect(parsed.reconstructionStatus).to.equal('reconstructed-from-history')
    expect(parsed.inferredHandles).to.deep.equal(['@alice'])
  })
})
