// @brv/agent-sdk — thin ergonomic wrapper over the Agent Client Protocol
// for building agents that join brv channels.
//
// See `CHANNEL_PROTOCOL.md` §15 for the wire spec this SDK targets.

export {
  ChannelAgent,
  type ChannelAgentConfig,
  type ChannelAgentRunOptions,
  type CancelHandler,
  type PromptHandler,
} from './channel-agent.js'

export {
  PromptContext,
  type PromptContextOptions,
  type RequestPermissionArgs,
  type SendToolCallArgs,
  type SendToolCallUpdateArgs,
} from './prompt-context.js'

// Re-export the upstream payload types so consumers don't need a second
// dependency declaration in their own package.json for type imports.
export type {
  ContentBlock,
  PromptRequest,
  PromptResponse,
  RequestPermissionOutcome,
  ToolCallContent,
} from '@agentclientprotocol/sdk'

export const VERSION = '0.1.0'
