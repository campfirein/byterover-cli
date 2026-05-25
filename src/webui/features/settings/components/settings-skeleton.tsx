import {Skeleton} from '@campfirein/byterover-packages/components/skeleton'

export function SettingsSkeleton() {
  return (
    <div className="flex flex-col gap-3">
      <Skeleton className="h-8 w-full" />
      <Skeleton className="h-8 w-full" />
    </div>
  )
}
