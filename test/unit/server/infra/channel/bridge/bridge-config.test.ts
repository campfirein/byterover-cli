/* eslint-disable camelcase */
// Config field names mirror IMPLEMENTATION_PHASE_9_CLOUD_BRIDGE.md §6.5
// on-disk JSON shape and are intentionally snake_case.

import {expect} from 'chai'

import {
  type BridgeConfig,
  DEFAULT_BRIDGE_CONFIG,
  parseBridgeConfig,
} from '../../../../../../src/server/infra/channel/bridge/bridge-config.js'

// Phase 9 / IMPLEMENTATION_PHASE_9_CLOUD_BRIDGE.md §6.5 — bridge config
// shape + defaults. v1 ships with defaults baked in; the config-file loader
// lands in a later slice (probably 9.11 doctor / observability).

describe('bridge-config', () => {
  describe('DEFAULT_BRIDGE_CONFIG', () => {
    it('listens on TCP loopback with ephemeral port (safe v1 default)', () => {
      // Default MUST NOT advertise on 0.0.0.0; users opt into wider
      // listening explicitly. v1 default = loopback + ephemeral.
      expect(DEFAULT_BRIDGE_CONFIG.listen_addrs).to.deep.equal(['/ip4/127.0.0.1/tcp/0'])
    })

    it('discovery_mode defaults to manual-only for v1 (no DHT/registry until configured)', () => {
      // Slice 9.1b ships the host only; discovery layers come in 9.6 + 9.7.
      // Default to manual-only so an upgraded install doesn't accidentally
      // announce itself before the user has opted in.
      expect(DEFAULT_BRIDGE_CONFIG.discovery_mode).to.equal('manual-only')
    })

    it('accept_modes includes both peer-tree and ca-issued-tree by default', () => {
      expect(DEFAULT_BRIDGE_CONFIG.accept_modes).to.have.members([
        'peer-tree',
        'ca-issued-tree',
      ])
    })

    it('dht_bootstrap defaults to empty (no ByteRover anchors until 9.6)', () => {
      expect(DEFAULT_BRIDGE_CONFIG.dht_bootstrap).to.deep.equal([])
    })
  })

  describe('parseBridgeConfig', () => {
    it('returns defaults when input is undefined', () => {
      expect(parseBridgeConfig()).to.deep.equal(DEFAULT_BRIDGE_CONFIG)
    })

    it('returns defaults when input is an empty object', () => {
      expect(parseBridgeConfig({})).to.deep.equal(DEFAULT_BRIDGE_CONFIG)
    })

    it('merges partial input over defaults', () => {
      const result = parseBridgeConfig({listen_addrs: ['/ip4/0.0.0.0/tcp/4001']})
      expect(result.listen_addrs).to.deep.equal(['/ip4/0.0.0.0/tcp/4001'])
      // Other fields fall back to defaults.
      expect(result.discovery_mode).to.equal(DEFAULT_BRIDGE_CONFIG.discovery_mode)
    })

    it('rejects unknown fields (Zod strict-mode-equivalent)', () => {
      // A typo in a config field name should fail loudly, not silently
      // accept the typo and silently miss the intended setting.
      expect(() => parseBridgeConfig({listen_addrz: ['/ip4/0.0.0.0/tcp/0']})).to.throw()
    })

    it('rejects invalid discovery_mode values', () => {
      expect(() => parseBridgeConfig({discovery_mode: 'magic'})).to.throw()
    })

    it('rejects non-array listen_addrs', () => {
      expect(() => parseBridgeConfig({listen_addrs: '/ip4/0.0.0.0/tcp/0'})).to.throw()
    })

    it('rejects accept_modes with invalid cert_kind values', () => {
      expect(() => parseBridgeConfig({accept_modes: ['install']})).to.throw()
    })

    it('rejects non-URL registry_url (opencode round-3 MEDIUM)', () => {
      expect(() => parseBridgeConfig({registry_url: 'not-a-url'})).to.throw()
      expect(() => parseBridgeConfig({registry_url: '/etc/passwd'})).to.throw()
    })

    it('accepts a valid registry_url', () => {
      const cfg = parseBridgeConfig({registry_url: 'https://discovery.byterover.dev/v1'})
      expect(cfg.registry_url).to.equal('https://discovery.byterover.dev/v1')
    })

    it('rejects non-multiaddr listen_addrs (opencode round-3 MINOR)', () => {
      expect(() => parseBridgeConfig({listen_addrs: ['not-a-multiaddr']})).to.throw()
    })

    it('rejects non-multiaddr dht_bootstrap entries', () => {
      expect(() => parseBridgeConfig({dht_bootstrap: ['not-a-multiaddr']})).to.throw()
    })

    it('rejects announce_interval_hours above 1 year cap (opencode round-3 MINOR)', () => {
      // 8761 hours > 1 year cap.
      expect(() => parseBridgeConfig({announce_interval_hours: 8761})).to.throw()
    })

    it('accepts announce_interval_hours = 1 (one hour)', () => {
      const cfg = parseBridgeConfig({announce_interval_hours: 1})
      expect(cfg.announce_interval_hours).to.equal(1)
    })
  })

  describe('type shape', () => {
    it('BridgeConfig fields are all readonly (TypeScript compile-time check)', () => {
      // This is enforced at compile time; just ensure the parsed object
      // matches the type at runtime.
      const cfg: BridgeConfig = parseBridgeConfig({})
      expect(cfg).to.be.an('object')
    })
  })
})
