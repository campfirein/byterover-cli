import {Skeleton} from '@campfirein/byterover-packages/components/skeleton'
import {Switch} from '@campfirein/byterover-packages/components/switch'
import {LoaderCircle} from 'lucide-react'
import {toast} from 'sonner'

import {formatError} from '../../../lib/error-messages'
import {noop} from '../../../lib/noop'
import {useReviewSetDisabled} from '../api/execute-review-set-disabled'
import {useGetReviewDisabled} from '../api/get-review-disabled'
import {SettingsSection} from './settings-section'

export function HitlSettingsPanel() {
  const {data, error, isError, isLoading, refetch} = useGetReviewDisabled()
  const setDisabled = useReviewSetDisabled()

  const reviewEnabled = data ? !data.reviewDisabled : true

  const handleToggle = async (next: boolean) => {
    try {
      await setDisabled.mutateAsync({reviewDisabled: !next})
    } catch (error_) {
      toast.error(formatError(error_, 'Failed to update agent review setting.'))
    }
  }

  return (
    <SettingsSection
      action={isLoading || setDisabled.isPending ? <LoaderCircle className="text-muted-foreground mt-1 size-4 animate-spin" /> : undefined}
      compact
      description="Surface agent edits in the Changes tab. High-impact edits are highlighted for your attention."
      error={isError ? error : undefined}
      errorFallback="Failed to load review setting"
      onRetry={() => refetch().catch(noop)}
      title="Agent supervision"
    >
      {data ? (
        <div className="flex items-center justify-between gap-3 rounded-md min-h-8">
          <span className="text-foreground min-w-0 truncate text-sm font-medium">Highlight agent edits</span>
          <Switch
            checked={reviewEnabled}
            disabled={setDisabled.isPending}
            onCheckedChange={(next) => {
              handleToggle(next).catch(noop)
            }}
          />
        </div>
      ) : (
        <div className="flex min-h-8 items-center gap-3">
          <Skeleton className="h-4 flex-1" />
          <Skeleton className="h-5 w-8" />
        </div>
      )}
    </SettingsSection>
  )
}
