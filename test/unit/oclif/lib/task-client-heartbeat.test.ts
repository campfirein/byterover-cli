import type {ITransportClient} from '@campfirein/brv-transport-client'

import {expect} from 'chai'
import {restore, type SinonFakeTimers, stub, useFakeTimers} from 'sinon'

import type {TaskHeartbeatEvent} from '../../../../src/shared/transport/events/index.js'

import {waitForTaskCompletion} from '../../../../src/oclif/lib/task-client.js'
import {LlmEvents, TaskEvents} from '../../../../src/shared/transport/events/index.js'

type EventHandler = (data: unknown) => void

function makeClient(): {
  client: ITransportClient
  emit: (event: string, payload: unknown) => void
  triggerState: (state: 'connected' | 'disconnected' | 'reconnecting') => void
} {
  const handlers: Map<string, EventHandler[]> = new Map()
  let stateHandler: ((state: 'connected' | 'disconnected' | 'reconnecting') => void) | undefined

  const client = {
    on: stub().callsFake((event: string, handler: EventHandler) => {
      const list = handlers.get(event) ?? []
      list.push(handler)
      handlers.set(event, list)
      return () => {
        const updated = (handlers.get(event) ?? []).filter((h) => h !== handler)
        handlers.set(event, updated)
      }
    }) as unknown as ITransportClient['on'],
    onStateChange: stub().callsFake((handler: (state: 'connected' | 'disconnected' | 'reconnecting') => void) => {
      stateHandler = handler
      return () => {
        stateHandler = undefined
      }
    }) as unknown as ITransportClient['onStateChange'],
  } as unknown as ITransportClient

  return {
    client,
    emit(event, payload) {
      const list = handlers.get(event) ?? []
      for (const handler of list) handler(payload)
    },
    triggerState(state) {
      if (stateHandler) stateHandler(state)
    },
  }
}

describe('waitForTaskCompletion — heartbeat watcher', () => {
  let clock: SinonFakeTimers

  beforeEach(() => {
    clock = useFakeTimers()
    // Silence JSON-mode writes that some paths may emit.
    stub(process.stdout, 'write').returns(true)
  })

  afterEach(() => {
    restore()
  })

  it('rejects with "Daemon is unresponsive on this task" when no event arrives within the stale threshold', async () => {
    const {client} = makeClient()
    let rejection: Error | undefined

    const promise = waitForTaskCompletion(
      {
        client,
        command: 'curate',
        format: 'text',
        onCompleted() {},
        onError() {},
        taskId: 't1',
      },
      () => {},
    ).catch((error) => {
      rejection = error instanceof Error ? error : new Error(String(error))
    })

    // Stale threshold = 30s; check interval = 5s. The next check after the
    // threshold elapses sees `Date.now() - lastActivityAt > 30_000` and
    // rejects. Tick well past 30s + one check interval to cover the boundary.
    await clock.tickAsync(40_000)
    await promise

    expect(rejection?.message).to.include('Daemon is unresponsive on this task')
  })

  it('does NOT reject when TaskEvents.HEARTBEAT arrives within the stale threshold', async () => {
    const {client, emit} = makeClient()
    let rejected = false

    const promise = waitForTaskCompletion(
      {
        client,
        command: 'curate',
        format: 'text',
        onCompleted() {},
        onError() {},
        taskId: 't1',
      },
      () => {},
    ).catch(() => {
      rejected = true
    })

    // Emit heartbeats every 10s for a total of 90s — well past the old wall-clock,
    // never past the 30s stale threshold because each heartbeat resets the timer.
    for (let i = 0; i < 9; i++) {
      // eslint-disable-next-line no-await-in-loop
      await clock.tickAsync(10_000)
      const event: TaskHeartbeatEvent = {lastActivityAt: Date.now(), taskId: 't1'}
      emit(TaskEvents.HEARTBEAT, event)
    }

    expect(rejected).to.equal(false)

    // Complete the task so the promise resolves cleanly.
    emit(TaskEvents.COMPLETED, {result: 'done', taskId: 't1'})
    await promise
  })

  it('does NOT reject when LLM events arrive within the stale threshold (no explicit heartbeat needed)', async () => {
    const {client, emit} = makeClient()
    let rejected = false

    const promise = waitForTaskCompletion(
      {
        client,
        command: 'curate',
        format: 'text',
        onCompleted() {},
        onError() {},
        taskId: 't1',
      },
      () => {},
    ).catch(() => {
      rejected = true
    })

    for (let i = 0; i < 5; i++) {
      // eslint-disable-next-line no-await-in-loop
      await clock.tickAsync(15_000)
      emit(LlmEvents.TOOL_CALL, {args: {}, callId: `c${i}`, taskId: 't1', toolName: 'bash'})
    }

    expect(rejected).to.equal(false)

    emit(TaskEvents.COMPLETED, {result: 'done', taskId: 't1'})
    await promise
  })

  it('ignores LLM events for a different taskId (does not falsely refresh the stale clock)', async () => {
    const {client, emit} = makeClient()
    let rejection: Error | undefined

    const promise = waitForTaskCompletion(
      {
        client,
        command: 'curate',
        format: 'text',
        onCompleted() {},
        onError() {},
        taskId: 't1',
      },
      () => {},
    ).catch((error) => {
      rejection = error instanceof Error ? error : new Error(String(error))
    })

    // Steady stream of LLM events for a DIFFERENT task — every 5s for 40s.
    // If the watcher were not filtering by taskId, this would keep our
    // stale clock fresh forever; with the fix, we still surface as stuck.
    for (let i = 0; i < 8; i++) {
      // eslint-disable-next-line no-await-in-loop
      await clock.tickAsync(5000)
      emit(LlmEvents.TOOL_CALL, {args: {}, callId: `c${i}`, taskId: 'other-task', toolName: 'bash'})
    }

    await clock.tickAsync(0)
    await promise

    expect(rejection?.message).to.include('Daemon is unresponsive on this task')
  })

  it('uses AGENT_DISCONNECTED (retryable) on socket disconnect, NOT the stale-task error', async () => {
    const {client, triggerState} = makeClient()
    let rejection: Error | undefined

    const promise = waitForTaskCompletion(
      {
        client,
        command: 'curate',
        format: 'text',
        onCompleted() {},
        onError() {},
        taskId: 't1',
      },
      () => {},
    ).catch((error) => {
      rejection = error instanceof Error ? error : new Error(String(error))
    })

    triggerState('disconnected')
    await promise

    expect(rejection?.message).to.include('Daemon disconnected')
    expect(rejection).to.have.property('code', 'ERR_AGENT_DISCONNECTED')
  })

  it('foreign-task task:created / task:ack / task:started do NOT bump the watcher (cross-task isolation)', async () => {
    // Section: regression guard for the new CREATED/ACK/STARTED subscriptions.
    // If those handlers forgot to filter by taskId, a noisy peer task in the
    // same project room would keep our watcher alive forever — masking real
    // stalls. This drives the explicit foreign-task filter on lines 228-243
    // of task-client.ts.
    const {client, emit} = makeClient()
    let rejection: Error | undefined

    const promise = waitForTaskCompletion(
      {
        client,
        command: 'curate',
        format: 'text',
        onCompleted() {},
        onError() {},
        taskId: 't1',
      },
      () => {},
    ).catch((error) => {
      rejection = error instanceof Error ? error : new Error(String(error))
    })

    // Fire all three NEW lifecycle events for a DIFFERENT task every 5s. With
    // the filter, watcher stays at lastActivityAt = 0 and stale-check rejects
    // around 30s. Without the filter, watcher would be kept alive forever.
    for (let i = 0; i < 8; i++) {
      // eslint-disable-next-line no-await-in-loop
      await clock.tickAsync(5000)
      emit(TaskEvents.CREATED, {taskId: 'other-task'})
      emit(TaskEvents.ACK, {taskId: 'other-task'})
      emit(TaskEvents.STARTED, {taskId: 'other-task'})
    }

    await clock.tickAsync(0)
    await promise

    expect(rejection?.message).to.include('Daemon is unresponsive on this task')
  })

  it('a single task:created bump still rejects 30s later when nothing follows (genuine stall after handshake)', async () => {
    // Section: post-handshake stall. The watcher gets ONE liveness event from
    // task:created at T+0, then the daemon dies during agent fork before any
    // ACK/STARTED/HEARTBEAT arrives. Watcher should reject 30s after the last
    // (and only) activity, not wait forever.
    const {client, emit} = makeClient()
    let rejection: Error | undefined

    const promise = waitForTaskCompletion(
      {
        client,
        command: 'curate',
        format: 'text',
        onCompleted() {},
        onError() {},
        taskId: 't1',
      },
      () => {},
    ).catch((error) => {
      rejection = error instanceof Error ? error : new Error(String(error))
    })

    await clock.tickAsync(1000)
    emit(TaskEvents.CREATED, {taskId: 't1'}) // single bump
    // Now daemon dies. No more events. Watcher should reject ~30s later.
    await clock.tickAsync(35_000)
    await promise

    expect(rejection?.message).to.include('Daemon is unresponsive on this task')
  })

  it('two concurrent watchers for different taskIds do NOT bump each other on CREATED/ACK/STARTED', async () => {
    // Section: parallel watchers. Each waitForTaskCompletion call creates an
    // independent watcher. They share the same client (same socket), so every
    // event fans out to every handler. Per-watcher taskId filter must isolate.
    const {client, emit} = makeClient()
    let r1: Error | undefined
    let r2: Error | undefined

    const p1 = waitForTaskCompletion(
      {client, command: 'curate', format: 'text', onCompleted() {}, onError() {}, taskId: 't1'},
      () => {},
    ).catch((error) => {
      r1 = error instanceof Error ? error : new Error(String(error))
    })

    const p2 = waitForTaskCompletion(
      {client, command: 'curate', format: 'text', onCompleted() {}, onError() {}, taskId: 't2'},
      () => {},
    ).catch((error) => {
      r2 = error instanceof Error ? error : new Error(String(error))
    })

    // t2 stays active forever via STARTED+HEARTBEAT cadence; t1 stays silent.
    for (let i = 0; i < 6; i++) {
      // eslint-disable-next-line no-await-in-loop
      await clock.tickAsync(8000)
      emit(TaskEvents.STARTED, {taskId: 't2'})
      const beat: TaskHeartbeatEvent = {lastActivityAt: Date.now(), taskId: 't2'}
      emit(TaskEvents.HEARTBEAT, beat)
    }

    // t1 should have rejected by now (no events for ~48s), t2 should still be alive.
    expect(r1?.message).to.include('Daemon is unresponsive on this task')
    expect(r2).to.equal(undefined, 'concurrent watcher for t2 must not be bumped down by t1 timeout')

    // Clean up t2.
    emit(TaskEvents.COMPLETED, {result: 'ok', taskId: 't2'})
    await p1
    await p2
  })

  it('does NOT reject during a cold-start where the first activity-bumping event arrives after >30s', async () => {
    // Cold-start scenario: agent fork + ESM bootstrap + auth/provider/billing
    // init + CipherAgent.start can take 30-40s on Windows under AV. During
    // this window the daemon DOES emit `task:created` (synchronously) and
    // `task:ack` (after lifecycle hooks), but the watcher only bumps
    // `lastActivityAt` on HEARTBEAT/LLM events, neither of which fire until
    // task-router runs `handleTaskStarted` -> `heartbeatManager.register`.
    // Daemon is alive the whole time; CLI should NOT reject.
    const {client, emit} = makeClient()
    let rejected = false
    let rejection: Error | undefined

    const promise = waitForTaskCompletion(
      {
        client,
        command: 'curate',
        format: 'text',
        onCompleted() {},
        onError() {},
        taskId: 't1',
      },
      () => {},
    ).then(
      () => {},
      (error) => {
        rejected = true
        rejection = error instanceof Error ? error : new Error(String(error))
      },
    )

    // 35s of cold-start: daemon emits CREATED at T+0 and ACK at T+5s, but
    // watcher does not subscribe to either. No HEARTBEAT/LLM yet.
    emit(TaskEvents.CREATED, {taskId: 't1'})
    await clock.tickAsync(5000)
    emit(TaskEvents.ACK, {taskId: 't1'})
    await clock.tickAsync(30_000) // total 35s elapsed

    // Agent finally booted, first heartbeat arrives.
    const beat: TaskHeartbeatEvent = {lastActivityAt: Date.now(), taskId: 't1'}
    emit(TaskEvents.HEARTBEAT, beat)
    await clock.tickAsync(0)

    emit(TaskEvents.COMPLETED, {result: 'ok', taskId: 't1'})
    await promise

    expect(rejected).to.equal(false, `should not reject during cold-start; got: ${rejection?.message}`)
  })

  it('disposes cleanly on TaskEvents.CANCELLED — no phantom unresponsive after cancellation', async () => {
    const {client, emit} = makeClient()
    let rejected = false
    let rejection: Error | undefined

    const promise = waitForTaskCompletion(
      {
        client,
        command: 'curate',
        format: 'text',
        onCompleted() {},
        onError() {},
        taskId: 't1',
      },
      () => {},
    ).then(
      () => {},
      (error) => {
        rejected = true
        rejection = error instanceof Error ? error : new Error(String(error))
      },
    )

    await clock.tickAsync(5000)
    emit(TaskEvents.CANCELLED, {taskId: 't1'})

    await clock.tickAsync(60_000)
    await promise

    expect(rejected).to.equal(false, `should not reject; got: ${rejection?.message}`)
  })

})
