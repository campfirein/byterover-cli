import {
  DropdownMenu,
  DropdownMenuCheckboxItem,
  DropdownMenuContent,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
  DropdownMenuTrigger,
} from '@campfirein/byterover-packages/components/dropdown-menu'
import {SlidersHorizontal} from 'lucide-react'

import {DURATION_PRESETS, type DurationPreset, isDurationPreset} from '../utils/duration-presets'
import {TaskDateFilterPanel} from './task-date-filter-panel'

const TYPE_OPTIONS = [
  {label: 'Curate', value: 'curate'},
  {label: 'Query', value: 'query'},
] as const

export interface TaskFilterMenuProps {
  createdAfter?: number
  createdBefore?: number
  durationPreset: DurationPreset
  onDurationChange: (preset: DurationPreset) => void
  onTimeRangeChange: (range: {createdAfter?: number; createdBefore?: number}) => void
  onTypeChange: (next: string[]) => void
  typeFilter: string[]
}

export function TaskFilterMenu({
  createdAfter,
  createdBefore,
  durationPreset,
  onDurationChange,
  onTimeRangeChange,
  onTypeChange,
  typeFilter,
}: TaskFilterMenuProps) {
  const timeActive = createdAfter !== undefined || createdBefore !== undefined
  const hasActive = typeFilter.length > 0 || timeActive || durationPreset !== 'all'

  return (
    <DropdownMenu>
      <DropdownMenuTrigger className="text-muted-foreground hover:text-foreground hover:bg-muted/60 border-border bg-background relative inline-flex h-8 cursor-pointer items-center gap-1.5 rounded-md border px-3 text-sm transition-colors">
        <SlidersHorizontal className="pointer-events-none size-3.5" />
        <span className="pointer-events-none">Filter</span>
        {hasActive && (
          <span className="bg-primary pointer-events-none absolute -top-1 -right-1 size-2 rounded-full" />
        )}
      </DropdownMenuTrigger>

      <DropdownMenuContent align="start" className="w-48">
        <DropdownMenuSub>
          <DropdownMenuSubTrigger className="cursor-pointer">
            <span>
              Type
              {typeFilter.length > 0 && <span className="ml-1">({typeFilter.length})</span>}
            </span>
          </DropdownMenuSubTrigger>
          <DropdownMenuSubContent className="w-48" sideOffset={8}>
            {TYPE_OPTIONS.map((option) => (
              <DropdownMenuCheckboxItem
                checked={typeFilter.includes(option.value)}
                className="cursor-pointer"
                key={option.value}
                onCheckedChange={() => toggleIn(typeFilter, option.value, onTypeChange)}
              >
                {option.label}
              </DropdownMenuCheckboxItem>
            ))}
          </DropdownMenuSubContent>
        </DropdownMenuSub>

        <DropdownMenuSub>
          <DropdownMenuSubTrigger className="cursor-pointer">
            <span>
              Time
              {timeActive && <span className="text-primary ml-1">·</span>}
            </span>
          </DropdownMenuSubTrigger>
          <DropdownMenuSubContent className="w-fit" sideOffset={8}>
            <TaskDateFilterPanel
              createdAfter={createdAfter}
              createdBefore={createdBefore}
              onChange={onTimeRangeChange}
            />
          </DropdownMenuSubContent>
        </DropdownMenuSub>

        <DropdownMenuSub>
          <DropdownMenuSubTrigger className="cursor-pointer">
            <span>
              Duration
              {durationPreset !== 'all' && <span className="text-primary ml-1">·</span>}
            </span>
          </DropdownMenuSubTrigger>
          <DropdownMenuSubContent className="w-48" sideOffset={8}>
            <DropdownMenuRadioGroup
              onValueChange={(value) => isDurationPreset(value) && onDurationChange(value)}
              value={durationPreset}
            >
              {DURATION_PRESETS.map((preset) => (
                <DropdownMenuRadioItem className="cursor-pointer" key={preset.value} value={preset.value}>
                  {preset.label}
                </DropdownMenuRadioItem>
              ))}
            </DropdownMenuRadioGroup>
          </DropdownMenuSubContent>
        </DropdownMenuSub>
      </DropdownMenuContent>
    </DropdownMenu>
  )
}

function toggleIn(current: string[], value: string, onChange: (next: string[]) => void) {
  onChange(current.includes(value) ? current.filter((v) => v !== value) : [...current, value])
}
