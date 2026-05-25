import {expect} from 'chai'

import {
  listQuorumDispatchIds,
  type QuorumSnapshot,
  readLatestQuorum,
  writeQuorumSnapshot,
} from '../../../../../../src/server/infra/channel/quorum/quorum-store.js'
import {makeTempContextTree} from '../../../../../helpers/temp-context-tree.js'
import {removeTempDir} from '../../../../../helpers/temp-dir.js'

function baseSnapshot(dispatchId = 'd-1'): Omit<QuorumSnapshot, 'snapshottedAt'> {
  return {
    channelId: 'ch-a',
    dispatchId,
    escalated: false,
    merged: {
      agreed: [],
      contradicted: [],
      coveredAgents: ['@kimi'],
      mergedAt: '2026-05-18T05:00:00.000Z',
      missingAgents: [],
      partial: false,
      pending: [],
    },
    poolMode: 'local-first',
    poolSizes: {local: 2, remote: 0},
  }
}

describe('quorum/quorum-store (Slice 10.7 Phase A)', () => {
  let projectRoot: string

  beforeEach(async () => {
    projectRoot = await makeTempContextTree()
  })

  afterEach(async () => {
    await removeTempDir(projectRoot)
  })

  it('writes a snapshot and reads it back', async () => {
    await writeQuorumSnapshot({
      channelId: 'ch-a',
      dispatchId: 'd-1',
      now: () => new Date('2026-05-18T05:00:01.000Z'),
      projectRoot,
      snapshot: baseSnapshot(),
    })

    const read = await readLatestQuorum({channelId: 'ch-a', dispatchId: 'd-1', projectRoot})
    expect(read?.channelId).to.equal('ch-a')
    expect(read?.dispatchId).to.equal('d-1')
    expect(read?.snapshottedAt).to.equal('2026-05-18T05:00:01.000Z')
  })

  it('returns undefined when no snapshot exists for the dispatchId', async () => {
    const read = await readLatestQuorum({channelId: 'ch-a', dispatchId: 'nonexistent', projectRoot})
    expect(read).to.equal(undefined)
  })

  it('append-only: writing twice keeps both lines, readLatestQuorum returns the latest', async () => {
    await writeQuorumSnapshot({
      channelId: 'ch-a',
      dispatchId: 'd-1',
      now: () => new Date('2026-05-18T05:00:01.000Z'),
      projectRoot,
      snapshot: baseSnapshot(),
    })
    // Phase B will write follow-up snapshots as late findings arrive.
    await writeQuorumSnapshot({
      channelId: 'ch-a',
      dispatchId: 'd-1',
      now: () => new Date('2026-05-18T05:00:02.000Z'),
      projectRoot,
      snapshot: {
        ...baseSnapshot(),
        merged: {...baseSnapshot().merged, mergedAt: '2026-05-18T05:00:02.000Z'},
      },
    })

    const read = await readLatestQuorum({channelId: 'ch-a', dispatchId: 'd-1', projectRoot})
    expect(read?.snapshottedAt).to.equal('2026-05-18T05:00:02.000Z')
    expect(read?.merged.mergedAt).to.equal('2026-05-18T05:00:02.000Z')
  })

  it('listQuorumDispatchIds returns sorted dispatch ids for a channel', async () => {
    await Promise.all(['d-b', 'd-a', 'd-c'].map(id =>
      writeQuorumSnapshot({
        channelId: 'ch-a',
        dispatchId: id,
        projectRoot,
        snapshot: baseSnapshot(id),
      }),
    ))

    const ids = await listQuorumDispatchIds({channelId: 'ch-a', projectRoot})
    expect(ids).to.deep.equal(['d-a', 'd-b', 'd-c'])
  })

  it('listQuorumDispatchIds returns [] for a channel with no quorum dir yet', async () => {
    expect(await listQuorumDispatchIds({channelId: 'no-such-channel', projectRoot})).to.deep.equal([])
  })

  it('round-trips parallel-pool outcome fields', async () => {
    const snap: Omit<QuorumSnapshot, 'snapshottedAt'> = {
      ...baseSnapshot(),
      localPoolOutcome: 'completed',
      localTimeoutMs: 5000,
      poolMode: 'parallel',
      remotePoolOutcome: 'timed-out',
      remoteTimeoutMs: 30_000,
    }
    await writeQuorumSnapshot({
      channelId: 'ch-a',
      dispatchId: 'd-parallel',
      projectRoot,
      snapshot: snap,
    })

    const read = await readLatestQuorum({channelId: 'ch-a', dispatchId: 'd-parallel', projectRoot})
    expect(read?.localPoolOutcome).to.equal('completed')
    expect(read?.remotePoolOutcome).to.equal('timed-out')
    expect(read?.poolMode).to.equal('parallel')
  })
})
