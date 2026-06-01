import {expect} from 'chai'
import {appendFile, mkdtemp, readFile, rm} from 'node:fs/promises'
import {tmpdir} from 'node:os'
import {join} from 'node:path'

import type {TurnEvent} from '../../../../../../src/shared/types/channel.js'

import {channelPaths} from '../../../../../../src/server/infra/channel/storage/channel-paths.js'
import {FileTranscriptStore} from '../../../../../../src/server/infra/channel/storage/file-transcript-store.js'
import {
  makeChunkEvent,
  makeMessageEvent,
  makeStateChangeEvent,
} from '../../../../../helpers/channel-fixtures.js'

/** Asserts a promise rejects with a message matching `pattern` (no chai-as-promised dependency). */
const assertRejects = async (promise: Promise<unknown>, pattern: RegExp): Promise<void> => {
  let caught: Error | undefined
  try {
    await promise
  } catch (error) {
    caught = error as Error
  }

  expect(caught, 'expected the promise to reject').to.be.instanceOf(Error)
  expect(caught?.message ?? '').to.match(pattern)
}

describe('transcript-store (FileTranscriptStore)', () => {
  const channelId = 'ch1'
  const turnId = 't1'
  let projectRoot: string
  let store: FileTranscriptStore

  beforeEach(async () => {
    projectRoot = await mkdtemp(join(tmpdir(), 'brv-transcript-'))
    store = new FileTranscriptStore()
  })

  afterEach(async () => {
    await rm(projectRoot, {force: true, recursive: true})
  })

  const append = (event: TurnEvent): Promise<void> =>
    store.appendTurnEvent({channelId, event, projectRoot, turnId})

  it('appends events and reads them back in seq order', async () => {
    const e0 = makeMessageEvent({seq: 0})
    const e1 = makeChunkEvent({seq: 1})
    const e2 = makeStateChangeEvent({seq: 2, to: 'completed'})
    await append(e0)
    await append(e1)
    await append(e2)

    const events = await store.readTurnEvents({channelId, projectRoot, turnId})
    expect(events.map((event) => event.seq)).to.deep.equal([0, 1, 2])
    expect(events).to.deep.equal([e0, e1, e2])
  })

  it('returns [] when the turn file does not exist', async () => {
    expect(await store.readTurnEvents({channelId, projectRoot, turnId: 'missing'})).to.deep.equal([])
  })

  it('writes exactly one physical line per event', async () => {
    await append(makeMessageEvent({content: 'a\nb', seq: 0}))
    await append(makeChunkEvent({seq: 1}))

    const raw = await readFile(channelPaths.turnNdjsonFile(projectRoot, channelId, turnId), 'utf8')
    expect(raw.split('\n').filter(Boolean)).to.have.lengthOf(2)
  })

  it('skips corrupt and blank lines on read', async () => {
    await append(makeMessageEvent({seq: 0}))
    await appendFile(channelPaths.turnNdjsonFile(projectRoot, channelId, turnId), 'not-json\n\n', 'utf8')
    await append(makeChunkEvent({seq: 1}))

    const events = await store.readTurnEvents({channelId, projectRoot, turnId})
    expect(events.map((event) => event.seq)).to.deep.equal([0, 1])
  })

  it('rejects an equal seq (non-monotonic)', async () => {
    await append(makeMessageEvent({seq: 0}))
    await append(makeChunkEvent({seq: 1}))
    await assertRejects(append(makeChunkEvent({seq: 1})), /seq/i)
  })

  it('rejects a regressing seq', async () => {
    await append(makeMessageEvent({seq: 0}))
    await append(makeChunkEvent({seq: 1}))
    await append(makeChunkEvent({seq: 2}))
    await assertRejects(append(makeChunkEvent({seq: 0})), /seq/i)
  })

  it('seeds lastSeq from disk so a fresh store still rejects a regression', async () => {
    await append(makeMessageEvent({seq: 0}))
    await append(makeChunkEvent({seq: 1}))

    const freshStore = new FileTranscriptStore()
    await assertRejects(
      freshStore.appendTurnEvent({channelId, event: makeChunkEvent({seq: 1}), projectRoot, turnId}),
      /seq/i,
    )
    await freshStore.appendTurnEvent({channelId, event: makeChunkEvent({seq: 2}), projectRoot, turnId})

    const events = await freshStore.readTurnEvents({channelId, projectRoot, turnId})
    expect(events.map((event) => event.seq)).to.deep.equal([0, 1, 2])
  })

  it('serializes concurrent appends to the same turn', async () => {
    await Promise.all(Array.from({length: 10}, (_, seq) => append(makeChunkEvent({seq}))))

    const events = await store.readTurnEvents({channelId, projectRoot, turnId})
    expect(events.map((event) => event.seq)).to.deep.equal([0, 1, 2, 3, 4, 5, 6, 7, 8, 9])
  })

  it('appends to different turns independently', async () => {
    await store.appendTurnEvent({
      channelId,
      event: makeMessageEvent({seq: 0, turnId: 'turn-a'}),
      projectRoot,
      turnId: 'turn-a',
    })
    await store.appendTurnEvent({
      channelId,
      event: makeMessageEvent({seq: 0, turnId: 'turn-b'}),
      projectRoot,
      turnId: 'turn-b',
    })

    expect(await store.readTurnEvents({channelId, projectRoot, turnId: 'turn-a'})).to.have.lengthOf(1)
    expect(await store.readTurnEvents({channelId, projectRoot, turnId: 'turn-b'})).to.have.lengthOf(1)
  })

  it('writes under .brv/channel-history with a trailing newline', async () => {
    await append(makeMessageEvent({seq: 0}))

    const file = channelPaths.turnNdjsonFile(projectRoot, channelId, turnId)
    expect(file).to.contain(join('.brv', 'channel-history'))
    expect(file).to.not.contain(join('.brv', 'context-tree'))
    const raw = await readFile(file, 'utf8')
    expect(raw.endsWith('\n')).to.equal(true)
  })
})
