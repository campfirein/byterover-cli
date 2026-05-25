import {expect} from 'chai'
import {dirname, resolve} from 'node:path'
import {fileURLToPath} from 'node:url'

import type {TurnEvent} from '../../src/shared/types/channel.js'

import {ChannelTestHarness, parseJson} from '../helpers/channel-test-harness.js'
import {makeTempContextTree} from '../helpers/temp-context-tree.js'
import {removeTempDir} from '../helpers/temp-dir.js'

const HERE = dirname(fileURLToPath(import.meta.url))
const FIXTURE_PERM = resolve(HERE, '..', 'fixtures', 'mock-acp-permission.js')

// Slice 3.1 — daemon-restart recovery. Sequence:
//   1. Onboard a permission-requesting agent.
//   2. Mention; wait for permission_request to appear.
//   3. Kill the daemon (harness.restart) WITHOUT resolving the permission.
//   4. Run any harness.run() — spawns a fresh daemon, which on bootstrap:
//      (a) seeds the seq allocator + events-writer from on-disk events.jsonl,
//      (b) replays pending-permissions.jsonl,
//      (c) marks the affected delivery `errored`,
//      (d) finalises the turn as `completed`.
//   5. Assert the events.jsonl tail carries `delivery_state_change → errored`
//      with monotonic seq AND `turn_state_change → completed`.

describe('Channel Phase 3 — restart recovery', () => {
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

  it('marks a permission-orphaned delivery errored + completes the turn after restart', async () => {
    await harness.run(`channel onboard mock -- node ${FIXTURE_PERM}`)
    await harness.run('channel new pi-test')
    await harness.run('channel invite pi-test @mock --profile mock')

    const mention = await harness.run('channel mention pi-test "@mock please write" --no-wait --json')
    expect(mention.exitCode, mention.stderr).to.equal(0)
    const accepted = parseJson<{turn: {turnId: string}}>(mention.stdout)
    const {turnId} = accepted.turn

    // Wait for the permission_request to be persisted.
    await harness.pollForEvent('pi-test', turnId, (e) => e.kind === 'permission_request')

    // Kill the daemon WITHOUT resolving the permission.
    await harness.restart()

    // Next harness.run spawns a fresh daemon; bootstrap runs recovery.
    await harness.run('channel get pi-test --json')

    // The replayed events.jsonl must carry an errored delivery and a completed turn.
    const show = parseJson<{events: TurnEvent[]}>(
      (await harness.run(`channel show pi-test ${turnId} --json`)).stdout,
    )
    const erroredDelivery = show.events.find(
      (e): e is Extract<TurnEvent, {kind: 'delivery_state_change'}> =>
        e.kind === 'delivery_state_change' && e.to === 'errored',
    )
    const completedTurn = show.events.find(
      (e): e is Extract<TurnEvent, {kind: 'turn_state_change'}> =>
        e.kind === 'turn_state_change' && e.to === 'completed',
    )
    expect(erroredDelivery, 'recovery must emit delivery_state_change → errored').to.not.equal(undefined)
    expect(completedTurn, 'recovery must finalise the turn → completed').to.not.equal(undefined)
    expect(completedTurn!.seq).to.be.greaterThan(erroredDelivery!.seq)
  })

  // Slice 8.10 — V3 reproducer: when the daemon restarts mid-permission and
  // the user then approves, the new daemon must surface
  // `CHANNEL_PERMISSION_LOST_ON_RESTART` (not the misleading
  // `CHANNEL_TURN_NOT_FOUND`) and embed an exclusive `--after-seq` recovery
  // cursor that points at the daemon-written `errored` event.
  // See plan/channel-protocol/IMPLEMENTATION_PHASE_8_FOLLOWUPS.md §"Slice 8.10".
  it('returns CHANNEL_PERMISSION_LOST_ON_RESTART when approve fires after a daemon restart killed the ACP session (Slice 8.10)', async () => {
    await harness.run(`channel onboard mock -- node ${FIXTURE_PERM}`)
    await harness.run('channel new pi-test')
    await harness.run('channel invite pi-test @mock --profile mock')

    const mention = await harness.run('channel mention pi-test "@mock please write" --no-wait --json')
    expect(mention.exitCode, mention.stderr).to.equal(0)
    const accepted = parseJson<{turn: {turnId: string}}>(mention.stdout)
    const {turnId} = accepted.turn

    const permRequest = await harness.pollForEvent(
      'pi-test',
      turnId,
      (e) => e.kind === 'permission_request',
    )
    const {permissionRequestId} = (permRequest as TurnEvent & {kind: 'permission_request'; permissionRequestId: string})

    // Kill mid-permission so the orphan registry seeds at next boot.
    await harness.restart()

    // First call after restart spawns the fresh daemon; recovery runs and
    // seeds the orphan registry before the Socket.IO port opens.
    await harness.run('channel get pi-test --json')

    // Now approve. The orchestrator's activeTurns is empty (lost on restart),
    // but the orphan registry has an entry → we get the new code, not the old.
    const approve = await harness.run(`channel approve pi-test ${turnId} ${permissionRequestId} --json`)
    expect(approve.exitCode, approve.stdout + '\n' + approve.stderr).to.not.equal(0)
    const stdout = approve.stdout + approve.stderr
    expect(stdout, 'expected CHANNEL_PERMISSION_LOST_ON_RESTART in approve output').to.match(/CHANNEL_PERMISSION_LOST_ON_RESTART/)
    expect(stdout, 'expected re-invite hint').to.match(/re-invite/i)
    expect(stdout, 'expected --after-seq cursor in the human message').to.match(/--after-seq \d+/)
  })

  // Slice 8.11 — V3 reproducer line 91 ("Driver reinvite needed before every
  // phase"): after a daemon restart, the orchestrator's in-memory pool is
  // empty. Layer 1 surfaces CHANNEL_DRIVER_NOT_REGISTERED on the first
  // mention's race window. Layer 2 (warmDriversForProject) spawns drivers
  // from meta.json on first client connection per project. After the warm
  // completes, subsequent mentions succeed WITHOUT explicit re-invite.
  // See plan/channel-protocol/IMPLEMENTATION_PHASE_8_FOLLOWUPS.md §"Slice 8.11".
  it('surfaces CHANNEL_DRIVER_NOT_REGISTERED on the first mention after restart (Slice 8.11 Layer 1 race)', async () => {
    // Use the mock fixture WITHOUT permission — just a normal driver.
    const FIXTURE = resolve(HERE, '..', 'fixtures', 'mock-acp.js')
    await harness.run(`channel onboard mock -- node ${FIXTURE}`)
    await harness.run('channel new pi-test')
    await harness.run('channel invite pi-test @mock --profile mock')

    // Sanity: first mention works (driver in pool).
    const baseline = await harness.run('channel mention pi-test "@mock ping" --mode sync --suppress-thoughts --json --timeout 30000')
    expect(baseline.exitCode, baseline.stderr).to.equal(0)

    // Kill the daemon to drop the in-memory pool.
    await harness.restart()

    // First mention after restart RACES against Layer 2 warm.
    // Whether it wins or loses, Layer 1 means the error is now informative.
    const racy = await harness.run('channel mention pi-test "@mock ping again" --mode sync --suppress-thoughts --json --timeout 30000')

    // Either the warm beat us (delivery succeeds) OR we beat the warm and
    // get CHANNEL_DRIVER_NOT_REGISTERED — never the legacy `unknown` failure.
    const combined = racy.stdout + racy.stderr
    if (racy.exitCode === 0) {
      // Warm beat us — delivery succeeded. Layer 2 fully covered the gap.
      expect(combined).to.match(/finalAnswer/)
    } else {
      // Race: warm hadn't completed. Layer 1 must surface the canonical code.
      expect(combined, 'first-mention race must surface CHANNEL_DRIVER_NOT_REGISTERED, never "unknown"').to.match(/CHANNEL_DRIVER_NOT_REGISTERED/)
      expect(combined, 'Layer 1 hint must mention re-invite').to.match(/re-invite/i)
      expect(combined, 'must NOT surface the legacy `unknown` reason').to.not.match(/"reason":\s*"unknown"|: unknown$/m)
    }
  })

  it('Layer 2 warm: subsequent mention after warm completes succeeds without explicit re-invite (Slice 8.11)', async () => {
    const FIXTURE = resolve(HERE, '..', 'fixtures', 'mock-acp.js')
    await harness.run(`channel onboard mock -- node ${FIXTURE}`)
    await harness.run('channel new pi-test')
    await harness.run('channel invite pi-test @mock --profile mock')

    await harness.restart()

    // The first run triggers daemon spawn + warm. Give warm enough time.
    // (mock-acp.js has fast initialize; a short delay is reliable.)
    await harness.run('channel list --json')
    await new Promise((r) => {
      setTimeout(r, 1500)
    })

    // Mention WITHOUT calling invite — Layer 2 should have warmed the driver.
    const after = await harness.run('channel mention pi-test "@mock no-reinvite-test" --mode sync --suppress-thoughts --json --timeout 30000')
    expect(after.exitCode, `post-warm mention should succeed without re-invite; stdout=${after.stdout}, stderr=${after.stderr}`).to.equal(0)
    expect(after.stdout, 'expected finalAnswer from mock driver').to.match(/finalAnswer/)
  })
})
