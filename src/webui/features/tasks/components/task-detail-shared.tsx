import type {ReactNode} from 'react'

import {cn} from '@campfirein/byterover-packages/lib/utils'
import {Check, X} from 'lucide-react'

import type {StoredTask} from '../types/stored-task'

export function Separator() {
  return (
    <span aria-hidden className="text-muted-foreground/40">
      ·
    </span>
  )
}

export function SectionLabel({children, count}: {children: ReactNode; count?: number | string}) {
  return (
    <div className="text-muted-foreground mono mb-3 flex items-baseline gap-2 text-[11px] uppercase tracking-wider">
      <span>{children}</span>
      <span className="bg-border/50 h-px flex-1" />
      {count !== undefined && <span className="tabular-nums">{count}</span>}
    </div>
  )
}

export function TerminalDot({tone}: {tone: 'completed' | 'error'}) {
  const Icon = tone === 'completed' ? Check : X
  const bg = tone === 'completed' ? 'bg-emerald-500' : 'bg-red-400'
  return (
    <span className="absolute -top-0.5 -left-1 grid size-5 place-items-center">
      <span className={cn('ring-background relative grid size-4 place-items-center rounded-full ring-2', bg)}>
        <Icon className="text-background absolute size-3 stroke-3" />
      </span>
    </span>
  )
}

export function elapsedMs(task: StoredTask, now: number): number {
  const start = task.startedAt ?? task.createdAt
  const end = task.completedAt ?? now
  return Math.max(0, end - start)
}
