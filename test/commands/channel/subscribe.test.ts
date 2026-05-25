import {expect} from 'chai'

import ChannelSubscribe from '../../../src/oclif/commands/channel/subscribe.js'

// Slice 8.9 — `brv channel subscribe` is a thin orchestration over
// connectChannelClient (the actual wire flow is exercised by integration tests
// and manual verification). These property tests pin the load-bearing surface
// — flag names, defaults, and description content — so a future refactor can't
// silently change the host-LLM contract that the brv-channel skill documents.

describe('ChannelSubscribe (Slice 8.9 — channel subscribe)', () => {
  describe('description', () => {
    it('should be defined and non-trivial (>= 100 chars)', () => {
      expect(ChannelSubscribe.description).to.be.a('string')
      expect(ChannelSubscribe.description.length).to.be.greaterThan(100)
    })

    it('should call out listener-before-join ordering (codex P1)', () => {
      expect(ChannelSubscribe.description).to.match(/listener.*before.*the\s+channel\s+room.*joined|listener.*before.*join/i)
    })

    it('should call out replay buffering during replay (codex impl-review high-2)', () => {
      expect(ChannelSubscribe.description).to.match(/buffer/i)
    })

    it('should clarify that --exit-on-terminal fires on ANY turn (codex impl-review medium-3)', () => {
      expect(ChannelSubscribe.description).to.match(/exit-on-terminal\s+fires\s+on\s+ANY/i)
    })

    it('should mention JSONL stdout — the host contract', () => {
      expect(ChannelSubscribe.description).to.match(/json/i)
    })

    it('should mention bounded-exit triggers (--count or --exit-on-terminal)', () => {
      expect(ChannelSubscribe.description).to.match(/--count|--exit-on-terminal|terminal/i)
    })
  })

  describe('flags', () => {
    it('should expose --roles for member filtering', () => {
      expect(ChannelSubscribe.flags).to.have.property('roles')
    })

    it('should expose --kinds for event-kind filtering', () => {
      expect(ChannelSubscribe.flags).to.have.property('kinds')
    })

    it('should expose --turn for scope filtering', () => {
      expect(ChannelSubscribe.flags).to.have.property('turn')
    })

    it('should expose --after-seq for crash-recovery cursor (codex P4)', () => {
      expect(ChannelSubscribe.flags).to.have.property('after-seq')
    })

    it('should expose --count for quorum exit (codex P3)', () => {
      expect(ChannelSubscribe.flags).to.have.property('count')
    })

    it('should expose --exit-on-terminal for simple terminal exit', () => {
      expect(ChannelSubscribe.flags).to.have.property('exit-on-terminal')
    })

    it('should expose --timeout with a default matching mention (300_000ms, codex P5)', () => {
      // oclif Flags expose .default as a property on the flag definition.
      const timeoutFlag = ChannelSubscribe.flags.timeout as {default?: number}
      expect(timeoutFlag).to.have.property('default')
      expect(timeoutFlag.default).to.equal(300_000)
    })

    it('should expose --json defaulting to true (codex impl-review high-1: JSONL IS the host contract)', () => {
      const jsonFlag = ChannelSubscribe.flags.json as {default?: boolean}
      expect(jsonFlag.default).to.equal(true)
    })

    it('should require --count >= 1 (codex impl-review low-4)', () => {
      const countFlag = ChannelSubscribe.flags.count as {min?: number}
      expect(countFlag.min).to.equal(1)
    })

    it('should require --timeout >= 1 (codex impl-review low-4)', () => {
      const timeoutFlag = ChannelSubscribe.flags.timeout as {min?: number}
      expect(timeoutFlag.min).to.equal(1)
    })
  })

  describe('args', () => {
    it('should require a channelId positional arg', () => {
      expect(ChannelSubscribe.args).to.have.property('channelId')
      const channelIdArg = ChannelSubscribe.args.channelId as {required?: boolean}
      expect(channelIdArg.required).to.equal(true)
    })
  })

  describe('examples', () => {
    it('should expose at least four examples (--exit-on-terminal, role-scoped completion, --count quorum, --after-seq recovery)', () => {
      expect(ChannelSubscribe.examples).to.be.an('array').with.length.greaterThanOrEqual(4)
    })

    it('should include an --exit-on-terminal example', () => {
      const text = JSON.stringify(ChannelSubscribe.examples)
      expect(text).to.match(/--exit-on-terminal/)
    })

    it('should include a --count quorum example', () => {
      const text = JSON.stringify(ChannelSubscribe.examples)
      expect(text).to.match(/--count/)
    })

    it('should include an --after-seq crash-recovery example', () => {
      const text = JSON.stringify(ChannelSubscribe.examples)
      expect(text).to.match(/--after-seq/)
    })
  })
})
