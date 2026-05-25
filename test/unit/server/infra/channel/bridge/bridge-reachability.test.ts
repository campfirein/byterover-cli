import {expect} from 'chai'

import {classifyBridgeReachability} from '../../../../../../src/server/infra/channel/bridge/bridge-reachability.js'

// Phase 9 / Slice 9.8 — pure reachability classifier (no network
// probes). brv channel doctor surfaces the label to operators so
// they can tell at a glance whether their install is dialable from
// the network.

describe('classifyBridgeReachability (slice 9.8)', () => {
  it('returns public for a real public IPv4 listen address', () => {
    expect(classifyBridgeReachability({
      listenAddrs: ['/ip4/203.0.113.5/tcp/4001'],
      relays: [],
    })).to.equal('public')
  })

  it('returns public for a real public IPv6 listen address', () => {
    expect(classifyBridgeReachability({
      listenAddrs: ['/ip6/2001:db8::1/tcp/4001'],
      relays: [],
    })).to.equal('public')
  })

  it('returns loopback-only for 127.0.0.1', () => {
    expect(classifyBridgeReachability({
      listenAddrs: ['/ip4/127.0.0.1/tcp/0'],
      relays: [],
    })).to.equal('loopback-only')
  })

  it('returns wildcard-unconfirmed for `/ip4/0.0.0.0/...` with no relay (kimi round-1 MED)', () => {
    // 0.0.0.0 means "listen on every interface" — the daemon MAY
    // be public (if a real interface exists) or loopback-only.
    // Surface the ambiguity rather than under-reporting.
    expect(classifyBridgeReachability({
      listenAddrs: ['/ip4/0.0.0.0/tcp/4001'],
      relays: [],
    })).to.equal('wildcard-unconfirmed')
  })

  it('returns wildcard-unconfirmed for IPv6 `::` wildcard with no relay', () => {
    expect(classifyBridgeReachability({
      listenAddrs: ['/ip6/::/tcp/4001'],
      relays: [],
    })).to.equal('wildcard-unconfirmed')
  })

  it('IPv6 ::1 (loopback) is still loopback-only, NOT wildcard-unconfirmed', () => {
    expect(classifyBridgeReachability({
      listenAddrs: ['/ip6/::1/tcp/4001'],
      relays: [],
    })).to.equal('loopback-only')
  })

  it('wildcard + relay → behind-nat-with-relay (relay routing takes priority over ambiguity)', () => {
    expect(classifyBridgeReachability({
      listenAddrs: ['/ip4/0.0.0.0/tcp/4001'],
      relays: ['/ip4/relay.example.com/tcp/4001/p2p/12D3KooWRelay/p2p-circuit'],
    })).to.equal('behind-nat-with-relay')
  })

  it('returns loopback-only for private RFC1918 IPv4 (10.0.0.0/8)', () => {
    expect(classifyBridgeReachability({
      listenAddrs: ['/ip4/10.0.0.5/tcp/4001'],
      relays: [],
    })).to.equal('loopback-only')
  })

  it('returns loopback-only for private 192.168.x.x', () => {
    expect(classifyBridgeReachability({
      listenAddrs: ['/ip4/192.168.1.5/tcp/4001'],
      relays: [],
    })).to.equal('loopback-only')
  })

  it('returns loopback-only for 172.16-31 private range', () => {
    expect(classifyBridgeReachability({
      listenAddrs: ['/ip4/172.16.1.5/tcp/4001'],
      relays: [],
    })).to.equal('loopback-only')
    expect(classifyBridgeReachability({
      listenAddrs: ['/ip4/172.31.1.5/tcp/4001'],
      relays: [],
    })).to.equal('loopback-only')
  })

  it('returns loopback-only for CGNAT 100.64.0.0/10', () => {
    expect(classifyBridgeReachability({
      listenAddrs: ['/ip4/100.64.1.5/tcp/4001'],
      relays: [],
    })).to.equal('loopback-only')
  })

  it('returns behind-nat-with-relay when listen is private/loopback but relays are configured', () => {
    expect(classifyBridgeReachability({
      listenAddrs: ['/ip4/127.0.0.1/tcp/0'],
      relays: ['/ip4/relay.example.com/tcp/4001/p2p/12D3KooWRelay/p2p-circuit'],
    })).to.equal('behind-nat-with-relay')
  })

  it('returns unreachable when there are NO listen addrs AND no relays', () => {
    expect(classifyBridgeReachability({
      listenAddrs: [],
      relays: [],
    })).to.equal('unreachable')
  })

  it('returns behind-nat-with-relay when listen is empty but relays exist', () => {
    expect(classifyBridgeReachability({
      listenAddrs: [],
      relays: ['/ip4/relay.example.com/tcp/4001/p2p/12D3KooWRelay/p2p-circuit'],
    })).to.equal('behind-nat-with-relay')
  })

  it('returns public when ANY listen addr is public (mixed list)', () => {
    expect(classifyBridgeReachability({
      listenAddrs: ['/ip4/127.0.0.1/tcp/0', '/ip4/203.0.113.5/tcp/4001'],
      relays: [],
    })).to.equal('public')
  })

  it('returns unknown for unparseable listen addresses with no relays', () => {
    expect(classifyBridgeReachability({
      listenAddrs: ['garbage'],
      relays: [],
    })).to.equal('unknown')
  })

  it('ignores IPv6 ULA fc00::/7 (treated as non-public)', () => {
    expect(classifyBridgeReachability({
      listenAddrs: ['/ip6/fc00::1/tcp/4001'],
      relays: [],
    })).to.equal('loopback-only')
  })

  it('ignores IPv6 link-local fe80::/10', () => {
    expect(classifyBridgeReachability({
      listenAddrs: ['/ip6/fe80::1/tcp/4001'],
      relays: [],
    })).to.equal('loopback-only')
  })
})
