import type {PoolSelector, QuorumAgentRef} from './dispatcher.js'

// Phase 10 Slice 10.3 — pool classification + local-first / remote-only
// selectors.
//
// Tier 1 classifies based on `invocation.command`: a value that LOOKS like a
// URL or peer identifier ("http://", "ws://", "dht://", "peer:") is remote;
// anything else is treated as local (the spawnable-subprocess path used by
// the existing ACP drivers). Tier 2 will widen this with proper classification
// (HTTP/WS transport drivers, DHT peer discovery).
//
// `LocalFirstPoolSelector` and `RemoteOnlyPoolSelector` plug into
// `QuorumDispatcher` without modifying its internals (codex Q7 — Slice 10.3
// is an extension, not a refactor of 10.2's dispatcher).

const REMOTE_COMMAND_PATTERN = /^(?:https?|wss?|dht|peer):/i

export type AgentLocality = 'local' | 'remote'

export type ClassifiableAgent = QuorumAgentRef & {
  readonly invocation?: {readonly command?: string}
}

export function classifyAgent(agent: ClassifiableAgent): AgentLocality {
  const command = agent.invocation?.command
  if (command !== undefined && REMOTE_COMMAND_PATTERN.test(command)) {
    return 'remote'
  }

  return 'local'
}

export function makeLocalFirstPoolSelector<T extends ClassifiableAgent>(): PoolSelector<T> {
  return (agents) => {
    const local = agents.filter(a => classifyAgent(a) === 'local')
    if (local.length === 0) {
      // No local agents at all — fall through to the remote pool. Pool tag
      // becomes 'remote' so MergeContext.pool reflects reality.
      return {pool: 'remote', selectedAgents: agents}
    }

    return {pool: 'local', selectedAgents: local}
  }
}

export function makeRemoteOnlyPoolSelector<T extends ClassifiableAgent>(): PoolSelector<T> {
  return (agents) => ({
    pool: 'remote',
    selectedAgents: agents.filter(a => classifyAgent(a) === 'remote'),
  })
}

export function makeLocalOnlyPoolSelector<T extends ClassifiableAgent>(): PoolSelector<T> {
  return (agents) => ({
    pool: 'local',
    selectedAgents: agents.filter(a => classifyAgent(a) === 'local'),
  })
}
