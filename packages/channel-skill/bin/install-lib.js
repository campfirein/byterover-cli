// Slice 8.2 — pure install logic for the brv-channel skill.
// Separated from bin/install.js so unit tests can import the functions
// without spawning a subprocess.

import {accessSync, constants, existsSync, mkdirSync, readFileSync, writeFileSync} from 'node:fs'
import {delimiter, dirname, join} from 'node:path'

/**
 * Canonical per-host skill discovery paths, relative to $HOME.
 *
 * Slice 8.2 ships THREE default targets, which between them cover the
 * five hosts audited in plan/channel-protocol/IMPLEMENTATION_PHASE_8.md:
 *
 *  - `~/.claude/skills/brv-channel/SKILL.md` — Claude Code (native);
 *    kimi-cli and opencode read it via their cross-brand fallback chains.
 *  - `~/.codex/skills/brv-channel/SKILL.md` — Codex CLI (codex does NOT
 *    fall back to ~/.claude, so it needs its own path).
 *  - `~/.agents/skills/brv-channel/SKILL.md` — Pi (cross-brand fallback);
 *    kimi-cli also reads this as an additional fallback.
 */
export const HOST_TO_PATH = Object.freeze({
  claude: '.claude/skills/brv-channel/SKILL.md',
  codex: '.codex/skills/brv-channel/SKILL.md',
  pi: '.agents/skills/brv-channel/SKILL.md',
})

/**
 * Aliases that map onto one of the three canonical paths above.
 * kimi-cli reads ~/.claude/skills first; opencode reads ~/.claude/skills.
 * Users passing `--target kimi` or `--target opencode` get the
 * Claude-Code path so the skill is discoverable for them too.
 */
const TARGET_ALIASES = Object.freeze({
  kimi: 'claude',
  opencode: 'claude',
})

export const DEFAULT_TARGET_PATHS = Object.freeze(['claude', 'codex', 'pi'])

/**
 * Resolve a `--target <host>` plus optional `--path <abs>` override
 * into a concrete list of absolute paths to write to.
 *
 * @param {object} opts
 * @param {string} opts.homeDir   `$HOME` (or test override).
 * @param {string} [opts.target]  Host name; 'all' = the three default paths.
 * @param {string} [opts.customPath]  Absolute path that overrides --target.
 * @returns {string[]} absolute paths in deterministic order
 */
export const resolveTargets = ({customPath, homeDir, target}) => {
  if (typeof customPath === 'string' && customPath !== '') {
    return [customPath]
  }

  const which = target ?? 'all'
  if (which === 'all') {
    return DEFAULT_TARGET_PATHS.map((host) => join(homeDir, HOST_TO_PATH[host]))
  }

  const resolved = TARGET_ALIASES[which] ?? which
  if (HOST_TO_PATH[resolved] === undefined) {
    throw new Error(
      `unknown target: ${which}. Expected one of: claude, codex, kimi, opencode, pi, all (or use --path <abs>).`,
    )
  }

  return [join(homeDir, HOST_TO_PATH[resolved])]
}

/**
 * Resolve the brv binary path that gets baked into the installed
 * SKILL.md. Priority:
 *   1. Explicit `brvBin` option (test override or `--brv-bin` flag).
 *   2. `BRV_BIN` env var.
 *   3. First `brv` executable found on `PATH`.
 *   4. Fallback: literal string `brv` — the host's shell will resolve it
 *      at call time, which works iff brv is on PATH at run time.
 *
 * The returned value is interpolated into `{{BRV_BIN}}` placeholders in
 * the SKILL.md body so the LLM sees a verbatim command path that works
 * on the user's machine.
 *
 * @param {object} [opts]
 * @param {string} [opts.brvBin]    Explicit override.
 * @param {string} [opts.pathEnv]   `PATH` value (default `process.env.PATH`).
 * @returns {string}
 */
export const resolveBrvBin = (opts = {}) => {
  if (typeof opts.brvBin === 'string' && opts.brvBin !== '') return opts.brvBin
  const envBin = process.env.BRV_BIN
  if (typeof envBin === 'string' && envBin !== '') return envBin
  const pathEnv = opts.pathEnv ?? process.env.PATH ?? ''
  for (const dir of pathEnv.split(delimiter)) {
    if (dir === '') continue
    const candidate = join(dir, 'brv')
    try {
      accessSync(candidate, constants.X_OK)
      return candidate
    } catch {
      // Not executable here — keep walking PATH.
    }
  }

  return 'brv'
}

/**
 * Install the skill body to each of `targets`. Idempotent: if a target
 * already contains identical content (after BRV_BIN substitution),
 * it's reported in `.skipped`. If a target exists with different
 * content, throws unless `force: true`.
 *
 * The source SKILL.md may contain `{{BRV_BIN}}` placeholders; they are
 * replaced with the resolved brv binary path before writing.
 *
 * @param {object} opts
 * @param {string} opts.skillSource  Absolute path to the source SKILL.md template.
 * @param {string[]} opts.targets    Absolute destination paths.
 * @param {boolean} [opts.dryRun]    If true, no disk writes.
 * @param {boolean} [opts.force]     If true, overwrite differing content.
 * @param {string} [opts.brvBin]     Override the resolved brv binary path.
 * @returns {Promise<{written: string[], skipped: string[], brvBin: string}>}
 */
export const install = async ({brvBin, dryRun, force, skillSource, targets}) => {
  if (!existsSync(skillSource)) {
    throw new Error(`SKILL.md source not found at ${skillSource}`)
  }

  const resolvedBrvBin = resolveBrvBin({brvBin})
  const template = readFileSync(skillSource, 'utf8')
  const body = template.replaceAll('{{BRV_BIN}}', resolvedBrvBin)
  const written = []
  const skipped = []

  for (const target of targets) {
    if (existsSync(target)) {
      const current = readFileSync(target, 'utf8')
      if (current === body) {
        skipped.push(target)
        continue
      }

      if (force !== true) {
        throw new Error(
          `${target} already exists with different content. Pass --force to overwrite.`,
        )
      }
    }

    if (dryRun !== true) {
      mkdirSync(dirname(target), {recursive: true})
      writeFileSync(target, body, 'utf8')
    }

    written.push(target)
  }

  return {brvBin: resolvedBrvBin, skipped, written}
}
