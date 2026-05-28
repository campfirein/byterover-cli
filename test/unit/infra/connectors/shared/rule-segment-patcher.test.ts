import {expect} from 'chai'
import {mkdir, readFile, rm, writeFile} from 'node:fs/promises'
import {tmpdir} from 'node:os'
import path from 'node:path'

import {BRV_RULE_MARKERS} from '../../../../../src/server/infra/connectors/shared/constants.js'
import {
  ensureCurateViewPatched,
  patchRulesFile,
  patchSkillFile,
  patchWorkflowsFile,
  removeByteroverBlock,
  upsertByteroverBlock,
} from '../../../../../src/server/infra/connectors/shared/rule-segment-patcher.js'

// ---------------------------------------------------------------------------
// Fixture builders — produce realistic "old" file content (pre-patch)
// ---------------------------------------------------------------------------

const {START} = BRV_RULE_MARKERS
const {END} = BRV_RULE_MARKERS

/**
 * Old rules file: has BRV markers + `brv curate` command line but NO `brv curate view`.
 * Simulates CLAUDE.md / AGENTS.md etc. from before the patch was introduced.
 */
function makeOldRulesContent(userContentBefore = 'User content here.'): string {
  return (
    `${userContentBefore}\n\n` +
    `${START}\n` +
    `# ByteRover CLI Command Reference\n\n` +
    `## Available Commands\n\n` +
    `- \`brv curate\` - Curate context to the context tree\n` +
    `- \`brv query\` - Query and retrieve information from the context tree\n` +
    `- \`brv status\` - Show CLI status and project information\n\n` +
    `Run \`brv query --help\` for query instruction and \`brv curate --help\` for curation instruction.\n` +
    `${END}\n`
  )
}

/**
 * Old SKILL.md: has Quick Reference table with `brv curate` row and the
 * Curate subsection with "Made an architecture decision" bullet, but NO `brv curate view`.
 */
const OLD_SKILL_CONTENT = `---
name: byterover
description: "Manages project knowledge."
---

# ByteRover Context Tree

## Quick Reference

| Command | When | Example |
|---------|------|---------|
| \`brv query "question"\` | Before starting work | \`brv query "How is auth implemented?"\` |
| \`brv curate "context" -f file\` | After completing work | \`brv curate "JWT 24h expiry" -f auth.ts\` |
| \`brv status\` | To check prerequisites | \`brv status\` |

## When to Use

**Query** when you need to understand something:
- "How does X work in this codebase?"

**Curate** when you learned or created something valuable:
- Implemented a feature using specific patterns
- Fixed a bug and found root cause
- Made an architecture decision

## Curate Quality

Good context is specific and actionable.
`

/**
 * Old WORKFLOWS.md: has `## What to Curate` section but NO `brv curate view`.
 */
const OLD_WORKFLOWS_CONTENT = `# ByteRover Workflows

## Pattern 1: Research Before Implementation

Use when starting new features.

## What to Curate

**Do curate:**
- Architecture decisions
- Patterns
`

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('rule-segment-patcher', () => {
  let testDir: string

  beforeEach(async () => {
    testDir = path.join(tmpdir(), `brv-patcher-test-${Date.now()}`)
    await mkdir(testDir, {recursive: true})
  })

  afterEach(async () => {
    await rm(testDir, {force: true, recursive: true})
  })

  // -------------------------------------------------------------------------
  // patchRulesFile
  // -------------------------------------------------------------------------

  describe('patchRulesFile', () => {
    it('returns false when file does not exist', async () => {
      const result = await patchRulesFile(path.join(testDir, 'CLAUDE.md'))
      expect(result).to.be.false
    })

    it('returns false when file has no BRV markers', async () => {
      const filePath = path.join(testDir, 'CLAUDE.md')
      await writeFile(filePath, '# My project\n\nSome user content.\n', 'utf8')

      const result = await patchRulesFile(filePath)
      expect(result).to.be.false

      const content = await readFile(filePath, 'utf8')
      expect(content).to.not.include('brv curate view')
    })

    it('patches old rules file and adds brv curate view lines', async () => {
      const filePath = path.join(testDir, 'CLAUDE.md')
      await writeFile(filePath, makeOldRulesContent(), 'utf8')

      const result = await patchRulesFile(filePath)
      expect(result).to.be.true

      const patched = await readFile(filePath, 'utf8')
      expect(patched).to.include('brv curate view')
      expect(patched).to.include('`brv curate view` - List curate history')
      expect(patched).to.include('`brv curate view <logId>`')
      expect(patched).to.include('`brv curate view --detail`')
    })

    it('inserts view lines immediately after the brv curate line', async () => {
      const filePath = path.join(testDir, 'CLAUDE.md')
      await writeFile(filePath, makeOldRulesContent(), 'utf8')
      await patchRulesFile(filePath)

      const patched = await readFile(filePath, 'utf8')
      const curateIdx = patched.indexOf('`brv curate` -')
      const viewIdx = patched.indexOf('`brv curate view`')
      expect(viewIdx).to.be.greaterThan(curateIdx)

      // view line should appear before brv query line
      const queryIdx = patched.indexOf('`brv query`')
      expect(viewIdx).to.be.lessThan(queryIdx)
    })

    it('does not modify user content outside BRV markers', async () => {
      const userContent = 'My important user notes here.'
      const filePath = path.join(testDir, 'CLAUDE.md')
      await writeFile(filePath, makeOldRulesContent(userContent), 'utf8')
      await patchRulesFile(filePath)

      const patched = await readFile(filePath, 'utf8')
      expect(patched).to.include(userContent)
      expect(patched.indexOf(userContent)).to.equal(0)
    })

    it('is idempotent — second call returns false, no duplicate insertion', async () => {
      const filePath = path.join(testDir, 'CLAUDE.md')
      await writeFile(filePath, makeOldRulesContent(), 'utf8')
      await patchRulesFile(filePath)

      const result2 = await patchRulesFile(filePath)
      expect(result2).to.be.false

      const patched = await readFile(filePath, 'utf8')
      const count = (patched.match(/brv curate view/g) ?? []).length
      // Should appear multiple times (view, logId, --detail lines) but not doubled
      expect(count).to.be.greaterThan(0)
      expect(count).to.be.lessThan(8)
    })

    it('returns false when brv curate view already present inside BRV section', async () => {
      const alreadyPatched =
        `${START}\n` +
        `- \`brv curate\` - Curate context\n` +
        `- \`brv curate view\` - List curate history\n` +
        `- \`brv query\` - Query\n` +
        `${END}\n`
      const filePath = path.join(testDir, 'CLAUDE.md')
      await writeFile(filePath, alreadyPatched, 'utf8')

      const result = await patchRulesFile(filePath)
      expect(result).to.be.false
    })

    it('patches a file whose footer mentions "brv curate view --help" but lacks the command bullets', async () => {
      // AGENTS.md (Codex) has the updated footer with brv curate view --help but not the command lines.
      // The old sentinel 'brv curate view' would match the footer and skip patching — CURATE_VIEW_RULES_SENTINEL fixes this.
      const footerOnlyContent =
        `${START}\n` +
        `## Available Commands\n\n` +
        `- \`brv curate\` - Curate context to the context tree\n` +
        `- \`brv query\` - Query and retrieve information from the context tree\n` +
        `- \`brv status\` - Show CLI status and project information\n\n` +
        `Run \`brv query --help\` for query instruction and \`brv curate --help\` / \`brv curate view --help\` for curation options.\n` +
        `${END}\n`
      const filePath = path.join(testDir, 'AGENTS.md')
      await writeFile(filePath, footerOnlyContent, 'utf8')

      const result = await patchRulesFile(filePath)
      expect(result).to.be.true

      const patched = await readFile(filePath, 'utf8')
      expect(patched).to.include('- `brv curate view` - List curate history')
      expect(patched).to.include('- `brv curate view <logId>`')
    })
  })

  // -------------------------------------------------------------------------
  // patchSkillFile
  // -------------------------------------------------------------------------

  describe('patchSkillFile', () => {
    it('returns false when file does not exist', async () => {
      const result = await patchSkillFile(path.join(testDir, 'SKILL.md'))
      expect(result).to.be.false
    })

    it('returns false when table row and subsection are both already present', async () => {
      const filePath = path.join(testDir, 'SKILL.md')
      await writeFile(filePath, OLD_SKILL_CONTENT, 'utf8')
      // First patch adds both
      await patchSkillFile(filePath)

      const result = await patchSkillFile(filePath)
      expect(result).to.be.false
    })

    it('patches file that has table row but is missing the View curate history subsection', async () => {
      // Scenario: .cursor/skills/byterover/SKILL.md — table row already present from a prior template
      // update but the "View curate history" subsection was never added.
      const tableRowAlreadyPresent = OLD_SKILL_CONTENT.replace(
        '| `brv status` | To check prerequisites | `brv status` |',
        '| `brv curate view` | Check curate history | `brv curate view` |\n| `brv status` | To check prerequisites | `brv status` |',
      )
      const filePath = path.join(testDir, 'SKILL.md')
      await writeFile(filePath, tableRowAlreadyPresent, 'utf8')

      const result = await patchSkillFile(filePath)
      expect(result).to.be.true

      const patched = await readFile(filePath, 'utf8')
      // Subsection added
      expect(patched).to.include('**View curate history** to check past curations:')
      // Table row not duplicated — "Check curate history" header text appears exactly once
      const count = (patched.match(/Check curate history/g) ?? []).length
      expect(count).to.equal(1)
    })

    it('returns false when Quick Reference anchor not found', async () => {
      const filePath = path.join(testDir, 'SKILL.md')
      // No Quick Reference table at all — e.g. a hub skill with different structure
      await writeFile(filePath, '# Hub Skill\n\nSome workflow steps.\n', 'utf8')

      const result = await patchSkillFile(filePath)
      expect(result).to.be.false
    })

    it('patches old SKILL.md and adds brv curate view table row', async () => {
      const filePath = path.join(testDir, 'SKILL.md')
      await writeFile(filePath, OLD_SKILL_CONTENT, 'utf8')

      const result = await patchSkillFile(filePath)
      expect(result).to.be.true

      const patched = await readFile(filePath, 'utf8')
      expect(patched).to.include('`brv curate view`')
      expect(patched).to.include('Check curate history')
    })

    it('inserts table row immediately after the brv curate row', async () => {
      const filePath = path.join(testDir, 'SKILL.md')
      await writeFile(filePath, OLD_SKILL_CONTENT, 'utf8')
      await patchSkillFile(filePath)

      const patched = await readFile(filePath, 'utf8')
      const curateRowIdx = patched.indexOf('`brv curate "context" -f file`')
      const viewRowIdx = patched.indexOf('`brv curate view`')
      const statusRowIdx = patched.indexOf('`brv status`')

      expect(viewRowIdx).to.be.greaterThan(curateRowIdx)
      expect(viewRowIdx).to.be.lessThan(statusRowIdx)
    })

    it('patches old SKILL.md and adds View curate history subsection', async () => {
      const filePath = path.join(testDir, 'SKILL.md')
      await writeFile(filePath, OLD_SKILL_CONTENT, 'utf8')

      await patchSkillFile(filePath)

      const patched = await readFile(filePath, 'utf8')
      expect(patched).to.include('**View curate history** to check past curations:')
      expect(patched).to.include('brv curate view <logId>')
      expect(patched).to.include('brv curate view --since 1h')
      expect(patched).to.include('brv curate view --help')
    })

    it('inserts subsection after "Made an architecture decision" bullet', async () => {
      const filePath = path.join(testDir, 'SKILL.md')
      await writeFile(filePath, OLD_SKILL_CONTENT, 'utf8')
      await patchSkillFile(filePath)

      const patched = await readFile(filePath, 'utf8')
      const decisionIdx = patched.indexOf('- Made an architecture decision')
      const subsectionIdx = patched.indexOf('**View curate history**')
      const qualityIdx = patched.indexOf('## Curate Quality')

      expect(subsectionIdx).to.be.greaterThan(decisionIdx)
      expect(subsectionIdx).to.be.lessThan(qualityIdx)
    })

    it('is idempotent — second call returns false, no duplicate content', async () => {
      const filePath = path.join(testDir, 'SKILL.md')
      await writeFile(filePath, OLD_SKILL_CONTENT, 'utf8')
      await patchSkillFile(filePath)

      const result2 = await patchSkillFile(filePath)
      expect(result2).to.be.false

      const patched = await readFile(filePath, 'utf8')
      const count = (patched.match(/View curate history/g) ?? []).length
      expect(count).to.equal(1)
    })
  })

  // -------------------------------------------------------------------------
  // patchWorkflowsFile
  // -------------------------------------------------------------------------

  describe('patchWorkflowsFile', () => {
    it('returns false when file does not exist', async () => {
      const result = await patchWorkflowsFile(path.join(testDir, 'WORKFLOWS.md'))
      expect(result).to.be.false
    })

    it('returns false when brv curate view already present', async () => {
      const filePath = path.join(testDir, 'WORKFLOWS.md')
      await writeFile(filePath, OLD_WORKFLOWS_CONTENT + '\nbrv curate view\n', 'utf8')

      const result = await patchWorkflowsFile(filePath)
      expect(result).to.be.false
    })

    it('returns false when "## What to Curate" anchor not found', async () => {
      const filePath = path.join(testDir, 'WORKFLOWS.md')
      await writeFile(filePath, '# Workflows\n\nSome content without the expected section.\n', 'utf8')

      const result = await patchWorkflowsFile(filePath)
      expect(result).to.be.false
    })

    it('patches old WORKFLOWS.md and adds Verifying Curate Results section', async () => {
      const filePath = path.join(testDir, 'WORKFLOWS.md')
      await writeFile(filePath, OLD_WORKFLOWS_CONTENT, 'utf8')

      const result = await patchWorkflowsFile(filePath)
      expect(result).to.be.true

      const patched = await readFile(filePath, 'utf8')
      expect(patched).to.include('## Verifying Curate Results')
      expect(patched).to.include('brv curate view cur-')
      expect(patched).to.include('brv curate view --detail')
    })

    it('inserts section before "## What to Curate"', async () => {
      const filePath = path.join(testDir, 'WORKFLOWS.md')
      await writeFile(filePath, OLD_WORKFLOWS_CONTENT, 'utf8')
      await patchWorkflowsFile(filePath)

      const patched = await readFile(filePath, 'utf8')
      const verifyIdx = patched.indexOf('## Verifying Curate Results')
      const whatIdx = patched.indexOf('## What to Curate')
      expect(verifyIdx).to.be.greaterThan(-1)
      expect(verifyIdx).to.be.lessThan(whatIdx)
    })

    it('is idempotent — second call returns false, no duplicate section', async () => {
      const filePath = path.join(testDir, 'WORKFLOWS.md')
      await writeFile(filePath, OLD_WORKFLOWS_CONTENT, 'utf8')
      await patchWorkflowsFile(filePath)

      const result2 = await patchWorkflowsFile(filePath)
      expect(result2).to.be.false

      const patched = await readFile(filePath, 'utf8')
      const count = (patched.match(/## Verifying Curate Results/g) ?? []).length
      expect(count).to.equal(1)
    })
  })

  // -------------------------------------------------------------------------
  // ensureCurateViewPatched
  // -------------------------------------------------------------------------

  describe('ensureCurateViewPatched', () => {
    it('silently no-ops when no connector files exist', async () => {
      // Should not throw even when no files are present
      let threw = false
      try {
        await ensureCurateViewPatched(testDir)
      } catch {
        threw = true
      }

      expect(threw).to.be.false
    })

    it('patches a rules file found at the project root', async () => {
      const rulesPath = path.join(testDir, 'CLAUDE.md')
      await writeFile(rulesPath, makeOldRulesContent(), 'utf8')

      await ensureCurateViewPatched(testDir)

      const patched = await readFile(rulesPath, 'utf8')
      expect(patched).to.include('brv curate view')
    })

    it('patches a SKILL.md found inside .claude/skills/', async () => {
      const skillDir = path.join(testDir, '.claude', 'skills', 'byterover')
      await mkdir(skillDir, {recursive: true})
      await writeFile(path.join(skillDir, 'SKILL.md'), OLD_SKILL_CONTENT, 'utf8')

      await ensureCurateViewPatched(testDir)

      const patched = await readFile(path.join(skillDir, 'SKILL.md'), 'utf8')
      expect(patched).to.include('brv curate view')
    })

    it('patches a WORKFLOWS.md found inside .claude/skills/', async () => {
      const skillDir = path.join(testDir, '.claude', 'skills', 'byterover')
      await mkdir(skillDir, {recursive: true})
      await writeFile(path.join(skillDir, 'WORKFLOWS.md'), OLD_WORKFLOWS_CONTENT, 'utf8')

      await ensureCurateViewPatched(testDir)

      const patched = await readFile(path.join(skillDir, 'WORKFLOWS.md'), 'utf8')
      expect(patched).to.include('brv curate view')
    })

    it('patches all connector files in one call', async () => {
      const rulesPath = path.join(testDir, 'CLAUDE.md')
      const skillDir = path.join(testDir, '.claude', 'skills', 'byterover')
      await mkdir(skillDir, {recursive: true})
      await writeFile(rulesPath, makeOldRulesContent(), 'utf8')
      await writeFile(path.join(skillDir, 'SKILL.md'), OLD_SKILL_CONTENT, 'utf8')
      await writeFile(path.join(skillDir, 'WORKFLOWS.md'), OLD_WORKFLOWS_CONTENT, 'utf8')

      await ensureCurateViewPatched(testDir)

      const [rules, skill, workflows] = await Promise.all([
        readFile(rulesPath, 'utf8'),
        readFile(path.join(skillDir, 'SKILL.md'), 'utf8'),
        readFile(path.join(skillDir, 'WORKFLOWS.md'), 'utf8'),
      ])
      expect(rules).to.include('brv curate view')
      expect(skill).to.include('brv curate view')
      expect(workflows).to.include('brv curate view')
    })

    it('is idempotent — second call does not modify already-patched files', async () => {
      const rulesPath = path.join(testDir, 'CLAUDE.md')
      await writeFile(rulesPath, makeOldRulesContent(), 'utf8')

      await ensureCurateViewPatched(testDir)
      const afterFirst = await readFile(rulesPath, 'utf8')

      await ensureCurateViewPatched(testDir)
      const afterSecond = await readFile(rulesPath, 'utf8')

      expect(afterFirst).to.equal(afterSecond)
    })

    it('skips hub skill SKILL.md files that lack the Quick Reference anchor', async () => {
      // Hub skills (byterover-plan, byterover-execute, etc.) have a different structure —
      // the patcher should not touch them and should not throw
      const hubSkillDir = path.join(testDir, '.claude', 'skills', 'byterover-plan')
      await mkdir(hubSkillDir, {recursive: true})
      const hubContent = '# ByteRover Plan\n\nWorkflow steps here.\n\n```bash\nbrv curate "plan"\n```\n'
      await writeFile(path.join(hubSkillDir, 'SKILL.md'), hubContent, 'utf8')

      await ensureCurateViewPatched(testDir)

      // File should be unchanged — no anchor found, no patch applied
      const content = await readFile(path.join(hubSkillDir, 'SKILL.md'), 'utf8')
      expect(content).to.equal(hubContent)
    })
  })

  describe('upsertByteroverBlock / removeByteroverBlock', () => {
    const BLOCK = `${START}\nmanaged byterover block\n${END}`

    it('creates a missing file (including parent dirs) with the managed block', async () => {
      const filePath = path.join(testDir, 'nested', 'SOUL.md')

      const changed = await upsertByteroverBlock(filePath, BLOCK)

      expect(changed).to.be.true
      const content = await readFile(filePath, 'utf8')
      expect(content).to.equal(`${BLOCK}\n`)
    })

    it('is a no-op when the block is already present and unchanged', async () => {
      const filePath = path.join(testDir, 'SOUL.md')
      await upsertByteroverBlock(filePath, BLOCK)

      const changed = await upsertByteroverBlock(filePath, BLOCK)

      expect(changed).to.be.false
    })

    it('replaces a stale block in place, preserving surrounding content', async () => {
      const filePath = path.join(testDir, 'SOUL.md')
      await writeFile(filePath, `before\n\n${START}\nstale\n${END}\n\nafter\n`, 'utf8')

      const changed = await upsertByteroverBlock(filePath, BLOCK)

      expect(changed).to.be.true
      const content = await readFile(filePath, 'utf8')
      expect(content).to.include('before')
      expect(content).to.include('after')
      expect(content).to.include('managed byterover block')
      expect(content).to.not.include('stale')
    })

    it('returns false when removing from a missing file', async () => {
      const removed = await removeByteroverBlock(path.join(testDir, 'absent.md'))

      expect(removed).to.be.false
    })

    it('returns false when the file has no managed block', async () => {
      const filePath = path.join(testDir, 'SOUL.md')
      await writeFile(filePath, 'just user content\n', 'utf8')

      const removed = await removeByteroverBlock(filePath)

      expect(removed).to.be.false
      expect(await readFile(filePath, 'utf8')).to.equal('just user content\n')
    })

    it('removes a mid-file block and keeps before/after separated by one blank line', async () => {
      const filePath = path.join(testDir, 'SOUL.md')
      await writeFile(filePath, `before\n\n${BLOCK}\n\nafter\n`, 'utf8')

      const removed = await removeByteroverBlock(filePath)

      expect(removed).to.be.true
      expect(await readFile(filePath, 'utf8')).to.equal('before\n\nafter\n')
    })

    it('empties a file that contained only the managed block', async () => {
      const filePath = path.join(testDir, 'SOUL.md')
      await writeFile(filePath, `${BLOCK}\n`, 'utf8')

      const removed = await removeByteroverBlock(filePath)

      expect(removed).to.be.true
      expect(await readFile(filePath, 'utf8')).to.equal('')
    })

    it('removes a block at EOF with no trailing newline, keeping the leading content', async () => {
      const filePath = path.join(testDir, 'SOUL.md')
      await writeFile(filePath, `keep me\n\n${BLOCK}`, 'utf8')

      const removed = await removeByteroverBlock(filePath)

      expect(removed).to.be.true
      expect(await readFile(filePath, 'utf8')).to.equal('keep me\n')
    })

    it('keeps only the trailing content when the block is at the start of the file', async () => {
      const filePath = path.join(testDir, 'SOUL.md')
      await writeFile(filePath, `${BLOCK}\n\ntrailing content\n`, 'utf8')

      const removed = await removeByteroverBlock(filePath)

      expect(removed).to.be.true
      expect(await readFile(filePath, 'utf8')).to.equal('trailing content\n')
    })
  })
})
