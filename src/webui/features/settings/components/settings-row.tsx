import {Input} from '@campfirein/byterover-packages/components/input'
import {Tooltip, TooltipContent, TooltipTrigger} from '@campfirein/byterover-packages/components/tooltip'
import {cn} from '@campfirein/byterover-packages/lib/utils'
import {LoaderCircle, RotateCcw} from 'lucide-react'
import {type ComponentRef, type KeyboardEvent, useEffect, useId, useRef, useState} from 'react'
import {toast} from 'sonner'

import type {SettingsRow as SettingsRowData} from '../../../../shared/types/settings-row'

import {formatCount} from '../../../../shared/utils/format-duration'
import {parseRowInput} from '../../../../shared/utils/format-settings'
import {noop} from '../../../lib/noop'
import {useResetSetting} from '../api/reset-setting'
import {useSetSetting} from '../api/set-setting'
import {labelFor} from '../lib/labels'
import {useRestartBannerStore} from '../stores/restart-banner-store'
import {BooleanSettingsRow} from './boolean-settings-row'

type Props = {
  row: SettingsRowData
}

export function SettingsRow({row}: Props) {
  if (row.type === 'boolean') return <BooleanSettingsRow row={row} />

  return <IntegerSettingsRow row={row} />
}

function IntegerSettingsRow({row}: Props) {
  const setMutation = useSetSetting()
  const resetMutation = useResetSetting()
  const markDirty = useRestartBannerStore((s) => s.markDirty)
  const descriptionId = useId()

  const [buffer, setBuffer] = useState(() => String(row.current))
  const [error, setError] = useState<string | undefined>()
  const isUserEditingRef = useRef(false)

  useEffect(() => {
    if (isUserEditingRef.current) return
    setBuffer(String(row.current))
    setError(undefined)
  }, [row.current])

  const label = labelFor(row.key)
  const isBusy = setMutation.isPending || resetMutation.isPending
  const isMs = row.unit === 'ms'
  const toastValue = (value: number) => (isMs ? `${formatCount(value)} milliseconds` : formatCount(value))

  const commit = async () => {
    const parsed = parseRowInput(row, buffer)
    if (parsed.kind === 'error') {
      setError(parsed.message)
      return
    }

    if (parsed.value === row.current) {
      setError(undefined)
      setBuffer(String(parsed.value))
      isUserEditingRef.current = false
      return
    }

    setError(undefined)
    const response = await setMutation.mutateAsync({key: row.key, value: parsed.value})
    if (response.ok) {
      markDirty(row.key, row.restartRequired)
      isUserEditingRef.current = false
      toast.success(`${label} set to ${toastValue(parsed.value)}`)
      return
    }

    setError(response.error.message)
  }

  const reset = async () => {
    setError(undefined)
    const response = await resetMutation.mutateAsync({key: row.key})
    if (response.ok) {
      markDirty(row.key, row.restartRequired)
      isUserEditingRef.current = false
      toast.success(`${label} reset to default`)
      return
    }

    setError(response.error.message)
  }

  const onChange = (event: {target: {value: string}}) => {
    isUserEditingRef.current = true
    setBuffer(event.target.value)
  }

  const onKeyDown = (event: KeyboardEvent<ComponentRef<typeof Input>>) => {
    if (event.key === 'Enter') {
      event.preventDefault()
      commit().catch(noop)
    }
  }

  const onBlur = () => {
    isUserEditingRef.current = false
    if (buffer === String(row.current)) return
    commit().catch(noop)
  }

  const canReset = row.modified && !isBusy
  const hasError = error !== undefined

  return (
    <div className="flex items-center justify-between gap-3">
      <div className="flex min-w-0 flex-col gap-0.5">
        <span className="text-foreground text-sm font-medium">{label}</span>
        <span
          className={cn('text-xs leading-snug', hasError ? 'text-destructive' : 'text-muted-foreground')}
          id={descriptionId}
        >
          {error ?? `${row.description} (range ${row.displayRange})`}
        </span>
      </div>
      <div className="flex shrink-0 items-center gap-2">
        <div className="relative">
          <Input
            aria-describedby={descriptionId}
            aria-invalid={hasError}
            className={cn('w-24 pr-8 text-xs border-border h-8', {'border-destructive': hasError})}
            disabled={isBusy}
            onBlur={onBlur}
            onChange={onChange}
            onKeyDown={onKeyDown}
            value={buffer}
          />
          <Tooltip>
            <TooltipTrigger
              render={
                <button
                  aria-label="Reset to default"
                  className="text-muted-foreground hover:text-foreground hover:bg-muted absolute top-1/2 right-1.5 flex size-6 -translate-y-1/2 cursor-pointer items-center justify-center rounded transition-colors disabled:pointer-events-none disabled:opacity-30"
                  disabled={!canReset}
                  onClick={() => reset().catch(noop)}
                  type="button"
                />
              }
            >
              {resetMutation.isPending ? (
                <LoaderCircle className="size-3.5 animate-spin" />
              ) : (
                <RotateCcw className="size-3.5" />
              )}
            </TooltipTrigger>
            <TooltipContent>Reset to default ({row.displayDefault})</TooltipContent>
          </Tooltip>
        </div>
        {isMs && <span className="text-muted-foreground text-xs">ms</span>}
      </div>
    </div>
  )
}
