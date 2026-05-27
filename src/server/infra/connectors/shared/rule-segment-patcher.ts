import {mkdir, readdir, readFile, writeFile} from 'node:fs/promises'
import path, {dirname} from 'node:path'

import {RULES_CONNECTOR_CONFIGS} from '../rules/rules-connector-config.js'
import {MAIN_SKILL_FILE_NAME, SKILL_CONNECTOR_CONFIGS} from '../skill/skill-connector-config.js'
import {resolveSkillGlobalBasePath} from '../skill/skill-path-resolver.js'
import {BRV_RULE_MARKERS, BYTEROVER_BLOCK_MARKERS} from './constants.js'

const WORKFLOWS_FILE_NAME = 'WORKFLOWS.md'

/** Anchor that marks where to insert the verifying section in WORKFLOWS.md. */
const CURATE_VIEW_WORKFLOWS_ANCHOR = '## What to Curate'

/**
 * Section to insert before "## What to Curate" in existing WORKFLOWS.md files.
 * Matches the content added to the template for new installs.
 */
const CURATE_VIEW_WORKFLOWS_SECTION =
  '## Verifying Curate Results\n' +
  '\n' +
  'After `brv curate` completes, it outputs a logId (e.g., `✓ Context curated successfully. (Log: cur-1739700001000)`). Use it to inspect exactly what was stored:\n' +
  '\n' +
  '```bash\n' +
  'brv curate view cur-1739700001000   # Full detail: input, operations, summary\n' +
  'brv curate view                     # List recent curates with status\n' +
  'brv curate view --detail            # List with per-entry file operations visible\n' +
  '```\n' +
  '\n' +
  'Useful for large contexts or folder-pack curations to confirm the knowledge was captured as expected.\n' +
  '\n'

/** Sentinel for WORKFLOWS.md — checks whether any mention of the command exists. */
const CURATE_VIEW_SENTINEL = 'brv curate view'

/**
 * Sentinel for rules files — more specific than CURATE_VIEW_SENTINEL.
 * Matches the command bullet (`- \`brv curate view\``) but NOT the footer line
 * (`brv curate view --help`) which may appear in newer templates without the command lines.
 */
const CURATE_VIEW_RULES_SENTINEL = '- `brv curate view`'

/** Sentinel for the Quick Reference table row in SKILL.md files. */
const CURATE_VIEW_SKILL_TABLE_SENTINEL = '| `brv curate view`'

/** Sentinel for the "View curate history" subsection in SKILL.md "When to Use" sections. */
const CURATE_VIEW_SKILL_SECTION_SENTINEL = '**View curate history**'

/**
 * Lines to insert after the `brv curate` bullet in existing rules files.
 * Matches the content added to the template for new installs.
 */
const CURATE_VIEW_RULES_LINES =
  '- `brv curate view` - List curate history (last 10 entries by default)\n' +
  '- `brv curate view <logId>` - Full detail for a specific entry: all files and operations performed (logId returned by `brv curate`)\n' +
  '- `brv curate view --detail` - List entries with their file operations visible (no logId needed)'

/** Anchor string that identifies the `brv curate` command line in a rules file. */
const CURATE_RULES_ANCHOR = '- `brv curate` -'

/**
 * Row to insert into existing SKILL.md Quick Reference tables.
 * Matches the single row added to the template for new installs.
 */
const CURATE_VIEW_SKILL_ROWS = '| `brv curate view` | Check curate history | `brv curate view` |'

/** Anchor string that identifies the `brv curate` row in the SKILL.md Quick Reference table. */
const CURATE_SKILL_ANCHOR = '| `brv curate "context" -f file`'

/** Anchor string that identifies the end of the Curate subsection in existing SKILL.md "When to Use" sections. */
const CURATE_SKILL_WHEN_ANCHOR = '- Made an architecture decision'

/**
 * Subsection to insert after the Curate bullets in existing SKILL.md "When to Use" sections.
 * Matches the content added to the template for new installs.
 */
const CURATE_VIEW_SKILL_WHEN_SECTION =
  '\n**View curate history** to check past curations:\n' +
  '- `brv curate view` — show recent entries (last 10)\n' +
  '- `brv curate view <logId>` — full detail for a specific entry: all files and operations performed (logId is printed by `brv curate` on completion, e.g. `cur-1739700001000`)\n' +
  '- `brv curate view --detail` — list entries with file operations visible (no logId needed)\n' +
  '- `brv curate view --since 1h --status completed` — filter by time and status\n' +
  '- Run `brv curate view --help` for all filter options'

/**
 * Inserts a new line immediately after the first occurrence of `anchor` in `text`.
 * Returns the patched string, or null if the anchor was not found.
 */
function insertAfterLine(text: string, anchor: string, newLine: string): null | string {
  const anchorIdx = text.indexOf(anchor)
  if (anchorIdx === -1) return null

  const lineEnd = text.indexOf('\n', anchorIdx)
  const insertAt = lineEnd === -1 ? text.length : lineEnd

  return text.slice(0, insertAt) + '\n' + newLine + text.slice(insertAt)
}

/**
 * Patches an existing rules file to add `brv curate view` inside the BRV markers section.
 * Only modifies content within `<!-- BEGIN/END BYTEROVER RULES -->` — never touches user content outside.
 *
 * @returns true if a patch was applied, false if no patch was needed or possible.
 */
export async function patchRulesFile(fullPath: string): Promise<boolean> {
  let content: string
  try {
    content = await readFile(fullPath, 'utf8')
  } catch {
    return false // file doesn't exist
  }

  const {END, START} = BRV_RULE_MARKERS
  const startIdx = content.indexOf(START)
  const endIdx = content.indexOf(END)
  if (startIdx === -1 || endIdx === -1) return false // no BRV markers

  const brvSection = content.slice(startIdx, endIdx + END.length)
  if (brvSection.includes(CURATE_VIEW_RULES_SENTINEL)) return false // already patched

  const patchedSection = insertAfterLine(brvSection, CURATE_RULES_ANCHOR, CURATE_VIEW_RULES_LINES)
  if (!patchedSection) return false // anchor not found — different template format, skip safely

  const patchedContent = content.slice(0, startIdx) + patchedSection + content.slice(endIdx + END.length)
  await writeFile(fullPath, patchedContent, 'utf8')
  return true
}

/**
 * Patches an existing WORKFLOWS.md to add the "Verifying Curate Results" section.
 * Inserts before "## What to Curate" — safe to run on any version of the file.
 *
 * @returns true if a patch was applied, false if no patch was needed or possible.
 */
export async function patchWorkflowsFile(fullPath: string): Promise<boolean> {
  let content: string
  try {
    content = await readFile(fullPath, 'utf8')
  } catch {
    return false // file doesn't exist
  }

  if (content.includes(CURATE_VIEW_SENTINEL)) return false // already patched

  const anchorIdx = content.indexOf(CURATE_VIEW_WORKFLOWS_ANCHOR)
  if (anchorIdx === -1) return false // anchor not found — different format, skip safely

  const patchedContent = content.slice(0, anchorIdx) + CURATE_VIEW_WORKFLOWS_SECTION + content.slice(anchorIdx)
  await writeFile(fullPath, patchedContent, 'utf8')
  return true
}

/**
 * Patches an existing SKILL.md to add `brv curate view` in the Quick Reference table
 * and the "View curate history" subsection under "When to Use".
 * Each patch is applied independently — files that already have the table row but lack
 * the subsection (or vice versa) are handled correctly.
 *
 * @returns true if any patch was applied, false if no patch was needed or possible.
 */
export async function patchSkillFile(fullPath: string): Promise<boolean> {
  let content: string
  try {
    content = await readFile(fullPath, 'utf8')
  } catch {
    return false // file doesn't exist
  }

  let current = content
  let didPatch = false

  // Patch 1: Insert row into Quick Reference table if missing.
  // If the table anchor is absent (older template without Quick Reference section), skip this
  // patch only — Patch 2 below runs independently.
  if (!current.includes(CURATE_VIEW_SKILL_TABLE_SENTINEL)) {
    const withTableRow = insertAfterLine(current, CURATE_SKILL_ANCHOR, CURATE_VIEW_SKILL_ROWS)
    if (withTableRow) {
      current = withTableRow
      didPatch = true
    }
  }

  // Patch 2: Insert "View curate history" subsection if missing
  // Gracefully skipped if anchor not found (older template version)
  if (!current.includes(CURATE_VIEW_SKILL_SECTION_SENTINEL)) {
    const withSection = insertAfterLine(current, CURATE_SKILL_WHEN_ANCHOR, CURATE_VIEW_SKILL_WHEN_SECTION)
    if (withSection) {
      current = withSection
      didPatch = true
    }
  }

  if (!didPatch) return false

  await writeFile(fullPath, current, 'utf8')
  return true
}

export async function upsertByteroverBlock(fullPath: string, blockContent: string): Promise<boolean> {
  let existing = ''
  try {
    existing = await readFile(fullPath, 'utf8')
  } catch {
    // Missing autonomous-agent instruction files are created because the
    // resolved target is agent-owned state, not a user's flexible workspace.
  }

  const currentBlock = findByteroverBlock(existing)
  // Replace in place with the bare block so the original boundary
  // (the newline after the END marker) is preserved — re-running install
  // must be idempotent, not accumulate blank lines after the block.
  const nextContent = currentBlock
    ? existing.slice(0, currentBlock.start) + stripTrailingNewlines(blockContent) + existing.slice(currentBlock.end)
    : appendManagedBlock(existing, normalizeManagedBlock(blockContent))

  if (nextContent === existing) return false

  await mkdir(dirname(fullPath), {recursive: true})
  await writeFile(fullPath, nextContent, 'utf8')
  return true
}

export async function removeByteroverBlock(fullPath: string): Promise<boolean> {
  let existing: string
  try {
    existing = await readFile(fullPath, 'utf8')
  } catch {
    return false
  }

  const currentBlock = findByteroverBlock(existing)
  if (!currentBlock) return false

  const nextContent = joinAfterBlockRemoval(existing.slice(0, currentBlock.start), existing.slice(currentBlock.end))
  await writeFile(fullPath, nextContent, 'utf8')
  return true
}

/**
 * True when the file carries a managed ByteRover block. When `expectedBlock` is
 * supplied the on-disk block must also match it byte-for-byte (newline-trimmed),
 * so a block with valid markers but stale content is reported as absent and the
 * same-type re-install short-circuit can fall through to repair it.
 */
export async function hasByteroverBlock(fullPath: string, expectedBlock?: string): Promise<boolean> {
  let existing: string
  try {
    existing = await readFile(fullPath, 'utf8')
  } catch {
    return false
  }

  const currentBlock = findByteroverBlock(existing)
  if (!currentBlock) return false
  if (expectedBlock === undefined) return true

  const onDisk = existing.slice(currentBlock.start, currentBlock.end)
  return stripTrailingNewlines(onDisk) === stripTrailingNewlines(expectedBlock)
}

function normalizeManagedBlock(blockContent: string): string {
  return blockContent.endsWith('\n') ? blockContent : `${blockContent}\n`
}

function stripTrailingNewlines(blockContent: string): string {
  return blockContent.replace(/\n+$/u, '')
}

function findByteroverBlock(content: string): undefined | {end: number; start: number} {
  const {END, START} = BYTEROVER_BLOCK_MARKERS
  const start = content.indexOf(START)
  if (start === -1) return undefined

  const endStart = content.indexOf(END, start + START.length)
  if (endStart === -1) return undefined

  return {
    end: endStart + END.length,
    start,
  }
}

function appendManagedBlock(existing: string, blockContent: string): string {
  if (!existing.trim()) return blockContent
  const separator = existing.endsWith('\n') ? '\n' : '\n\n'
  return `${existing}${separator}${blockContent}`
}

function joinAfterBlockRemoval(before: string, after: string): string {
  const trimmedBefore = before.replace(/[ \t\n]+$/u, '')
  const trimmedAfter = after.replace(/^[ \t\n]+/u, '')
  if (trimmedBefore && trimmedAfter) {
    return `${trimmedBefore}\n\n${trimmedAfter}`
  }

  if (trimmedBefore) return `${trimmedBefore}\n`
  if (trimmedAfter) return trimmedAfter
  return ''
}

/**
 * Ensures `brv curate view` is present in all connector files found on disk.
 * Each patcher function checks its own sentinel string before writing — safe to call on every command.
 * Silently no-ops on any error — never throws.
 */
export async function ensureCurateViewPatched(projectRoot: string): Promise<void> {
  const patches: Promise<boolean>[] = []

  for (const config of Object.values(RULES_CONNECTOR_CONFIGS)) {
    patches.push(patchRulesFile(path.join(projectRoot, config.filePath)).catch(() => false))
  }

  const skillDirScans = await Promise.all(
    Object.values(SKILL_CONNECTOR_CONFIGS).flatMap((config) => [
      config.projectPath ? scanSkillsDir(path.join(projectRoot, config.projectPath)) : null,
      scanSkillsDir(resolveSkillGlobalBasePath(config)),
    ]),
  )

  for (const scan of skillDirScans) {
    if (!scan) continue
    for (const entry of scan.entries) {
      if (!entry.isDirectory()) continue
      const skillDir = path.join(scan.skillsParentDir, entry.name)
      patches.push(
        patchSkillFile(path.join(skillDir, MAIN_SKILL_FILE_NAME)).catch(() => false),
        patchWorkflowsFile(path.join(skillDir, WORKFLOWS_FILE_NAME)).catch(() => false),
      )
    }
  }

  await Promise.all(patches)
}

const scanSkillsDir = async (dir: string) => {
  try {
    if (!dir) return null

    const entries = await readdir(dir, {withFileTypes: true})
    return {entries, skillsParentDir: dir}
  } catch {
    return null // skills parent dir doesn't exist — no skills installed for this agent
  }
}
