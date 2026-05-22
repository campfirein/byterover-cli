 
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
    autoProvision: z.enum(['auto', 'pinned-only', 'deny']).optional(),
    delegatePolicy: z.enum(['auto', 'prompt', 'deny']).optional(),
    // libp2p listen multiaddrs the daemon-integrated bridge binds.
    // DEFAULT_BRIDGE_CONFIG.listen_addrs is `['/ip4/127.0.0.1/tcp/0']`
    // (loopback-only, ephemeral port). Cross-machine bridge needs an
    // externally-routable address — operators set `BRV_BRIDGE_LISTEN_ADDRS`
    // (comma-separated) to something like
    // `/ip4/0.0.0.0/tcp/60001,/ip4/100.x.x.x/tcp/60001`.
    listenAddrs: z.array(z.string().min(1)).min(1).optional(),
    maxConcurrentPerProfile: z.number().int().positive().optional(),
    parleyProfile: z.string().min(1).optional(),
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
  readonly autoProvision: 'auto' | 'deny' | 'pinned-only'
  readonly delegatePolicy: 'auto' | 'deny' | 'prompt'
  /**
   * Listen multiaddrs the daemon-integrated bridge will bind. When env or
   * file don't supply this, `undefined` — caller falls back to
   * `DEFAULT_BRIDGE_CONFIG.listen_addrs` (loopback-only). Cross-machine
   * operators set `BRV_BRIDGE_LISTEN_ADDRS` (comma-separated multiaddrs).
   */
  readonly listenAddrs: readonly string[] | undefined
  readonly maxConcurrentPerProfile: number
  readonly parleyProfile: string | undefined
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

  // env > file > default
  const resolvedParleyProfile = envParleyProfile ?? fileCfg.parleyProfile
  const resolvedAutoProvision = envAutoProvision ?? fileCfg.autoProvision ?? 'pinned-only'
  const resolvedDelegatePolicy = envDelegatePolicy ?? fileCfg.delegatePolicy ?? 'prompt'
  const resolvedMaxConcurrent = envMaxConcurrent ?? fileCfg.maxConcurrentPerProfile ?? 1
  const resolvedProjectRoot = envProjectRoot ?? fileCfg.projectRoot ?? cwdFn()
  const resolvedListenAddrs = envListenAddrs ?? fileCfg.listenAddrs

  // Persist env-supplied values (and any settled defaults that env
  // promoted) so a future daemon respawn without env vars sees the
  // same config. We only write when something env-supplied differs
  // from what's already on disk; pure file-only or pure-default runs
  // are no-ops.
  const envSnapshot = {
    autoProvision: envAutoProvision,
    delegatePolicy: envDelegatePolicy,
    listenAddrs: envListenAddrs,
    maxConcurrentPerProfile: envMaxConcurrent,
    parleyProfile: envParleyProfile,
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
    autoProvision: resolvedAutoProvision,
    delegatePolicy: resolvedDelegatePolicy,
    listenAddrs: resolvedListenAddrs,
    maxConcurrentPerProfile: resolvedMaxConcurrent,
    parleyProfile: resolvedParleyProfile,
    projectRoot: resolvedProjectRoot,
  }
}

interface EnvSnapshot {
  readonly autoProvision: 'auto' | 'deny' | 'pinned-only' | undefined
  readonly delegatePolicy: 'auto' | 'deny' | 'prompt' | undefined
  readonly listenAddrs: readonly string[] | undefined
  readonly maxConcurrentPerProfile: number | undefined
  readonly parleyProfile: string | undefined
  readonly projectRoot: string | undefined
}

function anyDefined(env: EnvSnapshot): boolean {
  return (
    env.parleyProfile !== undefined ||
    env.autoProvision !== undefined ||
    env.delegatePolicy !== undefined ||
    env.listenAddrs !== undefined ||
    env.maxConcurrentPerProfile !== undefined ||
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
  if (args.env.delegatePolicy !== undefined) overlay.delegatePolicy = args.env.delegatePolicy
  if (args.env.listenAddrs !== undefined) overlay.listenAddrs = [...args.env.listenAddrs]
  if (args.env.maxConcurrentPerProfile !== undefined) overlay.maxConcurrentPerProfile = args.env.maxConcurrentPerProfile
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
