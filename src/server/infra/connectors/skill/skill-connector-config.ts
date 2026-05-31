import type {Agent} from '../../../core/domain/entities/agent.js'

/**
 * Configuration for agent-specific skill file directories.
 * Paths are relative to their respective roots and do NOT include the skill name.
 */
export type SkillConnectorConfig = {
  /**
   * Optional saved sub-agent definition deployed alongside the skill files.
   * `source` is a file name under `src/server/templates/agent/`; `target` is
   * the destination path resolved against the project root (project scope) or
   * home directory (global scope). Surfaces that don't support saved
   * sub-agents (Cursor, Windsurf, etc.) omit this field.
   */
  agentFile?: {
    source: string
    target: string
  }
  /**
   * Optional autonomous-agent instruction target that receives the managed
   * ByteRover rules block in addition to the skill files.
   */
  attachment?: 'hermes' | 'openclaw'
  /** Base directory for skill files relative to user home directory */
  globalPath: string
  /** Root used for globalPath. Defaults to user home. */
  globalRoot?: 'hermes-home' | 'home' | 'openclaw-state'
  /** Base directory for skill files relative to project root */
  projectPath: null | string
}

/**
 * Agent-specific skill connector configurations.
 * Maps each supported agent to its project and global skill directory paths.
 */
export const SKILL_CONNECTOR_CONFIGS = {
  Amp: {
    globalPath: '.config/agents/skills',
    projectPath: '.agents/skills',
  },
  Antigravity: {
    globalPath: '.gemini/antigravity/skills',
    projectPath: '.agent/skills',
  },
  'Auggie CLI': {
    globalPath: '.augment/skills',
    projectPath: '.augment/skills',
  },
  'Claude Code': {
    agentFile: {
      source: 'brv-curate.md',
      target: '.claude/agents/brv-curate.md',
    },
    globalPath: '.claude/skills',
    projectPath: '.claude/skills',
  },
  Codex: {
    agentFile: {
      source: 'brv-curate.toml',
      target: '.codex/agents/brv-curate.toml',
    },
    globalPath: '.agents/skills',
    projectPath: '.agents/skills',
  },
  Cursor: {
    globalPath: '.cursor/skills',
    projectPath: '.cursor/skills',
  },
  'Gemini CLI': {
    globalPath: '.gemini/skills',
    projectPath: '.gemini/skills',
  },
  'Github Copilot': {
    globalPath: '.copilot/skills',
    projectPath: '.github/skills',
  },
  Hermes: {
    attachment: 'hermes',
    globalPath: 'skills',
    globalRoot: 'hermes-home',
    projectPath: null,
  },
  Junie: {
    globalPath: '.junie/skills',
    projectPath: '.junie/skills',
  },
  'Kilo Code': {
    globalPath: '.kilocode/skills',
    projectPath: '.kilocode/skills',
  },
  Kiro: {
    globalPath: '.kiro/skills',
    projectPath: '.kiro/skills',
  },
  OpenClaude: {
    globalPath: '.claude/skills',
    projectPath: '.claude/skills',
  },
  OpenClaw: {
    attachment: 'openclaw',
    globalPath: 'skills',
    globalRoot: 'openclaw-state',
    projectPath: null,
  },
  OpenCode: {
    globalPath: '.config/opencode/skills',
    projectPath: '.opencode/skills',
  },
  Qoder: {
    globalPath: '.qoder/skills',
    projectPath: '.qoder/skills',
  },
  'Roo Code': {
    globalPath: '.roo/skills',
    projectPath: '.roo/skills',
  },
  'Trae.ai': {
    globalPath: '.trae/skills',
    projectPath: '.trae/skills',
  },
  Warp: {
    globalPath: '.warp/skills',
    projectPath: '.warp/skills',
  },
  Windsurf: {
    globalPath: '.codeium/windsurf/skills',
    projectPath: '.windsurf/skills',
  },
} as const satisfies Partial<Record<Agent, SkillConnectorConfig>>

/**
 * Type representing agents that have skill connector support.
 */
export type SkillSupportedAgent = keyof typeof SKILL_CONNECTOR_CONFIGS

/**
 * Name used for the ByteRover connector skill subdirectory.
 */
export const BRV_SKILL_NAME = 'byterover'

/**
 * Name of the main skill file.
 */
export const MAIN_SKILL_FILE_NAME = 'SKILL.md'

/**
 * Names of the skill files written by the skill connector.
 *
 * The first entry MUST be MAIN_SKILL_FILE_NAME — `status` and `uninstall`
 * use it as the install marker.
 */
export const SKILL_FILE_NAMES = [
  MAIN_SKILL_FILE_NAME,
  'onboarding.md',
  'query.md',
  'curate.md',
  'review.md',
  'swarm.md',
  'vc.md',
  'dream.md',
  'history.md',
  'troubleshooting.md',
] as const
