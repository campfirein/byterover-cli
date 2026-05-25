import {expect} from 'chai'

import {policyPermitsDelegation} from '../../../../../../src/server/infra/channel/bridge/delegate-policy.js'

// Phase 9 / Slice 9.9 — pure policy gate for the `delegate_policy`
// config. Query envelopes always pass; delegate envelopes consult
// the policy.

describe('policyPermitsDelegation (slice 9.9)', () => {
  describe('query envelopes', () => {
    it('accepted under `auto` without prompting', () => {
      const r = policyPermitsDelegation({mode: 'query', policy: 'auto'})
      expect(r.accepted).to.equal(true)
      if (r.accepted) expect(r.requiresInteractiveApproval).to.equal(false)
    })

    it('accepted under `prompt` without prompting (read-only is always free)', () => {
      const r = policyPermitsDelegation({mode: 'query', policy: 'prompt'})
      expect(r.accepted).to.equal(true)
      if (r.accepted) expect(r.requiresInteractiveApproval).to.equal(false)
    })

    it('explicitly accepted under `deny` (deny is delegate-only, NOT a hard mute) — kimi round-1 LOW-2', () => {
      const r = policyPermitsDelegation({mode: 'query', policy: 'deny'})
      expect(r.accepted).to.equal(true)
      if (r.accepted) {
        expect(r.requiresInteractiveApproval).to.equal(false)
      }
    })
  })

  describe('delegate envelopes', () => {
    it('accepted under `auto` without prompting', () => {
      const r = policyPermitsDelegation({mode: 'delegate', policy: 'auto'})
      expect(r.accepted).to.equal(true)
      if (r.accepted) expect(r.requiresInteractiveApproval).to.equal(false)
    })

    it('accepted under `prompt` BUT requiresInteractiveApproval=true', () => {
      const r = policyPermitsDelegation({mode: 'delegate', policy: 'prompt'})
      expect(r.accepted).to.equal(true)
      if (r.accepted) expect(r.requiresInteractiveApproval).to.equal(true)
    })

    it('rejected under `deny` with DELEGATE_POLICY_DENY reason', () => {
      const r = policyPermitsDelegation({mode: 'delegate', policy: 'deny'})
      expect(r.accepted).to.equal(false)
      if (!r.accepted) expect(r.reason).to.equal('DELEGATE_POLICY_DENY')
    })
  })

  describe('correlationId propagation (kimi round-1 LOW-1)', () => {
    it('echoes correlationId on accepted decisions so future prompt UI can match operator response back', () => {
      const r = policyPermitsDelegation({correlationId: 'turn-123', mode: 'delegate', policy: 'prompt'})
      expect(r.accepted).to.equal(true)
      if (r.accepted) expect(r.correlationId).to.equal('turn-123')
    })

    it('omits correlationId entirely when caller did not supply one', () => {
      const r = policyPermitsDelegation({mode: 'delegate', policy: 'auto'})
      expect(r.accepted).to.equal(true)
      if (r.accepted) expect(r.correlationId).to.equal(undefined)
    })

    it('does not echo correlationId on rejected decisions (deny has no correlation surface)', () => {
      const r = policyPermitsDelegation({correlationId: 'turn-xyz', mode: 'delegate', policy: 'deny'})
      expect(r.accepted).to.equal(false)
      // No correlationId field on reject — caller already has the
      // envelope it was about to dispatch.
    })
  })
})
