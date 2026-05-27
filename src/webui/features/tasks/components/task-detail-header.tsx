import {Button} from '@campfirein/byterover-packages/components/button'
import {Tooltip, TooltipContent, TooltipTrigger} from '@campfirein/byterover-packages/components/tooltip'
import {cn} from '@campfirein/byterover-packages/lib/utils'
import {CircleStop, LoaderCircle} from 'lucide-react'
import {toast} from 'sonner'

import type {StoredTask} from '../types/stored-task'

import {curateHtmlDirectRowTitle, isCurateHtmlDirectType} from '../utils/curate-tool-mode'
import {formatDuration, formatRelative} from '../utils/format-time'
import {displayTaskType, isActiveStatus, isTerminalStatus} from '../utils/task-status'
import {StatusPill} from './status-pill'
import {elapsedMs, Separator} from './task-detail-shared'

const STATUS_VERB: Record<StoredTask['status'], string> = {
  cancelled: 'cancelled',
  completed: 'finished',
  created: 'started',
  error: 'finished',
  started: 'started',
}

interface DetailHeaderProps {
  cancelling: boolean
  now: number
  onCancel: (taskId: string) => void
  task: StoredTask
}

export function DetailHeader({cancelling, now, onCancel, task}: DetailHeaderProps) {
  const isTerminal = isTerminalStatus(task.status)
  const isActive = isActiveStatus(task.status)
  const elapsed = elapsedMs(task, now)
  const referenceTime = task.startedAt ?? task.createdAt
  const verb = STATUS_VERB[task.status]
  const elapsedLabel = isTerminal ? 'ran' : 'running'
  // For curate-tool-mode the raw `content` is a JSON blob; decode it so the
  // header shows the user's intent (CLI) or topic path (MCP) instead.
  const displayTitle = isCurateHtmlDirectType(task.type) ? curateHtmlDirectRowTitle(task.content) : task.content

  return (
    <header className="px-6 pt-5 pb-4">
      <div className="flex items-center gap-3 pr-12">
        <StatusPill status={task.status} />
        <h1 className="text-foreground min-w-0 flex-1 truncate text-lg leading-tight font-medium tracking-tight">
          {displayTitle || <span className="text-muted-foreground italic">(empty)</span>}
        </h1>
      </div>
      <div className="text-muted-foreground mt-2.5 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs">
        <CopyableTaskId taskId={task.taskId} />
        <Separator />
        <span className="mono uppercase tracking-wider">{displayTaskType(task.type)}</span>
        <Separator />
        <span>
          {verb} {formatRelative(referenceTime, now)} ago
        </span>
        <Separator />
        <span className={cn('mono tabular-nums', isActive ? 'text-blue-400' : 'text-muted-foreground')}>
          {elapsedLabel} {formatDuration(elapsed)}
        </span>
        {isActive && (
          <Button
            aria-label="Cancel task"
            className="ml-1 h-6 gap-1 border-red-500/40 px-2 text-red-400 hover:border-red-500/60 hover:bg-red-500/10 hover:text-red-300"
            disabled={cancelling}
            onClick={() => onCancel(task.taskId)}
            size="xs"
            variant="outline"
          >
            {cancelling ? <LoaderCircle className="size-3 animate-spin" /> : <CircleStop className="size-3" />}
            {cancelling ? 'Cancelling…' : 'Cancel'}
          </Button>
        )}
      </div>
    </header>
  )
}

function CopyableTaskId({taskId}: {taskId: string}) {
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(taskId)
      toast.success('Task ID copied', {duration: 2000})
    } catch {
      toast.error('Failed to copy task ID', {duration: 3000})
    }
  }

  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <Button
            aria-label="Copy task ID"
            className="text-identifier hover:text-identifier hover:bg-identifier/10 mono px-1.5 font-normal"
            onClick={copy}
            size="xs"
            variant="ghost"
          />
        }
      >
        <span className="truncate">{taskId}</span>
      </TooltipTrigger>
      <TooltipContent>Click to copy</TooltipContent>
    </Tooltip>
  )
}
