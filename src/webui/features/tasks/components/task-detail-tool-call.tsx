import {cn} from '@campfirein/byterover-packages/lib/utils'
import {ChevronDown, ChevronUp} from 'lucide-react'
import {Fragment, memo, ReactNode, useMemo, useState} from 'react'

import type {ToolCallEvent} from '../types/stored-task'

import {oneDark, SyntaxHighlighter} from '../../../lib/syntax-highlighter'
import {formatToolArgs} from '../utils/format-tool-args'
import {stripTaskIdSuffix} from '../utils/strip-task-id'
import {MarkdownInline} from './markdown-inline'
import {EventDot} from './task-detail-shared'

type RowFormat = 'code' | 'keypath' | 'markdown' | 'plain'

const TOOL_LABEL_TONE: Record<ToolCallEvent['status'], string> = {
  completed: 'text-emerald-500/80',
  error: 'text-red-400/80',
  running: 'text-blue-400/80',
}

interface ToolLangs {
  in: string
  out: string
}

/* eslint-disable camelcase */
// Tool names match daemon registrations — see src/agent/core/domain/tools/constants.ts
// and the .txt files under src/agent/resources/tools/.
const TOOL_LANGUAGES: Record<string, ToolLangs> = {
  bash_exec: {in: 'bash', out: 'bash'},
  bash_output: {in: 'bash', out: 'bash'},
  code_exec: {in: 'javascript', out: 'json'},
}

const TOOL_DISPLAY_NAME: Record<string, string> = {
  agentic_map: 'map',
  bash_exec: 'bash',
  bash_output: 'bash output',
  code_exec: 'code exec',
  create_knowledge_topic: 'new topic',
  delete_memory: 'delete memory',
  detect_domains: 'detect domains',
  edit_file: 'edit',
  edit_memory: 'edit memory',
  expand_knowledge: 'expand',
  glob_files: 'glob',
  grep_content: 'grep',
  ingest_resource: 'ingest',
  kill_process: 'kill',
  list_directory: 'list',
  list_memories: 'memories',
  llm_map: 'llm map',
  read_file: 'read',
  read_memory: 'read memory',
  read_todos: 'todos',
  search_history: 'history',
  search_knowledge: 'search',
  swarm_query: 'swarm query',
  swarm_store: 'swarm store',
  write_file: 'write',
  write_memory: 'write memory',
  write_todos: 'todos',
}
/* eslint-enable camelcase */

function getToolDisplayName(toolName: string): string {
  return TOOL_DISPLAY_NAME[toolName] ?? toolName.replaceAll('_', ' ')
}

const EXTENSION_LANGUAGE: Record<string, string> = {
  bash: 'bash',
  c: 'c',
  cjs: 'javascript',
  cpp: 'cpp',
  cs: 'csharp',
  css: 'css',
  go: 'go',
  h: 'c',
  hpp: 'cpp',
  htm: 'html',
  html: 'html',
  java: 'java',
  js: 'javascript',
  json: 'json',
  jsx: 'jsx',
  kt: 'kotlin',
  less: 'less',
  md: 'markdown',
  mdx: 'markdown',
  mjs: 'javascript',
  php: 'php',
  py: 'python',
  rb: 'ruby',
  rs: 'rust',
  scss: 'scss',
  sh: 'bash',
  sql: 'sql',
  swift: 'swift',
  toml: 'toml',
  ts: 'typescript',
  tsx: 'tsx',
  xml: 'xml',
  yaml: 'yaml',
  yml: 'yaml',
  zsh: 'bash',
}

function inferFileLanguage(args: Record<string, unknown>): string | undefined {
  const path =
    (typeof args.path === 'string' && args.path) ||
    (typeof args.file_path === 'string' && args.file_path) ||
    (typeof args.filePath === 'string' && args.filePath)
  if (!path) return undefined
  const dot = path.lastIndexOf('.')
  if (dot === -1 || dot === path.length - 1) return undefined
  const ext = path.slice(dot + 1).toLowerCase()
  return EXTENSION_LANGUAGE[ext]
}

const MEMORY_TOOLS = new Set(['delete_memory', 'edit_memory', 'list_memories', 'read_memory', 'write_memory'])
const PLAIN_OUT_TOOLS = new Set(['bash_output'])
const JSON_OUT_TOOLS = new Set([
  'create_knowledge_topic',
  'curate',
  'detect_domains',
  'expand_knowledge',
  'ingest_resource',
  'list_directory',
  'list_memories',
  'read_todos',
  'search_history',
  'search_knowledge',
  'swarm_query',
  'swarm_store',
  'write_todos',
])

function getInFormat(toolName: string): {format: RowFormat; language?: string} {
  if (toolName in TOOL_LANGUAGES) return {format: 'code', language: TOOL_LANGUAGES[toolName].in}
  if (MEMORY_TOOLS.has(toolName)) return {format: 'keypath'}
  return {format: 'markdown'}
}

function getOutFormat(toolName: string, fileLang: string | undefined): {format: RowFormat; language?: string} {
  if (PLAIN_OUT_TOOLS.has(toolName)) return {format: 'plain'}
  if (fileLang) return {format: 'code', language: fileLang}
  if (toolName in TOOL_LANGUAGES) return {format: 'code', language: TOOL_LANGUAGES[toolName].out}
  if (JSON_OUT_TOOLS.has(toolName)) return {format: 'code', language: 'json'}
  return {format: 'markdown'}
}

const CodeBlock = memo(({content, language = 'bash'}: {content: string; language?: string}) => (
  <SyntaxHighlighter
    codeTagProps={{
      style: {fontFamily: 'ui-monospace, SF Mono, Menlo, Consolas, monospace', fontSize: '0.75rem'},
    }}
    customStyle={{background: 'transparent', fontSize: '0.75rem', lineHeight: 1.6, margin: 0, padding: 0}}
    language={language}
    PreTag="div"
    style={oneDark}
  >
    {content}
  </SyntaxHighlighter>
))
CodeBlock.displayName = 'CodeBlock'

export function ToolCallContent({
  call,
  flash,
  taskId,
  tooltip,
}: {
  call: ToolCallEvent
  flash: boolean
  taskId: string
  tooltip: ReactNode
}) {
  const [expanded, setExpanded] = useState(false)
  const argsText = useMemo(() => stripTaskIdSuffix(formatToolArgs(call), taskId), [call, taskId])
  const resultText = useMemo(() => stripTaskIdSuffix(formatResult(call), taskId), [call, taskId])
  const fileLang = useMemo(() => inferFileLanguage(call.args), [call.args])
  const inFormat = getInFormat(call.toolName)
  const outFormat = getOutFormat(call.toolName, fileLang)
  const hasResult = resultText.length > 0
  const isRunning = call.status === 'running'

  const toggle = () => setExpanded((prev) => !prev)

  return (
    <>
      <EventDot flash={flash} tone={call.status} tooltip={tooltip} />

      <div className="text-muted-foreground mb-2 flex flex-wrap items-baseline gap-2 text-[11px]">
        <span className={cn('mono uppercase tracking-wider', TOOL_LABEL_TONE[call.status])}>
          {getToolDisplayName(call.toolName)}
        </span>
        {isRunning && <span className="text-blue-400/80">running</span>}
      </div>

      <button
        aria-expanded={expanded}
        className="border-border/50 bg-muted/30 hover:bg-muted/60 group/toolblock relative w-full cursor-pointer rounded-md border text-left transition"
        onClick={toggle}
        type="button"
      >
        <IORow
          collapsedHeight="max-h-5"
          collapsedLines={IN_COLLAPSED_LINES}
          content={argsText || '—'}
          empty={!argsText}
          expanded={expanded}
          format={inFormat.format}
          label="in"
          language={inFormat.language}
        />
        <div className="border-border/50 border-t" />
        <IORow
          collapsedHeight="max-h-16"
          collapsedLines={OUT_COLLAPSED_LINES}
          content={resultText}
          empty={!hasResult}
          expanded={expanded}
          format={outFormat.format}
          label="out"
          language={outFormat.language}
          placeholder={isRunning ? 'running…' : '—'}
        />
        {!expanded && (
          <span
            aria-hidden
            className="from-background/95 via-background/60 pointer-events-none absolute inset-x-0 bottom-0 h-10 rounded-b-md bg-linear-to-t to-transparent"
          />
        )}
        <span className="border-border bg-background/80 text-foreground/80 group-hover/toolblock:text-foreground group-hover/toolblock:border-foreground/30 group-hover/toolblock:bg-muted absolute bottom-2 left-1/2 inline-flex -translate-x-1/2 items-center gap-1.5 rounded-full border px-3.5 py-1.5 text-xs font-medium shadow-lg backdrop-blur-md transition">
          <span>{expanded ? 'Click to collapse' : 'Click to expand'}</span>
          {expanded ? <ChevronUp className="size-3.5" /> : <ChevronDown className="size-3.5" />}
        </span>
      </button>
    </>
  )
}

const IN_COLLAPSED_LINES = 1
const OUT_COLLAPSED_LINES = 3

function IORow({
  collapsedHeight,
  collapsedLines,
  content,
  empty,
  expanded,
  format,
  label,
  language,
  placeholder,
}: {
  collapsedHeight: string
  collapsedLines: number
  content: string
  empty: boolean
  expanded: boolean
  format: RowFormat
  label: 'in' | 'out'
  language?: string
  placeholder?: string
}) {
  const overflowLines = useMemo(() => {
    if (expanded) return 0
    return Math.max(0, content.split('\n').length - collapsedLines)
  }, [content, collapsedLines, expanded])

  const renderContent = () => {
    switch (format) {
      case 'code': {
        return <CodeBlock content={content} language={language} />
      }

      case 'keypath': {
        return <KeyPath path={content} />
      }

      case 'plain': {
        return <PlainBlock content={content} />
      }

      default: {
        return <MarkdownInline className="text-foreground/90 text-sm">{content}</MarkdownInline>
      }
    }
  }

  return (
    <div className="flex items-start gap-3 px-3 py-2">
      <span className="text-muted-foreground mono mt-[3px] flex w-7 shrink-0 flex-col items-start text-[10px] uppercase tracking-wider">
        <span>{label}</span>
        {overflowLines > 0 && (
          <span className="text-muted-foreground/60 mt-1 text-[9px] normal-case tracking-normal">+{overflowLines}</span>
        )}
      </span>
      <div className="min-w-0 flex-1 overflow-x-auto">
        {empty ? (
          <span className="text-muted-foreground/60 italic text-xs">{placeholder ?? '—'}</span>
        ) : expanded ? (
          renderContent()
        ) : (
          <div className={cn('overflow-hidden', collapsedHeight)}>{renderContent()}</div>
        )}
      </div>
    </div>
  )
}

function PlainBlock({content}: {content: string}) {
  return <pre className="text-foreground/85 mono m-0 text-xs leading-6 whitespace-pre-wrap">{content}</pre>
}

function KeyPath({path}: {path: string}) {
  const parts = path.split('/')
  return (
    <span className="text-foreground/90 mono text-sm">
      {parts.map((part, i) => (
        <Fragment key={i}>
          {i > 0 && <span className="text-muted-foreground/40 mx-0.5">/</span>}
          {part}
        </Fragment>
      ))}
    </span>
  )
}

function formatResult(call: ToolCallEvent): string {
  if (call.status === 'error' && call.error) return call.error
  if (call.result === undefined || call.result === null) return ''
  if (typeof call.result === 'string') {
    const trimmed = call.result.trim()
    return trimmed.length > 1200 ? `${trimmed.slice(0, 1200)}\n…` : trimmed
  }

  try {
    const json = JSON.stringify(call.result, null, 2)
    return json.length > 1200 ? `${json.slice(0, 1200)}\n…` : json
  } catch {
    return String(call.result)
  }
}
