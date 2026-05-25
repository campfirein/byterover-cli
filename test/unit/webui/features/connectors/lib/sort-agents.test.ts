import {expect} from 'chai'

import type {AgentDTO, ConnectorDTO} from '../../../../../../src/shared/transport/types/dto.js'

import {
  buildConnectorList,
  type ConnectorListEntry,
} from '../../../../../../src/webui/features/connectors/lib/sort-agents.js'

function makeAgent(overrides: Partial<AgentDTO> = {}): AgentDTO {
  return {
    defaultConnectorType: 'mcp',
    id: 'Cursor',
    name: 'Cursor',
    supportedConnectorTypes: ['mcp', 'rules'],
    ...overrides,
  }
}

function makeConnector(overrides: Partial<ConnectorDTO> = {}): ConnectorDTO {
  return {
    agent: 'Cursor',
    connectorType: 'mcp',
    defaultType: 'mcp',
    supportedTypes: ['mcp', 'rules'],
    ...overrides,
  }
}

function nameOf(entry: ConnectorListEntry): string {
  if (entry.kind === 'available') return entry.agent.name
  if (entry.kind === 'docs') return entry.docs.name
  return entry.connector.agent
}

describe('buildConnectorList', () => {
  it('orders priority agents first in the configured sequence', () => {
    const list = buildConnectorList({
      agents: [
        makeAgent({id: 'Cursor', name: 'Cursor'}),
        makeAgent({id: 'Codex', name: 'Codex'}),
        makeAgent({id: 'Claude Code', name: 'Claude Code'}),
        makeAgent({id: 'OpenCode', name: 'OpenCode'}),
      ],
      connectors: [],
    })

    const names = list.map((entry) => nameOf(entry))
    expect(names.slice(0, 5)).to.deep.equal(['Claude Code', 'Codex', 'OpenCode', 'OpenClaw', 'Hermes'])
    expect(names[5]).to.equal('Cursor')
  })

  it('places installed agents first within their priority slot and keeps available ones after', () => {
    const list = buildConnectorList({
      agents: [
        makeAgent({id: 'Claude Code', name: 'Claude Code'}),
        makeAgent({id: 'Codex', name: 'Codex'}),
      ],
      connectors: [makeConnector({agent: 'Claude Code'})],
    })

    const claudeEntry = list.find((e) => nameOf(e) === 'Claude Code')
    const codexEntry = list.find((e) => nameOf(e) === 'Codex')
    expect(claudeEntry?.kind).to.equal('installed')
    expect(codexEntry?.kind).to.equal('available')
  })

  it('always emits OpenClaw and Hermes as docs entries, even if daemon returns OpenClaw', () => {
    const list = buildConnectorList({
      agents: [makeAgent({id: 'OpenClaw', name: 'OpenClaw'})],
      connectors: [],
    })

    const openclaw = list.find((e) => nameOf(e) === 'OpenClaw')
    const hermes = list.find((e) => nameOf(e) === 'Hermes')
    expect(openclaw?.kind).to.equal('docs')
    expect(hermes?.kind).to.equal('docs')
    expect(list.filter((e) => nameOf(e) === 'OpenClaw')).to.have.lengthOf(1)
  })

  it('skips an installed OpenClaw connector — it never appears as installed', () => {
    const list = buildConnectorList({
      agents: [],
      connectors: [makeConnector({agent: 'OpenClaw'})],
    })

    const openclawEntries = list.filter((e) => nameOf(e) === 'OpenClaw')
    expect(openclawEntries).to.have.lengthOf(1)
    expect(openclawEntries[0].kind).to.equal('docs')
  })

  it('places non-priority agents after the priority block in input order', () => {
    const list = buildConnectorList({
      agents: [
        makeAgent({id: 'Zed', name: 'Zed'}),
        makeAgent({id: 'Cursor', name: 'Cursor'}),
        makeAgent({id: 'Codex', name: 'Codex'}),
        makeAgent({id: 'Cline', name: 'Cline'}),
      ],
      connectors: [],
    })

    const names = list.map((entry) => nameOf(entry))
    const codexIdx = names.indexOf('Codex')
    const zedIdx = names.indexOf('Zed')
    const cursorIdx = names.indexOf('Cursor')
    const clineIdx = names.indexOf('Cline')
    expect(codexIdx).to.be.lessThan(zedIdx)
    expect(zedIdx).to.be.lessThan(cursorIdx)
    expect(cursorIdx).to.be.lessThan(clineIdx)
  })

  it('places connected agents before the unconnected priority block', () => {
    const list = buildConnectorList({
      agents: [
        makeAgent({id: 'Cursor', name: 'Cursor'}),
        makeAgent({id: 'Claude Code', name: 'Claude Code'}),
        makeAgent({id: 'Codex', name: 'Codex'}),
      ],
      connectors: [makeConnector({agent: 'Cursor'})],
    })

    const names = list.map((entry) => nameOf(entry))
    expect(names.indexOf('Cursor')).to.equal(0)
    expect(names.indexOf('Cursor')).to.be.lessThan(names.indexOf('Claude Code'))
    expect(names.indexOf('Cursor')).to.be.lessThan(names.indexOf('Codex'))
  })

  it('orders multiple connected agents by the priority list', () => {
    const list = buildConnectorList({
      agents: [
        makeAgent({id: 'Cursor', name: 'Cursor'}),
        makeAgent({id: 'Claude Code', name: 'Claude Code'}),
        makeAgent({id: 'Codex', name: 'Codex'}),
      ],
      connectors: [
        makeConnector({agent: 'Cursor'}),
        makeConnector({agent: 'Codex'}),
        makeConnector({agent: 'Claude Code'}),
      ],
    })

    const names = list.map((entry) => nameOf(entry))
    expect(names.indexOf('Claude Code')).to.be.lessThan(names.indexOf('Codex'))
    expect(names.indexOf('Codex')).to.be.lessThan(names.indexOf('Cursor'))
  })

  it('does not duplicate an agent that appears in both agents and connectors', () => {
    const list = buildConnectorList({
      agents: [makeAgent({id: 'Cursor', name: 'Cursor'})],
      connectors: [makeConnector({agent: 'Cursor'})],
    })

    const cursorEntries = list.filter((e) => nameOf(e) === 'Cursor')
    expect(cursorEntries).to.have.lengthOf(1)
    expect(cursorEntries[0].kind).to.equal('installed')
  })
})
