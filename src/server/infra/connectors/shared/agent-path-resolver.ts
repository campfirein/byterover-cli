import os from 'node:os'
import path from 'node:path'

/**
 * Shared resolver for autonomous-agent home/config locations (Hermes, OpenClaw).
 *
 * Lives in `connectors/shared` so both the skill and MCP connectors can resolve
 * the same root without the MCP connector importing skill internals. When no
 * options are supplied the resolver falls back to `process.env` / `os.homedir()`
 * so call sites without an injection seam (e.g. an MCP `configPathResolver`)
 * still honor `HERMES_HOME` / `OPENCLAW_STATE_DIR` / `OPENCLAW_CONFIG_PATH`.
 */
export type AgentPathResolverOptions = {
  env?: NodeJS.ProcessEnv
  homeDir?: string
}

const resolveEnv = (options?: AgentPathResolverOptions): NodeJS.ProcessEnv => options?.env ?? process.env

const resolveHomeDir = (options?: AgentPathResolverOptions): string => options?.homeDir ?? os.homedir()

export function resolveUserPath(input: string, options?: AgentPathResolverOptions): string {
  const value = input.trim()
  const homeDir = resolveHomeDir(options)
  if (value === '~') {
    return homeDir
  }

  if (value.startsWith('~/')) {
    return path.join(homeDir, value.slice(2))
  }

  if (path.isAbsolute(value)) {
    return value
  }

  return path.join(homeDir, value)
}

/**
 * OpenClaw home dir, mirroring OpenClaw's `resolveRequiredHomeDir`: `OPENCLAW_HOME`
 * wins (with `~` expanded against the base home), otherwise the injected/OS home.
 * `options.homeDir` stands in for OpenClaw's OS-home chain (HOME/USERPROFILE/os.homedir).
 */
export function resolveOpenClawHomeDir(options?: AgentPathResolverOptions): string {
  const base = resolveHomeDir(options)
  const override = resolveEnv(options).OPENCLAW_HOME?.trim()
  if (!override) {
    return base
  }

  if (override === '~' || override.startsWith('~/') || override.startsWith('~\\')) {
    return path.resolve(override.replace(/^~(?=$|[\\/])/u, base))
  }

  return path.resolve(override)
}

/**
 * OpenClaw path resolution, mirroring OpenClaw's `resolveHomeRelativePath`:
 * `~`-prefixed expands against the OpenClaw home; every other value is
 * `path.resolve`d (i.e. relative paths are CWD-relative, not home-relative).
 */
export function resolveOpenClawUserPath(input: string, options?: AgentPathResolverOptions): string {
  const trimmed = input.trim()
  if (!trimmed) {
    return trimmed
  }

  if (trimmed.startsWith('~')) {
    const home = resolveOpenClawHomeDir(options)
    const expanded = trimmed === '~' ? home : path.join(home, trimmed.replace(/^~[\\/]/u, ''))
    return path.resolve(expanded)
  }

  return path.resolve(trimmed)
}

export function resolveOpenClawStateDir(options?: AgentPathResolverOptions): string {
  const override = resolveEnv(options).OPENCLAW_STATE_DIR?.trim()
  if (override) {
    return resolveOpenClawUserPath(override, options)
  }

  return path.join(resolveOpenClawHomeDir(options), '.openclaw')
}

export function resolveOpenClawConfigPath(options?: AgentPathResolverOptions): string {
  const override = resolveEnv(options).OPENCLAW_CONFIG_PATH?.trim()
  if (override) {
    return resolveOpenClawUserPath(override, options)
  }

  return path.join(resolveOpenClawStateDir(options), 'openclaw.json')
}

export function resolveHermesHome(options?: AgentPathResolverOptions): string {
  const override = resolveEnv(options).HERMES_HOME?.trim()
  if (override) {
    return resolveUserPath(override, options)
  }

  return path.join(resolveHomeDir(options), '.hermes')
}

/**
 * Default workspace dir for the OpenClaw default agent, mirroring OpenClaw's
 * `resolveDefaultAgentWorkspaceDir`. Note: this is HOME-based
 * (`<home>/.openclaw/workspace`) and intentionally does NOT honor
 * OPENCLAW_STATE_DIR — only the OPENCLAW_PROFILE suffix.
 */
export function resolveOpenClawDefaultWorkspaceDir(options?: AgentPathResolverOptions): string {
  const profile = resolveEnv(options).OPENCLAW_PROFILE?.trim()
  const home = resolveOpenClawHomeDir(options)
  if (profile && profile.toLowerCase() !== 'default') {
    return path.join(home, '.openclaw', `workspace-${profile}`)
  }

  return path.join(home, '.openclaw', 'workspace')
}
