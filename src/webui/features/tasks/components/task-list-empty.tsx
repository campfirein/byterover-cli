import type {ReactNode} from 'react'

import {Button} from '@campfirein/byterover-packages/components/button'
import {Card} from '@campfirein/byterover-packages/components/card'
import {cn} from '@campfirein/byterover-packages/lib/utils'
import {ListTodo} from 'lucide-react'

import type {StatusFilter} from '../stores/task-store'

import {STATUS_LABEL} from './task-list-filter-bar'

export function PlaceholderCard({children, withDots}: {children: ReactNode; withDots?: boolean}) {
  return (
    <Card
      className={cn(
        'ring-border/80 flex min-h-0 flex-1 items-center justify-center p-0',
        withDots && 'dot-grid',
      )}
      size="sm"
    >
      {children}
    </Card>
  )
}

export function LoadingState() {
  return <div className="text-muted-foreground flex h-32 items-center justify-center text-sm">Loading tasks…</div>
}

export function EmptyState({
  hasActiveFilters,
  onClearFilters,
}: {
  hasActiveFilters?: boolean
  onClearFilters?: () => void
}) {
  if (hasActiveFilters) {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-4 p-8 text-center">
        <ListTodo className="text-muted-foreground/70 size-8" />
        <div>
          <h2 className="text-foreground text-base font-medium">No matching tasks</h2>
          <p className="text-muted-foreground mx-auto mt-1 max-w-sm text-sm leading-relaxed">
            No tasks match the current filters. Try adjusting or clearing them.
          </p>
        </div>
        {onClearFilters && (
          <Button className="cursor-pointer" onClick={onClearFilters} size="sm" variant="outline">
            Clear filters
          </Button>
        )}
      </div>
    )
  }

  return (
    <div className="flex h-full flex-col items-center justify-center gap-4 p-8 text-center">
      <ListTodo className="text-muted-foreground/70 size-8" />
      <div>
        <h2 className="text-foreground text-base font-medium">No tasks yet</h2>
        <p className="text-muted-foreground mx-auto mt-1 max-w-sm text-sm leading-relaxed">
          Tasks appear here when your coding agent calls the ByteRover MCP tools to curate or query the context tree.
        </p>
      </div>
    </div>
  )
}

export function NoMatchState({
  onClearSearch,
  query,
  status,
}: {
  onClearSearch: () => void
  query: string
  status: StatusFilter
}) {
  return (
    <div className="text-muted-foreground flex h-32 flex-col items-center justify-center gap-2 p-4 text-sm">
      <span>
        No {status === 'all' ? '' : `${STATUS_LABEL[status].toLowerCase()} `}tasks
        {query ? ` match "${query}"` : ''}.
      </span>
      {query && (
        <Button onClick={onClearSearch} size="xs" variant="link">
          Clear search
        </Button>
      )}
    </div>
  )
}
