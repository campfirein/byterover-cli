import path from 'node:path'

import type {SkillConnectorConfig} from './skill-connector-config.js'

import {
  type AgentPathResolverOptions,
  resolveHermesHome,
  resolveOpenClawStateDir,
  resolveUserPath,
} from '../shared/agent-path-resolver.js'

/** Skill-domain alias for the shared autonomous-agent path resolver options. */
export type SkillPathResolverOptions = AgentPathResolverOptions

const defaultHomeDir = (options?: SkillPathResolverOptions): string => resolveUserPath('~', options)

/**
 * Base path to display for an installed skill.
 *
 * Home/project-rooted agents keep their existing relative path
 * (e.g. `.claude/skills`). Custom-root agents (Hermes, OpenClaw) return the
 * fully resolved root so `skills/byterover` is not shown with the actual
 * location hidden.
 */
export function resolveSkillDisplayPath(
  config: SkillConnectorConfig,
  fallbackRelativeBase: string,
  options?: SkillPathResolverOptions,
): string {
  if ((config.globalRoot ?? 'home') === 'home') {
    return fallbackRelativeBase
  }

  return resolveSkillGlobalBasePath(config, options)
}

export function resolveSkillGlobalBasePath(
  config: SkillConnectorConfig,
  options?: SkillPathResolverOptions,
): string {
  switch (config.globalRoot ?? 'home') {
    case 'hermes-home': {
      return path.join(resolveHermesHome(options), config.globalPath)
    }

    case 'home': {
      return path.join(defaultHomeDir(options), config.globalPath)
    }

    case 'openclaw-state': {
      return path.join(resolveOpenClawStateDir(options), config.globalPath)
    }
  }
}
