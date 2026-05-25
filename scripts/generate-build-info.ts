
/**
 * Phase 9.5.9 §2.1 — generate dist/build-info.json.
 *
 * Run as part of the build chain, AFTER `shx rm -rf dist` and BEFORE
 * `tsc -b`. This ensures the artifact survives tsc compilation and all
 * subsequent copy steps.
 *
 * Invocation: `tsx scripts/generate-build-info.ts`
 */

import {execSync} from 'node:child_process'
import {mkdirSync, readFileSync, writeFileSync} from 'node:fs'
import {dirname, join} from 'node:path'
import {fileURLToPath} from 'node:url'

// __dirname equivalent in ESM
const scriptDir = dirname(fileURLToPath(import.meta.url))
const projectRoot = dirname(scriptDir)
const outDir = join(projectRoot, 'dist')

mkdirSync(outDir, {recursive: true})

let gitSha: string | undefined
let gitDirty = false

try {
  gitSha = execSync('git rev-parse --short HEAD', {cwd: projectRoot}).toString().trim()
  try {
    execSync('git diff --quiet', {cwd: projectRoot})
  } catch {
    // git diff exited non-zero → working tree is dirty
    gitDirty = true
  }
} catch {
  // git not available or not a git repo
}

const buildAtIso = new Date().toISOString()

const pkgRaw = readFileSync(join(projectRoot, 'package.json'), {encoding: 'utf8'})
const pkg = JSON.parse(pkgRaw) as {version: string}

const buildId = `${buildAtIso}-${gitSha ?? 'nogit'}-${gitDirty ? 'dirty' : 'clean'}`

const info = {
  buildAtIso,
  buildId,
  gitDirty,
  gitSha,
  packageVersion: pkg.version,
}

writeFileSync(join(outDir, 'build-info.json'), JSON.stringify(info, null, 2), 'utf8')
console.log(`[build] wrote dist/build-info.json — buildId=${buildId}`)
