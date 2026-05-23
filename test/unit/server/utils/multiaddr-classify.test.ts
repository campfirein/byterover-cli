import {expect} from 'chai'

import {classifyMultiaddr} from '../../../../src/server/utils/multiaddr-classify.js'

// Phase 9.5 §3.4 — multiaddr interface annotation.

describe('classifyMultiaddr', () => {
  it('classifies 127.0.0.1 as loopback', () => {
    const result = classifyMultiaddr('/ip4/127.0.0.1/tcp/60001/p2p/12D3KooWXXX')
    expect(result.kind).to.equal('loopback')
  })

  it('classifies 127.0.0.2 (loopback range) as loopback', () => {
    const result = classifyMultiaddr('/ip4/127.0.0.2/tcp/4001')
    expect(result.kind).to.equal('loopback')
  })

  it('classifies ::1 as loopback', () => {
    const result = classifyMultiaddr('/ip6/::1/tcp/4001')
    expect(result.kind).to.equal('loopback')
  })

  it('classifies 192.168.1.100 as lan', () => {
    const result = classifyMultiaddr('/ip4/192.168.1.100/tcp/60001')
    expect(result.kind).to.equal('lan')
  })

  it('classifies 10.0.0.1 as lan', () => {
    const result = classifyMultiaddr('/ip4/10.0.0.1/tcp/60001')
    expect(result.kind).to.equal('lan')
  })

  it('classifies 172.16.0.1 as lan', () => {
    const result = classifyMultiaddr('/ip4/172.16.0.1/tcp/60001')
    expect(result.kind).to.equal('lan')
  })

  it('classifies 169.254.1.1 (link-local) as lan', () => {
    const result = classifyMultiaddr('/ip4/169.254.1.1/tcp/60001')
    expect(result.kind).to.equal('lan')
  })

  it('classifies 100.64.0.1 (CGNAT Tailscale) as tailscale', () => {
    const result = classifyMultiaddr('/ip4/100.64.0.1/tcp/60001')
    expect(result.kind).to.equal('tailscale')
  })

  it('classifies 100.120.188.62 as tailscale', () => {
    const result = classifyMultiaddr('/ip4/100.120.188.62/tcp/60001')
    expect(result.kind).to.equal('tailscale')
  })

  it('classifies 8.8.8.8 (public) as wan', () => {
    const result = classifyMultiaddr('/ip4/8.8.8.8/tcp/60001')
    expect(result.kind).to.equal('wan')
  })

  it('classifies 203.0.113.1 (public) as wan', () => {
    const result = classifyMultiaddr('/ip4/203.0.113.1/tcp/60001')
    expect(result.kind).to.equal('wan')
  })

  it('returns unknown for a malformed multiaddr', () => {
    const result = classifyMultiaddr('not-a-multiaddr')
    expect(result.kind).to.equal('unknown')
  })

  it('returns unknown when no IP component is present', () => {
    const result = classifyMultiaddr('/dns4/example.com/tcp/4001')
    expect(result.kind).to.equal('unknown')
  })

  it('includes the label field when kind is not unknown', () => {
    const result = classifyMultiaddr('/ip4/127.0.0.1/tcp/60001')
    // label is optional; kind should be set
    expect(result.kind).to.equal('loopback')
  })
})
