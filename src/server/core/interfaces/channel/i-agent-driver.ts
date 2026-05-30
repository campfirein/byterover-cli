import type {ContentBlock, TurnEvent} from '../../../../shared/types/index.js'

/**
 * Payload-only `TurnEvent`: a variant's fields WITHOUT the base coordination
 * metadata (`channelId`, `turnId`, `deliveryId`, `memberHandle`, `emittedAt`,
 * `seq`). A driver is oblivious to channel-side coordinates — the orchestrator
 * stamps the base fields (including the gap-free monotonic `seq`) as it relays
 * each payload into the transcript, so correct ordering can only be assigned by
 * that single writer.
 *
 * Derived structurally from {@link TurnEvent} via a distributive conditional so
 * the two can never drift: adding a new `TurnEvent` variant updates this type
 * automatically. The omitted keys MUST mirror the `TurnEvent` base shape.
 */
export type TurnEventPayload = TurnEvent extends infer T
  ? T extends TurnEvent
    ? Omit<T, 'channelId' | 'deliveryId' | 'emittedAt' | 'memberHandle' | 'seq' | 'turnId'>
    : never
  : never

/** Arguments for a single prompt/turn dispatched to a driver. */
export type AgentDriverPromptArgs = {
  /** Opaque per-turn metadata forwarded to the underlying agent (driver-defined). */
  readonly meta?: Record<string, unknown>
  /** Prompt content blocks for this turn. */
  readonly prompt: ContentBlock[]
  /** Channel turn this dispatch belongs to (correlation only; not echoed in payloads). */
  readonly turnId: string
}

/** Lifecycle status of a single driver instance. */
export type AgentDriverStatus = 'errored' | 'idle' | 'stopped' | 'streaming'

/**
 * Transport-agnostic contract for driving one agent and streaming its turn — the
 * single most important seam in the channel subsystem. A local ACP subprocess
 * and a remote A2A peer implement THIS SAME interface, so the orchestrator never
 * knows or cares whether an agent is local or networked.
 *
 * Deliberately free of ACP vocabulary: no protocol version, no ACP capability
 * snapshot, no ACP `initialize` handshake — those belong to the concrete ACP
 * implementation, not to this contract.
 *
 * One instance serves one channel member. Spawn / teardown is the caller's
 * concern via {@link IAgentDriver.start} / {@link IAgentDriver.stop}.
 */
export interface IAgentDriver {
  /**
   * Cancels in-flight work. With a `turnId`, cancels just that turn; without, it
   * cancels whatever is currently streaming. Idempotent; later prompts still work.
   */
  cancel(turnId?: string): Promise<void>

  /** Stable channel-member handle this driver serves (e.g. `@claude`). */
  readonly handle: string

  /**
   * Dispatches a prompt and stream the turn as it unfolds. Each yielded
   * {@link TurnEventPayload} is a base-field-free slice; the orchestrator stamps
   * `channelId` / `turnId` / `deliveryId` / `memberHandle` / `seq` / `emittedAt`
   * before persisting and broadcasting. The iterator completes when the turn
   * reaches a terminal state and may throw to signal a driver-level failure.
   */
  prompt(args: AgentDriverPromptArgs): AsyncIterableIterator<TurnEventPayload>

  /**
   * Resolves a pending permission request the driver surfaced (via a
   * `permission_request` payload). `response` is opaque here; the concrete driver
   * interprets it.
   *
   * @param permissionRequestId - Id from the `permission_request` payload.
   * @param response - Driver-defined decision payload.
   */
  respondToPermission(permissionRequestId: string, response: unknown): Promise<void>

  /** Brings the underlying session up (spawn / connect / handshake). Idempotent. */
  start(): Promise<void>

  /** Current lifecycle status. */
  readonly status: AgentDriverStatus

  /** Tears the session down and release resources. Idempotent. */
  stop(): Promise<void>
}
