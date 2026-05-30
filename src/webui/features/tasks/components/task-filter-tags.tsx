import {Tag} from '@campfirein/byterover-packages/components/tag/tag'
import {X} from 'lucide-react'
import {useMemo} from 'react'

import type {StatusFilter} from '../stores/task-store'
import type {DurationPreset} from '../utils/duration-presets'

import {durationPresetLabel} from '../utils/duration-presets'
import {formatTimeRangeLabel} from '../utils/time-presets'
import {STATUS_LABEL} from './task-list-filter-bar'

const TYPE_LABEL: Record<string, string> = {
  curate: 'Curate',
  query: 'Query',
}

export interface TaskFilterTagsProps {
  createdAfter?: number
  createdBefore?: number
  durationPreset: DurationPreset
  onClearAll: () => void
  onDurationChange: (preset: DurationPreset) => void
  onSearchChange: (query: string) => void
  onStatusChange: (filter: StatusFilter) => void
  onTimeRangeChange: (range: {createdAfter?: number; createdBefore?: number}) => void
  onTypeChange: (next: string[]) => void
  searchQuery: string
  statusFilter: StatusFilter
  typeFilter: string[]
}

export function TaskFilterTags({
  createdAfter,
  createdBefore,
  durationPreset,
  onClearAll,
  onDurationChange,
  onSearchChange,
  onStatusChange,
  onTimeRangeChange,
  onTypeChange,
  searchQuery,
  statusFilter,
  typeFilter,
}: TaskFilterTagsProps) {
  const tags = useMemo(() => {
    const result: Array<{key: string; label: string; onRemove: () => void}> = []

    if (statusFilter !== 'all') {
      result.push({
        key: `status:${statusFilter}`,
        label: `Status: ${STATUS_LABEL[statusFilter]}`,
        onRemove: () => onStatusChange('all'),
      })
    }

    for (const value of typeFilter) {
      result.push({
        key: `type:${value}`,
        label: `Type: ${TYPE_LABEL[value] ?? value}`,
        onRemove: () => onTypeChange(typeFilter.filter((v) => v !== value)),
      })
    }

    if (createdAfter !== undefined || createdBefore !== undefined) {
      result.push({
        key: 'time',
        label: `Time: ${formatTimeRangeLabel({createdAfter, createdBefore})}`,
        onRemove: () => onTimeRangeChange({}),
      })
    }

    if (durationPreset !== 'all') {
      result.push({
        key: `duration:${durationPreset}`,
        label: `Duration: ${durationPresetLabel(durationPreset)}`,
        onRemove: () => onDurationChange('all'),
      })
    }

    if (searchQuery.trim()) {
      result.push({
        key: 'search',
        label: `“${searchQuery.trim()}”`,
        onRemove: () => onSearchChange(''),
      })
    }

    return result
  }, [
    statusFilter,
    typeFilter,
    createdAfter,
    createdBefore,
    durationPreset,
    searchQuery,
    onStatusChange,
    onTypeChange,
    onTimeRangeChange,
    onDurationChange,
    onSearchChange,
  ])

  if (tags.length === 0) return null

  return (
    <div className="flex flex-wrap items-center gap-1.5 px-1">
      {tags.map((tag) => (
        <Tag closable key={tag.key} onClose={tag.onRemove} variant="secondary">
          {tag.label}
        </Tag>
      ))}
      <button
        className="text-muted-foreground hover:text-foreground inline-flex cursor-pointer items-center gap-1 px-1.5 py-0.5 text-xs transition"
        onClick={onClearAll}
        type="button"
      >
        <X className="size-3" />
        Clear filters
      </button>
    </div>
  )
}
