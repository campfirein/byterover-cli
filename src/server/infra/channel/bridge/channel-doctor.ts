 
// TOFU + KnownPeer wire fields are snake_case (AMENDMENT_TOFU §A3.3).

import type {KnownPeer, TofuStore} from '../../../../agent/core/trust/tofu-store.js'
import type {ChannelMemberRemotePeer} from '../../../../shared/types/channel.js'

import {isL2CertExpired} from './identity-client.js'

/**
 * Phase 9 / Slice 9.11 — pure per-peer diagnostic for
 * `brv channel doctor`. Emits a structured `PeerHealthReport` so the
 * CLI can render text OR JSON without re-deriving findings.
 *
 * The diagnostic is read-only: it consults the TOFU store + the
 * channel member record + the wall clock. It does NOT dial any
 * remote peer (network probes belong in a future slice). Operators
 * get a fast, deterministic answer about whether the LOCAL state is
 * self-consistent.
 */

export type PeerHealthLevel = 'error' | 'info' | 'warn'

/**
 * Phase 9 / Slice 9.11 (kimi round-1 MED) — per-condition codes
 * so downstream automation can match specific findings (e.g.
 * "alert me when ANY channel has UNPINNED peers") without
 * parsing the human-readable message text.
 */
export type PeerHealthCode =
  | 'AUTO_TOFU_PIN_STATE'
  | 'L2_CERT_DRIFT'
  | 'L2_CERT_LEGACY'
  | 'L2_CERT_MISSING'
  | 'L2_CERT_STALE'
  | 'MIRROR_ONLY'
  | 'PEER_UNPINNED'

export type PeerHealthFinding = {
  readonly code: PeerHealthCode
  readonly level: PeerHealthLevel
  readonly message: string
}

export type PeerHealthReport = {
  /** Stored expiry from the TOFU cache, if any (ISO datetime). */
  readonly cachedL2ExpiresAt?: string
  /** Pin state (auto-tofu / user-confirmed / ca-bound) when pinned. */
  readonly cachedPinState?: KnownPeer['pin_state']
  readonly findings: PeerHealthFinding[]
  readonly handle: string
  /** True when the member is the auto-provisioned mirror that lacks dialing material. */
  readonly mirrorOnly: boolean
  /** Highest-severity finding across `findings`. */
  readonly overallLevel: PeerHealthLevel
  readonly peerId: string
  /** Did the peer appear in the local TOFU store? */
  readonly pinned: boolean
}

export interface DiagnoseRemotePeerArgs {
  readonly member: ChannelMemberRemotePeer
  readonly now: Date
  readonly tofu: TofuStore
}

export async function diagnoseRemotePeer(args: DiagnoseRemotePeerArgs): Promise<PeerHealthReport> {
  const findings: PeerHealthFinding[] = []
  const cached = await args.tofu.get(args.member.peerId)
  const mirrorOnly = args.member.multiaddr === undefined || args.member.remoteL2PubKey === undefined

  if (mirrorOnly) {
    findings.push({
      code: 'MIRROR_ONLY',
      level: 'info',
      message:
        'auto-provisioned mirror member — this install has seen the peer inbound but has no multiaddr or L2 pubkey to dial back. Run `brv channel invite` with the peer\'s bridge multiaddr to enable reverse parley.',
    })
  }

  if (cached === undefined) {
    findings.push({
      code: 'PEER_UNPINNED',
      level: 'error',
      message:
        'peer is not in the local TOFU store — outbound mentions against this member will fail with PEER_UNPINNED. Run `brv bridge pin <multiaddr>` first.',
    })
  } else {
    if (cached.pin_state === 'auto-tofu') {
      findings.push({
        code: 'AUTO_TOFU_PIN_STATE',
        level: 'warn',
        message:
          'peer is in `auto-tofu` pin state — inbound parley queries against the default `pinned-only` auto-provision policy will be declined. Promote with `brv bridge verify <peer-id>` after eyeballing the fingerprint.',
      })
    }

    if (cached.l2_pub_key === undefined) {
      findings.push({
        code: 'L2_CERT_MISSING',
        level: 'warn',
        message:
          'no L2 pubkey cached for this peer — initial parley will dial `/brv/identity/tree-cert/v1` to fetch one. If the dial fails, the mention will fail with no auto-retry.',
      })
    } else if (isL2CertExpired(cached, args.now)) {
      // kimi round-1 LOW — distinguish "expired with a known
      // expires_at" from "no expiry recorded at all" using separate
      // codes; the latter case (legacy pin) gets operator-friendly
      // wording rather than a slice-number reference.
      if (cached.l2_expires_at === undefined) {
        findings.push({
          code: 'L2_CERT_LEGACY',
          level: 'warn',
          message:
            'cached L2 cert has no recorded expiry date (pinned before expiry tracking was added) — next parley dial will re-fetch and validate. Safe to ignore unless mentions start failing.',
        })
      } else {
        findings.push({
          code: 'L2_CERT_STALE',
          level: 'warn',
          message: `cached L2 cert expired at ${cached.l2_expires_at} — next parley dial will fetch a fresh one. If the peer is unreachable, the mention will fail.`,
        })
      }
    }
  }

  // Cross-check stored remoteL2PubKey on the member record against
  // the cached one — drift here means the channel meta was pinned at
  // invite time but TOFU later got a fresher value (or vice-versa).
  if (
    args.member.remoteL2PubKey !== undefined &&
    cached?.l2_pub_key !== undefined &&
    args.member.remoteL2PubKey !== cached.l2_pub_key
  ) {
    findings.push({
      code: 'L2_CERT_DRIFT',
      level: 'warn',
      message:
        'member record\'s L2 pubkey differs from the TOFU-cached pubkey for this peer_id — channel meta is out of sync with the local trust store. The warm path refreshes the pubkey at use time so mentions still work, but `brv channel invite` would persist the fresh value.',
    })
  }

  const overallLevel = pickWorst(findings)
  return {
    ...(cached?.l2_expires_at === undefined ? {} : {cachedL2ExpiresAt: cached.l2_expires_at}),
    ...(cached === undefined ? {} : {cachedPinState: cached.pin_state}),
    findings,
    handle: args.member.handle,
    mirrorOnly,
    overallLevel,
    peerId: args.member.peerId,
    pinned: cached !== undefined,
  }
}

function pickWorst(findings: PeerHealthFinding[]): PeerHealthLevel {
  if (findings.some((f) => f.level === 'error')) return 'error'
  if (findings.some((f) => f.level === 'warn')) return 'warn'
  return 'info'
}
