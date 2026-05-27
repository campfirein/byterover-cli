import type {ConnectorType} from './connector-type.js'

export {type Agent, AGENT_VALUES} from '../../../../shared/types/agent.js'

// Re-import Agent for use in this file's type definitions
import {type Agent, AGENT_VALUES} from '../../../../shared/types/agent.js'

const agentSet: ReadonlySet<string> = new Set(AGENT_VALUES)

export function isAgent(value: string): value is Agent {
  return agentSet.has(value)
}

/**
 * Connector availability configuration for an agent.
 */
type AgentConnectorConfig = {
  /** The default connector type for this agent */
  default: ConnectorType
  /** Connector types supported by this agent */
  supported: readonly ConnectorType[]
}

/**
 * Single source of truth for agent connector configuration.
 * Defines which connectors each agent supports and which is the default.
 */
export const AGENT_CONNECTOR_CONFIG: Record<Agent, AgentConnectorConfig> = {
  Amp: {
    default: 'skill',
    supported: ['rules', 'mcp', 'skill'],
  },
  Antigravity: {
    default: 'skill',
    supported: ['rules', 'mcp', 'skill'],
  },
  'Auggie CLI': {
    default: 'skill',
    supported: ['rules', 'mcp', 'skill'],
  },
  'Augment Code': {
    default: 'mcp',
    supported: ['rules', 'mcp'],
  },
  'Claude Code': {
    default: 'skill',
    supported: ['rules', 'hook', 'mcp', 'skill'],
  },
  'Claude Desktop': {
    default: 'mcp',
    supported: ['mcp'],
  },
  Cline: {
    default: 'mcp',
    supported: ['rules', 'mcp'],
  },
  Codex: {
    default: 'skill',
    supported: ['rules', 'mcp', 'skill'],
  },
  Cursor: {
    default: 'skill',
    supported: ['rules', 'mcp', 'skill'],
  },
  'Gemini CLI': {
    default: 'skill',
    supported: ['rules', 'mcp', 'skill'],
  },
  'Github Copilot': {
    default: 'skill',
    supported: ['rules', 'mcp', 'skill'],
  },
  Hermes: {
    default: 'skill',
    supported: ['mcp', 'skill'],
  },
  Junie: {
    default: 'skill',
    supported: ['rules', 'mcp', 'skill'],
  },
  'Kilo Code': {
    default: 'skill',
    supported: ['rules', 'mcp', 'skill'],
  },
  Kiro: {
    default: 'skill',
    supported: ['rules', 'mcp', 'skill'],
  },
  OpenClaude: {
    default: 'skill',
    supported: ['rules', 'mcp', 'skill'],
  },
  OpenClaw: {
    default: 'skill',
    supported: ['skill'],
  },
  OpenCode: {
    default: 'skill',
    supported: ['rules', 'mcp', 'skill'],
  },
  Qoder: {
    default: 'skill',
    supported: ['rules', 'mcp', 'skill'],
  },
  'Qwen Code': {
    default: 'mcp',
    supported: ['rules', 'mcp'],
  },
  'Roo Code': {
    default: 'skill',
    supported: ['rules', 'mcp', 'skill'],
  },
  'Trae.ai': {
    default: 'skill',
    supported: ['rules', 'mcp', 'skill'],
  },
  Warp: {
    default: 'skill',
    supported: ['rules', 'mcp', 'skill'],
  },
  Windsurf: {
    default: 'skill',
    supported: ['rules', 'mcp', 'skill'],
  },
  Zed: {
    default: 'mcp',
    supported: ['rules', 'mcp'],
  },
}
