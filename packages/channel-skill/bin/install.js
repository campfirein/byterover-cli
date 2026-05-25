#!/usr/bin/env node
// `brv-channel-skill install` — copies the brv-channel SKILL.md into
// each host's agent-skill discovery dir. Idempotent.
//
// Default install paths (cover all five Phase-8 hosts):
//   ~/.claude/skills/brv-channel/SKILL.md   Claude Code (+kimi/opencode fallback)
//   ~/.codex/skills/brv-channel/SKILL.md    Codex CLI
//   ~/.agents/skills/brv-channel/SKILL.md   Pi (+kimi fallback)
//
// Flags:
//   --target <host>   claude | codex | kimi | opencode | pi | all (default 'all')
//   --path <abs>      override target with an explicit absolute path
//   --force           overwrite an existing SKILL.md that differs
//   --dry-run         print planned writes without touching disk

import {homedir} from 'node:os'
import {dirname, resolve} from 'node:path'
import process from 'node:process'
import {fileURLToPath} from 'node:url'

import {install, resolveTargets} from './install-lib.js'

const HERE = dirname(fileURLToPath(import.meta.url))
const PACKAGE_ROOT = resolve(HERE, '..')
const SKILL_SOURCE = resolve(PACKAGE_ROOT, 'SKILL.md')

const parseArgs = (argv) => {
  const args = {dryRun: false, force: false}
  // First positional that isn't a flag is the subcommand; we accept
  // `install` (default) and `--help`.
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]
    switch (arg) {
      case '--brv-bin': {
        args.brvBin = argv[i + 1]
        i += 1
        break
      }

      case '--dry-run': {
        args.dryRun = true
        break
      }

      case '--force': {
        args.force = true
        break
      }

      case '--help':
      case '-h':
      case 'help': {
        args.help = true
        break
      }

      case '--path': {
        args.customPath = argv[i + 1]
        i += 1
        break
      }

      case '--target': {
        args.target = argv[i + 1]
        i += 1
        break
      }

      case 'install': {
        args.sub = 'install'
        break
      }

      default: {
        if (arg.startsWith('-')) {
          throw new Error(`unknown flag: ${arg}`)
        }

        // Treat unrecognised positional as the subcommand.
        args.sub = arg
        break
      }
    }
  }

  return args
}

const HELP = `Usage: brv-channel-skill install [options]

Copies the brv-channel SKILL.md into each host's agent-skill discovery dir,
with the brv binary path baked into the body so the LLM sees a verbatim
command path that works on this machine.

Options:
  --target <host>   claude | codex | kimi | opencode | pi | all   default 'all'
  --path <abs>      override target with an explicit absolute path
  --brv-bin <path>  override the brv binary path baked into the skill
                    (default: BRV_BIN env > 'brv' on PATH > literal 'brv')
  --force           overwrite an existing SKILL.md that differs
  --dry-run         print planned writes without touching disk
  --help            show this help

Default install paths (cover all five Phase-8 hosts):
  ~/.claude/skills/brv-channel/SKILL.md     Claude Code (+kimi/opencode fallback)
  ~/.codex/skills/brv-channel/SKILL.md      Codex CLI
  ~/.agents/skills/brv-channel/SKILL.md     Pi (+kimi fallback)
`

const main = async () => {
  const args = parseArgs(process.argv.slice(2))
  if (args.help === true) {
    process.stdout.write(HELP)
    return
  }

  const sub = args.sub ?? 'install'
  if (sub !== 'install') {
    process.stderr.write(`brv-channel-skill: unknown command "${sub}"\n`)
    process.stderr.write(HELP)
    process.exit(1)
    return
  }

  const targets = resolveTargets({
    customPath: args.customPath,
    homeDir: homedir(),
    target: args.target ?? 'all',
  })

  const result = await install({
    brvBin: args.brvBin,
    dryRun: args.dryRun,
    force: args.force,
    skillSource: SKILL_SOURCE,
    targets,
  })

  process.stdout.write(`brv binary baked into SKILL.md: ${result.brvBin}\n`)
  const label = args.dryRun === true ? '(dry-run) would write' : '✓ installed'
  for (const path of result.written) process.stdout.write(`${label} ${path}\n`)
  for (const path of result.skipped) process.stdout.write(`= unchanged ${path}\n`)
  if (args.dryRun !== true && result.written.length > 0) {
    process.stdout.write('  Restart the host (Claude Code / Codex / Pi / kimi / opencode) to load.\n')
  }
}

main().catch((error) => {
  process.stderr.write(`brv-channel-skill: ${error instanceof Error ? error.message : String(error)}\n`)
  process.exit(1)
})
