import {expect} from 'chai'

import type {RegistryClient, RegistryRecord} from '../../../../../../src/server/infra/channel/bridge/registry-client.js'

import {
  CompositePeerMultiaddrResolver,
  type IPeerMultiaddrResolver,
  type Multiaddr,
  NoopPeerMultiaddrResolver,
  RegistryPeerMultiaddrResolver,
} from '../../../../../../src/server/infra/channel/bridge/peer-multiaddr-resolver.js'
import {NoopRegistryClient} from '../../../../../../src/server/infra/channel/bridge/registry-client.js'

// Phase 9 / Slice 9.6 + 9.7 — peer-multiaddr-resolver abstraction.
// Real DHT + registry implementations land later; this slice ships
// the interface + composite layering + a no-op default + the
// RegistryClient adapter.

class FakeResolver implements IPeerMultiaddrResolver {
  public closeCalls = 0
  public publishCalls = 0
  public readonly records: Map<string, Multiaddr[]>
  public resolveCalls = 0

  public constructor(records: Map<string, Multiaddr[]> = new Map()) {
    this.records = records
  }

  async close(): Promise<void> {
    this.closeCalls += 1
  }

  async publish(_addrs: readonly Multiaddr[]): Promise<void> {
    this.publishCalls += 1
  }

  async resolve(peerId: string): Promise<readonly Multiaddr[]> {
    this.resolveCalls += 1
    return this.records.get(peerId) ?? []
  }
}

describe('peer-multiaddr-resolver (slice 9.6 + 9.7)', () => {
describe('NoopPeerMultiaddrResolver (slice 9.6)', () => {
  it('resolve always returns empty', async () => {
    const r = new NoopPeerMultiaddrResolver()
    expect(await r.resolve('12D3KooWAlice')).to.deep.equal([])
  })

  it('publish is a no-op', async () => {
    const r = new NoopPeerMultiaddrResolver()
    await r.publish(['/ip4/1.2.3.4/tcp/4001'])
    // Should not throw.
  })

  it('close is idempotent', async () => {
    const r = new NoopPeerMultiaddrResolver()
    await r.close()
    await r.close()
  })
})

describe('CompositePeerMultiaddrResolver (slice 9.6)', () => {
  it('returns the first non-empty result from the priority chain', async () => {
    const primary = new FakeResolver(new Map([['12D3KooWAlice', ['/ip4/1.1.1.1/tcp/4001']]]))
    const fallback = new FakeResolver(new Map([['12D3KooWAlice', ['/ip4/9.9.9.9/tcp/4001']]]))
    const composite = new CompositePeerMultiaddrResolver([primary, fallback])

    expect(await composite.resolve('12D3KooWAlice')).to.deep.equal(['/ip4/1.1.1.1/tcp/4001'])
    expect(primary.resolveCalls).to.equal(1)
    expect(fallback.resolveCalls).to.equal(0)  // short-circuit
  })

  it('falls through to the next resolver when the previous returns empty', async () => {
    const primary = new FakeResolver()  // empty
    const fallback = new FakeResolver(new Map([['12D3KooWAlice', ['/ip4/9.9.9.9/tcp/4001']]]))
    const composite = new CompositePeerMultiaddrResolver([primary, fallback])

    expect(await composite.resolve('12D3KooWAlice')).to.deep.equal(['/ip4/9.9.9.9/tcp/4001'])
    expect(primary.resolveCalls).to.equal(1)
    expect(fallback.resolveCalls).to.equal(1)
  })

  it('treats a resolver throw as empty and continues', async () => {
    const angry: IPeerMultiaddrResolver = {
      async close() {},
      async publish() {},
      async resolve() { throw new Error('boom') },
    }
    const fallback = new FakeResolver(new Map([['12D3KooWAlice', ['/ip4/9.9.9.9/tcp/4001']]]))
    const composite = new CompositePeerMultiaddrResolver([angry, fallback])

    expect(await composite.resolve('12D3KooWAlice')).to.deep.equal(['/ip4/9.9.9.9/tcp/4001'])
  })

  it('returns empty when every resolver returns empty', async () => {
    const composite = new CompositePeerMultiaddrResolver([new FakeResolver(), new FakeResolver()])
    expect(await composite.resolve('12D3KooWAlice')).to.deep.equal([])
  })

  it('re-throws the FIRST error when every backend throws (kimi round-1 MED — no silent empty)', async () => {
    const angryA: IPeerMultiaddrResolver = {
      async close() {},
      async publish() {},
      async resolve() { throw new Error('A broken') },
    }
    const angryB: IPeerMultiaddrResolver = {
      async close() {},
      async publish() {},
      async resolve() { throw new Error('B broken') },
    }
    const composite = new CompositePeerMultiaddrResolver([angryA, angryB])
    try {
      await composite.resolve('12D3KooWAlice')
      expect.fail('expected all-throw to re-throw the first error')
    } catch (error) {
      expect((error as Error).message).to.equal('A broken')
    }
  })

  it('does NOT re-throw when at least one backend returns successfully (empty)', async () => {
    const angry: IPeerMultiaddrResolver = {
      async close() {},
      async publish() {},
      async resolve() { throw new Error('boom') },
    }
    const ok = new FakeResolver()
    const composite = new CompositePeerMultiaddrResolver([angry, ok])
    expect(await composite.resolve('12D3KooWAlice')).to.deep.equal([])
  })

  it('publishWithResults returns per-backend success/error (kimi round-1 MED)', async () => {
    const ok = new FakeResolver()
    const broken: IPeerMultiaddrResolver = {
      async close() {},
      async publish() { throw new Error('registry down') },
      async resolve() { return [] },
    }
    const composite = new CompositePeerMultiaddrResolver([ok, broken])
    const results = await composite.publishWithResults(['/ip4/1.2.3.4/tcp/4001'])
    expect(results).to.have.length(2)
    expect(results[0].ok).to.equal(true)
    expect(results[1].ok).to.equal(false)
    expect((results[1].error as Error).message).to.equal('registry down')
  })

  it('close is idempotent — second call does not explode even when a backend close is strict', async () => {
    let strictCalls = 0
    const strict: IPeerMultiaddrResolver = {
      async close() {
        strictCalls += 1
        if (strictCalls > 1) throw new Error('STRICT_DOUBLE_CLOSE')
      },
      async publish() {},
      async resolve() { return [] },
    }
    const composite = new CompositePeerMultiaddrResolver([strict])
    await composite.close()
    // Second composite.close: strict backend throws, but Promise.allSettled
    // swallows it — composite.close still resolves cleanly.
    await composite.close()
    expect(strictCalls).to.equal(2)
  })

  it('publish fans out to every resolver and swallows individual failures', async () => {
    const ok = new FakeResolver()
    const broken: IPeerMultiaddrResolver = {
      async close() {},
      async publish() { throw new Error('registry down') },
      async resolve() { return [] },
    }
    const composite = new CompositePeerMultiaddrResolver([ok, broken])
    await composite.publish(['/ip4/1.2.3.4/tcp/4001'])
    expect(ok.publishCalls).to.equal(1)
  })

  it('close fans out to every resolver', async () => {
    const a = new FakeResolver()
    const b = new FakeResolver()
    const composite = new CompositePeerMultiaddrResolver([a, b])
    await composite.close()
    expect(a.closeCalls).to.equal(1)
    expect(b.closeCalls).to.equal(1)
  })
})

describe('RegistryPeerMultiaddrResolver (slice 9.7)', () => {
  class FakeRegistry implements RegistryClient {
    public readonly recordsByPeer = new Map<string, RegistryRecord>()

    async close(): Promise<void> {}

    async lookupByHandle(): Promise<undefined> { return undefined }

    async lookupByPeerId(peerId: string): Promise<RegistryRecord | undefined> {
      return this.recordsByPeer.get(peerId)
    }

    async publish(): Promise<void> {}
  }

  it('returns the registry record\'s multiaddrs', async () => {
    const reg = new FakeRegistry()
    reg.recordsByPeer.set('12D3KooWAlice', {
      displayHandle: 'alice@byterover.dev',
      multiaddrs: ['/ip4/2.2.2.2/tcp/4001'],
      peerId: '12D3KooWAlice',
      publishedAt: '2026-05-19T00:00:00.000Z',
    })
    const r = new RegistryPeerMultiaddrResolver(reg)
    expect(await r.resolve('12D3KooWAlice')).to.deep.equal(['/ip4/2.2.2.2/tcp/4001'])
  })

  it('returns empty when the registry has no record', async () => {
    const r = new RegistryPeerMultiaddrResolver(new FakeRegistry())
    expect(await r.resolve('12D3KooWUnknown')).to.deep.equal([])
  })

  it('NoopRegistryClient lookups return undefined and publish throws REGISTRY_NOT_CONFIGURED', async () => {
    const noop = new NoopRegistryClient()
    expect(await noop.lookupByHandle('alice')).to.equal(undefined)
    expect(await noop.lookupByPeerId('12D3KooWAlice')).to.equal(undefined)
    try {
      await noop.publish({
        displayHandle: 'alice',
        multiaddrs: [],
        peerId: '12D3KooWAlice',
        publishedAt: '2026-05-19T00:00:00.000Z',
      })
      expect.fail('expected throw')
    } catch (error) {
      expect((error as Error).message).to.include('REGISTRY_NOT_CONFIGURED')
    }
  })
})
})
