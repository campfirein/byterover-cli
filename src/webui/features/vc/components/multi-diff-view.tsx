import { LoaderCircle } from 'lucide-react'
import { useEffect, useMemo, useRef, useState } from 'react'

import type { VcDiffSide } from '../../../../shared/transport/events/vc-events'
import type { ChangeFile } from '../types'

import { formatError } from '../../../lib/error-messages'
import { useGetVcDiffs } from '../api/get-vc-diffs'
import { DiffFileHeader } from './diff-file-header'
import { DiffViewer } from './diff-viewer'
import { FileMetaPanel } from './file-meta-panel'

/**
 * How long to keep a single loading overlay visible after batch data arrives,
 * to mask the per-DiffViewer Web Worker compute. Picked empirically — typical
 * markdown files compute in well under this window.
 */
const COMPUTE_MASK_MS = 300

interface MultiDiffViewProps {
  emptyMessage: string
  files: ChangeFile[]
  onOpenFile: (file: ChangeFile) => void
  onStageToggle: (file: ChangeFile) => void
  side: VcDiffSide
  title: string
}

export function MultiDiffView({ emptyMessage, files, onOpenFile, onStageToggle, side, title }: MultiDiffViewProps) {
  const paths = useMemo(() => files.map((f) => f.path), [files])
  const { data, error, isPending } = useGetVcDiffs({ paths, side })
  // Mask the per-DiffViewer worker compute only once on the first data arrival.
  // Later re-fetches (e.g. after staging a file) render smoothly via `keepPreviousData`.
  const hasMaskedRef = useRef(false)
  const [computeMasked, setComputeMasked] = useState(true)

  useEffect(() => {
    if (hasMaskedRef.current || !data) return
    hasMaskedRef.current = true
    const timer = setTimeout(() => setComputeMasked(false), COMPUTE_MASK_MS)
    return () => clearTimeout(timer)
  }, [data])

  if (files.length === 0) {
    return (
      <div className="flex h-full items-center justify-center bg-card rounded-md">
        <p className="text-secondary-foreground text-sm">{emptyMessage}</p>
      </div>
    )
  }

  if (error) {
    return (
      <div className="flex h-full items-center justify-center bg-card rounded-md">
        <p className="text-secondary-foreground text-sm">
          {formatError(error, 'Failed to load diffs')}
        </p>
      </div>
    )
  }

  const overlayVisible = (isPending && !data) || computeMasked

  return (
    <div className="relative flex h-full flex-col overflow-auto">
      {data && (
        <>
          <div className="flex items-center gap-2 px-1 py-2 text-sm font-semibold">
            <span className="text-foreground">{title}</span>
            <span className="text-muted-foreground">{files.length} file{files.length === 1 ? '' : 's'}</span>
          </div>

          <div className="flex flex-col gap-3">
            {data.diffs.map((diff) => {
              const file = files.find((f) => f.path === diff.path)
              if (!file) return null
              return (
                <div className="flex flex-col" key={`${side}:${diff.path}`}>
                  {file.agentMeta && <FileMetaPanel agentMeta={file.agentMeta} />}
                  <DiffFileHeader
                    className={file.agentMeta ? 'border-t' : 'rounded-t-md'}
                    file={file}
                    onOpenFile={() => onOpenFile(file)}
                    onStageToggle={() => onStageToggle(file)}
                  />
                  <div className="overflow-hidden rounded-b-md">
                    <DiffViewer
                      filename={diff.path}
                      hideSummary
                      newContent={diff.newContent}
                      oldContent={diff.oldContent}
                      showDiffOnly
                      showLoadingOverlay={false}
                      viewMode="split"
                    />
                  </div>
                </div>
              )
            })}
          </div>
        </>
      )}

      {overlayVisible && (
        <div className="bg-card absolute inset-0 z-30 flex items-center justify-center">
          <LoaderCircle className="text-muted-foreground size-5 animate-spin" />
        </div>
      )}
    </div>
  )
}
