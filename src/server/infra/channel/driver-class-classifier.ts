/**
 * Driver-class classifier (Slice 3.2).
 *
 * Maps an ACP agent's `initialize` + `session/new` outcomes to one of the
 * three v0.1 driver classes from CHANNEL_PROTOCOL.md §4.2 + Phase-3 plan
 * §3.2:
 *
 *   - **A**: ACP-native. `session/new` succeeded AND the agent advertises
 *     `promptCapabilities.embeddedContext === true` AND at least one of
 *     `promptCapabilities.image === true` OR `toolCallSupport === true`.
 *   - **B**: ACP-compatible baseline. `session/new` succeeded but the agent
 *     does not advertise the Class-A capability set.
 *   - **C-prime**: ACP-loose. Either `session/new` errored OR the agent
 *     explicitly advertises `_meta['brv.driverClass'] === 'C-prime'`.
 *
 * The classifier is pure — the onboard service supplies the probe outcomes
 * and the classifier returns the class. The probe lives in
 * {@link onboardCandidate}.
 */

export type DriverClass = 'A' | 'B' | 'C-prime'

/** Subset of ACP `initialize` response fields the classifier consumes. */
export type ClassifyDriverArgs = {
  /**
   * Channel-protocol extension: an ACP agent MAY advertise
   * `_meta['brv.driverClass']` in its initialize response to opt out of
   * automatic classification (e.g. mocks that want to be C-prime).
   */
  readonly _meta?: Readonly<Record<string, unknown>>
  /** ACP `initialize.result.agentCapabilities` if present. */
  readonly agentCapabilities?: {
    readonly promptCapabilities?: {
      readonly embeddedContext?: boolean
      readonly image?: boolean
    }
    readonly toolCallSupport?: boolean
  }
  /** True when the host's `session/new` probe succeeded; false otherwise. */
  readonly sessionNewSucceeded: boolean
}

export const classifyDriver = (args: ClassifyDriverArgs): DriverClass => {
  const explicitOverride = args._meta?.['brv.driverClass']
  if (explicitOverride === 'C-prime' || explicitOverride === 'A' || explicitOverride === 'B') {
    return explicitOverride
  }

  if (!args.sessionNewSucceeded) return 'C-prime'

  const promptCaps = args.agentCapabilities?.promptCapabilities ?? {}
  const embeddedContext = promptCaps.embeddedContext === true
  const image = promptCaps.image === true
  const toolCalls = args.agentCapabilities?.toolCallSupport === true

  if (embeddedContext && (image || toolCalls)) return 'A'
  return 'B'
}

/**
 * Returns the list of advertised capability names suitable for the
 * `AgentDriverProfile.capabilities` field. The onboard service uses this so
 * the doctor command can render the capability set without re-probing.
 */
export const advertisedCapabilities = (args: ClassifyDriverArgs): string[] => {
  const out: string[] = []
  const promptCaps = args.agentCapabilities?.promptCapabilities ?? {}
  if (promptCaps.embeddedContext === true) out.push('embeddedContext')
  if (promptCaps.image === true) out.push('image')
  if (args.agentCapabilities?.toolCallSupport === true) out.push('toolCallSupport')
  return out
}
