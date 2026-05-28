import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@campfirein/byterover-packages/components/select'
import {useId} from 'react'
import {toast} from 'sonner'

import type {SettingsRow as SettingsRowData} from '../../../../shared/types/settings-row'

import {LANGUAGE_NAMES} from '../../../../shared/language/language-names'
import {SETTINGS_KEYS} from '../../../../shared/types/settings-keys'
import {formatError} from '../../../lib/error-messages'
import {noop} from '../../../lib/noop'
import {useSetSetting} from '../api/set-setting'
import {labelFor} from '../lib/labels'
import {useRestartBannerStore} from '../stores/restart-banner-store'

type Props = {
  row: SettingsRowData
}

export function EnumSettingsRow({row}: Props) {
  const setMutation = useSetSetting()
  const markDirty = useRestartBannerStore((s) => s.markDirty)
  const descriptionId = useId()

  const label = labelFor(row.key)
  const current = typeof row.current === 'string' ? row.current : String(row.current)
  const options = row.options ?? []

  const choose = async (next: string) => {
    if (next === current) return
    try {
      const response = await setMutation.mutateAsync({key: row.key, value: next})
      if (response.ok) {
        markDirty(row.key, row.restartRequired)
        toast.success(`${label} set to ${displayLabel(row.key, next)}`)
        return
      }

      toast.error(response.error.message)
    } catch (error) {
      toast.error(formatError(error, `Failed to update ${label}`))
    }
  }

  return (
    <div className="flex items-center justify-between gap-3">
      <div className="flex min-w-0 flex-col gap-0.5">
        <span className="text-foreground text-sm font-medium">{label}</span>
        <span className="text-muted-foreground text-xs leading-snug" id={descriptionId}>
          {row.description}
        </span>
      </div>
      <Select
        disabled={setMutation.isPending}
        onValueChange={(next) => {
          if (next === null) return
          choose(next).catch(noop)
        }}
        value={current}
      >
        <SelectTrigger aria-describedby={descriptionId} className="h-8 w-44 text-xs" size="sm">
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          {options.map((option) => (
            <SelectItem key={option} value={option}>
              {displayLabel(row.key, option)}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
    </div>
  )
}

function displayLabel(key: string, option: string): string {
  if (key !== SETTINGS_KEYS.LANGUAGE_CODE) return option
  const name = LANGUAGE_NAMES[option]
  return name ? `${option} — ${name}` : option
}
