import type {ComponentRef} from 'react'

import type {StoredTask} from '../types/stored-task'

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
      task?.status,
    ],
    isActive,
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
      <div
        className="flex min-h-0 flex-1 flex-col gap-7 overflow-y-auto px-6 py-5"
        data-stick-to-bottom
        onScroll={onScroll}
        ref={scrollRef}
      >
        <InputSection task={task} />
        <EventLogSection now={now} task={task} />
        {showLive && <LiveStreamSection task={task} />}
        {result && <ResultSection content={result} taskType={task.type} />}
        {error && <ErrorSection task={task} />}
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
