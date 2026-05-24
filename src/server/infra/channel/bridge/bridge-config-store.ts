 
import {existsSync, mkdirSync, readFileSync, renameSync, writeFileSync} from 'node:fs'
import {dirname, join} from 'node:path'
import {z} from 'zod'

/**
 * Persistent bridge runtime config.
 *
 * Lives at `<dataDir>/state/bridge-config.json`. Captures the operator-
 * facing knobs that today are read from `BRV_BRIDGE_*` env vars
 * (`brv-server.ts` start-up). Persisting them survives daemon respawns
 * that drop the env: previously, any CLI call lacking
 * `BRV_BRIDGE_PARLEY_PROFILE` would auto-spawn a fresh daemon that
 * silently fell back to `mock-echo` + `pinned-only`, breaking active
 * bridges without an error.
 *
 * Precedence at resolve time (see `resolveBridgeRuntimeConfig` below):
 *
 *   env var  >  file value  >  built-in default
 *
 * When an env var supplies a value that's NOT already in the file (or
 * differs from the file), the resolver writes the env-supplied value
 * back to the file so subsequent respawns inherit it. Operators who
 * want to drop a setting reach into the file directly (or delete it).
 */

export const BridgePersistedConfigSchema = z
  .object({
    /**
     * Phase 9.5.9 §2.7 — persist BRV_BRIDGE_AUTO_CREATE_QUOTA so daemon
     * respawns without env inherit the operator-configured quota.
     */
    autoCreateQuota: z.number().int().positive().optional(),
    autoProvision: z.enum(['auto', 'pinned-only', 'deny']).optional(),
    /**
     * Phase 9.5.9 §2.7 — persist BRV_BRIDGE_CLAUDE_UNSAFE so a daemon
     * respawn without BRV_BRIDGE_CLAUDE_UNSAFE in env does not silently
     * fall back and fail Claude Code adapter registration.
     */
    claudeUnsafe: z.boolean().optional(),
    delegatePolicy: z.enum(['auto', 'prompt', 'deny']).optional(),
    // libp2p listen multiaddrs the daemon-integrated bridge binds.
    // DEFAULT_BRIDGE_CONFIG.listen_addrs is `['/ip4/127.0.0.1/tcp/0']`
    // (loopback-only, ephemeral port). Cross-machine bridge needs an
    // externally-routable address — operators set `BRV_BRIDGE_LISTEN_ADDRS`
    // (comma-separated) to something like
    // `/ip4/0.0.0.0/tcp/60001,/ip4/100.x.x.x/tcp/60001`.
    listenAddrs: z.array(z.string().min(1)).min(1).optional(),
    maxConcurrentPerProfile: z.number().int().positive().optional(),
    /**
     * Phase 9.5.9 §2.7 — persist BRV_BRIDGE_PARLEY_DIAL_TIMEOUT_MS
     * (Phase 9.5.7 split-timeout config) so respawns inherit it.
     */
    parleyDialTimeoutMs: z.number().int().positive().optional(),
    /**
     * Phase 9.5.9 §2.7 — for future use (Phase 9.5.7 hard-cap timeout).
     */
    parleyHardTimeoutMs: z.number().int().positive().optional(),
    parleyProfile: z.string().min(1).optional(),
    /**
     * Phase 9.5.9 §2.7 — persist BRV_BRIDGE_PARLEY_TURN_IDLE_TIMEOUT_MS
     * (Phase 9.5.7 split-timeout config) so respawns inherit it.
     */
    parleyTurnIdleTimeoutMs: z.number().int().positive().optional(),
    projectRoot: z.string().min(1).optional(),
  })
  .strict()

export type BridgePersistedConfig = z.infer<typeof BridgePersistedConfigSchema>

export const BRIDGE_CONFIG_FILE = 'bridge-config.json'

export class BridgeConfigStore {
  public readonly filePath: string

  public constructor(args: {readonly stateDir: string}) {
    this.filePath = join(args.stateDir, BRIDGE_CONFIG_FILE)
  }

  public load(): BridgePersistedConfig {
    if (!existsSync(this.filePath)) return {}
    try {
      const raw = readFileSync(this.filePath, 'utf8')
      const parsed = BridgePersistedConfigSchema.safeParse(JSON.parse(raw))
      if (!parsed.success) return {}
      return parsed.data
    } catch {
      // Corrupt file -> ignore, fall back to defaults. The next env-driven
      // resolve will overwrite it atomically.
      return {}
    }
  }

  public save(config: BridgePersistedConfig): void {
    const validated = BridgePersistedConfigSchema.parse(config)
    mkdirSync(dirname(this.filePath), {recursive: true})
    const tmp = `${this.filePath}.tmp`
    writeFileSync(tmp, JSON.stringify(validated, null, 2), 'utf8')
    renameSync(tmp, this.filePath)
  }
}

/**
 * Resolve the runtime bridge config from env + file + defaults, and
 * persist any env-supplied values to the file so daemon respawns
 * inherit them.
 *
 * Returns the resolved values for the caller to consume; the caller
 * stays responsible for logging the resolved policy at INFO so
 * operators see what the daemon ended up using (see `brv-server.ts`).
 */
export interface ResolvedBridgeRuntimeConfig {
  /** Phase 9.5.9 §2.7 — per-peer auto-create quota (default undefined = library default). */
  readonly autoCreateQuota: number | undefined
  readonly autoProvision: 'auto' | 'deny' | 'pinned-only'
  /** Phase 9.5.9 §2.7 — Claude-unsafe adapter flag. */
  readonly claudeUnsafe: boolean
  readonly delegatePolicy: 'auto' | 'deny' | 'prompt'
  /**
   * Listen multiaddrs the daemon-integrated bridge will bind. When env or
   * file don't supply this, `undefined` — caller falls back to
   * `DEFAULT_BRIDGE_CONFIG.listen_addrs` (loopback-only). Cross-machine
   * operators set `BRV_BRIDGE_LISTEN_ADDRS` (comma-separated multiaddrs).
   */
  readonly listenAddrs: readonly string[] | undefined
  readonly maxConcurrentPerProfile: number
  /** Phase 9.5.9 §2.7 — parley dial timeout in ms. */
  readonly parleyDialTimeoutMs: number | undefined
  readonly parleyProfile: string | undefined
  /** Phase 9.5.9 §2.7 — parley turn idle timeout in ms. */
  readonly parleyTurnIdleTimeoutMs: number | undefined
  readonly projectRoot: string
}

export interface ResolveBridgeRuntimeConfigArgs {
  readonly cwd?: () => string
  readonly env?: NodeJS.ProcessEnv
  readonly log: (msg: string) => void
  readonly store: BridgeConfigStore
}

export function resolveBridgeRuntimeConfig(args: ResolveBridgeRuntimeConfigArgs): ResolvedBridgeRuntimeConfig {
  const env = args.env ?? process.env
  const cwdFn = args.cwd ?? (() => process.cwd())
  const fileCfg = args.store.load()

  const envParleyProfile = readStringEnv(env.BRV_BRIDGE_PARLEY_PROFILE)
  const envAutoProvision = readEnumEnv(env.BRV_BRIDGE_AUTO_PROVISION, ['auto', 'pinned-only', 'deny'], (raw) =>
    args.log(`[Daemon] invalid BRV_BRIDGE_AUTO_PROVISION="${raw}"; expected {auto, pinned-only, deny}`),
  )
  const envDelegatePolicy = readEnumEnv(env.BRV_BRIDGE_DELEGATE_POLICY, ['auto', 'prompt', 'deny'], (raw) =>
    args.log(`[Daemon] invalid BRV_BRIDGE_DELEGATE_POLICY="${raw}"; expected {auto, prompt, deny}`),
  )
  const envMaxConcurrent = readPositiveIntEnv(env.BRV_BRIDGE_MAX_CONCURRENT_PER_PROFILE, (raw) =>
    args.log(`[Daemon] invalid BRV_BRIDGE_MAX_CONCURRENT_PER_PROFILE="${raw}"; expected positive integer`),
  )
  const envProjectRoot = readStringEnv(env.BRV_BRIDGE_PROJECT_ROOT)
  // Cross-machine bridge — operators set this to expose the
  // daemon-integrated bridge on a routable interface
  // (e.g. `/ip4/0.0.0.0/tcp/60001` or a Tailscale-IP'd multiaddr).
  // Comma-separated for multi-interface binding.
  const envListenAddrs = readCommaListEnv(env.BRV_BRIDGE_LISTEN_ADDRS)

  // Phase 9.5.9 §2.7 — new env vars that are also persisted to file
  const envClaudeUnsafe = readBoolEnv(env.BRV_BRIDGE_CLAUDE_UNSAFE)
  const envParleyDialTimeoutMs = readPositiveIntEnv(env.BRV_BRIDGE_PARLEY_DIAL_TIMEOUT_MS, (raw) =>
    args.log(`[Daemon] invalid BRV_BRIDGE_PARLEY_DIAL_TIMEOUT_MS="${raw}"; expected positive integer`),
  )
  const envParleyTurnIdleTimeoutMs = readPositiveIntEnv(env.BRV_BRIDGE_PARLEY_TURN_IDLE_TIMEOUT_MS, (raw) =>
    args.log(`[Daemon] invalid BRV_BRIDGE_PARLEY_TURN_IDLE_TIMEOUT_MS="${raw}"; expected positive integer`),
  )
  const envAutoCreateQuota = readPositiveIntEnv(env.BRV_BRIDGE_AUTO_CREATE_QUOTA, (raw) =>
    args.log(`[Daemon] invalid BRV_BRIDGE_AUTO_CREATE_QUOTA="${raw}"; expected positive integer`),
  )

  // env > file > default
  const resolvedParleyProfile = envParleyProfile ?? fileCfg.parleyProfile
  const resolvedAutoProvision = envAutoProvision ?? fileCfg.autoProvision ?? 'pinned-only'
  const resolvedDelegatePolicy = envDelegatePolicy ?? fileCfg.delegatePolicy ?? 'prompt'
  const resolvedMaxConcurrent = envMaxConcurrent ?? fileCfg.maxConcurrentPerProfile ?? 1
  const resolvedProjectRoot = envProjectRoot ?? fileCfg.projectRoot ?? cwdFn()
  const resolvedListenAddrs = envListenAddrs ?? fileCfg.listenAddrs
  const resolvedClaudeUnsafe = envClaudeUnsafe ?? fileCfg.claudeUnsafe ?? false
  const resolvedParleyDialTimeoutMs = envParleyDialTimeoutMs ?? fileCfg.parleyDialTimeoutMs
  const resolvedParleyTurnIdleTimeoutMs = envParleyTurnIdleTimeoutMs ?? fileCfg.parleyTurnIdleTimeoutMs
  const resolvedAutoCreateQuota = envAutoCreateQuota ?? fileCfg.autoCreateQuota

  // Persist env-supplied values (and any settled defaults that env
  // promoted) so a future daemon respawn without env vars sees the
  // same config. We only write when something env-supplied differs
  // from what's already on disk; pure file-only or pure-default runs
  // are no-ops.
  const envSnapshot = {
    autoCreateQuota: envAutoCreateQuota,
    autoProvision: envAutoProvision,
    claudeUnsafe: envClaudeUnsafe,
    delegatePolicy: envDelegatePolicy,
    listenAddrs: envListenAddrs,
    maxConcurrentPerProfile: envMaxConcurrent,
    parleyDialTimeoutMs: envParleyDialTimeoutMs,
    parleyProfile: envParleyProfile,
    parleyTurnIdleTimeoutMs: envParleyTurnIdleTimeoutMs,
    projectRoot: envProjectRoot,
  }
  if (anyDefined(envSnapshot)) {
    persistConfigIfChanged({
      env: envSnapshot,
      fileCfg,
      log: args.log,
      store: args.store,
    })
  }

  return {
    autoCreateQuota: resolvedAutoCreateQuota,
    autoProvision: resolvedAutoProvision,
    claudeUnsafe: resolvedClaudeUnsafe,
    delegatePolicy: resolvedDelegatePolicy,
    listenAddrs: resolvedListenAddrs,
    maxConcurrentPerProfile: resolvedMaxConcurrent,
    parleyDialTimeoutMs: resolvedParleyDialTimeoutMs,
    parleyProfile: resolvedParleyProfile,
    parleyTurnIdleTimeoutMs: resolvedParleyTurnIdleTimeoutMs,
    projectRoot: resolvedProjectRoot,
  }
}

interface EnvSnapshot {
  readonly autoCreateQuota: number | undefined
  readonly autoProvision: 'auto' | 'deny' | 'pinned-only' | undefined
  readonly claudeUnsafe: boolean | undefined
  readonly delegatePolicy: 'auto' | 'deny' | 'prompt' | undefined
  readonly listenAddrs: readonly string[] | undefined
  readonly maxConcurrentPerProfile: number | undefined
  readonly parleyDialTimeoutMs: number | undefined
  readonly parleyProfile: string | undefined
  readonly parleyTurnIdleTimeoutMs: number | undefined
  readonly projectRoot: string | undefined
}

function anyDefined(env: EnvSnapshot): boolean {
  return (
    env.parleyProfile !== undefined ||
    env.autoProvision !== undefined ||
    env.claudeUnsafe !== undefined ||
    env.delegatePolicy !== undefined ||
    env.listenAddrs !== undefined ||
    env.maxConcurrentPerProfile !== undefined ||
    env.parleyDialTimeoutMs !== undefined ||
    env.parleyTurnIdleTimeoutMs !== undefined ||
    env.autoCreateQuota !== undefined ||
    env.projectRoot !== undefined
  )
}

/**
 * Build the would-be-persisted shape by overlaying env onto file
 * (only for fields env actually supplied), then write to disk if it
 * differs from what's currently on disk. Pure file-only and pure-
 * default runs never reach this path (the caller checks
 * `anyDefined(env)` first).
 */
function persistConfigIfChanged(args: {
  readonly env: EnvSnapshot
  readonly fileCfg: BridgePersistedConfig
  readonly log: (msg: string) => void
  readonly store: BridgeConfigStore
}): void {
  const overlay: BridgePersistedConfig = {...args.fileCfg}
  if (args.env.parleyProfile !== undefined) overlay.parleyProfile = args.env.parleyProfile
  if (args.env.autoProvision !== undefined) overlay.autoProvision = args.env.autoProvision
  if (args.env.claudeUnsafe !== undefined) overlay.claudeUnsafe = args.env.claudeUnsafe
  if (args.env.delegatePolicy !== undefined) overlay.delegatePolicy = args.env.delegatePolicy
  if (args.env.listenAddrs !== undefined) overlay.listenAddrs = [...args.env.listenAddrs]
  if (args.env.maxConcurrentPerProfile !== undefined) overlay.maxConcurrentPerProfile = args.env.maxConcurrentPerProfile
  if (args.env.parleyDialTimeoutMs !== undefined) overlay.parleyDialTimeoutMs = args.env.parleyDialTimeoutMs
  if (args.env.parleyTurnIdleTimeoutMs !== undefined) overlay.parleyTurnIdleTimeoutMs = args.env.parleyTurnIdleTimeoutMs
  if (args.env.autoCreateQuota !== undefined) overlay.autoCreateQuota = args.env.autoCreateQuota
  if (args.env.projectRoot !== undefined) overlay.projectRoot = args.env.projectRoot

  if (configsEqual(args.fileCfg, overlay)) return

  try {
    args.store.save(overlay)
    args.log(`[Daemon] Bridge config persisted to ${args.store.filePath}`)
  } catch (error) {
    args.log(
      `[Daemon] Failed to persist bridge config to ${args.store.filePath}: ${
        error instanceof Error ? error.message : String(error)
      }`,
    )
  }
}

function readStringEnv(raw: string | undefined): string | undefined {
  if (raw === undefined) return undefined
  const trimmed = raw.trim()
  return trimmed === '' ? undefined : trimmed
}

function readEnumEnv<T extends string>(
  raw: string | undefined,
  allowed: readonly T[],
  onInvalid: (raw: string) => void,
): T | undefined {
  const value = readStringEnv(raw)
  if (value === undefined) return undefined
  if ((allowed as readonly string[]).includes(value)) return value as T
  onInvalid(value)
  return undefined
}

function readCommaListEnv(raw: string | undefined): readonly string[] | undefined {
  const value = readStringEnv(raw)
  if (value === undefined) return undefined
  const parts = value
    .split(',')
    .map((s) => s.trim())
    .filter((s) => s.length > 0)
  return parts.length === 0 ? undefined : parts
}

/**
 * Phase 9.5.9 §2.7 — parse a boolean env var.
 * Truthy values: '1', 'true', 'yes'. All else (or absent) → false/undefined.
 * Returns `undefined` when absent (so we can distinguish "not set" from "set to false").
 */
function readBoolEnv(raw: string | undefined): boolean | undefined {
  const value = readStringEnv(raw)
  if (value === undefined) return undefined
  return value === '1' || value.toLowerCase() === 'true' || value.toLowerCase() === 'yes'
}

function readPositiveIntEnv(raw: string | undefined, onInvalid: (raw: string) => void): number | undefined {
  const value = readStringEnv(raw)
  if (value === undefined) return undefined
  const parsed = Number.parseInt(value, 10)
  if (Number.isNaN(parsed) || parsed < 1) {
    onInvalid(value)
    return undefined
  }

  return parsed
}

function configsEqual(a: BridgePersistedConfig, b: BridgePersistedConfig): boolean {
  return JSON.stringify(sortKeys(a)) === JSON.stringify(sortKeys(b))
}

function sortKeys<T extends Record<string, unknown>>(obj: T): Record<string, unknown> {
  const sorted: Record<string, unknown> = {}
  for (const key of Object.keys(obj).sort()) {
    sorted[key] = obj[key]
  }

  return sorted
}
