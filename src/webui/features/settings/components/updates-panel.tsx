import {LoaderCircle} from 'lucide-react'
import {Fragment, useMemo} from 'react'

import {buildSettingsRows} from '../../../../shared/utils/format-settings'
import {noop} from '../../../lib/noop'
import {SettingsSection} from '../../vc/components/settings-section'
import {useGetSettings} from '../api/list-settings'
import {SettingsRow} from './settings-row'
import {SettingsSkeleton} from './settings-skeleton'

export function UpdatesPanel() {
  const {data, error, isError, isLoading, refetch} = useGetSettings()

  const rows = useMemo(() => {
    if (!data) return []
    return buildSettingsRows(data.items).filter((row) => row.category === 'updates')
  }, [data?.items])

  return (
    <SettingsSection
      action={isLoading ? <LoaderCircle className="text-muted-foreground mt-1 size-4 animate-spin" /> : undefined}
      description="Update checks performed when brv starts."
      error={isError ? error : undefined}
      errorFallback="Failed to load updates settings"
      onRetry={() => refetch().catch(noop)}
      title="Updates"
    >
      {data ? (
        <div className="flex flex-col gap-5">
          {rows.map((row, index) => (
            <Fragment key={row.key}>
              <SettingsRow row={row} />
              {index < rows.length - 1 && <div className="border-b" />}
            </Fragment>
          ))}
        </div>
      ) : (
        <SettingsSkeleton />
      )}
    </SettingsSection>
  )
}
