import {Switch} from '@campfirein/byterover-packages/components/switch'
import {useId} from 'react'
import {toast} from 'sonner'

import type {SettingsRow as SettingsRowData} from '../../../../shared/types/settings-row'

import {formatError} from '../../../lib/error-messages'
import {noop} from '../../../lib/noop'
import {useSetSetting} from '../api/set-setting'
import {labelFor} from '../lib/labels'
import {useRestartBannerStore} from '../stores/restart-banner-store'

type Props = {
  row: SettingsRowData
}

export function BooleanSettingsRow({row}: Props) {
  const setMutation = useSetSetting()
  const markDirty = useRestartBannerStore((s) => s.markDirty)
  const descriptionId = useId()

  const label = labelFor(row.key)
  const checked = typeof row.current === 'boolean' ? row.current : false

  const toggle = async (next: boolean) => {
    try {
      const response = await setMutation.mutateAsync({key: row.key, value: next})
      if (response.ok) {
        markDirty(row.key, row.restartRequired)
        toast.success(`${label} ${next ? 'enabled' : 'disabled'}`)
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
      <Switch
        aria-describedby={descriptionId}
        checked={checked}
        disabled={setMutation.isPending}
        onCheckedChange={(next) => {
          toggle(next).catch(noop)
        }}
      />
    </div>
  )
}
