import type { MouseEvent } from 'react'

import { Button } from '@campfirein/byterover-packages/components/button'
import { Tooltip, TooltipContent, TooltipTrigger } from '@campfirein/byterover-packages/components/tooltip'
import { cn } from '@campfirein/byterover-packages/lib/utils'
import { FileText, Minus, Plus, Undo2 } from 'lucide-react'

import type { ChangeFile, ChangeFileStatus, ConflictType } from '../types'

import { shouldShowAgentPulse } from '../utils/should-show-agent-pulse'

const STATUS_META: Record<ChangeFileStatus, { label: string; letter: string; textClass: string }> = {
  added: { label: 'Added', letter: 'A', textClass: 'text-primary-foreground' },
  deleted: { label: 'Deleted', letter: 'D', textClass: 'text-destructive' },
  modified: { label: 'Modified', letter: 'M', textClass: 'text-amber-500' },
  unmerged: { label: 'Conflict', letter: '!', textClass: 'text-amber-500' },
  untracked: { label: 'Untracked', letter: '?', textClass: 'text-primary-foreground' },
}

const CONFLICT_LABEL: Record<ConflictType, string> = {
  /* eslint-disable camelcase */
  both_added: 'Both added',
  both_modified: 'Both modified',
  deleted_modified: 'Deleted / modified',
  /* eslint-enable camelcase */
}

function AgentPulseDot() {
  return (
    <span
      className="size-1.5 shrink-0 animate-pulse rounded-full bg-amber-500"
      title="High-impact agent edit — worth reviewing before staging"
    />
  )
}

interface FileListItemProps {
  disabled?: boolean
  file: ChangeFile
  isSelected?: boolean
  onAction: (file: ChangeFile) => void
  onDiscard?: (file: ChangeFile) => void
  onSelect?: (file: ChangeFile) => void
}

export function FileListItem({ disabled, file, isSelected, onAction, onDiscard, onSelect }: FileListItemProps) {
  const meta = STATUS_META[file.status]
  const fileName = file.path.split('/').pop() ?? file.path
  const dirPath = file.path.slice(0, file.path.length - fileName.length).replace(/\/$/, '')

  const handleActionClick = (event: MouseEvent) => {
    event.stopPropagation()
    onAction(file)
  }

  const handleDiscardClick = (event: MouseEvent) => {
    event.stopPropagation()
    onDiscard?.(file)
  }

  return (
    <div
      className={cn(
        'group flex cursor-pointer items-center gap-2 rounded px-2 py-1 transition-colors h-8',
        isSelected ? 'bg-muted' : 'hover:bg-muted/50',
      )}
      onClick={() => onSelect?.(file)}
      onKeyDown={(event) => {
        if (event.key === 'Enter' || event.key === ' ') {
          event.preventDefault()
          onSelect?.(file)
        }
      }}
      role="button"
      tabIndex={0}
    >
      <FileText className="text-primary-foreground size-4 shrink-0" strokeWidth={2} />

      <Tooltip disableHoverablePopup>
        <TooltipTrigger render={<div className="flex min-w-0 flex-1 items-baseline gap-1.5" />}>
          <span className="text-foreground truncate text-sm">{fileName}</span>
          {dirPath && <span className="text-muted-foreground truncate text-xs group-hover:hidden">{dirPath}</span>}
        </TooltipTrigger>
        <TooltipContent className="pointer-events-none max-w-lg break-all" side="bottom">
          {file.path}
        </TooltipContent>
      </Tooltip>

      <div className="flex items-center gap-1">
        <div className="hidden items-center gap-1 group-hover:flex group-focus-within:flex">
          {onDiscard && (
            <Button
              className="size-5 transition-colors hover:bg-foreground/15 dark:hover:bg-foreground/15 hover:text-foreground"
              disabled={disabled}
              onClick={handleDiscardClick}
              size="icon-xs"
              title="Discard changes"
              variant="ghost"
            >
              <Undo2 className="size-3" />
            </Button>
          )}
          <Button
            className="size-5 transition-colors hover:bg-foreground/15 dark:hover:bg-foreground/15 hover:text-foreground"
            disabled={disabled}
            onClick={handleActionClick}
            size="icon-xs"
            title={file.isStaged ? 'Unstage' : 'Stage'}
            variant="ghost"
          >
            {file.isStaged ? <Minus className="size-3" /> : <Plus className="size-3" />}
          </Button>
        </div>
        {shouldShowAgentPulse(file.agentMeta) && <AgentPulseDot />}
        <span
          className={cn('w-4 text-center font-mono text-xs font-semibold', meta.textClass)}
          title={file.conflictType ? `Conflict: ${CONFLICT_LABEL[file.conflictType]}` : meta.label}
        >
          {meta.letter}
        </span>
      </div>
    </div>
  )
}
