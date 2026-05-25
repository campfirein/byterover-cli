import {networkInterfaces} from 'node:os'

/**
 * Phase 9.5 §3.4 — classify a libp2p multiaddr by network interface kind.
 *
 * Reads the IP component from the multiaddr and classifies it as:
 *   loopback   — 127.0.0.0/8 or ::1
 *   lan        — RFC1918 + link-local (10/8, 172.16/12, 192.168/16,
 *                169.254/16, fe80::/10)
 *   tailscale  — 100.64.0.0/10 (CGNAT range Tailscale uses)
 *   wan        — everything else routable
 *   unknown    — parse failure or non-IP multiaddr component
 *
 * The optional `iface` field is the OS interface name when an address
 * in the local `os.networkInterfaces()` table matches.
 */
export type MultiaddrKind = 'lan' | 'loopback' | 'tailscale' | 'unknown' | 'wan'

export interface MultiaddrClassification {
  /**
   * OS network interface name, e.g. `en0`, `utun8`. Set when the IP is
   * found in `os.networkInterfaces()`; `undefined` otherwise.
   */
  readonly iface?: string
  readonly kind: MultiaddrKind
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/** Parse `x.y.z.w` → four integers; return undefined on failure. */
function parseIPv4(addr: string): [number, number, number, number] | undefined {
  const parts = addr.split('.')
  if (parts.length !== 4) return undefined
  const nums = parts.map(Number)
  if (nums.some((n) => !Number.isInteger(n) || n < 0 || n > 255)) return undefined
  return nums as [number, number, number, number]
}

/** CIDR containment check for IPv4 using the first `prefix` bits. */
// CIDR math is fundamentally a bitwise operation — these are not the
// usual JS "did you mean logical?" mistakes the lint rule guards against.
/* eslint-disable no-bitwise */
function inRange(ip: [number, number, number, number], base: [number, number, number, number], prefix: number): boolean {
  // Pack both IPs into 32-bit integers and compare the upper `prefix` bits.
  const ipInt = (ip[0] << 24) | (ip[1] << 16) | (ip[2] << 8) | ip[3]
  const baseInt = (base[0] << 24) | (base[1] << 16) | (base[2] << 8) | base[3]
  const mask = prefix === 0 ? 0 : (~0 << (32 - prefix)) >>> 0
  return (ipInt >>> 0 & mask) === (baseInt >>> 0 & mask)
}
/* eslint-enable no-bitwise */

function classifyIPv4(addr: string): MultiaddrKind | undefined {
  const ip = parseIPv4(addr)
  if (!ip) return undefined

  // Loopback — 127.0.0.0/8
  if (inRange(ip, [127, 0, 0, 0], 8)) return 'loopback'

  // Tailscale — 100.64.0.0/10 (CGNAT range)
  if (inRange(ip, [100, 64, 0, 0], 10)) return 'tailscale'

  // RFC1918 LAN ranges
  if (inRange(ip, [10, 0, 0, 0], 8)) return 'lan'
  if (inRange(ip, [172, 16, 0, 0], 12)) return 'lan'
  if (inRange(ip, [192, 168, 0, 0], 16)) return 'lan'

  // Link-local — 169.254.0.0/16
  if (inRange(ip, [169, 254, 0, 0], 16)) return 'lan'

  return 'wan'
}

function classifyIPv6(addr: string): MultiaddrKind | undefined {
  const lower = addr.toLowerCase()

  // Loopback — ::1
  if (lower === '::1' || lower === '0:0:0:0:0:0:0:1') return 'loopback'

  // Link-local — fe80::/10
  if (lower.startsWith('fe80')) return 'lan'

  // Tailscale — fd7a:115c:a1e0::/48 (Tailscale IPv6 stable ULA)
  if (lower.startsWith('fd7a:115c:a1e0')) return 'tailscale'

  return undefined
}

/**
 * Attempt to resolve the OS interface name for an IP address by scanning
 * `os.networkInterfaces()`. Returns `undefined` when not found or on error.
 */
function resolveIface(ip: string): string | undefined {
  try {
    const ifaces = networkInterfaces()
    for (const [name, entries] of Object.entries(ifaces)) {
      if (!entries) continue
      for (const entry of entries) {
        if (entry.address === ip) return name
      }
    }
  } catch {
    // Non-critical — fall back to undefined.
  }

  return undefined
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Classify a multiaddr string and return the network interface kind.
 *
 * @example
 * classifyMultiaddr('/ip4/100.120.188.62/tcp/60001/p2p/12D3...')
 * // → { kind: 'tailscale', iface: 'utun8' }
 *
 * classifyMultiaddr('/ip4/127.0.0.1/tcp/60001')
 * // → { kind: 'loopback', iface: 'lo0' }
 */
export function classifyMultiaddr(maddr: string): MultiaddrClassification {
  // Extract /ip4/<address> or /ip6/<address> component.
  const ip4Match = maddr.match(/^(?:\/[^/]+)*\/ip4\/([^/]+)/)
  const ip6Match = maddr.match(/^(?:\/[^/]+)*\/ip6\/([^/]+)/)

  if (ip4Match) {
    const ip = ip4Match[1]
    const kind = classifyIPv4(ip)
    if (kind === undefined) return {kind: 'unknown'}
    const iface = kind === 'unknown' ? undefined : resolveIface(ip)
    return iface === undefined ? {kind} : {iface, kind}
  }

  if (ip6Match) {
    const ip = ip6Match[1]
    const kind = classifyIPv6(ip)
    if (kind === undefined) return {kind: 'wan'}
    const iface = resolveIface(ip)
    return iface === undefined ? {kind} : {iface, kind}
  }

  return {kind: 'unknown'}
}
