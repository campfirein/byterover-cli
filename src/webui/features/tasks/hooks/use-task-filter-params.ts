import {useCallback, useMemo} from 'react'
import {useSearchParams} from 'react-router-dom'

import {type StatusFilter} from '../stores/task-store'
import {type DurationPreset, isDurationPreset} from '../utils/duration-presets'

export interface TaskFilters {
  createdAfter?: number
  createdBefore?: number
  durationPreset: DurationPreset
  page: number
  pageSize: number
  searchQuery: string
  statusFilter: StatusFilter
  typeFilter: string[]
}

const STATUS_VALUES = new Set<string>(['all', 'cancelled', 'completed', 'failed', 'running'])
const DEFAULT_PAGE_SIZE = 20

const FILTER_PARAM_KEYS = ['status', 'types', 'from', 'to', 'duration', 'q', 'page', 'pageSize'] as const

function isStatusFilter(value: null | string): value is StatusFilter {
  return value !== null && STATUS_VALUES.has(value)
}

export function useTaskFilterParams(): {
  clearAllFilters: () => void
  filters: TaskFilters
  setDurationPreset: (preset: DurationPreset) => void
  setPage: (page: number) => void
  setPageSize: (pageSize: number) => void
  setSearchQuery: (query: string) => void
  setStatusFilter: (filter: StatusFilter) => void
  setTimeRange: (range: {createdAfter?: number; createdBefore?: number}) => void
  setTypeFilter: (next: string[]) => void
} {
  const [params, setParams] = useSearchParams()
  const filters = useMemo(() => parseFilters(params), [params])

  const update = useCallback(
    (updates: Record<string, null | string | string[]>, resetPage = true) => {
      setParams((prev) => {
        const next = new URLSearchParams(prev)
        for (const [key, value] of Object.entries(updates)) {
          if (value === null || value === '' || (Array.isArray(value) && value.length === 0)) {
            next.delete(key)
          } else if (Array.isArray(value)) {
            next.set(key, value.join(','))
          } else {
            next.set(key, value)
          }
        }

        if (resetPage) next.delete('page')
        return next
      })
    },
    [setParams],
  )

  const setters = useMemo(
    () => ({
      clearAllFilters() {
        setParams((prev) => {
          const next = new URLSearchParams(prev)
          for (const key of FILTER_PARAM_KEYS) next.delete(key)
          return next
        })
      },
      setDurationPreset(preset: DurationPreset) {
        update({duration: preset === 'all' ? null : preset})
      },
      setPage(page: number) {
        update({page: page === 1 ? null : String(page)}, false)
      },
      setPageSize(pageSize: number) {
        update({pageSize: pageSize === DEFAULT_PAGE_SIZE ? null : String(pageSize)})
      },
      setSearchQuery(query: string) {
        update({q: query})
      },
      setStatusFilter(filter: StatusFilter) {
        update({status: filter === 'all' ? null : filter})
      },
      setTimeRange(range: {createdAfter?: number; createdBefore?: number}) {
        update({
          from: range.createdAfter === undefined ? null : String(range.createdAfter),
          to: range.createdBefore === undefined ? null : String(range.createdBefore),
        })
      },
      setTypeFilter(next: string[]) {
        update({types: next})
      },
    }),
    [update, setParams],
  )

  return {filters, ...setters}
}

function parseFilters(params: URLSearchParams): TaskFilters {
  const status = params.get('status')
  const duration = params.get('duration')
  const pageRaw = params.get('page')
  const pageSizeRaw = params.get('pageSize')
  const fromRaw = params.get('from')
  const toRaw = params.get('to')
  return {
    durationPreset: duration !== null && isDurationPreset(duration) ? duration : 'all',
    page: pageRaw ? Math.max(1, Number.parseInt(pageRaw, 10) || 1) : 1,
    pageSize: pageSizeRaw ? Math.max(1, Number.parseInt(pageSizeRaw, 10) || DEFAULT_PAGE_SIZE) : DEFAULT_PAGE_SIZE,
    searchQuery: params.get('q') ?? '',
    statusFilter: isStatusFilter(status) ? status : 'all',
    typeFilter: parseList(params.get('types')),
    ...(fromRaw && Number.isFinite(Number(fromRaw)) ? {createdAfter: Number(fromRaw)} : {}),
    ...(toRaw && Number.isFinite(Number(toRaw)) ? {createdBefore: Number(toRaw)} : {}),
  }
}

function parseList(raw: null | string): string[] {
  if (!raw) return []
  return raw.split(',').filter(Boolean)
}
