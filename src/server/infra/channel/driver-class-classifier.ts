/**
 * Driver-class classifier. Maps an ACP agent's `initialize` + `session/new`
 * probe outcomes to one of three driver classes:
 *
 *   - **A**: ACP-native. `session/new` succeeded AND the agent advertises
 *     `promptCapabilities.embeddedContext === true` AND at least one of
 *     `promptCapabilities.image === true` OR `toolCallSupport === true`.
 *   - **B**: ACP-compatible baseline. `session/new` succeeded but the agent
 *     does not advertise the Class-A capability set.
 *   - **C-prime**: ACP-loose. Either `session/new` errored OR the agent
 *     explicitly advertises `_meta['brv.driverClass'] === 'C-prime'`.
 *
 * Pure: the onboard service supplies the probe outcomes and reads back the
 * class. Keeping classification out of the driver lets a mock opt itself into
 * a class via `_meta` without faking capabilities.
 */

export type DriverClass = 'A' | 'B' | 'C-prime'

/** Subset of ACP `initialize` response fields the classifier consumes. */
export type ClassifyDriverArgs = {
  /**
   * An agent MAY advertise `_meta['brv.driverClass']` in its initialize
   * response to opt out of automatic classification (e.g. mocks).
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
 * Returns the advertised capability names suitable for
 * `AgentDriverProfile.capabilities`, so the surface can render the capability
 * set without re-probing.
 */
export const advertisedCapabilities = (args: ClassifyDriverArgs): string[] => {
  const out: string[] = []
  const promptCaps = args.agentCapabilities?.promptCapabilities ?? {}
  if (promptCaps.embeddedContext === true) out.push('embeddedContext')
  if (promptCaps.image === true) out.push('image')
  if (args.agentCapabilities?.toolCallSupport === true) out.push('toolCallSupport')
  return out
}
