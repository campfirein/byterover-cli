import {Button} from '@campfirein/byterover-packages/components/button'
import {Sheet, SheetContent} from '@campfirein/byterover-packages/components/sheet'
import {useCallback, useEffect, useMemo, useState} from 'react'
import {useSearchParams} from 'react-router-dom'
import {toast} from 'sonner'

import type {ComposerType} from './task-composer-types'

import {useTransportStore} from '../../../stores/transport-store'
import {CURATE_EXAMPLE, QUERY_EXAMPLE, TOUR_STEP_LABEL} from '../../onboarding/lib/tour-examples'
import {useOnboardingStore} from '../../onboarding/stores/onboarding-store'
import {useGetProviders} from '../../provider/api/get-providers'
import {useCancelTask} from '../api/cancel-task'
import {useClearCompleted} from '../api/clear-completed'
import {useDeleteBulkTasks} from '../api/delete-bulk-tasks'
import {useDeleteTask} from '../api/delete-task'
import {useGetTasks} from '../api/get-tasks'
import {useDebouncedValue} from '../hooks/use-debounced-value'
import {useTaskFilterParams} from '../hooks/use-task-filter-params'
import {useTickingNow} from '../hooks/use-ticking-now'
import {useComposerRetryStore} from '../stores/composer-retry-store'
import {useTaskStore} from '../stores/task-store'
import {durationPresetToRange} from '../utils/duration-presets'
import {statusFilterToServer} from '../utils/status-filter-to-server'
import {isTerminalStatus} from '../utils/task-status'
import {TaskComposerSheet} from './task-composer'
import {TaskDetailView} from './task-detail-view'
import {TaskFilterTags} from './task-filter-tags'
import {BulkActionsBar} from './task-list-bulk-actions'
import {EmptyState, LoadingState, PlaceholderCard} from './task-list-empty'
import {FilterBar} from './task-list-filter-bar'
import {TaskListPagination} from './task-list-pagination'
import {TaskTable} from './task-list-table'

// eslint-disable-next-line complexity
export function TaskListView() {
  const [searchParams, setSearchParams] = useSearchParams()
  const selectedTaskId = searchParams.get('task') ?? undefined
  const openTask = (taskId: string) => {
    setSearchParams((prev) => {
      const next = new URLSearchParams(prev)
      next.set('task', taskId)
      return next
    })
  }

  const closeTask = useCallback(() => {
    setSearchParams((prev) => {
      const next = new URLSearchParams(prev)
      next.delete('task')
      return next
    })
  }, [setSearchParams])

  const projectPath = useTransportStore((s) => s.selectedProject)

  const clearCompleted = useTaskStore((s) => s.clearCompleted)
  const removeTask = useTaskStore((s) => s.removeTask)

  const {
    clearAllFilters,
    filters,
    setDurationPreset,
    setModelFilter,
    setPage,
    setPageSize,
    setProviderFilter,
    setSearchQuery,
    setStatusFilter,
    setTimeRange,
    setTypeFilter,
  } = useTaskFilterParams()
  const {data: providersResponse} = useGetProviders()
  const providers = providersResponse?.providers ?? []
  const providerNames = useMemo(
    () => new Map((providersResponse?.providers ?? []).map((p) => [p.id, p.name])),
    [providersResponse],
  )
  const {
    createdAfter,
    createdBefore,
    durationPreset,
    modelFilter,
    page,
    pageSize,
    providerFilter,
    searchQuery,
    statusFilter,
    typeFilter,
  } = filters

  const durationRange = useMemo(() => durationPresetToRange(durationPreset), [durationPreset])
  const debouncedSearch = useDebouncedValue(searchQuery, 300)

  const nonStatusFilters = useMemo(
    () => ({
      projectPath: projectPath || undefined,
      ...(typeFilter.length > 0 ? {type: typeFilter} : {}),
      ...(providerFilter.length > 0 ? {provider: providerFilter} : {}),
      ...(modelFilter.length > 0 ? {model: modelFilter} : {}),
      ...(createdAfter === undefined ? {} : {createdAfter}),
      ...(createdBefore === undefined ? {} : {createdBefore}),
      ...durationRange,
      ...(debouncedSearch.trim() ? {searchText: debouncedSearch.trim()} : {}),
    }),
    [projectPath, typeFilter, providerFilter, modelFilter, createdAfter, createdBefore, durationRange, debouncedSearch],
  )

  const serverStatus = useMemo(() => statusFilterToServer(statusFilter), [statusFilter])
  const {data, isLoading} = useGetTasks({
    page,
    pageSize,
    ...nonStatusFilters,
    ...(serverStatus ? {status: serverStatus} : {}),
  })

  const {data: countsData} = useGetTasks({page: 1, pageSize: 1, ...nonStatusFilters})

  const tasks = data?.tasks ?? []
  const breakdown = countsData?.counts ?? {all: 0, cancelled: 0, completed: 0, failed: 0, running: 0}
  const availableProviders = data?.availableProviders ?? []
  const availableModels = data?.availableModels ?? []
  const now = useTickingNow(breakdown.running > 0)
  const hasActiveFilters =
    statusFilter !== 'all' ||
    typeFilter.length > 0 ||
    providerFilter.length > 0 ||
    modelFilter.length > 0 ||
    createdAfter !== undefined ||
    createdBefore !== undefined ||
    durationPreset !== 'all' ||
    searchQuery.trim().length > 0

  const deleteMutation = useDeleteTask()
  const deleteBulkMutation = useDeleteBulkTasks()
  const clearCompletedMutation = useClearCompleted()
  const cancelMutation = useCancelTask()

  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set())
  const [cancellingIds, setCancellingIds] = useState<Set<string>>(new Set())
  const [composer, setComposer] = useState<{
    initialContent?: string
    initialType?: ComposerType
    open: boolean
  }>({open: false})

  const tourActive = useOnboardingStore((s) => s.tourActive)
  const tourStep = useOnboardingStore((s) => s.tourStep)
  const tourTaskId = useOnboardingStore((s) => s.tourTaskId)
  const setTourTaskId = useOnboardingStore((s) => s.setTourTaskId)
  const inComposerStep = tourStep === 'curate' || tourStep === 'query'
  const inTour = tourActive && inComposerStep
  const tourCueLabel =
    inTour && !tourTaskId
      ? tourStep === 'curate'
        ? 'Click to capture knowledge'
        : 'Click to ask a question'
      : undefined

  const openComposer = () => {
    if (inTour) {
      const example = tourStep === 'curate' ? CURATE_EXAMPLE : QUERY_EXAMPLE
      setComposer({initialContent: example, initialType: tourStep, open: true})
      return
    }

    setComposer({open: true})
  }

  const closeComposer = () => setComposer({open: false})

  const retrySeed = useComposerRetryStore((s) => s.seed)
  const consumeRetry = useComposerRetryStore((s) => s.consume)

  useEffect(() => {
    if (!retrySeed) return
    setComposer({initialContent: retrySeed.content, initialType: retrySeed.type, open: true})
    closeTask()
    consumeRetry()
  }, [retrySeed, consumeRetry, closeTask])

  const onComposerSubmitted = (taskId: string, openDetail: boolean) => {
    if (inTour) setTourTaskId(taskId)
    if (openDetail) openTask(taskId)
  }

  const taskMap = useMemo(() => new Map(tasks.map((task) => [task.taskId, task])), [tasks])

  const filtered = useMemo(
    () =>
      [...tasks].sort((a, b) => {
        const aActive = isTerminalStatus(a.status) ? 1 : 0
        const bActive = isTerminalStatus(b.status) ? 1 : 0
        if (aActive !== bActive) return aActive - bActive
        const aRef = a.completedAt ?? a.startedAt ?? a.createdAt
        const bRef = b.completedAt ?? b.startedAt ?? b.createdAt
        return bRef - aRef
      }),
    [tasks],
  )

  const allFilteredSelected = filtered.length > 0 && filtered.every((task) => selectedIds.has(task.taskId))
  const someSelected = selectedIds.size > 0
  const finishedCount = breakdown.completed + breakdown.failed + breakdown.cancelled

  const canBulkDelete = useMemo(() => {
    for (const id of selectedIds) {
      const task = taskMap.get(id)
      if (task && isTerminalStatus(task.status)) return true
    }

    return false
  }, [selectedIds, taskMap])

  const toggleSelect = (taskId: string) => {
    setSelectedIds((prev) => {
      const next = new Set(prev)
      if (next.has(taskId)) next.delete(taskId)
      else next.add(taskId)
      return next
    })
  }

  const toggleSelectAll = () => {
    setSelectedIds((prev) => {
      if (allFilteredSelected) return new Set()
      const next = new Set(prev)
      for (const task of filtered) next.add(task.taskId)
      return next
    })
  }

  const clearSelection = () => setSelectedIds(new Set())

  const handleDelete = (taskId: string) => {
    deleteMutation.mutate(
      {taskId},
      {
        onError: (err) => toast.error(err.message),
        onSuccess: () => removeTask(taskId),
      },
    )
  }

  const handleCancel = (taskId: string) => {
    setCancellingIds((prev) => {
      const next = new Set(prev)
      next.add(taskId)
      return next
    })
    const clear = () => {
      setCancellingIds((prev) => {
        if (!prev.has(taskId)) return prev
        const next = new Set(prev)
        next.delete(taskId)
        return next
      })
    }

    cancelMutation.mutate(
      {taskId},
      {
        onError(err) {
          toast.error(err.message)
          clear()
        },
        onSuccess: clear,
      },
    )
  }

  const deleteSelected = () => {
    const eligibleIds = [...selectedIds].filter((id) => {
      const task = taskMap.get(id)
      return task !== undefined && isTerminalStatus(task.status)
    })
    if (eligibleIds.length === 0) {
      clearSelection()
      return
    }

    deleteBulkMutation.mutate(
      {taskIds: eligibleIds},
      {
        onError: (err) => toast.error(err.message),
        onSuccess() {
          for (const id of eligibleIds) removeTask(id)
          clearSelection()
        },
      },
    )
  }

  const handleClearCompleted = () => {
    clearCompletedMutation.mutate(projectPath ? {projectPath} : {}, {
      onError: (err) => toast.error(err.message),
      onSuccess: () => clearCompleted(),
    })
  }

  return (
    <div className="mx-auto flex h-full w-full min-h-0 max-w-7xl flex-col gap-3">
      {someSelected ? (
        <BulkActionsBar
          canDelete={canBulkDelete}
          count={selectedIds.size}
          onClear={clearSelection}
          onDelete={deleteSelected}
        />
      ) : (
        <FilterBar
          availableModels={availableModels}
          availableProviders={availableProviders}
          breakdown={breakdown}
          createdAfter={createdAfter}
          createdBefore={createdBefore}
          durationPreset={durationPreset}
          modelFilter={modelFilter}
          onDurationChange={(next) => {
            setDurationPreset(next)
            clearSelection()
          }}
          onModelChange={(next) => {
            setModelFilter(next)
            clearSelection()
          }}
          onNewTask={openComposer}
          onProviderChange={(next) => {
            setProviderFilter(next)
            clearSelection()
          }}
          onSearchChange={setSearchQuery}
          onStatusChange={(filter) => {
            setStatusFilter(filter)
            clearSelection()
          }}
          onTimeRangeChange={(next) => {
            setTimeRange(next)
            clearSelection()
          }}
          onTypeChange={(next) => {
            setTypeFilter(next)
            clearSelection()
          }}
          providerFilter={providerFilter}
          providers={providers}
          searchQuery={searchQuery}
          statusFilter={statusFilter}
          tourCue={tourCueLabel && tasks.length > 0 ? tourCueLabel : undefined}
          typeFilter={typeFilter}
        />
      )}

      <TaskFilterTags
        createdAfter={createdAfter}
        createdBefore={createdBefore}
        durationPreset={durationPreset}
        modelFilter={modelFilter}
        onClearAll={clearAllFilters}
        onDurationChange={setDurationPreset}
        onModelChange={setModelFilter}
        onProviderChange={setProviderFilter}
        onSearchChange={setSearchQuery}
        onStatusChange={setStatusFilter}
        onTimeRangeChange={setTimeRange}
        onTypeChange={setTypeFilter}
        providerFilter={providerFilter}
        providers={providers}
        searchQuery={searchQuery}
        statusFilter={statusFilter}
        typeFilter={typeFilter}
      />

      {isLoading ? (
        <PlaceholderCard>
          <LoadingState />
        </PlaceholderCard>
      ) : tasks.length === 0 ? (
        <PlaceholderCard withDots>
          <EmptyState
            hasActiveFilters={hasActiveFilters}
            onClearFilters={clearAllFilters}
            onNewTask={openComposer}
            tourCue={tourCueLabel}
          />
        </PlaceholderCard>
      ) : (
        <TaskTable
          allSelected={allFilteredSelected}
          cancellingIds={cancellingIds}
          filtered={filtered}
          now={now}
          onCancel={handleCancel}
          onClearSearch={() => setSearchQuery('')}
          onDelete={handleDelete}
          onRowClick={openTask}
          onToggleSelect={toggleSelect}
          onToggleSelectAll={toggleSelectAll}
          providerNames={providerNames}
          searchQuery={searchQuery}
          selectedIds={selectedIds}
          statusFilter={statusFilter}
        />
      )}

      {(data || finishedCount > 0) && (
        <div className="flex items-center justify-between gap-3 px-1">
          {data ? (
            <TaskListPagination
              onPageChange={setPage}
              onPageSizeChange={setPageSize}
              page={data.page}
              pageCount={data.pageCount}
              pageSize={data.pageSize}
              total={data.total}
            />
          ) : (
            <span />
          )}
          {finishedCount > 0 && (
            <Button onClick={handleClearCompleted} size="xs" variant="ghost">
              Clear finished ({finishedCount})
            </Button>
          )}
        </div>
      )}

      <Sheet onOpenChange={(open) => !open && closeTask()} open={Boolean(selectedTaskId)}>
        <SheetContent
          className="data-[side=right]:w-full data-[side=right]:max-w-3xl p-0 shadow-[inset_1px_0_0_rgba(96,165,250,0.18)]"
          side="right"
        >
          {selectedTaskId && (
            <TaskDetailView
              cancelling={cancellingIds.has(selectedTaskId)}
              onCancel={handleCancel}
              taskId={selectedTaskId}
            />
          )}
        </SheetContent>
      </Sheet>

      <TaskComposerSheet
        initialContent={composer.initialContent}
        initialType={composer.initialType}
        onClose={closeComposer}
        onSubmitted={onComposerSubmitted}
        open={composer.open}
        prefillNotice={inTour ? 'example' : undefined}
        tourStepLabel={inTour ? TOUR_STEP_LABEL[tourStep] : undefined}
      />
    </div>
  )
}
