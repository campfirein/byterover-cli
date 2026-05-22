import type {ComponentRef} from 'react'

import type {StoredTask} from '../types/stored-task'

import {TourTaskBanner, TourTaskContinueCta} from '../../onboarding/components/tour-task-banner'
import {useOnboardingStore} from '../../onboarding/stores/onboarding-store'
import {useGetTaskDetail} from '../api/get-task'
import {useStickToBottom} from '../hooks/use-stick-to-bottom'
import {useTickingNow} from '../hooks/use-ticking-now'
import {useTaskById} from '../stores/task-store'
import {taskHistoryEntryToStoredTask} from '../utils/task-history-entry-to-stored-task'
import {isActiveStatus} from '../utils/task-status'
import {EventLogSection} from './task-detail-event-log'
import {DetailHeader} from './task-detail-header'
import {ErrorSection, InputSection, LiveStreamSection, NotFound, ResultSection} from './task-detail-sections'

interface TaskDetailViewProps {
  cancelling: boolean
  onCancel: (taskId: string) => void
  taskId: string
}

function hasRichDetail(task: StoredTask | undefined): boolean {
  if (!task) return false
  if (task.responseContent && task.responseContent.length > 0) return true
  if (task.toolCalls && task.toolCalls.length > 0) return true
  return false
}

// eslint-disable-next-line complexity
export function TaskDetailView({cancelling, onCancel, taskId}: TaskDetailViewProps) {
  const storeTask = useTaskById(taskId)
  const isLiveInStore = storeTask !== undefined && isActiveStatus(storeTask.status)
  const needsFetch = !hasRichDetail(storeTask) && !isLiveInStore

  const {data, isLoading} = useGetTaskDetail({enabled: needsFetch, taskId})

  const fetched: StoredTask | undefined = data?.task ? taskHistoryEntryToStoredTask(data.task) : undefined
  const task: StoredTask | undefined = needsFetch ? fetched ?? storeTask : storeTask
  const isActive = task ? isActiveStatus(task.status) : false
  const now = useTickingNow(isActive)

  const tourTaskId = useOnboardingStore((s) => s.tourTaskId)
  const isTourTask = tourTaskId === taskId

  const lastReasoning = task?.reasoningContents?.at(-1)
  const {onScroll, ref: scrollRef} = useStickToBottom<ComponentRef<'div'>>(
    [
      task?.toolCalls?.length ?? 0,
      task?.reasoningContents?.length ?? 0,
      lastReasoning?.content?.length ?? 0,
      task?.streamingContent?.length ?? 0,
      task?.responseContent,
      task?.result,
      task?.error?.message,
      // Include status so the active → terminal transition (which is when the
      // Result/Error sections + tour Continue CTA appear) re-runs the effect
      // and snaps the user to the new bottom if they were already there.
      task?.status,
    ],
    // Stay enabled for the tour task even after it terminates, so the final
    // scroll picks up the Continue CTA at the bottom of the detail.
    isActive || isTourTask,
  )

  if (needsFetch && isLoading) {
    return <DetailLoading />
  }

  if (needsFetch && data && data.task === null) {
    return <NotFound taskId={taskId} />
  }

  if (!task) {
    return <NotFound taskId={taskId} />
  }

  // Live and Result are mutually exclusive (TUI convention).
  const showLive = isActive && (task.streamingContent || task.responseContent)
  const result = task.status === 'completed' ? task.result : undefined
  const error = task.status === 'error' ? task.error : undefined

  return (
    <div className="flex h-full min-h-0 flex-col">
      <DetailHeader cancelling={cancelling} now={now} onCancel={onCancel} task={task} />
      <div className="border-border/50 border-t" />
      <div className="flex min-h-0 flex-1 flex-col gap-7 overflow-y-auto px-6 py-5" onScroll={onScroll} ref={scrollRef}>
        <TourTaskBanner task={task} />
        <InputSection task={task} />
        <EventLogSection now={now} task={task} />
        {showLive && <LiveStreamSection task={task} />}
        {result && <ResultSection content={result} />}
        {error && <ErrorSection task={task} />}
        <TourTaskContinueCta task={task} />
      </div>
    </div>
  )
}

function DetailLoading() {
  return (
    <div className="text-muted-foreground flex h-full items-center justify-center text-sm" role="status">
      Loading task…
    </div>
  )
}
