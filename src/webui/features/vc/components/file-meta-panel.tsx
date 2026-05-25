import { Badge } from '@campfirein/byterover-packages/components/badge'
import { Tooltip, TooltipContent, TooltipTrigger } from '@campfirein/byterover-packages/components/tooltip'
import { cn } from '@campfirein/byterover-packages/lib/utils'
import { Sparkles } from 'lucide-react'

import type { AgentChangeMeta } from '../types'

import { getEffectiveImpact } from '../types'
import { shouldShowAgentPulse } from '../utils/should-show-agent-pulse'
import { splitReasonPrefix } from '../utils/split-reason-prefix'

interface FileMetaPanelProps {
  agentMeta: AgentChangeMeta
}

const OP_TYPE_CLASSES: Record<AgentChangeMeta['type'], string> = {
  ADD: 'bg-emerald-500/10 text-emerald-600 dark:text-emerald-400 border-emerald-500/40',
  DELETE: 'bg-destructive/10 text-destructive border-destructive/40',
  MERGE: 'bg-emerald-500/10 text-emerald-600 dark:text-emerald-400 border-emerald-500/40',
  UPDATE: 'bg-muted text-muted-foreground border-border',
  UPSERT: 'bg-emerald-500/10 text-emerald-600 dark:text-emerald-400 border-emerald-500/40',
}

function ReasonText({ text }: { text: string }) {
  const {body, prefix} = splitReasonPrefix(text)
  if (!prefix) return <>{text}</>

  return (
    <>
      <span className="text-muted-foreground italic">{prefix}</span>
      {' — '}
      {body}
    </>
  )
}

function ReasonBody({ agentMeta }: { agentMeta: AgentChangeMeta }) {
  const primary = agentMeta.summary ?? agentMeta.reason
  const secondary = agentMeta.summary ? agentMeta.reason : undefined
  if (!primary) return null

  return (
    <div className="mt-2 space-y-1">
      <p className="text-foreground text-sm leading-relaxed">
        <ReasonText text={primary} />
      </p>
      {secondary && (
        <p className="text-muted-foreground text-[12.5px] leading-relaxed">
          <ReasonText text={secondary} />
        </p>
      )}
    </div>
  )
}

export function FileMetaPanel({ agentMeta }: FileMetaPanelProps) {
  const impact = getEffectiveImpact(agentMeta)
  const isHigh = impact === 'high'
  const showPulse = shouldShowAgentPulse(agentMeta)

  return (
    <section className="bg-card rounded-t-md px-4 py-3">
      <div className="flex flex-wrap items-center gap-2">
        <Sparkles className="text-primary-foreground size-3.5 shrink-0" strokeWidth={2} />
        <Badge
          className={cn('h-5 px-2 font-mono text-[10px] uppercase tracking-wide', OP_TYPE_CLASSES[agentMeta.type])}
          variant="outline"
        >
          {agentMeta.type}
        </Badge>
        <Badge
          className={cn(
            'h-5 px-2 font-mono text-[10px] uppercase tracking-wide',
            isHigh ? 'border-amber-500/40 bg-amber-500/10 text-amber-600 dark:text-amber-400' : '',
          )}
          variant="outline"
        >
          {impact} impact
        </Badge>
        {showPulse && (
          <Tooltip>
            <TooltipTrigger
              render={<span className="ml-1 size-1.5 animate-pulse rounded-full bg-amber-500" />}
            />
            <TooltipContent side="top">Worth reviewing — high-impact agent edit</TooltipContent>
          </Tooltip>
        )}
      </div>

      <ReasonBody agentMeta={agentMeta} />
    </section>
  )
}

