import {expect} from 'chai'

import {enrichDialFailureError} from '../../../../../../src/server/infra/channel/bridge/remote-member-driver.js'

// Phase 9.5.4 — enriched dial-failure error for bootstrap-only multiaddrs.

describe('enrichDialFailureError (#8 — BRIDGE_MULTIADDR_STALE recovery hint)', () => {
  it('returns a plain error message when addressability is pinned', () => {
    const err = enrichDialFailureError({
      addressability: 'pinned',
      channelId: 'cc-chat',
      multiaddr: '/ip4/10.0.0.1/tcp/60001/p2p/12D3KooWAlice',
      originalMessage: 'connection refused',
    })
    expect(err.message).to.include('connection refused')
    expect(err.message).to.not.include('bootstrap-only')
    expect(err.message).to.not.include('brv bridge connect')
  })

  it('enriches the error with BRIDGE_MULTIADDR_STALE hint when addressability is bootstrap-only', () => {
    const err = enrichDialFailureError({
      addressability: 'bootstrap-only',
      channelId: 'cc-chat',
      multiaddr: '/ip4/10.0.0.1/tcp/60001/p2p/12D3KooWAlice',
      originalMessage: 'ECONNREFUSED',
    })
    expect(err.message).to.include('BRIDGE_DIAL_FAILED')
    expect(err.message).to.include('bootstrap-only')
    expect(err.message).to.include('brv bridge connect')
    expect(err.message).to.include('cc-chat')
    expect(err.message).to.include('/ip4/10.0.0.1/tcp/60001/p2p/12D3KooWAlice')
  })

  it('includes brv bridge whoami hint in bootstrap-only enrichment', () => {
    const err = enrichDialFailureError({
      addressability: 'bootstrap-only',
      channelId: 'my-channel',
      multiaddr: '/ip4/192.168.1.1/tcp/60001/p2p/12D3KooWBob',
      originalMessage: 'dial error',
    })
    expect(err.message).to.include('brv bridge whoami')
  })
})
