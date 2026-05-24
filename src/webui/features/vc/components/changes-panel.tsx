import { Button } from '@campfirein/byterover-packages/components/button'
import { FileText, LoaderCircle } from 'lucide-react'
import { useMemo, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { toast } from 'sonner'

import type { ChangeFile } from '../types'

import successTick from '../../../assets/success-tick.svg'
import { formatError } from '../../../lib/error-messages'
import { toastVcError } from '../../../lib/toast-vc-error'
import { useTransportStore } from '../../../stores/transport-store'
import { useAuthStore } from '../../auth/stores/auth-store'
import { useReviewDecideTask } from '../api/execute-review-decide-task'
import { useVcAdd } from '../api/execute-vc-add'
import { useVcCommit } from '../api/execute-vc-commit'
import { useVcMergeAbort } from '../api/execute-vc-merge-abort'
import { useVcMergeContinue } from '../api/execute-vc-merge-continue'
import { useVcPull } from '../api/execute-vc-pull'
import { useVcPush } from '../api/execute-vc-push'
import { useVcReset } from '../api/execute-vc-reset'
import { useGetAgentChanges } from '../api/get-agent-changes'
import { useGetVcStatus } from '../api/get-vc-status'
import { fileKey } from '../utils/file-key'
import { joinAgentMeta } from '../utils/join-agent-meta'
import { statusToFiles } from '../utils/status-to-files'
import { BranchBar } from './branch-bar'
import { CommitInput } from './commit-input'
import { DiffView } from './diff-view'
import { DiscardChangesDialog } from './discard-changes-dialog'
import { FileList } from './file-list'
import { InitializeVcButton } from './initialize-vc-button'
import { MultiDiffView } from './multi-diff-view'
import { StageAllAndCommitDialog } from './stage-all-and-commit-dialog'

type ViewMode = 'multi-staged' | 'multi-unstaged' | 'single'

async function runAction(promise: Promise<unknown>, errorMsg: string): Promise<void> {
  try {
    await promise
  } catch (error) {
    toast.error(formatError(error, errorMsg))
  }
}

export function ChangesPanel() {
  const navigate = useNavigate()
  const isAuthenticated = useAuthStore((s) => s.isAuthorized)
  const selectedProject = useTransportStore((s) => s.selectedProject)
  const { data: status, isFetching, isLoading, refetch } = useGetVcStatus()
  const { data: agentChanges } = useGetAgentChanges()
  const [selectedKey, setSelectedKey] = useState<string | undefined>()
  const [viewMode, setViewMode] = useState<ViewMode>('single')
  const [discardTargets, setDiscardTargets] = useState<ChangeFile[] | undefined>()
  const [commitMessage, setCommitMessage] = useState('')
  const [showStageAllConfirm, setShowStageAllConfirm] = useState(false)

  const addMutation = useVcAdd()
  const resetMutation = useVcReset()
  const commitMutation = useVcCommit()
  const pushMutation = useVcPush()
  const pullMutation = useVcPull()
  const mergeAbortMutation = useVcMergeAbort()
  const mergeContinueMutation = useVcMergeContinue()
  const reviewDecideMutation = useReviewDecideTask()

  const { staged, unmerged, unstaged } = useMemo(() => {
    const buckets = statusToFiles(status)
    const ops = agentChanges?.operations ?? []
    return {
      staged: joinAgentMeta(buckets.staged, ops),
      unmerged: joinAgentMeta(buckets.unmerged, ops),
      unstaged: joinAgentMeta(buckets.unstaged, ops),
    }
  }, [status, agentChanges])

  const selectedFile = useMemo(
    () => (selectedKey ? [...unmerged, ...staged, ...unstaged].find((f) => fileKey(f) === selectedKey) : undefined),
    [selectedKey, staged, unmerged, unstaged],
  )

  const busy =
    addMutation.isPending ||
    resetMutation.isPending ||
    commitMutation.isPending ||
    pushMutation.isPending ||
    pullMutation.isPending ||
    mergeAbortMutation.isPending ||
    mergeContinueMutation.isPending

  if (isLoading) {
    return (
      <div className="flex h-full items-center justify-center">
        <LoaderCircle className="text-muted-foreground size-5 animate-spin" />
      </div>
    )
  }

  if (!status?.initialized) {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-4">
        <div className="flex flex-col items-center gap-1 text-center">
          <h2 className="text-foreground text-lg font-semibold">Version control not initialized</h2>
          <p className="text-muted-foreground text-sm">Initialize to start tracking changes in this project.</p>
        </div>
        <InitializeVcButton />
      </div>
    )
  }

  const groupPendingByTask = (files: ChangeFile[]): Map<string, string[]> => {
    const byTask = new Map<string, string[]>()
    for (const f of files) {
      if (f.agentMeta?.reviewStatus !== 'pending') continue
      const arr = byTask.get(f.agentMeta.taskId) ?? []
      arr.push(f.path)
      byTask.set(f.agentMeta.taskId, arr)
    }

    return byTask
  }

  const decidePendingFiles = async (files: ChangeFile[], decision: 'approved' | 'rejected') => {
    const byTask = groupPendingByTask(files)
    if (byTask.size === 0) return
    await Promise.all(
      [...byTask.entries()].map(([taskId, filePaths]) =>
        runAction(
          reviewDecideMutation.mutateAsync({ decision, filePaths, taskId }),
          decision === 'approved' ? 'Failed to approve agent edits' : 'Failed to reject agent edits',
        ),
      ),
    )
  }

  const handleStageFile = async (file: ChangeFile) => {
    try {
      await addMutation.mutateAsync({ filePaths: [file.path] })
    } catch (error) {
      toast.error(formatError(error, 'Failed to stage file'))
      return
    }

    await decidePendingFiles([file], 'approved')
  }

  const handleUnstageFile = (file: ChangeFile) =>
    runAction(resetMutation.mutateAsync({ filePaths: [file.path] }), 'Failed to unstage file')

  const handleStageAll = async () => {
    if (unstaged.length === 0) return
    const filePaths = unstaged.map((f) => f.path)
    try {
      await addMutation.mutateAsync({ filePaths })
    } catch (error) {
      toast.error(formatError(error, 'Failed to stage all'))
      return
    }

    await decidePendingFiles(unstaged, 'approved')
  }

  const stageMergeFiles = (paths: string[]) =>
    runAction(addMutation.mutateAsync({ filePaths: paths }), 'Failed to stage')

  const handleStageMergeAll = () => stageMergeFiles(unmerged.map((f) => f.path))

  const handleAbortMerge = async () => {
    try {
      await mergeAbortMutation.mutateAsync()
      toast.success('Merge aborted')
    } catch (error) {
      toast.error(formatError(error, 'Failed to abort merge'))
    }
  }

  const handleUnstageAll = () => runAction(resetMutation.mutateAsync({}), 'Failed to unstage all')

  const doCommit = async (message: string): Promise<boolean> => {
    try {
      await commitMutation.mutateAsync({ message })
      toast.success('Committed')
      return true
    } catch (error) {
      toastVcError(error, 'Failed to commit', navigate, {projectPath: selectedProject})
      return false
    }
  }

  const continueMerge = async (message: string): Promise<boolean> => {
    try {
      await mergeContinueMutation.mutateAsync({ message })
      toast.success('Merge committed')
      return true
    } catch (error) {
      toastVcError(error, 'Failed to commit merge', navigate, {projectPath: selectedProject})
      return false
    }
  }

  const handleCommit = async () => {
    const message = commitMessage.trim()
    if (!message) return

    // During a merge, route through `vc:merge --continue` so the server's
    // unmerged-files guard runs (handleCommit doesn't have it).
    if (status.mergeInProgress) {
      const ok = await continueMerge(message)
      if (ok) setCommitMessage('')
      return
    }

    if (staged.length === 0 && unstaged.length > 0) {
      setShowStageAllConfirm(true)
      return
    }

    const committed = await doCommit(message)
    if (committed) setCommitMessage('')
  }

  const handleStageAllAndCommit = async () => {
    const message = commitMessage.trim()
    if (!message) return
    try {
      await addMutation.mutateAsync({})
      const committed = await doCommit(message)
      if (committed) {
        setCommitMessage('')
        setShowStageAllConfirm(false)
      }
    } catch (error) {
      toastVcError(error, 'Failed to stage & commit', navigate, {projectPath: selectedProject})
    }
  }

  const handlePush = async () => {
    try {
      const result = await pushMutation.mutateAsync({ setUpstream: !status.trackingBranch })
      toast.success(result.alreadyUpToDate ? 'Already up to date' : `Pushed ${result.branch}`)
    } catch (error) {
      toastVcError(error, 'Failed to push', navigate)
    }
  }

  const handlePull = async () => {
    try {
      const result = await pullMutation.mutateAsync({})
      if (result.conflicts && result.conflicts.length > 0) {
        toast.error(`Pull had conflicts in ${result.conflicts.length} file(s)`)
      } else {
        toast.success(result.alreadyUpToDate ? 'Already up to date' : `Pulled ${result.branch}`)
      }
    } catch (error) {
      toastVcError(error, 'Failed to pull', navigate)
    }
  }

  const handleSelectFile = (file: ChangeFile) => {
    setSelectedKey(fileKey(file))
    setViewMode('single')
  }

  const isFileSelected = (file: ChangeFile) => fileKey(file) === selectedKey && viewMode === 'single'

  const handleOpenStagedChanges = () => setViewMode('multi-staged')
  const handleOpenChanges = () => setViewMode('multi-unstaged')

  const handleOpenInContext = (file: ChangeFile) => {
    navigate(`/contexts?path=${encodeURIComponent(file.path)}`)
  }

  const handleStageToggle = (file: ChangeFile) => (file.isStaged ? handleUnstageFile(file) : handleStageFile(file))

  const handleDiscardFile = async (file: ChangeFile) => {
    if (file.agentMeta?.reviewStatus === 'pending') {
      await decidePendingFiles([file], 'rejected')
      return
    }

    setDiscardTargets([file])
  }

  const handleDiscardAll = async () => {
    if (unstaged.length === 0) return
    const pending = unstaged.filter((f) => f.agentMeta?.reviewStatus === 'pending')
    const others = unstaged.filter((f) => f.agentMeta?.reviewStatus !== 'pending')
    if (pending.length > 0) await decidePendingFiles(pending, 'rejected')
    if (others.length > 0) setDiscardTargets(others)
  }

  const hasAnyChanges = staged.length + unstaged.length + unmerged.length > 0

  return (
    <div className="flex h-full w-full">
      <aside className="border-border flex h-full w-80 shrink-0 flex-col gap-2">
        <BranchBar
          ahead={status.ahead}
          behind={status.behind}
          branch={status.branch}
          hasTracking={Boolean(status.trackingBranch)}
          isAborting={mergeAbortMutation.isPending}
          isAuthenticated={isAuthenticated}
          isPulling={pullMutation.isPending}
          isPushing={pushMutation.isPending}
          mergeInProgress={status.mergeInProgress}
          onAbortMerge={handleAbortMerge}
          onPull={handlePull}
          onPush={handlePush}
        />

        <CommitInput
          canCommit={staged.length > 0 || unstaged.length > 0}
          isCommitting={commitMutation.isPending}
          message={commitMessage}
          onCommit={handleCommit}
          onMessageChange={setCommitMessage}
        />

        <div className="flex min-h-0 flex-1 flex-col gap-2 overflow-y-auto">
          <FileList
            disabled={busy}
            files={unmerged}
            isFileSelected={isFileSelected}
            label="Merge Changes"
            onFileAction={handleStageFile}
            onFileSelect={handleSelectFile}
            onGroupAction={handleStageMergeAll}
            variant="stage"
          />
          <FileList
            disabled={busy}
            files={staged}
            isFileSelected={isFileSelected}
            label="Staged Changes"
            onFileAction={handleUnstageFile}
            onFileSelect={handleSelectFile}
            onGroupAction={handleUnstageAll}
            onOpenAll={handleOpenStagedChanges}
            openAllLabel="Open all staged changes"
            variant="unstage"
          />
          <FileList
            disabled={busy}
            files={unstaged}
            isFileSelected={isFileSelected}
            label="Changes"
            onDiscardFile={handleDiscardFile}
            onDiscardGroup={handleDiscardAll}
            onFileAction={handleStageFile}
            onFileSelect={handleSelectFile}
            onGroupAction={handleStageAll}
            onOpenAll={handleOpenChanges}
            openAllLabel="Open all changes"
            variant="stage"
          />
        </div>
      </aside>

      <main className="flex h-full flex-1 flex-col overflow-hidden pl-4">
        {viewMode === 'multi-staged' && (
          <MultiDiffView
            emptyMessage="No staged changes"
            files={staged}
            onOpenFile={handleOpenInContext}
            onStageToggle={handleStageToggle}
            side="staged"
            title="Staged Changes"
          />
        )}
        {viewMode === 'multi-unstaged' && (
          <MultiDiffView
            emptyMessage="No changes"
            files={unstaged}
            onOpenFile={handleOpenInContext}
            onStageToggle={handleStageToggle}
            side="unstaged"
            title="Changes"
          />
        )}
        {viewMode === 'single' &&
          (selectedFile ? (
            <DiffView file={selectedFile} onOpenFile={handleOpenInContext} onStageToggle={handleStageToggle} />
          ) : hasAnyChanges ? (
            <div className="bg-card text-secondary-foreground flex h-full flex-col items-center justify-center gap-3 rounded-md text-sm">
              <FileText className="size-8" strokeWidth={1.25} />
              <p>Select a file to view changes</p>
            </div>
          ) : (
            <div className="flex h-full flex-col items-center justify-center rounded-md bg-card">
              <img alt="" className="size-30 mb-6" src={successTick} />
              <div className="flex flex-col items-center gap-1 text-center mb-5">
                <p className="text-foreground text-base font-medium">No changes detected</p>
                <p className="text-muted-foreground max-w-xs text-xs">
                  Your workspace is up to date. Any modifications to your files will appear here.
                </p>
              </div>
              <Button className="w-37" disabled={isFetching} onClick={() => refetch()} variant="secondary">
                Refresh
              </Button>
            </div>
          ))}
      </main>

      <DiscardChangesDialog
        files={discardTargets ?? []}
        onOpenChange={(open) => {
          if (!open) setDiscardTargets(undefined)
        }}
        open={discardTargets !== undefined && discardTargets.length > 0}
      />

      <StageAllAndCommitDialog
        isCommitting={addMutation.isPending || commitMutation.isPending}
        onConfirm={handleStageAllAndCommit}
        onOpenChange={setShowStageAllConfirm}
        open={showStageAllConfirm}
      />
    </div>
  )
}
