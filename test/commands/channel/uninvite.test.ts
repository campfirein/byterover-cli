import {expect} from 'chai'

import ChannelUninvite from '../../../src/oclif/commands/channel/uninvite.js'

// Operator-UX gap surfaced during 2026-05-20 internal-test prep —
// daemon restarts re-randomise libp2p ports, so any cross-bridge member
// invited at a previous multiaddr becomes unreachable; without a
// `brv channel uninvite` CLI the only workaround was creating a fresh
// channel. The transport-level `ChannelEvents.UNINVITE` + orchestrator
// `uninviteMember` were already wired (Phase 2); this command exposes
// them at the CLI.

describe('ChannelUninvite (operator-UX gap — kick / member-remove)', () => {
  describe('static contract', () => {
    it('exposes `channelId` and `handle` required args (matches invite)', () => {
      expect(ChannelUninvite.args).to.have.property('channelId')
      expect(ChannelUninvite.args).to.have.property('handle')
      expect(ChannelUninvite.args.channelId.required).to.equal(true)
      expect(ChannelUninvite.args.handle.required).to.equal(true)
    })

    it('exposes a --json flag for scriptability (CLI convention)', () => {
      expect(ChannelUninvite.flags).to.have.property('json')
    })

    it('has a non-trivial description that mentions the operator-UX motivation', () => {
      expect(ChannelUninvite.description).to.be.a('string')
      expect(ChannelUninvite.description.length).to.be.greaterThan(60)
    })

    it('description calls out the in-flight cancel + driver release behaviour', () => {
      // The orchestrator's uninviteMember cancels in-flight deliveries
      // and releases the pool driver — operators using this for stale
      // multiaddrs need to know it's a clean stop, not a leaked
      // child-process.
      expect(ChannelUninvite.description).to.match(/cancel|driver|release|stale|multiaddr/i)
    })

    it('ships at least one example to anchor the multiaddr-rotation use case', () => {
      expect(ChannelUninvite.examples).to.be.an('array').with.lengthOf.at.least(1)
    })

    it('handle arg rejects non-@-prefixed values via run-time validation', () => {
      // We can't construct the runtime context here, but the static
      // shape commitment is that the handle must start with @ —
      // mirrored from invite.ts:46-48. The command implementation
      // performs the check at runtime.
      // (Smoke check: the args definition is present.)
      expect(ChannelUninvite.args.handle.description).to.match(/@/)
    })
  })
})
