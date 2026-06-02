import {Badge} from '@campfirein/byterover-packages/components/badge'
import {Card} from '@campfirein/byterover-packages/components/card'
import {Tooltip, TooltipContent, TooltipTrigger} from '@campfirein/byterover-packages/components/tooltip'
import {cn} from '@campfirein/byterover-packages/lib/utils'
import {ChevronDown, ChevronUp, FileText} from 'lucide-react'
import {type ComponentRef, useLayoutEffect, useRef, useState} from 'react'

import type {QueryToolModeMatchedDoc} from '../utils/query-tool-mode-results'

import {MarkdownInline} from './markdown-inline'
import {SectionLabel, TerminalDot} from './task-detail-shared'

export function QueryResultsList({matchedDocs}: {matchedDocs: QueryToolModeMatchedDoc[]}) {
  const label = `Result · ${matchedDocs.length} ${matchedDocs.length === 1 ? 'match' : 'matches'}`

  return (
    <section className="relative pl-8">
      <TerminalDot tone="completed" />
      <SectionLabel>{label}</SectionLabel>
      {matchedDocs.length === 0 ? (
        <p className="text-muted-foreground text-sm">No matching documents.</p>
      ) : (
        <div className="flex flex-col gap-3">
          {matchedDocs.map((doc, index) => (
            <QueryResultRow doc={doc} key={`${doc.path}-${index}`} />
          ))}
        </div>
      )}
    </section>
  )
}

function QueryResultRow({doc}: {doc: QueryToolModeMatchedDoc}) {
  const hasBody = typeof doc.rendered_md === 'string' && doc.rendered_md.length > 0
  const bodyRef = useRef<ComponentRef<'div'>>(null)
  const [expanded, setExpanded] = useState(false)
  const [overflowing, setOverflowing] = useState(false)

  useLayoutEffect(() => {
    const el = bodyRef.current
    if (!el) return
    setOverflowing(el.scrollHeight > el.clientHeight + 1)
  }, [doc.rendered_md])

  return (
    <Card className="ring-border bg-card flex flex-col gap-1.5 p-4" size="sm">
      <div className="flex items-start justify-between gap-3">
        <div className="flex min-w-0 items-center gap-2">
          <FileText className="text-muted-foreground size-3.5 shrink-0" />
          <span className="text-foreground/90 truncate text-sm font-medium">{doc.title}</span>
        </div>
        <Tooltip>
          <TooltipTrigger
            render={
              <Badge className="mono text-emerald-400 shrink-0" variant="outline">
                {doc.score.toFixed(2)}
              </Badge>
            }
          />
          <TooltipContent>Match score</TooltipContent>
        </Tooltip>
      </div>
      <p className="text-muted-foreground mono pl-5 text-[11px] break-all">{doc.path}</p>
      {hasBody && (
        <div className="pl-5">
          <div className={cn('overflow-hidden', {'max-h-36': !expanded})} ref={bodyRef}>
            <MarkdownInline className="text-foreground/70 text-xs">{doc.rendered_md ?? ''}</MarkdownInline>
          </div>
          {overflowing && (
            <button
              className="text-muted-foreground hover:text-foreground mt-1.5 inline-flex cursor-pointer items-center gap-1 text-[11px]"
              onClick={() => setExpanded((value) => !value)}
              type="button"
            >
              {expanded ? <ChevronUp className="size-3" /> : <ChevronDown className="size-3" />}
              {expanded ? 'Show less' : 'Show more'}
            </button>
          )}
        </div>
      )}
    </Card>
  )
}
