/**
 * Phase 9 / Slice 9.4i — refresh the cached L2 pubkey for a remote-peer
 * member at orchestrator warm time so a long-running Alice daemon
 * doesn't keep using a pubkey that expired (or whose cert rotated)
 * after the invite landed.
 *
 * The function delegates to the daemon's `resolveRemotePeerL2PubKey`
 * (wired in `brv-server.ts`), which in turn consults the TOFU cache
 * via the 9.4h expiry-aware fast-path: if the cached cert is still
 * valid it returns the cached pubkey, otherwise it dials
 * `fetchAndPin({fetchTreeCert: true})` to fetch + re-verify a fresh
 * one.
 *
 * Graceful degradation: when the resolver throws (peer unreachable,
 * libp2p host not started, etc.) we fall back to the member's stored
 * pubkey rather than wedging the warm. The subsequent dial may fail
 * with `signature-invalid`, which a future slice can use to trigger a
 * full driver tear-down + re-warm cycle.
 */

export interface RefreshRemotePeerL2Args {
  readonly member: {
    readonly multiaddr?: string
    readonly peerId: string
    readonly remoteL2PubKey?: string
  }
  readonly resolve?: (args: {multiaddr: string; peerId: string}) => Promise<string>
}

export async function refreshRemotePeerL2PubKey(
  args: RefreshRemotePeerL2Args,
): Promise<string | undefined> {
  // Caller is responsible for skipping members without a cached
  // pubkey (i.e. bridge-auto-provisioned mirror members on the
  // receiving side). The helper just passes through `undefined`.
  if (args.member.remoteL2PubKey === undefined) return undefined

  // No multiaddr → no place to dial → cannot refresh. Keep the cached
  // pubkey; the upstream dial-site will surface the real failure.
  if (args.member.multiaddr === undefined) return args.member.remoteL2PubKey

  // No resolver wired (e.g. tests, or the daemon was started without
  // the bridge host) → cannot refresh. Same fallback as above.
  if (args.resolve === undefined) return args.member.remoteL2PubKey

  try {
    return await args.resolve({
      multiaddr: args.member.multiaddr,
      peerId: args.member.peerId,
    })
  } catch {
    // Graceful degradation. We deliberately do NOT distinguish the
    // failure mode here — the caller logs at a higher level if
    // wanted.
    return args.member.remoteL2PubKey
  }
}
