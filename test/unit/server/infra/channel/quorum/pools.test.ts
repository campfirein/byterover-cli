import {expect} from 'chai'

import {
  type ClassifiableAgent,
  classifyAgent,
  makeLocalFirstPoolSelector,
  makeLocalOnlyPoolSelector,
  makeRemoteOnlyPoolSelector,
} from '../../../../../../src/server/infra/channel/quorum/pools.js'

function agent(handle: string, command?: string): ClassifiableAgent {
  return command === undefined ? {handle} : {handle, invocation: {command}}
}

describe('quorum/pools', () => {
describe('classifyAgent', () => {
  it('treats spawnable subprocess commands as local', () => {
    expect(classifyAgent(agent('@a', '/usr/local/bin/kimi'))).to.equal('local')
    expect(classifyAgent(agent('@b', 'codex'))).to.equal('local')
    expect(classifyAgent(agent('@c', 'node'))).to.equal('local')
  })

  it('treats URL-like and peer-id commands as remote', () => {
    expect(classifyAgent(agent('@a', 'https://example.com/agent'))).to.equal('remote')
    expect(classifyAgent(agent('@b', 'http://localhost:8080'))).to.equal('remote')
    expect(classifyAgent(agent('@c', 'ws://peer/agent'))).to.equal('remote')
    expect(classifyAgent(agent('@d', 'wss://secure-peer/agent'))).to.equal('remote')
    expect(classifyAgent(agent('@e', 'dht://abc123'))).to.equal('remote')
    expect(classifyAgent(agent('@f', 'peer:Qm12345'))).to.equal('remote')
  })

  it('defaults to local when invocation/command is missing', () => {
    expect(classifyAgent({handle: '@a'})).to.equal('local')
    expect(classifyAgent({handle: '@b', invocation: {}})).to.equal('local')
  })
})

describe('makeLocalFirstPoolSelector', () => {
  it('picks only local agents when local agents exist', () => {
    const agents = [
      agent('@a', '/bin/local-a'),
      agent('@b', 'https://remote-b'),
      agent('@c', '/bin/local-c'),
    ]
    const selector = makeLocalFirstPoolSelector<ClassifiableAgent>()
    const result = selector(agents)
    expect(result.pool).to.equal('local')
    expect(result.selectedAgents.map(a => a.handle).sort()).to.deep.equal(['@a', '@c'])
  })

  it('falls back to all agents (tagged remote) when no local exists', () => {
    const agents = [
      agent('@a', 'https://remote-a'),
      agent('@b', 'wss://remote-b'),
    ]
    const selector = makeLocalFirstPoolSelector<ClassifiableAgent>()
    const result = selector(agents)
    expect(result.pool).to.equal('remote')
    expect(result.selectedAgents).to.have.lengthOf(2)
  })
})

describe('makeRemoteOnlyPoolSelector', () => {
  it('picks only remote agents', () => {
    const agents = [
      agent('@a', '/bin/local'),
      agent('@b', 'https://remote-b'),
      agent('@c', 'dht://remote-c'),
    ]
    const selector = makeRemoteOnlyPoolSelector<ClassifiableAgent>()
    const result = selector(agents)
    expect(result.pool).to.equal('remote')
    expect(result.selectedAgents.map(a => a.handle).sort()).to.deep.equal(['@b', '@c'])
  })

  it('returns empty selection when no remote agents exist', () => {
    const agents = [agent('@a', '/bin/local-a'), agent('@b', '/bin/local-b')]
    const selector = makeRemoteOnlyPoolSelector<ClassifiableAgent>()
    const result = selector(agents)
    expect(result.selectedAgents).to.have.lengthOf(0)
  })
})

describe('makeLocalOnlyPoolSelector', () => {
  it('picks only local agents (no fallback to remote)', () => {
    const agents = [agent('@a', '/bin/local-a'), agent('@b', 'https://remote-b')]
    const selector = makeLocalOnlyPoolSelector<ClassifiableAgent>()
    const result = selector(agents)
    expect(result.pool).to.equal('local')
    expect(result.selectedAgents.map(a => a.handle)).to.deep.equal(['@a'])
  })
})
})
