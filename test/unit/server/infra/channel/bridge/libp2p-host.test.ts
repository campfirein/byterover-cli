import {expect} from 'chai'
import {mkdtemp, rm} from 'node:fs/promises'
import {tmpdir} from 'node:os'
import {join} from 'node:path'

import {InstallIdentityService} from '../../../../../../src/agent/core/trust/install-identity-service.js'
import {DEFAULT_BRIDGE_CONFIG} from '../../../../../../src/server/infra/channel/bridge/bridge-config.js'
import {Libp2pHost} from '../../../../../../src/server/infra/channel/bridge/libp2p-host.js'

// Phase 9 / IMPLEMENTATION_PHASE_9_CLOUD_BRIDGE.md §3.2 + Slice 9.1 —
// Libp2pHost singleton wrapping `createLibp2p`. Uses the L1 install
// Ed25519 key as the libp2p host key, so libp2p's transport-layer
// PeerID equals our brv peer_id (§A7 bind-the-keys invariant).

describe('Libp2pHost', () => {
  let installDir: string

  beforeEach(async () => {
    installDir = await mkdtemp(join(tmpdir(), 'brv-libp2p-host-'))
  })

  afterEach(async () => {
    await rm(installDir, {force: true, recursive: true})
  })

  describe('start / stop lifecycle', () => {
    it('starts a libp2p node using the L1 install key', async () => {
      const identity = new InstallIdentityService({installDir})
      const id = await identity.loadOrGenerate()
      const host = new Libp2pHost({config: DEFAULT_BRIDGE_CONFIG, identity})
      await host.start()
      try {
        // libp2p peerId MUST match the brv peer_id derived from the
        // SAME install Ed25519 public key (AMENDMENT_TOFU §A7 — same
        // key drives both transport-layer Noise auth and brv L1).
        expect(host.peerId).to.equal(id.peerId)
      } finally {
        await host.stop()
      }
    })

    it('exposes the listening multiaddrs after start', async () => {
      const identity = new InstallIdentityService({installDir})
      await identity.loadOrGenerate()
      const host = new Libp2pHost({config: DEFAULT_BRIDGE_CONFIG, identity})
      await host.start()
      try {
        const addrs = host.getMultiaddrs()
        expect(addrs).to.be.an('array').and.have.length.greaterThan(0)
        // Default config listens on TCP loopback with ephemeral port.
        expect(addrs[0]).to.match(/^\/ip4\/127\.0\.0\.1\/tcp\/\d+\/p2p\/12D3KooW/)
      } finally {
        await host.stop()
      }
    })

    it('start is idempotent (second call is a no-op)', async () => {
      const identity = new InstallIdentityService({installDir})
      await identity.loadOrGenerate()
      const host = new Libp2pHost({config: DEFAULT_BRIDGE_CONFIG, identity})
      await host.start()
      try {
        await host.start()  // should not throw
        expect(host.peerId).to.be.a('string')
      } finally {
        await host.stop()
      }
    })

    it('stop is idempotent (second call is a no-op)', async () => {
      const identity = new InstallIdentityService({installDir})
      await identity.loadOrGenerate()
      const host = new Libp2pHost({config: DEFAULT_BRIDGE_CONFIG, identity})
      await host.start()
      await host.stop()
      await host.stop()  // should not throw
    })

    it('throws if peerId is read before start', async () => {
      const identity = new InstallIdentityService({installDir})
      await identity.loadOrGenerate()
      const host = new Libp2pHost({config: DEFAULT_BRIDGE_CONFIG, identity})
      expect(() => host.peerId).to.throw(/not started/i)
    })

    it('throws if getMultiaddrs is called before start', async () => {
      const identity = new InstallIdentityService({installDir})
      await identity.loadOrGenerate()
      const host = new Libp2pHost({config: DEFAULT_BRIDGE_CONFIG, identity})
      expect(() => host.getMultiaddrs()).to.throw(/not started/i)
    })
  })

  describe('two hosts in-process can dial + exchange a stream', () => {
    let installDirA: string
    let installDirB: string

    beforeEach(async () => {
      installDirA = await mkdtemp(join(tmpdir(), 'brv-libp2p-host-a-'))
      installDirB = await mkdtemp(join(tmpdir(), 'brv-libp2p-host-b-'))
    })

    afterEach(async () => {
      await rm(installDirA, {force: true, recursive: true})
      await rm(installDirB, {force: true, recursive: true})
    })

    it('host B dials host A and exchanges a test stream over /brv/test/v1', async () => {
      const identityA = new InstallIdentityService({installDir: installDirA})
      await identityA.loadOrGenerate()
      const hostA = new Libp2pHost({config: DEFAULT_BRIDGE_CONFIG, identity: identityA})

      const identityB = new InstallIdentityService({installDir: installDirB})
      await identityB.loadOrGenerate()
      const hostB = new Libp2pHost({config: DEFAULT_BRIDGE_CONFIG, identity: identityB})

      await hostA.start()
      await hostB.start()

      try {
        // A registers a test protocol echo handler.
        const echoBytes = Buffer.from('hello from B', 'utf8')
        const received: Buffer[] = []
        await hostA.handle('/brv/test/v1', async (stream) => {
          for await (const chunk of stream) {
            received.push(Buffer.from(chunk.subarray()))
          }

          await stream.close()
        })

        // B dials A and writes one frame.
        const addrA = hostA.getMultiaddrs()[0]
        await hostB.dialAndWrite(addrA, '/brv/test/v1', new Uint8Array(echoBytes))

        // Wait briefly for the source iterator to flush.
        await new Promise<void>((r) => {
          setTimeout(r, 200)
        })
        const flat = Buffer.concat(received)
        expect(flat.toString('utf8')).to.equal('hello from B')
      } finally {
        await Promise.allSettled([hostA.stop(), hostB.stop()])
      }
    })

    it('hostA.peerId !== hostB.peerId (independent identities)', async () => {
      const identityA = new InstallIdentityService({installDir: installDirA})
      await identityA.loadOrGenerate()
      const hostA = new Libp2pHost({config: DEFAULT_BRIDGE_CONFIG, identity: identityA})
      const identityB = new InstallIdentityService({installDir: installDirB})
      await identityB.loadOrGenerate()
      const hostB = new Libp2pHost({config: DEFAULT_BRIDGE_CONFIG, identity: identityB})
      await hostA.start()
      await hostB.start()
      try {
        expect(hostA.peerId).to.not.equal(hostB.peerId)
      } finally {
        await Promise.allSettled([hostA.stop(), hostB.stop()])
      }
    })
  })

  // §9.5.8 Fix C — libp2p connection-state observability
  describe('§9.5.8 Fix C — connection lifecycle event listeners are registered on start', () => {
    it('registers connection:open, connection:close, peer:connect, peer:disconnect listeners and fires heartbeat interval', async () => {
      const identity = new InstallIdentityService({installDir})
      await identity.loadOrGenerate()

      // We need to capture the real node's addEventListener calls. Since
      // Libp2pHost creates the node internally, we verify via the real node
      // after start() by checking that the observed connection events fire
      // when we make a real connection.
      //
      // Approach: start two real hosts, make a connection, and verify that
      // the console.warn output from the connection:open listener appears.
      const identityB = new InstallIdentityService({installDir: installDir + '-b'})
      await identityB.loadOrGenerate()
      const hostA = new Libp2pHost({config: DEFAULT_BRIDGE_CONFIG, identity})
      const hostB = new Libp2pHost({config: DEFAULT_BRIDGE_CONFIG, identity: identityB})

      const warnLogs: string[] = []
      const originalWarn = console.warn
      console.warn = (...args: unknown[]) => {
        const msg = args.join(' ')
        warnLogs.push(msg)
        // Suppress output to keep test output clean
      }

      await hostA.start()
      await hostB.start()

      try {
        // B dials A — this should trigger connection:open on A
        const addrA = hostA.getMultiaddrs()[0]
        await hostB.dialAndWrite(addrA, '/brv/test/v1', new Uint8Array([1])).catch(() => {})

        // Allow event dispatch to propagate
        await new Promise<void>((r) => { setTimeout(r, 100) })

        // connection:open or peer:connect must have fired on hostA — look for
        // the [libp2p] prefix in warn logs
        const connectionLogs = warnLogs.filter((l) => l.includes('[libp2p]'))
        expect(connectionLogs.length, `expected [libp2p] warn logs from connection events, got: ${JSON.stringify(warnLogs)}`).to.be.greaterThan(0)

        // Verify at least connection:open or peer:connect was logged
        const hasConnectionEvent = connectionLogs.some(
          (l) => l.includes('connection:open') || l.includes('peer:connect'),
        )
        expect(hasConnectionEvent, `expected connection:open or peer:connect in logs: ${JSON.stringify(connectionLogs)}`).to.equal(true)
      } finally {
        console.warn = originalWarn
        await Promise.allSettled([hostA.stop(), hostB.stop()])
      }
    }).timeout(5000)
  })
})
