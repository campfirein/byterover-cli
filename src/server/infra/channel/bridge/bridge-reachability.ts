/**
 * Phase 9 / Slice 9.8 — bridge reachability classifier.
 *
 * Walks the local libp2p config + listen addresses + relay list to
 * produce a coarse-grained reachability label that `brv channel
 * doctor` (and ops) can surface. The classifier is PURE — no
 * network probes — so the answer is deterministic and instant. Real
 * AutoNAT + DCUtR probing requires libp2p service wiring deferred
 * to a future operator-driven commit.
 *
 * Labels (priority order — first match wins):
 *
 *   - `public` — at least one listen address is a real public-IP
 *     (NOT loopback, NOT RFC1918, NOT CGNAT, NOT IPv6 ULA / link-
 *     local). The install can accept inbound dials without relay.
 *     Trigger: ANY `listenAddrs[i]` matches `isPublicishIpv4` OR
 *     `isPublicishIpv6`.
 *
 *   - `wildcard-unconfirmed` (kimi round-1 MED) — at least one
 *     listen address is a wildcard bind (`/ip4/0.0.0.0/...` or
 *     `/ip6/::/...`) and no relay is configured. The OS will bind
 *     to every interface, so the daemon MAY be public, MAY be
 *     loopback-only, depending on which interfaces actually exist.
 *     The classifier can't tell without a real interface probe,
 *     so it surfaces the ambiguity explicitly rather than
 *     conservatively labelling as `loopback-only`. Operators
 *     running `brv channel doctor` see the ambiguity and can
 *     either narrow the listen address or run AutoNAT.
 *     Trigger: ANY `listenAddrs[i]` is a wildcard bind AND no
 *     `public` match above AND `relays` is empty.
 *
 *   - `behind-nat-with-relay` — no public listen address, but at
 *     least one relay multiaddr is configured. Inbound dials route
 *     through the relay.
 *     Trigger: no `public` match above AND `relays.length > 0`.
 *
 *   - `loopback-only` — listening only on 127.0.0.1, ::1, or
 *     RFC1918 / CGNAT / ULA / link-local addresses. The install is
 *     reachable from other processes on the same host or LAN but
 *     NOT from the public network. This is the fresh-install
 *     state.
 *     Trigger: no `public` / `wildcard-unconfirmed` / relay match
 *     above AND at least one parseable listen address.
 *
 *   - `unreachable` — no listen addresses AND no relays. The
 *     install cannot accept inbound dials at all.
 *     Trigger: `listenAddrs.length === 0 && relays.length === 0`.
 *
 *   - `unknown` — the classifier could not parse any listen
 *     address. Shouldn't happen given the multiaddr schema gate;
 *     surfaced for safety.
 *     Trigger: every entry in `listenAddrs` failed to parse AND
 *     `relays` is empty.
 */

export type BridgeReachability =
  | 'behind-nat-with-relay'
  | 'loopback-only'
  | 'public'
  | 'unknown'
  | 'unreachable'
  | 'wildcard-unconfirmed'

export interface ClassifyReachabilityArgs {
  readonly listenAddrs: readonly string[]
  readonly relays: readonly string[]
}

const LOOPBACK_HOST_PATTERNS = [
  /^\/ip4\/127\./,
  /^\/ip6\/::1\b/,
]

// kimi round-1 MED — wildcard binds need their own label (can be
// public OR loopback depending on actual interfaces) rather than
// being lumped under loopback-only. The IPv6 pattern uses a
// negative lookahead `(?!1)` rather than `\b` because `\b` doesn't
// trigger between two non-word characters (`:` and `/`).
const WILDCARD_HOST_PATTERNS = [
  /^\/ip4\/0\.0\.0\.0\b/,
  /^\/ip6\/::(?!1)/,
]

const PUBLIC_IP4_PRIVATE_PATTERNS = [
  /^\/ip4\/10\./,
  /^\/ip4\/172\.(1[6-9]|2[0-9]|3[0-1])\./,
  /^\/ip4\/192\.168\./,
  /^\/ip4\/169\.254\./,
  /^\/ip4\/100\.(6[4-9]|[7-9][0-9]|1[01][0-9]|12[0-7])\./, // CGNAT 100.64.0.0/10
]

function isLoopback(multiaddr: string): boolean {
  return LOOPBACK_HOST_PATTERNS.some((p) => p.test(multiaddr))
}

function isWildcard(multiaddr: string): boolean {
  return WILDCARD_HOST_PATTERNS.some((p) => p.test(multiaddr))
}

function isPrivateIpv4(multiaddr: string): boolean {
  return PUBLIC_IP4_PRIVATE_PATTERNS.some((p) => p.test(multiaddr))
}

function isPublicishIpv4(multiaddr: string): boolean {
  if (isLoopback(multiaddr)) return false
  if (isPrivateIpv4(multiaddr)) return false
  return /^\/ip4\/\d+\.\d+\.\d+\.\d+/.test(multiaddr)
}

function isPublicishIpv6(multiaddr: string): boolean {
  if (isLoopback(multiaddr)) return false
  // ULA fc00::/7 + link-local fe80::/10 are non-public.
  if (/^\/ip6\/f[cd][0-9a-f]{2}:/i.test(multiaddr)) return false
  if (/^\/ip6\/fe[89ab][0-9a-f]:/i.test(multiaddr)) return false
  return /^\/ip6\/[0-9a-f:]+/i.test(multiaddr)
}

export function classifyBridgeReachability(args: ClassifyReachabilityArgs): BridgeReachability {
  if (args.listenAddrs.length === 0 && args.relays.length === 0) return 'unreachable'

  let anyParsed = false
  let anyPublic = false
  let anyWildcard = false
  let anyLoopback = false
  for (const addr of args.listenAddrs) {
    if (!addr.startsWith('/')) continue
    anyParsed = true
    if (isWildcard(addr)) {
      anyWildcard = true
      continue
    }

    if (isLoopback(addr)) {
      anyLoopback = true
      continue
    }

    if (isPublicishIpv4(addr) || isPublicishIpv6(addr)) {
      anyPublic = true
      // Don't break — caller may want to surface every address. The
      // classifier itself only cares that AT LEAST ONE is public.
    }
  }

  if (anyPublic) return 'public'
  if (args.relays.length > 0) return 'behind-nat-with-relay'
  // kimi round-1 MED — wildcards surface as `wildcard-unconfirmed`
  // when there's no real public IP and no relay to fall back to.
  if (anyWildcard) return 'wildcard-unconfirmed'
  if (anyLoopback) return 'loopback-only'
  if (anyParsed) return 'loopback-only'  // private-IP listen with no relay
  return 'unknown'
}
