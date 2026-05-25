import {expect} from 'chai'

import {MockAcpDriver} from '../../../../../../src/server/infra/channel/drivers/mock-driver.js'

// Slice 2.2 — in-process scripted driver for the orchestrator unit tests.
// Same IAcpDriver surface as the subprocess-driven AcpDriver, but the event
// sequence is hand-rolled and there's no IO. Keeps orchestrator tests fast.

describe('MockAcpDriver', () => {
  it('start() resolves and exposes the scripted protocolVersion + capabilities', async () => {
    const driver = new MockAcpDriver({
      capabilities: ['embeddedContext'],
      events: [],
      handle: '@mock',
      protocolVersion: 1,
    })
    await driver.start()
    expect(driver.protocolVersion).to.equal(1)
    expect(driver.capabilities).to.deep.equal(['embeddedContext'])
  })

  it('prompt() yields the scripted payload-only events in order', async () => {
    const driver = new MockAcpDriver({
      events: [
        {content: 'chunk 1', kind: 'agent_message_chunk'},
        {content: 'chunk 2', kind: 'agent_message_chunk'},
      ],
      handle: '@mock',
    })
    await driver.start()

    const collected: unknown[] = []
    for await (const ev of driver.prompt({prompt: [], turnId: 't1'})) {
      collected.push(ev)
    }

    expect(collected).to.deep.equal([
      {content: 'chunk 1', kind: 'agent_message_chunk'},
      {content: 'chunk 2', kind: 'agent_message_chunk'},
    ])
  })

  it('prompt() emits a scripted permission_request and awaits respondToPermission before continuing', async () => {
    const driver = new MockAcpDriver({
      events: [
        {content: 'before', kind: 'agent_message_chunk'},
        {
          kind: 'permission_request',
          permissionRequestId: 'p-1',
          request: {
            options: [
              {kind: 'allow_once', name: 'Allow', optionId: 'opt-allow'},
            ],
            sessionId: 's',
            toolCall: {toolCallId: 'tc-1'},
          },
        },
        {content: 'after', kind: 'agent_message_chunk'},
      ],
      handle: '@mock',
    })
    await driver.start()

    const iter = driver.prompt({prompt: [], turnId: 't1'})
    const first = await iter.next()
    expect((first.value as {kind: string}).kind).to.equal('agent_message_chunk')

    const second = await iter.next()
    expect((second.value as {kind: string}).kind).to.equal('permission_request')

    // The "after" chunk MUST NOT arrive until the host responds. Detach the
    // next() promise so we can re-await it once respondToPermission lands.
    const thirdPromise = iter.next()
    const racing = await Promise.race([
      thirdPromise.then(() => 'arrived'),
      new Promise((resolve) => {
        setTimeout(() => resolve('timeout'), 30)
      }),
    ])
    expect(racing).to.equal('timeout')

    await driver.respondToPermission('p-1', {outcome: {optionId: 'opt-allow', outcome: 'selected'}})

    const third = await thirdPromise
    expect((third.value as {content: string}).content).to.equal('after')

    const done = await iter.next()
    expect(done.done).to.equal(true)
  })

  it('cancel() short-circuits the in-flight prompt iteration with a cancelled stopReason', async () => {
    const driver = new MockAcpDriver({
      events: [
        {content: 'first', kind: 'agent_message_chunk'},
        // Permission that will never be answered → blocks until cancel.
        {
          kind: 'permission_request',
          permissionRequestId: 'p-1',
          request: {options: [], sessionId: 's', toolCall: {toolCallId: 'tc-1'}},
        },
      ],
      handle: '@mock',
    })
    await driver.start()

    const iter = driver.prompt({prompt: [], turnId: 't1'})
    await iter.next() // first chunk
    await iter.next() // permission_request

    await driver.cancel('t1')

    const next = await iter.next()
    expect(next.done).to.equal(true)
  })
})
