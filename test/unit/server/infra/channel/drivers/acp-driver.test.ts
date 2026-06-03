import {expect} from 'chai'
import {fileURLToPath} from 'node:url'

import type {TurnEventPayload} from '../../../../../../src/server/core/interfaces/channel/i-agent-driver.js'

import {AgentBinaryNotFoundError} from '../../../../../../src/server/core/domain/channel/errors.js'
import {AcpDriver} from '../../../../../../src/server/infra/channel/drivers/acp-driver.js'

// Drives a real ACP subprocess (node test/fixtures/mock-acp.js) over stdio.
// Real timers only — the subprocess runs on the real event loop; faking timers
// would freeze the handshake while real I/O events still fire.

const MOCK_ACP = fileURLToPath(new URL('../../../../../fixtures/mock-acp.js', import.meta.url))
const MOCK_ACP_NOISY = fileURLToPath(new URL('../../../../../fixtures/mock-acp-noisy.js', import.meta.url))

const drain = async (iter: AsyncIterableIterator<TurnEventPayload>): Promise<TurnEventPayload[]> => {
  const events: TurnEventPayload[] = []
  for await (const event of iter) events.push(event)
  return events
}

describe('AcpDriver', () => {
  it('streams the fixture agent_message_chunk events in order then completes on end_turn', async () => {
    const driver = new AcpDriver({
      handle: '@mock',
      invocation: {args: [MOCK_ACP], command: process.execPath, cwd: process.cwd()},
    })
    await driver.start()
    try {
      const events = await drain(driver.prompt({prompt: [{text: 'hi', type: 'text'}], turnId: 't1'}))
      expect(events).to.deep.equal([
        {content: 'mock chunk 1', kind: 'agent_message_chunk'},
        {content: 'mock chunk 2', kind: 'agent_message_chunk'},
      ])
    } finally {
      await driver.stop()
    }
  })

  it('captures the initialize snapshot and probes session/new for onboarding', async () => {
    const driver = new AcpDriver({
      handle: '@mock',
      invocation: {args: [MOCK_ACP], command: process.execPath, cwd: process.cwd()},
    })
    await driver.start()
    try {
      expect(driver.protocolVersion).to.equal(1)
      expect(driver.acpInitialize?.agentCapabilities?.promptCapabilities?.embeddedContext).to.equal(false)
      expect(await driver.probeSession()).to.equal(true)
    } finally {
      await driver.stop()
    }
  })

  it('drops malformed and cross-session updates, yielding only this session’s chunks', async () => {
    const driver = new AcpDriver({
      handle: '@mock',
      invocation: {args: [MOCK_ACP_NOISY], command: process.execPath, cwd: process.cwd()},
    })
    await driver.start()
    try {
      const events = await drain(driver.prompt({prompt: [{text: 'hi', type: 'text'}], turnId: 't1'}))
      expect(events).to.deep.equal([
        {content: 'real chunk 1', kind: 'agent_message_chunk'},
        {content: 'real chunk 2', kind: 'agent_message_chunk'},
      ])
    } finally {
      await driver.stop()
    }
  })

  it('exposes the configured handle', () => {
    const driver = new AcpDriver({
      handle: '@mock',
      invocation: {args: [MOCK_ACP], command: process.execPath, cwd: process.cwd()},
    })
    expect(driver.handle).to.equal('@mock')
  })

  it('reports lifecycle status across start → prompt → stop', async () => {
    const driver = new AcpDriver({
      handle: '@mock',
      invocation: {args: [MOCK_ACP], command: process.execPath, cwd: process.cwd()},
    })
    expect(driver.status).to.equal('idle')
    await driver.start()
    expect(driver.status).to.equal('idle')

    const iter = driver.prompt({prompt: [{text: 'go', type: 'text'}], turnId: 't1'})
    expect(driver.status).to.equal('streaming')
    await drain(iter)
    expect(driver.status).to.equal('idle')

    await driver.stop()
    expect(driver.status).to.equal('stopped')
  })

  it('throws AgentBinaryNotFoundError when the binary does not exist', async () => {
    const driver = new AcpDriver({
      handle: '@ghost',
      invocation: {args: [], command: '/nonexistent/brv-acp-not-a-real-binary', cwd: process.cwd()},
    })
    let caught: unknown
    await driver.start().catch((error: unknown) => {
      caught = error
    })
    expect(caught).to.be.instanceOf(AgentBinaryNotFoundError)
    expect(driver.status).to.equal('errored')
  })

  it('rejects a concurrent prompt while one is in flight, then allows a sequential one', async () => {
    const driver = new AcpDriver({
      handle: '@mock',
      invocation: {args: [MOCK_ACP], command: process.execPath, cwd: process.cwd()},
    })
    await driver.start()
    try {
      const iter = driver.prompt({prompt: [{text: 'one', type: 'text'}], turnId: 't1'})
      expect(() => driver.prompt({prompt: [{text: 'two', type: 'text'}], turnId: 't2'})).to.throw(
        /already in flight/,
      )
      await drain(iter)

      // Once the first turn drains, a fresh prompt is allowed (session reused).
      const events = await drain(driver.prompt({prompt: [{text: 'three', type: 'text'}], turnId: 't3'}))
      expect(events).to.deep.equal([
        {content: 'mock chunk 1', kind: 'agent_message_chunk'},
        {content: 'mock chunk 2', kind: 'agent_message_chunk'},
      ])
    } finally {
      await driver.stop()
    }
  })

  it('start() and stop() are idempotent', async () => {
    const driver = new AcpDriver({
      handle: '@mock',
      invocation: {args: [MOCK_ACP], command: process.execPath, cwd: process.cwd()},
    })
    await driver.start()
    await driver.start()
    await driver.stop()
    await driver.stop()
    expect(driver.status).to.equal('stopped')
  })
})
