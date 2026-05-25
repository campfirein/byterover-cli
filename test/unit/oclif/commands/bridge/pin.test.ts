import {expect} from 'chai'

import BridgePin from '../../../../../src/oclif/commands/bridge/pin.js'

// Phase 9.5 §3.2 — `brv bridge pin --verify` structural tests.
//
// The pin command directly instantiates libp2p primitives (Libp2pHost,
// TofuStore, etc.) so run() is not exercised here. These tests pin the
// command's public contract — flag names, defaults, and descriptions —
// so a refactor cannot silently drop the `--verify` flag.

describe('BridgePin (§3.2 --verify flag)', () => {
  describe('flags', () => {
    it('should expose a --format flag defaulting to text', () => {
      const flag = BridgePin.flags.format as {default?: string; options?: string[]}
      expect(flag.default).to.equal('text')
      expect(flag.options).to.include('json')
      expect(flag.options).to.include('text')
    })

    it('should expose a --verify boolean flag', () => {
      expect(BridgePin.flags).to.have.property('verify')
      const flag = BridgePin.flags.verify as {default?: boolean}
      expect(flag.default).to.equal(false)
    })

    it('--verify flag description should mention user-confirmed', () => {
      const flag = BridgePin.flags.verify as {description?: string}
      expect(flag.description).to.be.a('string')
      expect(flag.description!.toLowerCase()).to.include('user-confirmed')
    })
  })

  describe('args', () => {
    it('should require a multiaddr positional arg', () => {
      expect(BridgePin.args).to.have.property('multiaddr')
      const arg = BridgePin.args.multiaddr as {required?: boolean}
      expect(arg.required).to.equal(true)
    })
  })

  describe('description', () => {
    it('should be defined and non-trivial', () => {
      expect(BridgePin.description).to.be.a('string').with.length.greaterThan(20)
    })
  })
})
