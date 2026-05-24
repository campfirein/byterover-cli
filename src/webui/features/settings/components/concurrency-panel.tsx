import {LoaderCircle} from 'lucide-react'
import {Fragment, useMemo} from 'react'

import {buildSettingsRows} from '../../../../shared/utils/format-settings'
import {noop} from '../../../lib/noop'
import {SettingsSection} from '../../vc/components/settings-section'
import {useGetSettings} from '../api/list-settings'
import {SettingsRow} from './settings-row'
import {SettingsSkeleton} from './settings-skeleton'

export function ConcurrencyPanel() {
  const {data, error, isError, isLoading, refetch} = useGetSettings()

  const rows = useMemo(() => {
    if (!data) return []
    return buildSettingsRows(data.items).filter((row) => row.category === 'concurrency')
  }, [data?.items])

  return (
    <SettingsSection
      action={isLoading ? <LoaderCircle className="text-muted-foreground mt-1 size-4 animate-spin" /> : undefined}
      description="How many projects and tasks run in parallel."
      error={isError ? error : undefined}
      errorFallback="Failed to load concurrency settings"
      onRetry={() => refetch().catch(noop)}
      title="Concurrency"
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
