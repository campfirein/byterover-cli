import type {
  AcpDriverPromptArgs,
  AcpDriverStatus,
  AcpInitializeSnapshot,
  IAcpDriver,
  TurnEventPayload,
} from '../../../core/interfaces/channel/i-acp-driver.js'

/**
 * In-process scripted IAcpDriver implementation for orchestrator unit tests.
 *
 * The constructor takes an ordered sequence of payload-only TurnEvents.
 * `prompt()` yields them one by one; on a `permission_request` payload the
 * iterator parks until {@link respondToPermission} (with the matching
 * permissionRequestId) or {@link cancel} runs. `cancel()` ends the in-flight
 * iteration cleanly.
 */
export type MockAcpDriverOptions = {
  /** Phase-3 onboarding: optional pre-canned initialize snapshot. */
  readonly acpInitialize?: AcpInitializeSnapshot
  readonly capabilities?: string[]
  readonly events: TurnEventPayload[]
  readonly handle: string
  /** Phase-3 onboarding: pre-canned `session/new` outcome for the probe. */
  readonly probeSessionResult?: boolean
  readonly protocolVersion?: number
}

type PermissionGate = {
  resolve(): void
}

async function* iteratePrompt(
  events: TurnEventPayload[],
  gates: Map<string, PermissionGate>,
  isCancelled: () => boolean,
): AsyncGenerator<TurnEventPayload> {
  for (const event of events) {
    if (isCancelled()) return
    yield event
    if (event.kind === 'permission_request') {
      // Re-check cancellation AFTER the yield. The host can call cancel()
      // while the generator is suspended at the yield; if so, do not
      // create a permission gate (cancel() has already iterated the map
      // and missed it).
      if (isCancelled()) return
      const id = (event as {permissionRequestId: string}).permissionRequestId
      // eslint-disable-next-line no-await-in-loop
      await new Promise<void>((resolve) => {
        gates.set(id, {resolve})
      })
      if (isCancelled()) return
    }
  }
}

export class MockAcpDriver implements IAcpDriver {
  public acpInitialize: AcpInitializeSnapshot | undefined
  public readonly capabilities: string[]
  public readonly handle: string
  public probeSessionResult: boolean
  public protocolVersion: number | undefined
  public status: AcpDriverStatus = 'idle'
  private cancelled = false
  private readonly events: TurnEventPayload[]
  private permissionGates = new Map<string, PermissionGate>()

  public constructor(options: MockAcpDriverOptions) {
    this.handle = options.handle
    this.capabilities = options.capabilities ?? []
    this.events = [...options.events]
    this.protocolVersion = options.protocolVersion
    this.acpInitialize = options.acpInitialize
    this.probeSessionResult = options.probeSessionResult ?? true
  }

   
  async cancel(_turnId?: string): Promise<void> {
    this.cancelled = true
    for (const gate of this.permissionGates.values()) gate.resolve()
    this.permissionGates.clear()
  }

  async probeSession(): Promise<boolean> {
    return this.probeSessionResult
  }

  prompt(_args: AcpDriverPromptArgs): AsyncIterableIterator<TurnEventPayload> {
    return iteratePrompt(
      [...this.events],
      this.permissionGates,
      () => this.cancelled,
    )
  }

   
  async respondToPermission(permissionRequestId: string, _response: unknown): Promise<void> {
    const gate = this.permissionGates.get(permissionRequestId)
    if (gate === undefined) return
    this.permissionGates.delete(permissionRequestId)
    gate.resolve()
  }

   
  async start(): Promise<void> {
    this.status = 'idle'
  }

   
  async stop(): Promise<void> {
    this.status = 'stopped'
    for (const gate of this.permissionGates.values()) gate.resolve()
    this.permissionGates.clear()
  }
}
