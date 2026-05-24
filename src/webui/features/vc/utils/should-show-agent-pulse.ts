import type {AgentChangeMeta} from '../types'

import {getEffectiveImpact} from '../types'

export function shouldShowAgentPulse(agentMeta?: AgentChangeMeta): boolean {
  if (!agentMeta) return false
  if (agentMeta.reviewStatus !== 'pending') return false
  return getEffectiveImpact(agentMeta) === 'high'
}
