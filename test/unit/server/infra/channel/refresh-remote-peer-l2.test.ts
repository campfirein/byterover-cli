import {expect} from 'chai'

import {refreshRemotePeerL2PubKey} from '../../../../../src/server/infra/channel/refresh-remote-peer-l2.js'

// Phase 9 / Slice 9.4i — refresh the cached L2 pubkey for a remote-
// peer member at warm time. Closes the post-invite indefinite-cache
// gap flagged by kimi on slice 9.4h.

const buildMember = (overrides: Partial<{multiaddr: string; peerId: string; remoteL2PubKey: string}> = {}) => ({
  multiaddr: '/ip4/127.0.0.1/tcp/4001/p2p/12D3KooWAlice',
  peerId: '12D3KooWAlice',
  remoteL2PubKey: 'STORED'.repeat(11),
  ...overrides,
})

describe('refreshRemotePeerL2PubKey (slice 9.4i)', () => {
  it('returns the resolver result when refresh succeeds (uses fresh pubkey at warm time)', async () => {
    const result = await refreshRemotePeerL2PubKey({
      member: buildMember(),
      async resolve() { return 'FRESH'.repeat(13) },
    })
    expect(result).to.equal('FRESH'.repeat(13))
  })

  it('returns the stored pubkey when the resolver returns the same value (no rotation)', async () => {
    const member = buildMember()
    const result = await refreshRemotePeerL2PubKey({
      member,
      async resolve() { return member.remoteL2PubKey },
    })
    expect(result).to.equal(member.remoteL2PubKey)
  })

  it('falls back to the stored pubkey when the resolver throws (graceful degradation)', async () => {
    const member = buildMember()
    const result = await refreshRemotePeerL2PubKey({
      member,
      async resolve() { throw new Error('peer unreachable') },
    })
    expect(result).to.equal(member.remoteL2PubKey)
  })

  it('returns the stored pubkey when no resolver is wired (test / pre-daemon path)', async () => {
    const member = buildMember()
    const result = await refreshRemotePeerL2PubKey({member})
    expect(result).to.equal(member.remoteL2PubKey)
  })

  it('returns the stored pubkey when no multiaddr is on the member (cannot dial)', async () => {
    const member = {peerId: '12D3KooWAlice', remoteL2PubKey: 'STORED'.repeat(11)}
    const result = await refreshRemotePeerL2PubKey({
      member,
      async resolve() { throw new Error('should not be called') },
    })
    expect(result).to.equal(member.remoteL2PubKey)
  })

  it('passes undefined through when the member has no cached pubkey (bridge-auto-provisioned mirror)', async () => {
    const result = await refreshRemotePeerL2PubKey({
      member: {peerId: '12D3KooWBob'},
      async resolve() { throw new Error('should not be called') },
    })
    expect(result).to.be.undefined
  })

  it('passes the peerId + multiaddr to the resolver (contract integration)', async () => {
    let capturedArgs: unknown
    const member = buildMember({multiaddr: '/ip4/10.0.0.5/tcp/4001/p2p/12D3KooWBob', peerId: '12D3KooWBob'})
    await refreshRemotePeerL2PubKey({
      member,
      async resolve(args) {
        capturedArgs = args
        return 'FRESH'.repeat(13)
      },
    })
    expect(capturedArgs).to.deep.equal({
      multiaddr: '/ip4/10.0.0.5/tcp/4001/p2p/12D3KooWBob',
      peerId: '12D3KooWBob',
    })
  })
})
