import {Badge} from '@campfirein/byterover-packages/components/badge'
import {Button} from '@campfirein/byterover-packages/components/button'
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@campfirein/byterover-packages/components/table'
import {Tooltip, TooltipContent, TooltipTrigger} from '@campfirein/byterover-packages/components/tooltip'
import {cn} from '@campfirein/byterover-packages/lib/utils'
import {CircleStop, LoaderCircle, Trash2} from 'lucide-react'

import type {StatusFilter} from '../stores/task-store'
import type {StoredTask} from '../types/stored-task'

import {curateHtmlDirectRowTitle, isCurateHtmlDirectType} from '../utils/curate-tool-mode'
import {getCurrentActivity} from '../utils/current-activity'
import {formatDuration, formatRelative, formatTimeOfDay, shortTaskId} from '../utils/format-time'
import {isInterrupted} from '../utils/is-interrupted'
import {rowActionKind} from '../utils/row-action-kind'
import {displayTaskType, isTerminalStatus} from '../utils/task-status'
import {StatusPill} from './status-pill'
import {NoMatchState} from './task-list-empty'

const COL = {
  action: 'w-12', // 48px — kebab/X
  checkbox: 'w-10', // 40px
  duration: 'w-24', // 96px
  id: 'w-36', // 144px
  // Flexible column — fills the remaining space but never below ~288px so the
  // input + activity line stay readable on narrow viewports.
  input: 'min-w-72',
  started: 'w-28', // 112px
  status: 'w-36', // 144px
  type: 'w-24', // 96px
} as const

function durationOf(task: StoredTask, now: number): string {
  if (task.completedAt && task.startedAt) return formatDuration(task.completedAt - task.startedAt)
  if (task.startedAt) return formatDuration(now - task.startedAt)
  if (task.completedAt) return formatDuration(task.completedAt - task.createdAt)
  return formatDuration(now - task.createdAt)
}

interface TaskTableProps {
  allSelected: boolean
  cancellingIds: Set<string>
  filtered: StoredTask[]
  now: number
  onCancel: (taskId: string) => void
  onClearSearch: () => void
  onDelete: (taskId: string) => void
  onRowClick: (taskId: string) => void
  onToggleSelect: (taskId: string) => void
  onToggleSelectAll: () => void
  searchQuery: string
  selectedIds: Set<string>
  statusFilter: StatusFilter
}

export function TaskTable({
  allSelected,
  cancellingIds,
  filtered,
  now,
  onCancel,
  onClearSearch,
  onDelete,
  onRowClick,
  onToggleSelect,
  onToggleSelectAll,
  searchQuery,
  selectedIds,
  statusFilter,
}: TaskTableProps) {
  return (
    <Table>
      <TableHeader>
        <TableRow>
          <TableHead className={COL.checkbox}>
            <Checkbox checked={allSelected} onChange={onToggleSelectAll} />
          </TableHead>
          <TableHead className={cn(COL.id, 'text-xs tracking-wider')}>ID</TableHead>
          <TableHead className={cn(COL.type, 'text-xs tracking-wider')}>Type</TableHead>
          <TableHead className={cn(COL.input, 'text-xs tracking-wider')}>Input</TableHead>
          <TableHead className={cn(COL.status, 'text-xs tracking-wider')}>Status</TableHead>
          <TableHead className={cn(COL.started, 'text-right text-xs tracking-wider')}>Started</TableHead>
          <TableHead className={cn(COL.duration, 'text-right text-xs tracking-wider')}>Duration</TableHead>
          <TableHead className={COL.action} />
        </TableRow>
      </TableHeader>
      <TableBody>
        {filtered.length === 0 ? (
          <TableRow>
            <TableCell className="text-muted-foreground py-10 text-center text-sm" colSpan={8}>
              <NoMatchState onClearSearch={onClearSearch} query={searchQuery} status={statusFilter} />
            </TableCell>
          </TableRow>
        ) : (
          filtered.map((task) => (
            <TaskRow
              cancelling={cancellingIds.has(task.taskId)}
              isSelected={selectedIds.has(task.taskId)}
              key={task.taskId}
              now={now}
              onCancel={onCancel}
              onDelete={onDelete}
              onRowClick={onRowClick}
              onToggleSelect={onToggleSelect}
              task={task}
            />
          ))
        )}
      </TableBody>
    </Table>
  )
}

function TaskRow({
  cancelling,
  isSelected,
  now,
  onCancel,
  onDelete,
  onRowClick,
  onToggleSelect,
  task,
}: {
  cancelling: boolean
  isSelected: boolean
  now: number
  onCancel: (taskId: string) => void
  onDelete: (taskId: string) => void
  onRowClick: (taskId: string) => void
  onToggleSelect: (taskId: string) => void
  task: StoredTask
}) {
  const terminal = isTerminalStatus(task.status)
  const isRunning = !terminal
  const interrupted = isInterrupted(task)
  const activity = getCurrentActivity(task)
  // For curate-tool-mode, task.content is a JSON blob — decode it so the
  // row shows the user's intent (CLI) or topic path (MCP) instead.
  const displayInput = isCurateHtmlDirectType(task.type) ? curateHtmlDirectRowTitle(task.content) : task.content
  const actionKind = rowActionKind(task.status)

  const row = (
    <TableRow
      className={cn('cursor-pointer [&>td]:align-middle', {'opacity-60': interrupted})}
      data-state={isSelected ? 'selected' : undefined}
      onClick={() => onRowClick(task.taskId)}
    >
      <TableCell className="relative" onClick={(event) => event.stopPropagation()}>
        {isRunning && (
          <span className="bg-blue-400/70 pointer-events-none absolute top-2 bottom-2 left-0 w-0.5 rounded-full" />
        )}
        <Checkbox checked={isSelected} onChange={() => onToggleSelect(task.taskId)} />
      </TableCell>
      <TableCell className="text-identifier mono text-xs" title={task.taskId}>
        {shortTaskId(task.taskId)}
      </TableCell>
      <TableCell>
        <TypeBadge type={task.type} />
      </TableCell>
      <TableCell className="text-foreground max-w-0">
        <div className="truncate" title={displayInput || undefined}>
          {displayInput || <span className="text-muted-foreground italic">(empty)</span>}
        </div>
        {activity && (
          <div className="text-muted-foreground mono mt-1 flex items-center gap-1.5 text-[11px]">
            <span className="text-blue-400">▸</span>
            {activity === 'thinking' && <span className="italic">thinking…</span>}
            {activity !== 'thinking' && activity.kind === 'tool' && (
              <>
                <span className="text-foreground/80">{activity.tool}</span>
                {activity.arg && <span className="truncate">· {activity.arg}</span>}
              </>
            )}
            {activity !== 'thinking' && activity.kind === 'reasoning' && (
              <span className="truncate italic">{activity.text}</span>
            )}
          </div>
        )}
      </TableCell>
      <TableCell>
        <StatusPill status={task.status} />
      </TableCell>
      <TableCell
        className="text-muted-foreground text-right text-xs"
        title={formatTimeOfDay(task.startedAt ?? task.createdAt)}
      >
        {formatRelative(task.startedAt ?? task.createdAt, now)} ago
      </TableCell>
      <TableCell
        className={cn('text-right mono text-xs tabular-nums', isRunning ? 'text-blue-400' : 'text-muted-foreground')}
      >
        {durationOf(task, now)}
      </TableCell>
      <TableCell className="text-center" onClick={(event) => event.stopPropagation()}>
        {actionKind === 'delete' ? (
          <DeleteRowAction onClick={() => onDelete(task.taskId)} />
        ) : (
          <CancelRowAction cancelling={cancelling} onClick={() => onCancel(task.taskId)} />
        )}
      </TableCell>
    </TableRow>
  )

  if (!interrupted) return row

  return (
    <Tooltip>
      <TooltipTrigger render={row} />
      <TooltipContent>Daemon was restarted while this task was running. The task did not complete.</TooltipContent>
    </Tooltip>
  )
}

function TypeBadge({type}: {type: string}) {
  return (
    <Badge className="text-muted-foreground mono text-[10px] leading-none uppercase tracking-wider" variant="outline">
      {displayTaskType(type)}
    </Badge>
  )
}

function DeleteRowAction({onClick}: {onClick: () => void}) {
  return (
    <Button aria-label="Delete" onClick={onClick} size="icon-xs" title="Delete" variant="ghost">
      <Trash2 className="size-3.5" />
    </Button>
  )
}

function CancelRowAction({cancelling, onClick}: {cancelling: boolean; onClick: () => void}) {
  return (
    <Button
      aria-label="Cancel task"
      disabled={cancelling}
      onClick={onClick}
      size="icon-xs"
      title={cancelling ? 'Cancelling…' : 'Cancel task'}
      variant="ghost"
    >
      {cancelling ? <LoaderCircle className="size-3.5 animate-spin" /> : <CircleStop className="size-3.5" />}
    </Button>
  )
}

function Checkbox({checked, onChange}: {checked: boolean; onChange: () => void}) {
  return (
    <input
      checked={checked}
      className="border-border bg-transparent accent-blue-500 size-3.5 cursor-pointer rounded border"
      onChange={onChange}
      type="checkbox"
    />
  )
}
