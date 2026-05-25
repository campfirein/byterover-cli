import {type AgentDriverProfileInvocation} from '../../../../../shared/types/channel.js'
import {type IAcpDriver, type TurnEventPayload} from '../../../../core/interfaces/channel/i-acp-driver.js'
import {type IDriverProfileStore} from '../../../../core/interfaces/channel/i-driver-profile-store.js'
import {type BridgeDriverPool} from '../bridge-driver-pool.js'
import {type ParleyAdapter, type ParleyAdapterContext} from '../parley-adapter.js'
import {
  type ParleyResponseDataChunk,
  ParleyResponseError,
} from '../parley-response-generator.js'

/**
 * Phase 9.5.2 — `AcpAdapter` drives an ACP-native agent (codex, kimi,
 * opencode, gemini, etc.) via a configured driver-profile name.
 *
 * This is the sole owner of ACP dispatch logic; the legacy
 * `local-agent-response-generator.ts` has been deleted in this phase
 * (plan §2.6 — no duplicate path).
 */

// Internal handle: never registered in a ChannelMember pool.
const LOCAL_HANDLE = '@bridge-parley-handler'

export interface AcpAdapterArgs {
  readonly driverFactory: (invocation: AgentDriverProfileInvocation, handle: string) => IAcpDriver
  /**
   * Optional warm driver pool. When provided, drivers are reused across
   * queries. When absent, a driver is spawned + stopped per query (the
   * legacy 9.4c path).
   */
  readonly pool?: BridgeDriverPool
  /**
   * The driver-profile name that both identifies this adapter in the
   * registry AND is used to look up the invocation in `profileStore`.
   */
  readonly profileName: string
  readonly profileStore: IDriverProfileStore
}

export class AcpAdapter implements ParleyAdapter {
  public readonly kind = 'acp' as const
  public readonly profile: string
  private readonly driverFactory: AcpAdapterArgs['driverFactory']
  private readonly pool: BridgeDriverPool | undefined
  private readonly profileStore: IDriverProfileStore

  public constructor(args: AcpAdapterArgs) {
    this.profile = args.profileName
    this.driverFactory = args.driverFactory
    this.pool = args.pool
    this.profileStore = args.profileStore
  }

  public async *generate(args: ParleyAdapterContext): AsyncIterable<ParleyResponseDataChunk> {
    const profile = await this.profileStore.get(this.profile)
    if (profile === undefined) {
      throw new ParleyResponseError(
        'PARLEY_LOCAL_AGENT_PROFILE_MISSING',
        `BRV_BRIDGE_PARLEY_PROFILE="${this.profile}" does not exist in the driver-profile registry`,
      )
    }

    const promptBlocks = args.envelope.prompt.map((b) => ({
      text: b.text,
      type: 'text' as const,
    }))

    if (this.pool !== undefined) {
      const {pool} = this
      let acquired
      try {
        acquired = await pool.acquire(this.profile, () => this.driverFactory(profile.invocation, LOCAL_HANDLE))
      } catch (error) {
        if (error instanceof ParleyResponseError) throw error
        const msg = error instanceof Error ? error.message : String(error)
        throw new ParleyResponseError('PARLEY_LOCAL_AGENT_START_FAILED', msg)
      }

      try {
        for await (const payload of acquired.driver.prompt({
          prompt: promptBlocks,
          turnId: args.envelope.turn_id,
        })) {
          const chunk = projectPayload(payload)
          if (chunk !== undefined) yield chunk
        }
      } finally {
        acquired.release()
      }

      return
    }

    // Pool-less fallback: spawn + start + stop per query.
    const driver = this.driverFactory(profile.invocation, LOCAL_HANDLE)
    try {
      await driver.start()
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error)
      throw new ParleyResponseError('PARLEY_LOCAL_AGENT_START_FAILED', msg)
    }

    try {
      for await (const payload of driver.prompt({
        prompt: promptBlocks,
        turnId: args.envelope.turn_id,
      })) {
        const chunk = projectPayload(payload)
        if (chunk !== undefined) yield chunk
      }
    } finally {
      await driver.stop().catch(() => {})
    }
  }
}

/**
 * Project a `TurnEventPayload` into a `ParleyResponseDataChunk`.
 * Only text + thought chunks flow through; everything else is dropped.
 */
function projectPayload(payload: TurnEventPayload): ParleyResponseDataChunk | undefined {
  if (payload.kind === 'agent_message_chunk') {
    return {content: payload.content, kind: 'agent_message_chunk'}
  }

  if (payload.kind === 'agent_thought_chunk') {
    return {content: payload.content, kind: 'agent_thought_chunk'}
  }

  console.debug(`[parley] dropping unprojected payload kind: ${payload.kind}`)
  return undefined
}
