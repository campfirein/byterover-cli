import {expect} from 'chai'
import {dirname, resolve} from 'node:path'
import {fileURLToPath} from 'node:url'

import type {TurnEvent} from '../../src/shared/types/channel.js'

import {ChannelTestHarness, parseJson} from '../helpers/channel-test-harness.js'
import {makeTempContextTree} from '../helpers/temp-context-tree.js'
import {removeTempDir} from '../helpers/temp-dir.js'

const HERE = dirname(fileURLToPath(import.meta.url))
const FIXTURE = resolve(HERE, '..', 'fixtures', 'mock-acp.js')

// Slice 3.1 — multi-agent fan-out. Two sub-cases:
//   (a) Parallel: default maxParallelAgents=4 dispatches both deliveries
//       immediately.
//   (b) Queueing: harness.seedSettings(channel, {maxParallelAgents: 1}) makes
//       the second delivery queue behind the first.

describe('Channel Phase 3 — multi-agent fan-out', () => {
  let projectDir: string
  let harness: ChannelTestHarness

  beforeEach(async () => {
    projectDir = await makeTempContextTree()
    harness = await ChannelTestHarness.boot({projectDir})
  })

  afterEach(async () => {
    await harness.shutdown()
    await removeTempDir(projectDir)
  })

  it('(a) default parallelism: two mentions both dispatch immediately', async () => {
    await harness.run(`channel onboard mock -- node ${FIXTURE}`)
    await harness.run('channel new pi-test')
    await harness.run('channel invite pi-test @a --profile mock')
    await harness.run('channel invite pi-test @b --profile mock')

    const mention = await harness.run('channel mention pi-test "@a @b ping" --no-wait --json')
    expect(mention.exitCode, mention.stderr).to.equal(0)
    const accepted = parseJson<{deliveries: Array<{state: string}>; turn: {turnId: string}}>(mention.stdout)
    expect(accepted.deliveries).to.have.lengthOf(2)
    expect(accepted.deliveries.every((d) => d.state === 'dispatched')).to.equal(true)

    await harness.pollForTerminal('pi-test', accepted.turn.turnId)
  })

  it('(b) maxParallelAgents=1: second delivery queues behind the first', async () => {
    await harness.run(`channel onboard mock -- node ${FIXTURE}`)
    await harness.run('channel new pi-test')
    await harness.seedSettings('pi-test', {maxParallelAgents: 1})
    await harness.run('channel invite pi-test @a --profile mock')
    await harness.run('channel invite pi-test @b --profile mock')

    const mention = await harness.run('channel mention pi-test "@a @b ping" --no-wait --json')
    expect(mention.exitCode, mention.stderr).to.equal(0)
    const accepted = parseJson<{deliveries: Array<{deliveryId: string; memberHandle: string; state: string}>; turn: {turnId: string}}>(mention.stdout)
    expect(accepted.deliveries).to.have.lengthOf(2)

    // At dispatch time, the second delivery is still queued.
    const sorted = [...accepted.deliveries].sort((a, b) => a.memberHandle.localeCompare(b.memberHandle))
    expect(sorted[0].state).to.equal('dispatched')
    expect(sorted[1].state).to.equal('queued')

    await harness.pollForTerminal('pi-test', accepted.turn.turnId)

    // events.jsonl ordering: the second delivery's queued → dispatched
    // transition fires AFTER the first delivery's → completed transition.
    const show = parseJson<{events: TurnEvent[]}>(
      (await harness.run(`channel show pi-test ${accepted.turn.turnId} --json`)).stdout,
    )
    const firstDispatchedDeliveryId = accepted.deliveries.find((d) => d.state === 'dispatched')!.deliveryId
    const queuedDeliveryId = accepted.deliveries.find((d) => d.state === 'queued')!.deliveryId

    const firstCompletedSeq = show.events
      .find((e): e is Extract<TurnEvent, {kind: 'delivery_state_change'}> =>
        e.kind === 'delivery_state_change' && e.deliveryId === firstDispatchedDeliveryId && e.to === 'completed',
      )?.seq
    const queuedDispatchedSeq = show.events
      .find((e): e is Extract<TurnEvent, {kind: 'delivery_state_change'}> =>
        e.kind === 'delivery_state_change' && e.deliveryId === queuedDeliveryId && e.from === 'queued' && e.to === 'dispatched',
      )?.seq

    expect(firstCompletedSeq, 'first delivery should reach completed').to.be.a('number')
    expect(queuedDispatchedSeq, 'queued delivery should eventually dispatch').to.be.a('number')
    expect(queuedDispatchedSeq! > firstCompletedSeq!, 'second delivery dispatches after first completes').to.equal(true)
  })
})
