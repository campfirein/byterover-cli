import {Card} from '@campfirein/byterover-packages/components/card'
import {TopicViewer} from '@campfirein/byterover-packages/components/topic-viewer/topic-viewer'
import {cn} from '@campfirein/byterover-packages/lib/utils'
import {Folder, Paperclip} from 'lucide-react'

import type {StoredTask} from '../types/stored-task'

import {formatError} from '../../../lib/error-messages'
import {
  isCurateHtmlDirectType,
  parseCurateHtmlDirectInput,
  parseCurateHtmlDirectResult,
} from '../utils/curate-tool-mode'
import {shortTaskId} from '../utils/format-time'
import {isBvTopicHtml} from '../utils/is-bv-topic-html'
import {isActiveStatus} from '../utils/task-status'
import {AttachmentChip} from './attachment-chip'
import {CurateHtmlDirectInputView, CurateHtmlDirectResultView} from './curate-tool-mode-sections'
import {MarkdownInline} from './markdown-inline'
import {SectionLabel, TerminalDot} from './task-detail-shared'

export function InputSection({task}: {task: StoredTask}) {
  if (isCurateHtmlDirectType(task.type)) {
    const payload = parseCurateHtmlDirectInput(task.content)
    if (payload) return <CurateHtmlDirectInputView payload={payload} />
  }

  const {folderPath} = task
  const files = task.files ?? []
  const hasAttachments = Boolean(folderPath) || files.length > 0
  return (
    <section>
      <SectionLabel>Input</SectionLabel>
      <div className="border-blue-400 text-foreground/90 mono border-l-2 pl-3 text-sm leading-relaxed whitespace-pre-wrap">
        {task.content || <span className="text-muted-foreground italic">(empty)</span>}
      </div>
      {hasAttachments && (
        <div className="mt-3 flex flex-wrap gap-1.5 pl-3">
          {folderPath && <AttachmentChip Icon={Folder} path={folderPath} />}
          {files.map((file) => (
            <AttachmentChip Icon={Paperclip} key={file} path={file} />
          ))}
        </div>
      )}
    </section>
  )
}

export function LiveStreamSection({task}: {task: StoredTask}) {
  const content = task.responseContent ?? task.streamingContent ?? ''
  const isLive = task.isStreaming || (!task.responseContent && isActiveStatus(task.status))

  return (
    <section>
      <div className="mono mb-2 flex items-baseline gap-2 text-[11px] uppercase tracking-wider">
        {isLive ? (
          <>
            <span className="text-blue-400 inline-flex items-center gap-1.5">
              <span className="bg-blue-400 size-1 rounded-full animate-pulse" />
              live
            </span>
            <span className="text-muted-foreground">agent is responding</span>
          </>
        ) : (
          <span className="text-muted-foreground">Response</span>
        )}
        <span className="bg-border/50 h-px flex-1" />
      </div>
      <div
        className={cn('pl-3 text-foreground/90 text-sm border-l-2', isLive ? 'border-blue-500/30' : 'border-border')}
      >
        {isBvTopicHtml(content) ? (
          <TopicViewer breadcrumb={{show: false}} html={content} />
        ) : (
          <MarkdownInline className="text-foreground/90 text-sm">{content || ' '}</MarkdownInline>
        )}
        {isLive && <span className="bg-blue-400/70 ml-1 inline-block h-3 w-1.5 align-middle animate-pulse" />}
      </div>
    </section>
  )
}

export function ResultSection({content, taskType}: {content: string; taskType?: string}) {
  if (taskType && isCurateHtmlDirectType(taskType)) {
    const payload = parseCurateHtmlDirectResult(content)
    if (payload) return <CurateHtmlDirectResultView payload={payload} />
  }

  return (
    <section className="relative pl-8">
      <TerminalDot tone="completed" />
      <SectionLabel>Result</SectionLabel>
      <Card className="ring-border bg-card p-5" size="sm">
        {isBvTopicHtml(content) ? (
          <TopicViewer breadcrumb={{show: false}} html={content} />
        ) : (
          <MarkdownInline className="text-foreground/90 text-sm">{content}</MarkdownInline>
        )}
      </Card>
    </section>
  )
}

export function ErrorSection({task}: {task: StoredTask}) {
  const {error} = task
  if (!error) return null

  return (
    <section className="relative pl-8">
      <TerminalDot tone="error" />
      <SectionLabel>Error</SectionLabel>
      <Card className="bg-red-500/5 p-5 ring-1 ring-red-500/30" size="sm">
        <p className="text-red-400 text-sm">{formatError(error)}</p>
        {error.code && <p className="text-muted-foreground mono mt-1 text-[11px]">{error.code}</p>}
      </Card>
    </section>
  )
}

export function NotFound({taskId}: {taskId: string}) {
  return (
    <div className="flex h-full flex-col items-center justify-center gap-3 p-8 text-center">
      <h2 className="text-foreground text-base font-medium">Task not found</h2>
      <p className="text-muted-foreground max-w-md text-sm">
        Task <span className="mono">{shortTaskId(taskId)}</span> isn't in the local cache. It may have completed before
        the page was loaded, or it belongs to a different project.
      </p>
    </div>
  )
}
