import {Badge} from '@campfirein/byterover-packages/components/badge'
import {Card} from '@campfirein/byterover-packages/components/card'
import {TopicViewer} from '@campfirein/byterover-packages/components/topic-viewer/topic-viewer'
import {AlertTriangle, Check, FileText} from 'lucide-react'
import {ReactNode} from 'react'

import type {
  CurateHtmlDirectInputPayload,
  CurateHtmlDirectResultPayload,
  CurateHtmlWriteError,
} from '../utils/curate-tool-mode'

import {SectionLabel, TerminalDot} from './task-detail-shared'

export function CurateHtmlDirectInputView({payload}: {payload: CurateHtmlDirectInputPayload}) {
  return (
    <section>
      <SectionLabel>Input · Curate topic (HTML direct)</SectionLabel>
      <div className="flex flex-col gap-2 pl-3">
        {payload.confirmOverwrite && (
          <div>
            <Badge className="mono text-amber-400" variant="outline">
              confirmOverwrite: true
            </Badge>
          </div>
        )}
        <Card className="ring-border bg-card p-4" size="sm">
          <TopicViewer breadcrumb={{show: false}} html={payload.html} />
        </Card>
      </div>
    </section>
  )
}

export function CurateHtmlDirectResultView({payload}: {payload: CurateHtmlDirectResultPayload}) {
  if (payload.status === 'ok') {
    return (
      <section className="relative pl-8">
        <TerminalDot tone="completed" />
        <SectionLabel>Result · Topic written</SectionLabel>
        <Card className="ring-border bg-card p-5" size="sm">
          <div className="flex flex-col gap-3">
            <div className="flex flex-wrap items-center gap-2">
              <Badge className="inline-flex items-center gap-1 text-emerald-400" variant="outline">
                <Check className="size-3" />
                {payload.overwrote ? 'Overwritten' : 'Created'}
              </Badge>
            </div>
            <KeyValue label="Topic path" value={payload.topicPath} />
            <KeyValue icon={<FileText className="size-3.5 shrink-0" />} label="File" value={payload.filePath} />
          </div>
        </Card>
      </section>
    )
  }

  return (
    <section className="relative pl-8">
      <TerminalDot tone="error" />
      <SectionLabel>Result · Validation failed</SectionLabel>
      <Card className="bg-red-500/5 p-5 ring-1 ring-red-500/30" size="sm">
        <div className="flex flex-col gap-4">
          {payload.errors.length === 0 ? (
            <p className="text-muted-foreground text-sm">The daemon refused the write but reported no errors.</p>
          ) : (
            payload.errors.map((err, i) => <WriteErrorItem error={err} key={`${err.kind}-${i}`} />)
          )}
        </div>
      </Card>
    </section>
  )
}

function WriteErrorItem({error}: {error: CurateHtmlWriteError}) {
  return (
    <div className="flex flex-col gap-2">
      <div className="flex items-start gap-2">
        <AlertTriangle className="text-red-400 mt-0.5 size-4 shrink-0" />
        <div className="flex min-w-0 flex-1 flex-col gap-0.5">
          <p className="text-red-400 text-sm font-medium">{error.message}</p>
          <p className="text-muted-foreground mono text-[11px]">{error.kind}</p>
        </div>
      </div>
      {error.existingContent && (
        <div className="ml-6">
          <p className="text-muted-foreground mono mb-1 text-[10px] uppercase tracking-wider">Existing content</p>
          <Card className="ring-border bg-background p-3" size="sm">
            <TopicViewer breadcrumb={{show: false}} html={error.existingContent} />
          </Card>
        </div>
      )}
    </div>
  )
}

function KeyValue({icon, label, value}: {icon?: ReactNode; label: string; value: string}) {
  return (
    <div className="flex flex-col gap-0.5">
      <p className="text-muted-foreground mono text-[10px] uppercase tracking-wider">{label}</p>
      <div className="text-foreground/90 mono flex items-center gap-1.5 text-sm break-all">
        {icon}
        <span>{value}</span>
      </div>
    </div>
  )
}
