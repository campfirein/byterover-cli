import {type AgentDriverProfileInvocation} from '../../../../shared/types/channel.js'
import {type IAcpDriver} from '../../../core/interfaces/channel/i-acp-driver.js'
import {type IDriverProfileStore} from '../../../core/interfaces/channel/i-driver-profile-store.js'
import {AcpAdapter} from './adapters/acp-adapter.js'
import {ClaudeCodeHeadlessAdapter} from './adapters/claude-code-headless-adapter.js'
import {MockEchoAdapter} from './adapters/mock-echo-adapter.js'
import {type BridgeDriverPool} from './bridge-driver-pool.js'
import {type ParleyAdapterSessionStore} from './parley-adapter-session-store.js'
import {type ParleyAdapter} from './parley-adapter.js'
import {type ProfileConcurrencyGate} from './profile-concurrency-gate.js'

/**
 * Phase 9.5.2 — registry contract + in-memory implementation.
 *
 * Adapters are keyed by `profile` name. The parley-server (and daemon
 * startup) resolve the active adapter by profile name at runtime.
 * Future adapters (`ClaudeCodeHeadlessAdapter`, `ShellTemplateAdapter`)
 * drop in by registering themselves here without further plumbing changes.
 */

/**
 * Thrown at daemon startup when `BRV_BRIDGE_PARLEY_PROFILE` is explicitly
 * set but the named profile is not registered in the adapter registry.
 *
 * Silently falling back to mock-echo when an operator has explicitly
 * configured a real profile masks misconfiguration: a live bridge
 * would silently become an echo endpoint instead of failing visibly
 * (codex round-2 MUST-FIX — plan §2.3).
 */

/**
 * Profile-specific hint table. When the requested profile matches a key here,
 * the hint is appended to the error message. This keeps the hint co-located
 * with the error class (plan §2.5, codex K79P0sTCkPTOaaZefPoh1 Fix 3).
 */
const PROFILE_HINTS: Readonly<Record<string, string>> = {
  'claude-code':
    `The 'claude-code' adapter is registered only when BRV_BRIDGE_CLAUDE_UNSAFE=1 is set ` +
    `in the daemon environment. See plan/bridge-smoothness/PLAN.md §2.5.`,
}

export class ParleyAdapterNotFoundError extends Error {
  public readonly code = 'PARLEY_ADAPTER_NOT_FOUND'
  public readonly profile: string

  public constructor(
    profile: string,
    available: ReadonlyArray<Pick<ParleyAdapter, 'kind' | 'profile'>>,
  ) {
    const names = available.map((a) => `"${a.profile}"`).join(', ')
    const hint = PROFILE_HINTS[profile]
    const hintSuffix = hint === undefined ? '' : ` > ${hint}`
    super(
      `Parley adapter profile "${profile}" is not registered. ` +
        `Available profiles: [${names || 'none'}]. ` +
        `Check BRV_BRIDGE_PARLEY_PROFILE or register a matching adapter.${hintSuffix}`,
    )
    this.name = 'ParleyAdapterNotFoundError'
    this.profile = profile
  }
}
export interface ParleyAdapterRegistry {
  list(): ReadonlyArray<Pick<ParleyAdapter, 'kind' | 'profile'>>
  register(adapter: ParleyAdapter): void
  resolve(profile: string): ParleyAdapter | undefined
}

export class InMemoryParleyAdapterRegistry implements ParleyAdapterRegistry {
  private readonly adapters = new Map<string, ParleyAdapter>()

  public list(): ReadonlyArray<Pick<ParleyAdapter, 'kind' | 'profile'>> {
    return [...this.adapters.values()].map(({kind, profile}) => ({kind, profile}))
  }

  public register(adapter: ParleyAdapter): void {
    this.adapters.set(adapter.profile, adapter)
  }

  public resolve(profile: string): ParleyAdapter | undefined {
    return this.adapters.get(profile)
  }
}

export interface CreateDefaultRegistryArgs {
  /**
   * When provided, the ACP adapter is registered and can serve profiles
   * stored in `profileStore`. When absent, only MockEchoAdapter is
   * registered (useful for integration tests that don't need real ACP).
   */
  readonly bridgeDriverPool?: BridgeDriverPool
  /**
   * Concurrency gate for spawn-per-turn adapters (e.g.
   * `ClaudeCodeHeadlessAdapter`). Required when `env.BRV_BRIDGE_CLAUDE_UNSAFE`
   * is `'1'`.
   */
  readonly concurrencyGate?: ProfileConcurrencyGate
  readonly driverFactory?: (invocation: AgentDriverProfileInvocation, handle: string) => IAcpDriver
  /**
   * Daemon process environment. Used to gate unsafe adapters behind
   * `BRV_BRIDGE_CLAUDE_UNSAFE=1`.
   *
   * Precedence for claude-code registration:
   *   env.BRV_BRIDGE_CLAUDE_UNSAFE === '1'  → register (env wins)
   *   persistedClaudeUnsafe === true          → register (persisted fallback)
   *   otherwise                               → skip (default-off)
   */
  readonly env?: NodeJS.ProcessEnv
  readonly log: (msg: string) => void
  /**
   * Phase 9.5.9 Issue 3 — persisted claudeUnsafe value from bridge-config.json.
   * Precedence: env > persisted > false.
   * Set this to `bridgeRuntime.claudeUnsafe` when constructing the registry
   * at daemon startup so a respawn without BRV_BRIDGE_CLAUDE_UNSAFE in env
   * still registers the claude-code adapter if it was persisted.
   */
  readonly persistedClaudeUnsafe?: boolean
  readonly profileName?: string
  readonly profileStore?: IDriverProfileStore
  /**
   * Session store for adapters that persist per-turn state (e.g.
   * `ClaudeCodeHeadlessAdapter`). Required when
   * `env.BRV_BRIDGE_CLAUDE_UNSAFE` is `'1'`.
   */
  readonly sessionStore?: ParleyAdapterSessionStore
}

/**
 * The set of profile names owned by built-in adapters. AcpAdapter MUST
 * never register under one of these, even when wired via
 * BRV_BRIDGE_PARLEY_PROFILE. When the matching built-in is env-gated off
 * (e.g. 'claude-code' without BRV_BRIDGE_CLAUDE_UNSAFE=1), the strict
 * startup resolve should fail-fast with the hint table — NOT silently
 * fall back to an AcpAdapter that will throw PARLEY_LOCAL_AGENT_PROFILE_MISSING
 * at first turn.
 *
 * `ReadonlySet<string>` so membership is checked with `.has()` not `.includes()`.
 * (codex round-2: original plan declared array — type bug fixed here.)
 */
export const BUILTIN_PARLEY_PROFILE_NAMES: ReadonlySet<string> = new Set(['claude-code', 'mock-echo'])

/**
 * Build the default adapter registry used by the daemon.
 *
 * Always registers `MockEchoAdapter` (profile `'mock-echo'`).
 * Registers `AcpAdapter` only when `bridgeDriverPool`, `driverFactory`,
 * `profileStore`, and `profileName` are all supplied AND the profile name
 * does NOT collide with a built-in name (phase 9.5.7 §3.1).
 *
 * Phase 9.5.3 — registers `ClaudeCodeHeadlessAdapter` ONLY when
 * `env.BRV_BRIDGE_CLAUDE_UNSAFE === '1'`. Default-off per plan §2.5
 * (codex round-1 BLOCKER #1): the adapter spawns
 * `--dangerously-skip-permissions` and must not activate by accident.
 */
export function createDefaultRegistry(args: CreateDefaultRegistryArgs): ParleyAdapterRegistry {
  const registry = new InMemoryParleyAdapterRegistry()
  registry.register(new MockEchoAdapter())

  if (
    args.bridgeDriverPool !== undefined &&
    args.driverFactory !== undefined &&
    args.profileStore !== undefined &&
    args.profileName !== undefined &&
    !BUILTIN_PARLEY_PROFILE_NAMES.has(args.profileName)
  ) {
    // ACP adapter registration: only when all args are supplied AND the
    // profile name does not collide with a built-in. The function MUST NOT
    // return here — downstream ClaudeCodeHeadlessAdapter registration must
    // still run (codex round-2: avoid early-return that skips built-in reg).
    registry.register(
      new AcpAdapter({
        driverFactory: args.driverFactory,
        pool: args.bridgeDriverPool,
        profileName: args.profileName,
        profileStore: args.profileStore,
      }),
    )
  } else if (args.profileName !== undefined && BUILTIN_PARLEY_PROFILE_NAMES.has(args.profileName)) {
    // Reserved name — do NOT register AcpAdapter, log a warning, and
    // continue so downstream built-in registrations (e.g.
    // ClaudeCodeHeadlessAdapter) still run.
    args.log(
      `[Daemon] Refusing AcpAdapter registration under reserved name "${args.profileName}"; ` +
      `this name is owned by a built-in adapter. If you intended to use the built-in, ` +
      `check the relevant env var (e.g. BRV_BRIDGE_CLAUDE_UNSAFE=1 for claude-code).`,
    )
  } else if (args.profileName !== undefined) {
    args.log(`[Daemon] Parley adapter registry: ACP adapter skipped — missing driverFactory or profileStore`)
  }

  // Phase 9.5.3 — ClaudeCodeHeadlessAdapter gated behind unsafe env flag.
  // Registered only when the unsafe flag is set to prevent accidental
  // activation of --dangerously-skip-permissions in production environments.
  //
  // Issue 3a fix: precedence is env > persisted > false.
  //   env.BRV_BRIDGE_CLAUDE_UNSAFE === '1'  → register (env wins)
  //   args.persistedClaudeUnsafe === true    → register (persisted fallback)
  //   otherwise                              → skip (safe default)
  const env = args.env ?? {}
  const claudeUnsafeActive = env.BRV_BRIDGE_CLAUDE_UNSAFE === '1' || args.persistedClaudeUnsafe === true
  if (claudeUnsafeActive) {
    if (args.sessionStore !== undefined && args.concurrencyGate !== undefined) {
      const adapter = new ClaudeCodeHeadlessAdapter({
        concurrencyGate: args.concurrencyGate,
        log: args.log,
        sessionStore: args.sessionStore,
      })
      registry.register(adapter)
      args.log('[Daemon] Parley adapter registered: claude-code (kind=sdk-headless, UNSAFE — no permission gate)')
    } else {
      args.log(
        '[Daemon] BRV_BRIDGE_CLAUDE_UNSAFE=1 but sessionStore or concurrencyGate not provided; ' +
          'claude-code adapter NOT registered',
      )
    }
  }

  return registry
}
