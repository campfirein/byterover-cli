import type {AgentDTO, ConnectorDTO} from '../../../../shared/transport/types/dto'

import {DOCS_AGENT_NAMES, DOCS_AGENTS, type DocsAgent} from './docs-agents'

const PRIORITY_AGENT_ORDER: readonly string[] = [
  'Claude Code',
  'Codex',
  'OpenCode',
  'OpenClaw',
  'Hermes',
]

export type ConnectorListEntry =
  | {readonly agent: AgentDTO; readonly kind: 'available'}
  | {readonly connector: ConnectorDTO; readonly kind: 'installed'}
  | {readonly docs: DocsAgent; readonly kind: 'docs'}

export function entryName(entry: ConnectorListEntry): string {
  switch (entry.kind) {
    case 'available': {
      return entry.agent.name
    }

    case 'docs': {
      return entry.docs.name
    }

    case 'installed': {
      return entry.connector.agent
    }
  }
}

type BuildArgs = {
  readonly agents: readonly AgentDTO[]
  readonly connectors: readonly ConnectorDTO[]
}

export function buildConnectorList({agents, connectors}: BuildArgs): ConnectorListEntry[] {
  const entries: ConnectorListEntry[] = []
  const installedNames = new Set<string>()

  for (const connector of connectors) {
    if (DOCS_AGENT_NAMES.has(connector.agent)) continue
    entries.push({connector, kind: 'installed'})
    installedNames.add(connector.agent)
  }

  for (const agent of agents) {
    if (DOCS_AGENT_NAMES.has(agent.name)) continue
    if (installedNames.has(agent.name)) continue
    entries.push({agent, kind: 'available'})
  }

  for (const docs of DOCS_AGENTS) {
    entries.push({docs, kind: 'docs'})
  }

  return sortByPriority(entries)
}

function byPriorityIndex(a: ConnectorListEntry, b: ConnectorListEntry): number {
  const aIdx = PRIORITY_AGENT_ORDER.indexOf(entryName(a))
  const bIdx = PRIORITY_AGENT_ORDER.indexOf(entryName(b))
  if (aIdx !== -1 && bIdx !== -1) return aIdx - bIdx
  if (aIdx !== -1) return -1
  if (bIdx !== -1) return 1
  return 0
}

function sortByPriority(entries: readonly ConnectorListEntry[]): ConnectorListEntry[] {
  const installed: ConnectorListEntry[] = []
  const priority: ConnectorListEntry[] = []
  const rest: ConnectorListEntry[] = []

  for (const entry of entries) {
    if (entry.kind === 'installed') {
      installed.push(entry)
    } else if (PRIORITY_AGENT_ORDER.includes(entryName(entry))) {
      priority.push(entry)
    } else {
      rest.push(entry)
    }
  }

  installed.sort(byPriorityIndex)
  priority.sort(byPriorityIndex)

  return [...installed, ...priority, ...rest]
}
