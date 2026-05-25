import type {DoctorDiagnostic} from '../../../shared/transport/events/channel-events.js'
import type {
  AgentDriverProfile,
  AgentDriverProfileInvocation,
} from '../../../shared/types/channel.js'
import type {IAcpDriver} from '../../core/interfaces/channel/i-acp-driver.js'
import type {IDriverProfileStore} from '../../core/interfaces/channel/i-driver-profile-store.js'
import type {IProfileMetadataStore} from './profile-metadata-store.js'

import {AcpAuthRequiredError, AcpSessionFailedError} from '../../core/domain/channel/errors.js'
import {advertisedCapabilities, classifyDriver} from './driver-class-classifier.js'

/**
 * Phase-3 onboarding service (Slice 3.2).
 *
 * Probe a candidate ACP agent end-to-end:
 *   1. `driver.start()` — runs `initialize`. A handshake failure throws
 *      AcpHandshakeFailedError (from the driver) and propagates upward;
 *      `stop()` is always invoked in finally.
 *   2. `driver.probeSession()` — issues `session/new`. If `false`, the
 *      classifier downgrades to `C-prime`. We also surface an error-level
 *      DoctorDiagnostic AND throw AcpSessionFailedError so the caller's
 *      CLI exits non-zero — Phase-3 spec edit §11 makes this an error code.
 *   3. Classify via {@link classifyDriver}.
 *   4. Persist the AgentDriverProfile via {@link IDriverProfileStore}.
 *
 * On any failure the profile is NOT persisted and the driver is stopped.
 * Successful onboards return `{profile, diagnostics}` so the CLI can echo
 * any non-error advisories (e.g. capability surface notes).
 */

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
  readonly driverFactory: (invocation: AgentDriverProfileInvocation, handle: string) => IAcpDriver
  /**
   * Slice 4.2 — local-only metadata for AUTH_REQUIRED probe results.
   * Optional so Phase-3 callers that haven't migrated yet keep working.
   * When supplied, failed re-probes against an existing profile record
   * `{lastProbeError: 'AUTH_REQUIRED', lastProbeAt}`; successful probes
   * clear the record.
   */
  readonly metadataStore?: IProfileMetadataStore
  readonly store: IDriverProfileStore
}

export interface IChannelOnboardService {
  onboard(args: OnboardArgs): Promise<OnboardResult>
}

export class ChannelOnboardService implements IChannelOnboardService {
  private readonly deps: ChannelOnboardServiceDeps

  public constructor(deps: ChannelOnboardServiceDeps) {
    this.deps = deps
  }

  async onboard(args: OnboardArgs): Promise<OnboardResult> {
    const diagnostics: DoctorDiagnostic[] = []
    // The handle used to satisfy the driverFactory contract; the onboarding
    // probe does not register against a channel, so we synthesise one.
    const handle = `@${args.profileName}`
    const driver = this.deps.driverFactory(args.invocation, handle)
    try {
      try {
        await driver.start()
      } catch (error) {
        if (error instanceof AcpAuthRequiredError) {
          await this.recordAuthRequired(args.profileName)
          throw error
        }

        throw error
      }

      diagnostics.push({code: 'ONBOARD_INITIALIZE_OK', message: 'ACP initialize handshake succeeded', severity: 'info'})

      let sessionNewSucceeded: boolean
      try {
        sessionNewSucceeded = await driver.probeSession()
      } catch (error) {
        if (error instanceof AcpAuthRequiredError) {
          await this.recordAuthRequired(args.profileName)
          throw error
        }

        throw error
      }

      if (!sessionNewSucceeded) {
        diagnostics.push({
          code: 'ONBOARD_SESSION_NEW_FAILED',
          details: {profileName: args.profileName},
          message: 'ACP session/new probe failed — agent classified as C-prime and onboarding refused',
          severity: 'error',
        })
        throw new AcpSessionFailedError(
          `session/new probe failed for ${args.profileName}; onboarding refused.`,
        )
      }

      const snapshot = driver.acpInitialize ?? {}
      const driverClass = classifyDriver({
        _meta: snapshot._meta,
        agentCapabilities: snapshot.agentCapabilities,
        sessionNewSucceeded,
      })
      const capabilities = advertisedCapabilities({
        agentCapabilities: snapshot.agentCapabilities,
        sessionNewSucceeded,
      })

      const profile: AgentDriverProfile = {
        capabilities,
        detectedAcpVersion:
          driver.protocolVersion === undefined ? undefined : String(driver.protocolVersion),
        displayName: args.displayName,
        driverClass,
        invocation: args.invocation,
        name: args.profileName,
        probedAt: this.deps.clock().toISOString(),
      }
      await this.deps.store.upsert(profile)
      // A successful onboard clears any stale AUTH_REQUIRED metadata for
      // this profile name (Slice 4.2). Best-effort; metadata is diagnostic-
      // only and failing to clear it doesn't break the onboard.
      if (this.deps.metadataStore !== undefined) {
        try {
          await this.deps.metadataStore.clearLastProbeError(args.profileName)
        } catch {
          // Diagnostic state; don't fail the onboard.
        }
      }

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

  /**
   * Slice 4.2 — write the local-only AUTH_REQUIRED metadata record IF a
   * profile already exists for this name. First-time onboards leave no
   * trace on auth failure (so an empty `~/.brv/state/` stays empty).
   *
   * Best-effort: a metadata write failure should not mask the
   * AcpAuthRequiredError the caller is about to surface — that error is
   * the actionable signal for the user.
   */
  private async recordAuthRequired(profileName: string): Promise<void> {
    const {metadataStore} = this.deps
    if (metadataStore === undefined) return
    try {
      const existing = await this.deps.store.get(profileName)
      if (existing === undefined) return
      await metadataStore.setLastProbeError({
        at: this.deps.clock().toISOString(),
        error: 'AUTH_REQUIRED',
        name: profileName,
      })
    } catch {
      // Diagnostic-only; never break the AUTH_REQUIRED error surfacing.
    }
  }
}
