/* eslint-disable camelcase */
// TOFU KnownPeer wire fields use snake_case to match the on-disk
// schema (AMENDMENT_TOFU §A3.2). Disabled at file scope.

import type {KnownPeer, TofuStore} from './tofu-store.js'

/**
 * Phase 9 / Slice 9.4g — promote a TOFU-pinned peer from
 * `auto-tofu` → `user-confirmed`.
 *
 * Background: the spec §7.3 auto-provision policy defaults to
 * `pinned-only`, which rejects inbound parley queries from senders in
 * `pin_state: 'auto-tofu'`. Operators see the resulting
 * `CHANNEL_AUTO_PROVISION_DECLINED` error on Alice's side and need a
 * way to promote the peer after eyeballing the fingerprint. This
 * helper IS that promotion — it does not re-dial, re-fetch, or
 * re-verify the install cert (the existing pin already did all that);
 * it only moves the `pin_state` enum.
 *
 * Idempotent:
 *   - `auto-tofu`     → flips to `user-confirmed` and returns the new record
 *   - `user-confirmed` → returns the existing record unchanged
 *   - `ca-bound`      → returns the existing record unchanged. `ca-bound` is
 *                       strictly stronger than `user-confirmed` in the
 *                       trust ordering — re-flipping the enum would be a
 *                       downgrade.
 *
 * Throws `VerifyPinError(PEER_NOT_PINNED)` when the peer is not in
 * the TOFU store. The caller should suggest `brv bridge pin` first.
 */

export type VerifyPinErrorCode = 'INVALID_PEER_ID' | 'PEER_NOT_PINNED'

export class VerifyPinError extends Error {
  public readonly code: VerifyPinErrorCode

  public constructor(code: VerifyPinErrorCode, message: string) {
    super(message)
    this.code = code
    this.name = 'VerifyPinError'
  }
}

/**
 * Narrow tofu-store contract used by verifyPin + loadPinnedPeer.
 * Production callers pass a full `TofuStore` (which satisfies this
 * shape); tests pass a structural mock without needing an `as` cast
 * (kimi round-2 NIT).
 */
export type VerifyPinTofuStore = Pick<TofuStore, 'get' | 'upsertWithMerge'>

export type VerifyPinArgs = {
  readonly peerId: string
  readonly tofu: VerifyPinTofuStore
}

/**
 * Look up the peer WITHOUT modifying it. Used by the CLI to render
 * the install_cert_fingerprint before prompting the operator to
 * confirm promotion (kimi round-1 MED-1).
 */
export async function loadPinnedPeer(args: VerifyPinArgs): Promise<KnownPeer> {
  const existing = await args.tofu.get(args.peerId)
  if (existing === undefined) {
    throw new VerifyPinError(
      'PEER_NOT_PINNED',
      `peer ${args.peerId} is not in the TOFU store.\n` +
        `If you have the peer's multiaddr, run \`brv bridge pin <multiaddr>\` first.\n` +
        `Otherwise, obtain the multiaddr out-of-band, or temporarily set\n` +
        `BRV_BRIDGE_AUTO_PROVISION=auto on Bob to accept first-contact peers.`,
    )
  }

  return existing
}

export async function verifyPin(args: VerifyPinArgs): Promise<KnownPeer> {
  return args.tofu.upsertWithMerge(args.peerId, (existing) => {
    if (existing === undefined) {
      throw new VerifyPinError(
        'PEER_NOT_PINNED',
        `peer ${args.peerId} is not in the TOFU store.\n` +
          `If you have the peer's multiaddr, run \`brv bridge pin <multiaddr>\` first.\n` +
          `Otherwise, obtain the multiaddr out-of-band, or temporarily set\n` +
          `BRV_BRIDGE_AUTO_PROVISION=auto on Bob to accept first-contact peers.`,
      )
    }

    // ca-bound is strictly stronger than user-confirmed: a CA log
    // entry has corroborated the peer's identity beyond the local
    // operator's eyeball check. Don't downgrade.
    if (existing.pin_state === 'ca-bound') return existing
    if (existing.pin_state === 'user-confirmed') return existing
    return {...existing, pin_state: 'user-confirmed'}
  })
}
