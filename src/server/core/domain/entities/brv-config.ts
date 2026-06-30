import {BRV_CONFIG_VERSION} from '../../../constants.js'
import {Agent, AGENT_VALUES} from './agent.js'
import {Space} from './space.js'

/**
 * Per-project language preference. Drives the language-preservation clause
 * surfaced through the curate kickoff / correction prompts.
 *
 * - `auto`: instruct the LLM to match the user's input language.
 * - `fixed`: instruct the LLM to write in a specific language (ISO 639-1).
 *   `code` is required when `mode === 'fixed'`; the loader rejects fixed
 *   without code so silent fallback to English is structurally impossible.
 */
export type BrvConfigLanguage = {
  code?: string
  mode: 'auto' | 'fixed'
}

/**
 * Parameters for creating a BrvConfig instance.
 * chatLogPath, cwd, ide, and cloud fields (spaceId, spaceName, teamId, teamName)
 * are optional to support local-only configs and partial configs.
 */
export type BrvConfigParams = {
  chatLogPath?: string
  cipherAgentContext?: string
  cipherAgentModes?: string[]
  cipherAgentSystemPrompt?: string
  createdAt: string
  cwd?: string
  ide?: Agent
  language?: BrvConfigLanguage
  reviewDisabled?: boolean
  spaceId?: string
  spaceName?: string
  teamId?: string
  teamName?: string
  version: string
}

/**
 * Parameters for creating a BrvConfig from a Space entity.
 */
export type FromSpaceParams = {
  chatLogPath: string
  cwd: string
  ide: Agent
  space: Space
}

/**
 * Parameters for creating a partial BrvConfig from a Space entity.
 * Used for login pre-select when user has only one team and one space.
 */
export type PartialFromSpaceParams = {
  space: Space
}

/**
 * Shape of JSON read from .brv/config.json (version may be missing in old configs).
 */
type BrvConfigFromJson = Omit<BrvConfigParams, 'version'> & {
  version?: string
}

/**
 * Type guard for Agent validation
 */
const isCodingAgent = (value: unknown): value is Agent => {
  if (typeof value !== 'string') return false
  for (const agent of AGENT_VALUES) {
    if (agent === value) return true
  }

  return false
}

/**
 * Validate the shape of a `language` field on a config JSON object.
 * Accepts `undefined` (the field is optional). For present values:
 * - must be a non-null object with `mode: 'auto' | 'fixed'`
 * - `code` is required when `mode === 'fixed'` (silent fallback to
 *   English would otherwise be possible at prompt time)
 */
const isOptionalLanguageJson = (value: unknown): boolean => {
  if (value === undefined) return true
  if (typeof value !== 'object' || value === null) return false
  const lang = value as Record<string, unknown>
  if (lang.mode !== 'auto' && lang.mode !== 'fixed') return false
  if (lang.code !== undefined && typeof lang.code !== 'string') return false
  if (lang.mode === 'fixed' && typeof lang.code !== 'string') return false
  return true
}

/**
 * Type guard for BrvConfigFromJson - validates JSON structure at runtime.
 * Note: version is optional in this check (old configs may not have it).
 * chatLogPath, cwd, and ide are optional to support partial configs.
 */
const isBrvConfigJson = (json: unknown): json is BrvConfigFromJson => {
  if (typeof json !== 'object' || json === null) return false

  const requiredInputJsonKeys = ['createdAt'] as const satisfies readonly (keyof BrvConfigFromJson)[]

  for (const key of requiredInputJsonKeys) {
    if (!(key in json) || typeof (json as Record<string, unknown>)[key] !== 'string') {
      return false
    }
  }

  // Check optional fields if present
  const obj = json as Record<string, unknown>
  if (obj.chatLogPath !== undefined && typeof obj.chatLogPath !== 'string') return false
  if (obj.cwd !== undefined && typeof obj.cwd !== 'string') return false
  if (obj.ide !== undefined && !isCodingAgent(obj.ide)) return false
  if (obj.spaceId !== undefined && typeof obj.spaceId !== 'string') return false
  if (obj.spaceName !== undefined && typeof obj.spaceName !== 'string') return false
  if (obj.teamId !== undefined && typeof obj.teamId !== 'string') return false
  if (obj.teamName !== undefined && typeof obj.teamName !== 'string') return false
  if (obj.cipherAgentContext !== undefined && typeof obj.cipherAgentContext !== 'string') return false
  if (obj.cipherAgentSystemPrompt !== undefined && typeof obj.cipherAgentSystemPrompt !== 'string') return false
  if (obj.cipherAgentModes !== undefined && !Array.isArray(obj.cipherAgentModes)) return false
  if (obj.version !== undefined && typeof obj.version !== 'string') return false
  if (obj.reviewDisabled !== undefined && typeof obj.reviewDisabled !== 'boolean') return false
  if (!isOptionalLanguageJson(obj.language)) return false

  return true
}

/**
 * Represents the configuration stored in .brv/config.json
 * This config links a project directory to a ByteRover space.
 */
export class BrvConfig {
  public readonly chatLogPath?: string
  public readonly cipherAgentContext?: string
  public readonly cipherAgentModes?: string[]
  public readonly cipherAgentSystemPrompt?: string
  public readonly createdAt: string
  public readonly cwd?: string
  public readonly ide?: Agent
  public readonly language?: BrvConfigLanguage
  public readonly reviewDisabled?: boolean
  public readonly spaceId?: string
  public readonly spaceName?: string
  public readonly teamId?: string
  public readonly teamName?: string
  public readonly version: string

  public constructor(params: BrvConfigParams) {
    if (params.createdAt.trim().length === 0) {
      throw new Error('Created at cannot be empty')
    }

    this.chatLogPath = params.chatLogPath
    this.cipherAgentContext = params.cipherAgentContext
    this.cipherAgentModes = params.cipherAgentModes
    this.cipherAgentSystemPrompt = params.cipherAgentSystemPrompt
    this.createdAt = params.createdAt
    this.cwd = params.cwd
    this.ide = params.ide
    this.language = params.language
    this.reviewDisabled = params.reviewDisabled
    this.spaceId = params.spaceId
    this.spaceName = params.spaceName
    this.teamId = params.teamId
    this.teamName = params.teamName
    this.version = params.version
  }

  /**
   * Creates a minimal local-only BrvConfig (no cloud fields).
   * Used for auto-init when .brv/ doesn't exist.
   */
  public static createLocal(params: {cwd: string}): BrvConfig {
    return new BrvConfig({
      createdAt: new Date().toISOString(),
      cwd: params.cwd,
      version: BRV_CONFIG_VERSION,
    })
  }

  /**
   * Deserializes config from JSON format.
   * Preserves the original version from the file (or defaults to '' if missing).
   * Callers should check config.version and migrate if needed.
   * @throws Error if the JSON structure is invalid.
   */
  public static fromJson(json: unknown): BrvConfig {
    if (typeof json !== 'object' || json === null || json === undefined) {
      throw new Error('BrvConfig JSON must be an object')
    }

    if (!isBrvConfigJson(json)) {
      throw new Error('Invalid BrvConfig JSON structure')
    }

    const jsonObj = json as Record<string, unknown>
    const version = typeof jsonObj.version === 'string' ? jsonObj.version : ''

    return new BrvConfig({...json, version})
  }

  /**
   * Creates a BrvConfig from a Space entity.
   */
  public static fromSpace(params: FromSpaceParams): BrvConfig {
    return new BrvConfig({
      chatLogPath: params.chatLogPath,
      createdAt: new Date().toISOString(),
      cwd: params.cwd,
      ide: params.ide,
      spaceId: params.space.id,
      spaceName: params.space.name,
      teamId: params.space.teamId,
      teamName: params.space.teamName,
      version: BRV_CONFIG_VERSION,
    })
  }

  /**
   * Creates a partial BrvConfig from a Space entity.
   * Used for login pre-select when user has only one team and one space.
   * Does not include chatLogPath, cwd, or ide (agent selection happens in /init).
   */
  public static partialFromSpace(params: PartialFromSpaceParams): BrvConfig {
    return new BrvConfig({
      createdAt: new Date().toISOString(),
      spaceId: params.space.id,
      spaceName: params.space.name,
      teamId: params.space.teamId,
      teamName: params.space.teamName,
      version: BRV_CONFIG_VERSION,
    })
  }

  /**
   * Returns true when all cloud fields (spaceId, spaceName, teamId, teamName) are set.
   */
  public isCloudConnected(): boolean {
    return Boolean(this.spaceId && this.spaceName && this.teamId && this.teamName)
  }

  /**
   * Serializes the config to JSON format
   */
  public toJson(): Record<string, unknown> {
    return {
      chatLogPath: this.chatLogPath,
      cipherAgentContext: this.cipherAgentContext,
      cipherAgentModes: this.cipherAgentModes,
      cipherAgentSystemPrompt: this.cipherAgentSystemPrompt,
      createdAt: this.createdAt,
      cwd: this.cwd,
      ide: this.ide,
      language: this.language,
      reviewDisabled: this.reviewDisabled,
      spaceId: this.spaceId,
      spaceName: this.spaceName,
      teamId: this.teamId,
      teamName: this.teamName,
      version: this.version,
    }
  }

  /**
   * Creates a new BrvConfig with space fields cleared, preserving all other fields.
   */
  public withoutSpace(): BrvConfig {
    return new BrvConfig({
      ...this,
      spaceId: undefined,
      spaceName: undefined,
      teamId: undefined,
      teamName: undefined,
    })
  }

  /**
   * Creates a new BrvConfig with the reviewDisabled flag updated, preserving all other fields.
   */
  public withReviewDisabled(reviewDisabled: boolean): BrvConfig {
    return new BrvConfig({
      chatLogPath: this.chatLogPath,
      cipherAgentContext: this.cipherAgentContext,
      cipherAgentModes: this.cipherAgentModes,
      cipherAgentSystemPrompt: this.cipherAgentSystemPrompt,
      createdAt: this.createdAt,
      cwd: this.cwd,
      ide: this.ide,
      language: this.language,
      reviewDisabled,
      spaceId: this.spaceId,
      spaceName: this.spaceName,
      teamId: this.teamId,
      teamName: this.teamName,
      version: this.version,
    })
  }

  /**
   * Creates a new BrvConfig with space fields replaced, preserving all other fields.
   */
  public withSpace(space: Space): BrvConfig {
    return new BrvConfig({
      chatLogPath: this.chatLogPath,
      cipherAgentContext: this.cipherAgentContext,
      cipherAgentModes: this.cipherAgentModes,
      cipherAgentSystemPrompt: this.cipherAgentSystemPrompt,
      createdAt: new Date().toISOString(),
      cwd: this.cwd,
      ide: this.ide,
      language: this.language,
      reviewDisabled: this.reviewDisabled,
      spaceId: space.id,
      spaceName: space.name,
      teamId: space.teamId,
      teamName: space.teamName,
      version: this.version,
    })
  }

  /**
   * Creates a new BrvConfig with version updated, preserving all other fields.
   */
  public withVersion(version: string): BrvConfig {
    return new BrvConfig({
      chatLogPath: this.chatLogPath,
      cipherAgentContext: this.cipherAgentContext,
      cipherAgentModes: this.cipherAgentModes,
      cipherAgentSystemPrompt: this.cipherAgentSystemPrompt,
      createdAt: this.createdAt,
      cwd: this.cwd,
      ide: this.ide,
      language: this.language,
      reviewDisabled: this.reviewDisabled,
      spaceId: this.spaceId,
      spaceName: this.spaceName,
      teamId: this.teamId,
      teamName: this.teamName,
      version,
    })
  }
}
