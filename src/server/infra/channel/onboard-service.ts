import type {DoctorDiagnostic} from '../../../shared/transport/events/channel-events.js'
import type {AgentDriverProfile, AgentDriverProfileInvocation} from '../../../shared/types/index.js'
import type {IDriverProfileStore} from '../../core/interfaces/channel/i-driver-profile-store.js'
import type {AcpInitializeSnapshot} from './drivers/acp-driver.js'

import {AcpSessionFailedError} from '../../core/domain/channel/errors.js'
import {advertisedCapabilities, classifyDriver} from './driver-class-classifier.js'

/**
 * The slice of a concrete ACP driver the onboard probe needs. Narrower than
 * `IAgentDriver` and ACP-specific on purpose: onboarding probes an ACP agent's
 * `initialize` + `session/new` to classify it, which is exactly the vocabulary
 * `IAgentDriver` deliberately excludes.
 */
export interface IAcpProbeDriver {
  readonly acpInitialize: AcpInitializeSnapshot | undefined
  probeSession(): Promise<boolean>
  readonly protocolVersion: number | undefined
  start(): Promise<void>
  stop(): Promise<void>
}

export type OnboardArgs = {
  readonly displayName: string
  readonly invocation: AgentDriverProfileInvocation
  readonly profileName: string
}

export type OnboardResult = {
  readonly diagnostics: DoctorDiagnostic[]
  readonly profile: AgentDriverProfile
}

export type ChannelOnboardServiceDeps = {
  readonly clock: () => Date
  readonly driverFactory: (invocation: AgentDriverProfileInvocation, handle: string) => IAcpProbeDriver
  readonly store: IDriverProfileStore
}

export interface IChannelOnboardService {
  onboard(args: OnboardArgs): Promise<OnboardResult>
}

/**
 * Probes a candidate ACP agent end-to-end and persists a reusable profile:
 *   1. `start()` runs the `initialize` handshake (a failure propagates).
 *   2. `probeSession()` issues `session/new`; a failure classifies the agent
 *      C-prime and refuses onboarding (typed {@link AcpSessionFailedError}).
 *   3. Classify via {@link classifyDriver} and persist the profile.
 *
 * On any failure the profile is NOT persisted, and the driver is always
 * stopped — onboarding never leaks a subprocess.
 */
export class ChannelOnboardService implements IChannelOnboardService {
  private readonly deps: ChannelOnboardServiceDeps

  public constructor(deps: ChannelOnboardServiceDeps) {
    this.deps = deps
  }

  async onboard(args: OnboardArgs): Promise<OnboardResult> {
    const diagnostics: DoctorDiagnostic[] = []
    // The probe doesn't register against a channel; synthesise a handle to
    // satisfy the driverFactory contract.
    const handle = `@${args.profileName}`
    const driver = this.deps.driverFactory(args.invocation, handle)
    try {
      await driver.start()
      diagnostics.push({code: 'ONBOARD_INITIALIZE_OK', message: 'ACP initialize handshake succeeded', severity: 'info'})

      const sessionNewSucceeded = await driver.probeSession()
      if (!sessionNewSucceeded) {
        diagnostics.push({
          code: 'ONBOARD_SESSION_NEW_FAILED',
          details: {profileName: args.profileName},
          message: 'ACP session/new probe failed — agent classified C-prime and onboarding refused',
          severity: 'error',
        })
        throw new AcpSessionFailedError(`session/new probe failed for ${args.profileName}; onboarding refused.`)
      }

      const snapshot = driver.acpInitialize ?? {}
      const driverClass = classifyDriver({
        _meta: snapshot._meta,
        agentCapabilities: snapshot.agentCapabilities,
        sessionNewSucceeded,
      })
      const capabilities = advertisedCapabilities({agentCapabilities: snapshot.agentCapabilities, sessionNewSucceeded})

      const profile: AgentDriverProfile = {
        capabilities,
        detectedAcpVersion: driver.protocolVersion === undefined ? undefined : String(driver.protocolVersion),
        displayName: args.displayName,
        driverClass,
        invocation: args.invocation,
        name: args.profileName,
        probedAt: this.deps.clock().toISOString(),
      }
      await this.deps.store.upsert(profile)

      diagnostics.push({
        code: 'ONBOARD_CLASSIFIED',
        details: {capabilities, driverClass},
        message: `Driver classified as ${driverClass}`,
        severity: 'info',
      })

      return {diagnostics, profile}
    } finally {
      await driver.stop().catch(() => {})
    }
  }
}
