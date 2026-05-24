import {Button} from '@campfirein/byterover-packages/components/button'
import {cn} from '@campfirein/byterover-packages/lib/utils'
import {ExternalLink, FileText, Minus, Plus} from 'lucide-react'

import type {ChangeFile} from '../types'

interface DiffFileHeaderProps {
  className?: string
  file: ChangeFile
  onOpenFile: () => void
  onStageToggle: () => void
}

export function DiffFileHeader({className, file, onOpenFile, onStageToggle}: DiffFileHeaderProps) {
  const stageLabel = file.isStaged ? 'Unstage' : 'Stage'
  const StageIcon = file.isStaged ? Minus : Plus
  const isDeleted = file.status === 'deleted'

  return (
    <div
      className={cn(
        'border-border bg-muted sticky top-0 z-10 flex items-center gap-2 border-b px-3 py-1.5',
        className,
      )}
    >
      <FileText className="text-primary-foreground size-4 shrink-0" strokeWidth={2} />
      <span className="text-foreground flex-1 truncate font-mono text-xs">{file.path}</span>
      <Button
        className="size-6 transition-colors hover:bg-foreground/15 dark:hover:bg-foreground/15 hover:text-foreground"
        disabled={isDeleted}
        onClick={onOpenFile}
        size="icon-xs"
        title={isDeleted ? 'File no longer exists' : 'Open file'}
        variant="ghost"
      >
        <ExternalLink className="size-3" />
      </Button>
      <Button
        className="size-6 transition-colors hover:bg-foreground/15 dark:hover:bg-foreground/15 hover:text-foreground"
        onClick={onStageToggle}
        size="icon-xs"
        title={stageLabel}
        variant="ghost"
      >
        <StageIcon className="size-3" />
      </Button>
    </div>
  )
}
