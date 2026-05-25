#!/usr/bin/env node
// `pi-channel-extension install` — copies the bundled extension.js into
// Pi's extensions directory. Idempotent; overwrites on every run.
//
// Install path priority — matches Pi's discovery in
// pi/packages/coding-agent/src/config.ts + extensions/loader.ts:
//   1. `PI_EXTENSIONS_DIR` (this CLI's own escape hatch — full extensions dir)
//   2. `PI_CODING_AGENT_DIR/extensions/` (Pi's canonical agent-dir env var)
//   3. `~/.pi/agent/extensions/` (Pi's default)

import {existsSync, mkdirSync, copyFileSync} from 'node:fs'
import {homedir} from 'node:os'
import {dirname, join, resolve} from 'node:path'
import {fileURLToPath} from 'node:url'
import process from 'node:process'

const HERE = dirname(fileURLToPath(import.meta.url))
const PACKAGE_ROOT = resolve(HERE, '..')

const SOURCE = join(PACKAGE_ROOT, 'dist', 'extension.js')
const TARGET_FILENAME = 'brv-channel.js'

const sub = process.argv[2] ?? 'install'

if (sub === '--help' || sub === '-h' || sub === 'help') {
  printHelp()
  process.exit(0)
}

if (sub !== 'install') {
  console.error(`pi-channel-extension: unknown command "${sub}"`)
  printHelp()
  process.exit(1)
}

if (!existsSync(SOURCE)) {
  console.error(`pi-channel-extension: bundled extension not found at ${SOURCE}.`)
  console.error('Run `npm run build` in the package first.')
  process.exit(1)
}

const targetDir = resolveTargetDir()

mkdirSync(targetDir, {recursive: true})
const targetFile = join(targetDir, TARGET_FILENAME)
copyFileSync(SOURCE, targetFile)
console.log(`✓ installed ${targetFile}`)
console.log('  Restart pi to load.')

function printHelp() {
  console.log('Usage: pi-channel-extension install')
  console.log('')
  console.log('Copies the brv channel extension into Pi\'s extensions directory.')
  console.log('Install path priority:')
  console.log('  1. PI_EXTENSIONS_DIR              — full path to the extensions dir')
  console.log('  2. PI_CODING_AGENT_DIR/extensions — Pi\'s canonical agent dir + /extensions')
  console.log('  3. ~/.pi/agent/extensions         — Pi\'s default')
}

function resolveTargetDir() {
  const explicit = process.env.PI_EXTENSIONS_DIR
  if (explicit && explicit !== '') return explicit
  const piAgent = process.env.PI_CODING_AGENT_DIR
  if (piAgent && piAgent !== '') return join(piAgent, 'extensions')
  return join(homedir(), '.pi', 'agent', 'extensions')
}
