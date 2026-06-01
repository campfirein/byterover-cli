import {Skeleton} from '@campfirein/byterover-packages/components/skeleton'

import {formatError} from '../../../lib/error-messages'
import {noop} from '../../../lib/noop'
import {MarkdownView} from '../../context/components/markdown-view'
import {useGetAnalyticsDisclosure} from '../api/get-analytics-disclosure'

export function DisclosureDetails() {
  const {data, error, isError, isLoading, refetch} = useGetAnalyticsDisclosure()

  if (isLoading) {
    return (
      <div className="flex flex-col gap-2">
        <Skeleton className="h-4 w-32" />
        <Skeleton className="h-4 w-full" />
        <Skeleton className="h-4 w-3/4" />
      </div>
    )
  }

  if (isError) {
    return (
      <p className="text-destructive text-sm">
        ✗ {formatError(error, 'Failed to load disclosure')}
        {' · '}
        <button
          className="underline underline-offset-2"
          onClick={() => refetch().catch(noop)}
          type="button"
        >
          retry
        </button>
      </p>
    )
  }

  return <MarkdownView content={data?.markdown ?? ''} />
}
