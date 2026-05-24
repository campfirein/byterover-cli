import type {TofuStore} from '../../../agent/core/trust/tofu-store.js'
import type {DoctorDiagnostic} from '../../../shared/transport/events/channel-events.js'
import type {IChannelStore} from '../../core/interfaces/channel/i-channel-store.js'
import type {IAcpDriverPool} from '../../core/interfaces/channel/i-driver-pool.js'
import type {IDriverProfileStore} from '../../core/interfaces/channel/i-driver-profile-store.js'
import type {IPermissionBroker} from './drivers/permission-broker.js'
import type {IProfileMetadataStore} from './profile-metadata-store.js'

import {diagnoseRemotePeer} from './bridge/channel-doctor.js'

/**
 * Phase-3 doctor service (Slice 3.3).
 *
 * Aggregates pool + broker + profile + channel/turn state into structured
 * diagnostics. The CLI command (`brv channel doctor`) and any future UI
 * surface render these directly.
 *
 * v0.1 diagnostic codes:
 *   - DOCTOR_CHANNEL_NOT_FOUND (error): channelId provided but absent.
 *   - DOCTOR_MEMBER_IDLE (info): member has no in-flight delivery.
 *   - DOCTOR_MEMBER_ERRORED (error): member.status === 'errored'.
 *   - DOCTOR_PERMISSION_PENDING (warning): broker has a pending permission
 *     for this channel/member.
 *   - DOCTOR_PROFILE_STALE (warning): profile was last probed > 7 days ago.
 *   - DOCTOR_DRIVER_NOT_REGISTERED (warning): member exists in meta.json
 *     but no driver is in the pool (likely needs re-invite).
 *   - DOCTOR_NO_RECENT_TURN (info): last turn was > 30 days ago.
 */
export type ChannelDoctorServiceDeps = {
  readonly broker: IPermissionBroker
  readonly clock: () => Date
  readonly pool: IAcpDriverPool
  /**
   * Slice 4.2 — local-only metadata for probe outcomes (e.g. AUTH_REQUIRED).
   * Optional so legacy callers without metadata stay green; when supplied,
   * doctor emits `KIMI_AUTH_STALE` for profiles with a stale auth probe.
   */
  readonly profileMetadataStore?: IProfileMetadataStore
  readonly profileStore: IDriverProfileStore
  readonly store: IChannelStore
  /**
   * Slice 9.11 — local TOFU store for diagnosing remote-peer channel
   * members (pin state, L2 cert freshness, mirror-only status,
   * member-record vs TOFU drift). Optional so non-bridge daemons stay
   * green; when omitted, remote-peer members are skipped silently.
   */
  readonly tofu?: TofuStore
}

export type DoctorRunArgs = {
  readonly channelId?: string
  readonly memberHandle?: string
  readonly profileName?: string
  readonly projectRoot: string
}

export type DoctorRunResult = {
  readonly diagnostics: DoctorDiagnostic[]
}

const PROFILE_STALE_MS = 7 * 24 * 60 * 60 * 1000
const NO_RECENT_TURN_MS = 30 * 24 * 60 * 60 * 1000

export interface IChannelDoctorService {
  run(args: DoctorRunArgs): Promise<DoctorRunResult>
}

export class ChannelDoctorService implements IChannelDoctorService {
  private readonly deps: ChannelDoctorServiceDeps

  public constructor(deps: ChannelDoctorServiceDeps) {
    this.deps = deps
  }

  async run(args: DoctorRunArgs): Promise<DoctorRunResult> {
    const diagnostics: DoctorDiagnostic[] = []
    const now = this.deps.clock()

    if (args.channelId !== undefined) {
      await this.diagnoseChannel({
        channelId: args.channelId,
        diagnostics,
        memberHandle: args.memberHandle,
        now,
        projectRoot: args.projectRoot,
      })
    }

    if (args.profileName !== undefined) {
      await this.diagnoseProfile({diagnostics, name: args.profileName, now})
    }

    return {diagnostics}
  }

  private brokerPendingFor(channelId: string): Array<{channelId: string; permissionRequestId: string}> {
    return this.deps.broker.inspect().filter((p) => p.channelId === channelId)
  }

  private async diagnoseChannel(args: {
    channelId: string
    diagnostics: DoctorDiagnostic[]
    memberHandle?: string
    now: Date
    projectRoot: string
  }): Promise<void> {
    const meta = await this.deps.store.readChannelMeta({
      channelId: args.channelId,
      projectRoot: args.projectRoot,
    })
    if (meta === undefined) {
      args.diagnostics.push({
        code: 'DOCTOR_CHANNEL_NOT_FOUND',
        details: {channelId: args.channelId},
        message: `Channel #${args.channelId} not found`,
        severity: 'error',
      })
      return
    }

    // Inspect pool + broker for each member.
    const pending = this.brokerPendingFor(args.channelId)
    if (pending.length > 0) {
      args.diagnostics.push({
        code: 'DOCTOR_PERMISSION_PENDING',
        details: {pending: pending.length},
        message: `${pending.length} permission request(s) pending on this channel`,
        severity: 'warning',
      })
    }

    // Slice 9.11 — diagnose remote-peer members BEFORE the acp-agent
    // loop. kimi round-1 LOW: use Promise.allSettled instead of
    // Promise.all so one tofu.get I/O error doesn't hide every
    // other remote-peer diagnosis; results are reassembled in
    // declaration order so the CLI output stays stable.
    const remotePeers = meta.members.filter(
      (m): m is import('../../../shared/types/channel.js').ChannelMemberRemotePeer =>
        m.memberKind === 'remote-peer' &&
        (args.memberHandle === undefined || m.handle === args.memberHandle),
    )
    if (remotePeers.length > 0) {
      // Phase 9.5.9 §2.5 — surface DOCTOR_INBOUND_ONLY for members whose
      // addressability='inbound-only' regardless of TOFU wiring. These
      // members accepted an inbound parley but lack the multiaddr or L2 key
      // required for reverse-dial. Emit the warning before any TOFU check so
      // it always surfaces, even on non-bridge daemons.
      for (const member of remotePeers) {
        if (member.addressability === 'inbound-only') {
          args.diagnostics.push({
            code: 'DOCTOR_INBOUND_ONLY',
            details: {handle: member.handle, peerId: member.peerId},
            message: `Remote-peer member ${member.handle} (peerId=${member.peerId}) is inbound-only — ` +
              `reverse-dial is impossible until you share a routable multiaddr. Recovery: ` +
              `brv bridge connect <fresh-multiaddr> --channel ${args.channelId}`,
            severity: 'warning',
          })
        }
      }

      if (this.deps.tofu === undefined) {
        // kimi round-1 MED — explicit info diagnostic so operators
        // can see that remote-peer health is unknown rather than
        // healthy. Common case: daemon was built without the bridge
        // wired (no TOFU store), so doctor has no local trust state
        // to consult.
        for (const member of remotePeers) {
          args.diagnostics.push({
            code: 'DOCTOR_REMOTE_PEER_DAEMON_NO_BRIDGE',
            details: {handle: member.handle, peerId: member.peerId},
            message: `Remote-peer member ${member.handle} (peerId=${member.peerId}): bridge TOFU store not wired — remote-peer health cannot be diagnosed on this daemon.`,
            severity: 'info',
          })
        }
      } else {
        const {tofu} = this.deps
        const results = await Promise.allSettled(
          remotePeers.map((member) =>
            this.diagnoseRemotePeerMember({member, now: args.now, tofu}),
          ),
        )
        for (const [i, result] of results.entries()) {
          const member = remotePeers[i]
          if (result.status === 'rejected') {
            args.diagnostics.push({
              code: 'DOCTOR_REMOTE_PEER_DIAGNOSE_FAILED',
              details: {handle: member.handle, peerId: member.peerId},
              message: `Remote-peer member ${member.handle} (peerId=${member.peerId}): diagnostic failed — ${result.reason instanceof Error ? result.reason.message : String(result.reason)}`,
              severity: 'warning',
            })
            continue
          }

          for (const d of result.value) args.diagnostics.push(d)
        }
      }
    }

    for (const member of meta.members) {
      // Remote-peer members handled above in the Promise.allSettled batch.
      if (member.memberKind === 'remote-peer') continue
      if (member.memberKind !== 'acp-agent') continue
      // Phase-3 doctor: `--member <handle>` filters diagnostics to one
      // member. The handle is matched verbatim (handles always carry the
      // canonical `@` prefix per `HandleSchema`).
      if (args.memberHandle !== undefined && member.handle !== args.memberHandle) continue
      if (member.status === 'errored') {
        args.diagnostics.push({
          code: 'DOCTOR_MEMBER_ERRORED',
          details: {handle: member.handle},
          message: `Member ${member.handle} is in 'errored' state`,
          severity: 'error',
        })
      } else {
        args.diagnostics.push({
          code: 'DOCTOR_MEMBER_IDLE',
          details: {handle: member.handle},
          message: `Member ${member.handle} is idle`,
          severity: 'info',
        })
      }

      const driver = this.deps.pool.acquire({
        channelId: args.channelId,
        memberHandle: member.handle,
      })
      if (driver === undefined) {
        args.diagnostics.push({
          code: 'DOCTOR_DRIVER_NOT_REGISTERED',
          details: {handle: member.handle},
          message: `Member ${member.handle} has no driver in the pool — reinvite to spawn`,
          severity: 'warning',
        })
      }
    }

    // Turn freshness.
    const turns = await this.deps.store.listTurns({channelId: args.channelId, projectRoot: args.projectRoot})
    let lastTurn = 0
    for (const t of turns.turns) {
      const n = Date.parse(t.startedAt)
      if (Number.isFinite(n) && n > lastTurn) lastTurn = n
    }

    const ageMs = lastTurn === 0 ? Number.POSITIVE_INFINITY : args.now.getTime() - lastTurn
    if (ageMs > NO_RECENT_TURN_MS) {
      args.diagnostics.push({
        code: 'DOCTOR_NO_RECENT_TURN',
        details: {channelId: args.channelId, lastTurnIso: lastTurn === 0 ? undefined : new Date(lastTurn).toISOString()},
        message: 'No turns in the last 30 days',
        severity: 'info',
      })
    }
  }

  private async diagnoseProfile(args: {
    diagnostics: DoctorDiagnostic[]
    name: string
    now: Date
  }): Promise<void> {
    const profile = await this.deps.profileStore.get(args.name)
    if (profile === undefined) {
      args.diagnostics.push({
        code: 'DOCTOR_PROFILE_NOT_FOUND',
        details: {name: args.name},
        message: `Driver profile ${args.name} not found`,
        severity: 'warning',
      })
      return
    }

    if (profile.probedAt !== undefined) {
      const ageMs = args.now.getTime() - Date.parse(profile.probedAt)
      if (ageMs > PROFILE_STALE_MS) {
        args.diagnostics.push({
          code: 'DOCTOR_PROFILE_STALE',
          details: {ageDays: Math.round(ageMs / (24 * 60 * 60 * 1000)), name: args.name},
          message: `Profile ${args.name} was last probed more than 7 days ago — consider rerunning 'brv channel onboard ${args.name}'`,
          severity: 'warning',
        })
      }
    }

    // Slice 4.2 — surface AUTH_REQUIRED from the local-only metadata store
    // so users see an actionable hint without re-probing kimi.
    if (this.deps.profileMetadataStore !== undefined) {
      const record = await this.deps.profileMetadataStore.get(args.name)
      if (record?.lastProbeError === 'AUTH_REQUIRED') {
        args.diagnostics.push({
          code: 'KIMI_AUTH_STALE',
          details: {lastProbeAt: record.lastProbeAt, name: args.name},
          message: `Profile ${args.name} last probe failed with AUTH_REQUIRED — re-authenticate the agent and rerun 'brv channel onboard ${args.name}'`,
          severity: 'warning',
        })
      }
    }
  }

  /**
   * Slice 9.11 — project the bridge `diagnoseRemotePeer` report onto
   * the wire `DoctorDiagnostic` shape. Returns the diagnostics array
   * (instead of mutating a shared one) so the caller can reassemble
   * results in declaration order under Promise.allSettled (kimi
   * round-1 LOW). Each finding carries its own per-condition code so
   * downstream automation can match on specific failure modes
   * (kimi round-1 MED).
   */
  private async diagnoseRemotePeerMember(args: {
    member: import('../../../shared/types/channel.js').ChannelMemberRemotePeer
    now: Date
    tofu: TofuStore
  }): Promise<DoctorDiagnostic[]> {
    const report = await diagnoseRemotePeer({member: args.member, now: args.now, tofu: args.tofu})

    if (report.findings.length === 0) {
      return [
        {
          code: 'DOCTOR_REMOTE_PEER_OK',
          details: {handle: args.member.handle, peerId: args.member.peerId},
          message: `Remote-peer member ${args.member.handle} (peerId=${args.member.peerId}) is healthy`,
          severity: 'info',
        },
      ]
    }

    return report.findings.map((finding) => ({
      code: `DOCTOR_REMOTE_PEER_${finding.code}`,
      details: {handle: args.member.handle, peerId: args.member.peerId},
      message: `Remote-peer member ${args.member.handle}: ${finding.message}`,
      severity: finding.level === 'error' ? 'error' : finding.level === 'warn' ? 'warning' : 'info',
    }))
  }
}
