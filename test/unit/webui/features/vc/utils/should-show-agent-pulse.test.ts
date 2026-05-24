import {expect} from 'chai'

import type {AgentChangeMeta} from '../../../../../../src/webui/features/vc/types'

import {shouldShowAgentPulse} from '../../../../../../src/webui/features/vc/utils/should-show-agent-pulse'

function makeMeta(overrides: Partial<AgentChangeMeta> = {}): AgentChangeMeta {
  return {opCreatedAt: 100, taskId: 'task-1', type: 'UPSERT', ...overrides}
}

describe('shouldShowAgentPulse', () => {
  it('returns true for an explicitly high-impact pending agent file', () => {
    expect(shouldShowAgentPulse(makeMeta({impact: 'high', reviewStatus: 'pending'}))).to.equal(true)
  })

  it('returns true for a DELETE pending op (high via effective impact)', () => {
    expect(shouldShowAgentPulse(makeMeta({reviewStatus: 'pending', type: 'DELETE'}))).to.equal(true)
  })

  it('returns false once a high-impact op has been approved', () => {
    expect(shouldShowAgentPulse(makeMeta({impact: 'high', reviewStatus: 'approved'}))).to.equal(false)
  })

  it('returns false once a high-impact op has been rejected', () => {
    expect(shouldShowAgentPulse(makeMeta({impact: 'high', reviewStatus: 'rejected'}))).to.equal(false)
  })

  it('returns false for low-impact ops regardless of review status', () => {
    expect(shouldShowAgentPulse(makeMeta({impact: 'low', reviewStatus: 'pending'}))).to.equal(false)
    expect(shouldShowAgentPulse(makeMeta({impact: 'low', reviewStatus: 'approved'}))).to.equal(false)
  })

  it('returns false when reviewStatus is missing (auto-applied — no pulse needed)', () => {
    expect(shouldShowAgentPulse(makeMeta({impact: 'high'}))).to.equal(false)
  })

  it('returns false when no agent meta is given', () => {
    expect(shouldShowAgentPulse()).to.equal(false)
  })
})
