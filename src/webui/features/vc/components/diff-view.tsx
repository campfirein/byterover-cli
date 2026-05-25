import { LoaderCircle } from 'lucide-react'

import type { ChangeFile } from '../types'

import { formatError } from '../../../lib/error-messages'
import { useGetVcDiff } from '../api/get-vc-diff'
import { DiffFileHeader } from './diff-file-header'
import { DiffViewer } from './diff-viewer'
import { FileMetaPanel } from './file-meta-panel'

interface DiffViewProps {
  file: ChangeFile
  onOpenFile: (file: ChangeFile) => void
  onStageToggle: (file: ChangeFile) => void
}

export function DiffView({ file, onOpenFile, onStageToggle }: DiffViewProps) {
  const side = file.isStaged ? 'staged' : 'unstaged'
  const { data, error, isLoading } = useGetVcDiff({ path: file.path, side })

  if (isLoading) {
    return (
      <div className="flex h-full items-center justify-center">
        <LoaderCircle className="text-muted-foreground size-5 animate-spin" />
      </div>
    )
  }

  if (error) {
    return (
      <div className="flex h-full items-center justify-center">
        <p className="text-muted-foreground text-sm">
          {formatError(error, 'Failed to load diff')}
        </p>
      </div>
    )
  }

  if (!data) {
    return (
      <div className="flex h-full items-center justify-center">
        <p className="text-muted-foreground text-sm">No diff available</p>
      </div>
    )
  }

  return (
    <div className="bg-card flex h-full flex-col overflow-auto rounded-md">
      {file.agentMeta && <FileMetaPanel agentMeta={file.agentMeta} />}
      <DiffFileHeader
        className={file.agentMeta ? 'border-t' : undefined}
        file={file}
        onOpenFile={() => onOpenFile(file)}
        onStageToggle={() => onStageToggle(file)}
      />
      <div className="flex-1 [&>div]:min-h-full">
        <DiffViewer filename={file.path} hideSummary newContent={data.newContent} oldContent={data.oldContent} viewMode="split" />
      </div>
    </div>
  )
}
