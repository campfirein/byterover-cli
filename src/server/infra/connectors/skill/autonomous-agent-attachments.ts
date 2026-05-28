import {load as yamlLoad} from 'js-yaml'
import {readFile} from 'node:fs/promises'
import path from 'node:path'

import type {AgentPathResolverOptions} from '../shared/agent-path-resolver.js'

import {isRecord} from '../../../utils/type-guards.js'
import {
  resolveHermesHome,
  resolveOpenClawConfigPath,
  resolveOpenClawDefaultWorkspaceDir,
  resolveOpenClawStateDir,
  resolveOpenClawUserPath,
} from '../shared/agent-path-resolver.js'
import {hasByteroverBlock, removeByteroverBlock, upsertByteroverBlock} from '../shared/rule-segment-patcher.js'

type AttachmentKind = 'hermes' | 'openclaw'
type UnknownRecord = Record<string, unknown>

const DEFAULT_OPENCLAW_AGENT_ID = 'main'
const VALID_OPENCLAW_ID_RE = /^[a-z0-9][a-z0-9_-]{0,63}$/i
const INVALID_OPENCLAW_ID_CHARS_RE = /[^a-z0-9_-]+/g
const LEADING_DASH_RE = /^-+/
const TRAILING_DASH_RE = /-+$/

export async function upsertAutonomousAgentBlocks(
  kind: AttachmentKind,
  blockContent: string,
  options?: AgentPathResolverOptions,
): Promise<void> {
  const paths = await resolveAttachmentFilePaths(kind, options)
  await Promise.all(paths.map((targetPath) => upsertByteroverBlock(targetPath, blockContent)))
}

export async function removeAutonomousAgentBlocks(
  kind: AttachmentKind,
  options?: AgentPathResolverOptions,
): Promise<boolean> {
  const paths = await resolveAttachmentFilePaths(kind, options)
  const results = await Promise.all(paths.map((targetPath) => removeByteroverBlock(targetPath)))
  return results.some(Boolean)
}

/**
 * True only when every resolved attachment target already carries the managed
 * ByteRover block. Used by status() so a present SKILL.md is not reported as a
 * complete install when the always-loaded block is missing or stale.
 */
export async function hasAutonomousAgentBlocks(
  kind: AttachmentKind,
  expectedBlock: string,
  options?: AgentPathResolverOptions,
): Promise<boolean> {
  const paths = await resolveAttachmentFilePaths(kind, options)
  const results = await Promise.all(paths.map((targetPath) => hasByteroverBlock(targetPath, expectedBlock)))
  return results.every(Boolean)
}

async function resolveAttachmentFilePaths(
  kind: AttachmentKind,
  options?: AgentPathResolverOptions,
): Promise<string[]> {
  if (kind === 'hermes') {
    return [path.join(resolveHermesHome(options), 'SOUL.md')]
  }

  const openClawConfig = await readOpenClawConfig(options)
  const stateDir = resolveOpenClawStateDir(options)
  return resolveOpenClawWorkspaceDirs(openClawConfig, stateDir, options).map((workspaceDir) =>
    path.join(workspaceDir, 'AGENTS.md'),
  )
}

async function readOpenClawConfig(options?: AgentPathResolverOptions): Promise<UnknownRecord> {
  const configPath = resolveOpenClawConfigPath(options)
  let raw: string
  try {
    raw = await readFile(configPath, 'utf8')
  } catch {
    return {}
  }

  const parsed = yamlLoad(raw)
  return isRecord(parsed) ? parsed : {}
}

/**
 * Resolve the workspace directory for every relevant OpenClaw agent.
 *
 * OpenClaw loads its always-loaded bootstrap file (AGENTS.md) from the agent's
 * WORKSPACE dir (loadWorkspaceBootstrapFiles), NOT the agentDir. This mirrors
 * OpenClaw's `resolveAgentWorkspaceDir` / `resolveDefaultAgentId` so the managed
 * block lands where OpenClaw actually reads it.
 */
function resolveOpenClawWorkspaceDirs(
  config: UnknownRecord,
  stateDir: string,
  options?: AgentPathResolverOptions,
): string[] {
  const entries = readOpenClawAgentEntries(config)
  const ids = collectOpenClawAgentIds(config, entries)
  const defaultAgentId = resolveDefaultOpenClawAgentId(entries)
  const defaultsWorkspace = readString(asRecord(asRecord(config.agents)?.defaults)?.workspace)
  const seen = new Set<string>()
  const dirs: string[] = []

  for (const id of ids) {
    const entry = entries.find((candidate) => normalizeOpenClawAgentId(readString(candidate.id)) === id)
    const workspace = resolveOpenClawAgentWorkspace({
      defaultAgentId,
      defaultsWorkspace,
      entry,
      id,
      options,
      stateDir,
    })
    if (seen.has(workspace)) continue
    seen.add(workspace)
    dirs.push(workspace)
  }

  return dirs
}

function resolveOpenClawAgentWorkspace(params: {
  defaultAgentId: string
  defaultsWorkspace: string | undefined
  entry: undefined | UnknownRecord
  id: string
  options?: AgentPathResolverOptions
  stateDir: string
}): string {
  const {defaultAgentId, defaultsWorkspace, entry, id, options, stateDir} = params

  const configured = readString(entry?.workspace)
  if (configured) {
    return resolveOpenClawUserPath(configured, options)
  }

  if (id === defaultAgentId) {
    return defaultsWorkspace
      ? resolveOpenClawUserPath(defaultsWorkspace, options)
      : resolveOpenClawDefaultWorkspaceDir(options)
  }

  return defaultsWorkspace
    ? path.join(resolveOpenClawUserPath(defaultsWorkspace, options), id)
    : path.join(stateDir, `workspace-${id}`)
}

function resolveDefaultOpenClawAgentId(entries: UnknownRecord[]): string {
  if (entries.length === 0) {
    return DEFAULT_OPENCLAW_AGENT_ID
  }

  const explicitDefault = entries.find((entry) => entry.default === true)
  return normalizeOpenClawAgentId(readString((explicitDefault ?? entries[0]).id))
}

function collectOpenClawAgentIds(config: UnknownRecord, entries: UnknownRecord[]): string[] {
  const ids = new Set<string>()
  const addId = (value: string | undefined): void => {
    const id = normalizeOpenClawAgentId(value)
    if (id) ids.add(id)
  }

  if (entries.length === 0) {
    addId(DEFAULT_OPENCLAW_AGENT_ID)
  }

  for (const entry of entries) {
    addId(readString(entry.id))
    for (const allowedId of readSubagentAllowAgents(entry)) {
      addId(allowedId)
    }
  }

  const defaults = asRecord(asRecord(config.agents)?.defaults)
  for (const allowedId of readSubagentAllowAgents(defaults)) {
    addId(allowedId)
  }

  if (ids.size === 0) {
    ids.add(DEFAULT_OPENCLAW_AGENT_ID)
  }

  return [...ids]
}

function readOpenClawAgentEntries(config: UnknownRecord): UnknownRecord[] {
  const agents = asRecord(config.agents)
  const list = agents?.list
  if (!Array.isArray(list)) return []
  return list.filter((entry): entry is UnknownRecord => isRecord(entry))
}

function readSubagentAllowAgents(entry: undefined | UnknownRecord): string[] {
  const subagents = asRecord(entry?.subagents)
  const allowAgents = subagents?.allowAgents
  if (!Array.isArray(allowAgents)) return []
  return allowAgents.filter((value): value is string => {
    if (typeof value !== 'string') return false
    const trimmed = value.trim()
    return Boolean(trimmed) && trimmed !== '*'
  })
}

function normalizeOpenClawAgentId(value: string | undefined): string {
  const trimmed = value?.trim() ?? ''
  if (!trimmed) return DEFAULT_OPENCLAW_AGENT_ID
  const lowered = trimmed.toLowerCase()
  if (VALID_OPENCLAW_ID_RE.test(trimmed)) {
    return lowered
  }

  return (
    lowered
      .replaceAll(INVALID_OPENCLAW_ID_CHARS_RE, '-')
      .replace(LEADING_DASH_RE, '')
      .replace(TRAILING_DASH_RE, '')
      .slice(0, 64) || DEFAULT_OPENCLAW_AGENT_ID
  )
}

function asRecord(value: unknown): undefined | UnknownRecord {
  return isRecord(value) ? value : undefined
}

function readString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value : undefined
}
