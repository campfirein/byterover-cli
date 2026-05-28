import {expect} from 'chai'
import {restore, stub} from 'sinon'

import type {AgentConfig} from '../../../../src/agent/infra/agent/index.js'

import {CipherAgent} from '../../../../src/agent/infra/agent/index.js'

describe('CipherAgent.cancelTask', () => {
  let agentConfig: AgentConfig

  beforeEach(() => {
    agentConfig = {
      apiBaseUrl: 'http://localhost:3333',
      blobStorage: {
        maxBlobSize: 100 * 1024 * 1024,
        maxTotalSize: 1024 * 1024 * 1024,
        storageDir: '/tmp/brv-test-blobs',
      },
      llm: {
        maxIterations: 10,
        maxTokens: 1000,
        temperature: 0.5,
      },
      model: 'gemini-2.5-flash',
      projectId: 'byterover',
      sessionKey: 'test-session-key',
      storagePath: '/tmp/brv-test-storage',
    }
    stub(console, 'log')
  })

  afterEach(() => {
    restore()
  })

  it('returns false when no session holds the taskId', async () => {
    const agent = new CipherAgent(agentConfig)
    await agent.start()
    try {
      const result = await agent.cancelTask('unknown-task')
      expect(result).to.equal(false)
    } finally {
      await agent.stop()
    }
  })

  it('returns true when at least one session cancels the taskId', async () => {
    const agent = new CipherAgent(agentConfig)
    await agent.start()
    try {
      const sessions = agent.listSessions()
      expect(sessions.length).to.be.greaterThan(0)
      const session = agent.getSession(sessions[0])
      expect(session).to.not.be.undefined
      stub(session!, 'cancel').returns(true)

      const result = await agent.cancelTask('task-A')
      expect(result).to.equal(true)
    } finally {
      await agent.stop()
    }
  })

  it('returns true when any one of several sessions cancels the taskId', async () => {
    const agent = new CipherAgent(agentConfig)
    await agent.start()
    try {
      await agent.createSession('extra-1')
      await agent.createSession('extra-2')

      const sessions = agent.listSessions()
      expect(sessions.length).to.be.gte(3)

      // First two sessions report false, last reports true.
      const last = sessions.at(-1)!
      for (const id of sessions) {
        const s = agent.getSession(id)!
        stub(s, 'cancel').returns(id === last)
      }

      const result = await agent.cancelTask('task-B')
      expect(result).to.equal(true)
    } finally {
      await agent.stop()
    }
  })

  it('is idempotent: second call returns false after the controller is gone', async () => {
    const agent = new CipherAgent(agentConfig)
    await agent.start()
    try {
      const sessions = agent.listSessions()
      const session = agent.getSession(sessions[0])!
      const cancelStub = stub(session, 'cancel')
      cancelStub.onFirstCall().returns(true)
      cancelStub.onSecondCall().returns(false)

      const first = await agent.cancelTask('task-C')
      const second = await agent.cancelTask('task-C')

      expect(first).to.equal(true)
      expect(second).to.equal(false)
    } finally {
      await agent.stop()
    }
  })

  it('throws if called before start()', async () => {
    const agent = new CipherAgent(agentConfig)
    try {
      await agent.cancelTask('task-X')
      expect.fail('Should have thrown')
    } catch (error) {
      expect((error as Error).message).to.include('must be started')
    }
  })
})
