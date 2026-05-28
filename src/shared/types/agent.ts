/**
 * Array of all supported Agents.
 */
export const AGENT_VALUES = [
  'Amp',
  'Antigravity',
  'Auggie CLI',
  'Augment Code',
  'Claude Code',
  'Claude Desktop',
  'Cline',
  'Codex',
  'Cursor',
  'Gemini CLI',
  'Github Copilot',
  'Hermes',
  'Junie',
  'Kilo Code',
  'Kiro',
  'OpenClaude',
  'OpenClaw',
  'OpenCode',
  'Qoder',
  'Qwen Code',
  'Roo Code',
  'Trae.ai',
  'Warp',
  'Windsurf',
  'Zed',
] as const

export type Agent = (typeof AGENT_VALUES)[number]

export const CLAUDE_DESKTOP: Agent = 'Claude Desktop'
