/**
 * Phase 9.5.6 — `brv bridge connect` orchestration.
 *
 * Collapses the four-step setup ceremony (pin → verify → channel new →
 * channel invite) into one idempotent operation. The actual transport
 * calls are injected via {@link BridgeConnectDeps} so this lib is unit-
 * testable without spinning up the daemon or libp2p.
 *
 * Failure semantics (codex round-2 verdict, 2026-05-23): no transactional
 * state. Each completed step is independently valid; on partial failure
 * the result surfaces the steps that succeeded and a copy-paste-ready
 * retry hint that omits already-done flags.
 */

export type PinStatus = 'added' | 'already-pinned'
export type VerifyStatus = 'already-user-confirmed' | 'ca-bound' | 'user-confirmed'
export type ChannelCreateStatus = 'already-exists' | 'created'
export type ChannelInviteStatus = 'added' | 'already-member'

export interface PinResult {
  readonly peerId: string
  readonly pinState: 'auto-tofu' | 'ca-bound' | 'user-confirmed'
  readonly resolvedMultiaddr: string
  readonly status: PinStatus
}

export interface VerifyResult {
  readonly status: VerifyStatus
}

export interface ChannelCreateResult {
  readonly status: ChannelCreateStatus
}

export interface ChannelInviteResult {
  readonly status: ChannelInviteStatus
}

export interface BridgeConnectArgs {
  readonly alias?: string
  readonly channelId?: string
  readonly multiaddr: string
  readonly verify: boolean
}

export interface BridgeConnectDeps {
  channelCreate(channelId: string): Promise<ChannelCreateResult>
  channelExists(channelId: string): Promise<boolean>
  channelHasMember(channelId: string, peerId: string): Promise<boolean>
  channelInvite(args: {
    readonly alias?: string
    readonly channelId: string
    readonly multiaddr: string
    readonly peerId: string
  }): Promise<ChannelInviteResult>
  pin(multiaddr: string, peerId: string): Promise<PinResult>
  verify(peerId: string): Promise<VerifyResult>
}

export type StepName = 'channelCreate' | 'channelInvite' | 'pin' | 'verify'

export type BridgeConnectStepResult =
  | {
      readonly alias?: string
      readonly channelId?: string
      readonly multiaddr: string
      readonly peerId: string
      readonly steps: {
        readonly channelCreate: ChannelCreateStatus | null
        readonly channelInvite: ChannelInviteStatus | null
        readonly pin: PinStatus
        readonly verify: null | VerifyStatus
      }
      readonly success: true
    }
  | {
      readonly completed: ReadonlyArray<StepName>
      readonly error: {readonly code: string; readonly message: string}
      readonly failedAt: StepName
      readonly peerId: string
      readonly retryHint: string
      readonly success: false
    }

export class BridgeConnectInvalidMultiaddrError extends Error {
  public readonly code = 'BRIDGE_CONNECT_INVALID_MULTIADDR'

  public constructor(multiaddr: string) {
    super(
      `multiaddr ${multiaddr} is missing a /p2p/<peer-id> suffix — without it the verifier has no expected peer_id to check.`,
    )
    this.name = 'BridgeConnectInvalidMultiaddrError'
  }
}

const PEER_ID_RE = /\/p2p\/([1-9A-HJ-NP-Za-km-z]+)$/

function extractPeerIdFromMultiaddr(multiaddr: string): string | undefined {
  const match = multiaddr.match(PEER_ID_RE)
  return match ? match[1] : undefined
}

interface ErrorWithCode {
  readonly code?: string
  readonly message?: string
}

function toErrorPayload(error: unknown): {readonly code: string; readonly message: string} {
  if (error instanceof Error) {
    const code = (error as ErrorWithCode).code ?? error.name ?? 'BRIDGE_CONNECT_STEP_FAILED'
    return {code, message: error.message}
  }

  return {code: 'BRIDGE_CONNECT_STEP_FAILED', message: String(error)}
}

function buildRetryHint(args: {
  readonly alias?: string
  readonly channelId?: string
  readonly completed: ReadonlyArray<StepName>
  readonly multiaddr: string
  readonly verify: boolean
}): string {
  const parts: string[] = ['brv bridge connect', args.multiaddr]
  if (args.alias !== undefined) parts.push(`--alias ${args.alias}`)
  // --verify is dropped from the hint once the pin is already user-
  // confirmed (verify step succeeded), so a retry doesn't re-prompt for
  // a fingerprint comparison the operator already did.
  if (args.verify && !args.completed.includes('verify')) parts.push('--verify')
  if (args.channelId !== undefined) parts.push(`--channel ${args.channelId}`)
  return parts.join(' ')
}

export async function runBridgeConnect(
  args: BridgeConnectArgs,
  deps: BridgeConnectDeps,
): Promise<BridgeConnectStepResult> {
  const peerId = extractPeerIdFromMultiaddr(args.multiaddr)
  if (peerId === undefined) {
    throw new BridgeConnectInvalidMultiaddrError(args.multiaddr)
  }

  const completed: StepName[] = []

  // Step 1 — pin.
  let pinResult: PinResult
  try {
    pinResult = await deps.pin(args.multiaddr, peerId)
  } catch (error) {
    return {
      completed: [],
      error: toErrorPayload(error),
      failedAt: 'pin',
      peerId,
      retryHint: buildRetryHint({
        alias: args.alias,
        channelId: args.channelId,
        completed: [],
        multiaddr: args.multiaddr,
        verify: args.verify,
      }),
      success: false,
    }
  }

  completed.push('pin')

  // Step 2 — verify (only when --verify flag is set).
  let verifyStatus: null | VerifyStatus = null
  if (args.verify) {
    try {
      const r = await deps.verify(peerId)
      verifyStatus = r.status
    } catch (error) {
      return {
        completed,
        error: toErrorPayload(error),
        failedAt: 'verify',
        peerId,
        retryHint: buildRetryHint({
          alias: args.alias,
          channelId: args.channelId,
          completed,
          multiaddr: args.multiaddr,
          verify: args.verify,
        }),
        success: false,
      }
    }

    completed.push('verify')
  }

  // Step 3 — channel create (only when --channel flag is set).
  let channelCreateStatus: ChannelCreateStatus | null = null
  if (args.channelId !== undefined) {
    try {
      const r = await deps.channelCreate(args.channelId)
      channelCreateStatus = r.status
    } catch (error) {
      return {
        completed,
        error: toErrorPayload(error),
        failedAt: 'channelCreate',
        peerId,
        retryHint: buildRetryHint({
          alias: args.alias,
          channelId: args.channelId,
          completed,
          multiaddr: args.multiaddr,
          verify: args.verify,
        }),
        success: false,
      }
    }

    completed.push('channelCreate')
  }

  // Step 4 — channel invite (only when --channel flag is set).
  let channelInviteStatus: ChannelInviteStatus | null = null
  if (args.channelId !== undefined) {
    try {
      const r = await deps.channelInvite({
        alias: args.alias,
        channelId: args.channelId,
        multiaddr: pinResult.resolvedMultiaddr,
        peerId,
      })
      channelInviteStatus = r.status
    } catch (error) {
      return {
        completed,
        error: toErrorPayload(error),
        failedAt: 'channelInvite',
        peerId,
        retryHint: buildRetryHint({
          alias: args.alias,
          channelId: args.channelId,
          completed,
          multiaddr: args.multiaddr,
          verify: args.verify,
        }),
        success: false,
      }
    }

    completed.push('channelInvite')
  }

  return {
    alias: args.alias,
    channelId: args.channelId,
    multiaddr: pinResult.resolvedMultiaddr,
    peerId,
    steps: {
      channelCreate: channelCreateStatus,
      channelInvite: channelInviteStatus,
      pin: pinResult.status,
      verify: verifyStatus,
    },
    success: true,
  }
}
