import {expect} from 'chai'
import {dirname, resolve} from 'node:path'
import {fileURLToPath} from 'node:url'

import {AcpHandshakeFailedError} from '../../../../../../src/server/core/domain/channel/errors.js'
import {AcpDriver} from '../../../../../../src/server/infra/channel/drivers/acp-driver.js'

// Slice 2.2 — subprocess-driven ACP driver. Spawns the mock-acp.js fixtures
// from Slice 2.1 and exercises start() / prompt() / cancel() / stop().

const HARNESS_DIR = dirname(fileURLToPath(import.meta.url))
// test/unit/server/infra/channel/drivers/ → up six levels to byterover-cli/
const REPO_ROOT = resolve(HARNESS_DIR, '..', '..', '..', '..', '..', '..')
const MOCK_ACP_PATH = resolve(REPO_ROOT, 'test', 'fixtures', 'mock-acp.js')
const MOCK_BAD_HANDSHAKE_PATH = resolve(REPO_ROOT, 'test', 'fixtures', 'mock-acp-bad-handshake.js')

describe('AcpDriver', function () {
  this.timeout(20_000)

  it('start() spawns the child, runs ACP initialize, and caches protocolVersion + capabilities', async () => {
    const driver = new AcpDriver({
      handle: '@mock',
      invocation: {args: [MOCK_ACP_PATH], command: 'node', cwd: REPO_ROOT},
    })
    try {
      await driver.start()
      expect(driver.protocolVersion).to.equal(1)
      expect(driver.capabilities, 'capabilities cached from agentCapabilities.promptCapabilities').to.be.an(
        'array',
      )
    } finally {
      await driver.stop()
    }
  })

  it('start() throws AcpHandshakeFailedError when the agent rejects initialize', async () => {
    const driver = new AcpDriver({
      handle: '@bad',
      invocation: {args: [MOCK_BAD_HANDSHAKE_PATH], command: 'node', cwd: REPO_ROOT},
    })
    try {
      await driver.start()
      expect.fail('expected AcpHandshakeFailedError')
    } catch (error) {
      expect(error).to.be.instanceOf(AcpHandshakeFailedError)
    } finally {
      await driver.stop()
    }
  })

  it('prompt() lazily creates a session and yields projected TurnEvent payloads', async () => {
    const driver = new AcpDriver({
      handle: '@mock',
      invocation: {args: [MOCK_ACP_PATH], command: 'node', cwd: REPO_ROOT},
    })
    try {
      await driver.start()
      const collected: Array<{content?: string; kind: string}> = []
      for await (const ev of driver.prompt({prompt: [{text: 'hi', type: 'text'}], turnId: 't-1'})) {
        collected.push(ev as {content?: string; kind: string})
      }

      const chunks = collected.filter((e) => e.kind === 'agent_message_chunk')
      expect(chunks).to.have.lengthOf.at.least(1)
      expect(chunks[0].content).to.match(/mock chunk/)
    } finally {
      await driver.stop()
    }
  })
})
