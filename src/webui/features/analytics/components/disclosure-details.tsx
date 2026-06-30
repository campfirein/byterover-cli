import {Skeleton} from '@campfirein/byterover-packages/components/skeleton'
import {Database, Eye, Info, Link2, type LucideIcon, PowerOff, Server} from 'lucide-react'

import type {AnalyticsDisclosureSection} from '../../../../shared/transport/events/analytics-events.js'

import {formatError} from '../../../lib/error-messages'
import {noop} from '../../../lib/noop'
import {MarkdownView} from '../../context/components/markdown-view'
import {useGetAnalyticsDisclosure} from '../api/get-analytics-disclosure'

const SECTION_ICONS: Record<string, LucideIcon> = {
  'cross-device alias': Link2,
  'how to disable': PowerOff,
  'what is collected': Database,
  'where it goes': Server,
  'which surfaces are tracked': Eye,
}

function iconForLabel(label: string): LucideIcon {
  return SECTION_ICONS[label.trim().toLowerCase()] ?? Info
}

function isVisibleSection(section: AnalyticsDisclosureSection): boolean {
  return !section.label.trim().toLowerCase().includes('privacy')
}

export function DisclosureDetails() {
  const {data, error, isError, isLoading, refetch} = useGetAnalyticsDisclosure()

  if (isLoading) {
    return (
      <div className="grid grid-cols-1 gap-x-6 gap-y-5 md:grid-cols-2">
        {['a', 'b', 'c', 'd'].map((slot) => (
          <div className="flex flex-col gap-2" key={slot}>
            <Skeleton className="size-4" />
            <Skeleton className="h-3 w-32" />
            <Skeleton className="h-3 w-full" />
          </div>
        ))}
      </div>
    )
  }

  if (isError) {
    return (
      <p className="text-destructive text-sm">
        ✗ {formatError(error, 'Failed to load disclosure')}
        {' · '}
        <button className="underline underline-offset-2" onClick={() => refetch().catch(noop)} type="button">
          retry
        </button>
      </p>
    )
  }

  const sections = (data?.sections ?? []).filter((section) => isVisibleSection(section))

  return (
    <div className="grid grid-cols-1 gap-x-6 gap-y-5 md:grid-cols-2">
      {sections.map((section) => {
        const Icon = iconForLabel(section.label)
        return (
          <div className="flex flex-col gap-2" key={section.label}>
            <Icon className="text-muted-foreground size-4" strokeWidth={1.75} />
            <div className="flex flex-col gap-1">
              <span className="text-foreground text-[0.6875rem] font-semibold tracking-wider uppercase">
                {section.label}
              </span>
              <MarkdownView
                className="text-muted-foreground space-y-2 break-words text-[0.8125rem] leading-relaxed"
                content={section.body}
              />
            </div>
          </div>
        )
      })}
    </div>
  )
}
