import {Button} from '@campfirein/byterover-packages/components/button'
import {AlertTriangle, Check, Copy} from 'lucide-react'
import {Children, createElement, type FC, isValidElement, memo, ReactElement, type ReactNode, useState} from 'react'
import ReactMarkdown, {type Components, type Options} from 'react-markdown'
import remarkFrontmatter from 'remark-frontmatter'
import remarkGfm from 'remark-gfm'

import {hasConflictMarkers} from '../../../../shared/utils/conflict-markers'
import {copyTextToClipboard} from '../../../lib/clipboard'
import {oneDark, SyntaxHighlighter} from '../../../lib/syntax-highlighter'

// ── CodeBlock ──────────────────────────────────────────────────────────────

interface CodeBlockProps {
  language: string
  value: string
}

const CodeBlock: FC<CodeBlockProps> = memo(({language, value}) => {
  const [isCopied, setIsCopied] = useState(false)

  const handleCopy = () => {
    setIsCopied(true)
    copyTextToClipboard(value).catch(() => {})
    setTimeout(() => setIsCopied(false), 1000)
  }

  return (
    <div className="codeblock border-input relative w-full overflow-hidden rounded border p-2 font-sans dark:bg-zinc-900">
      <div className="bg-secondary flex w-full items-center justify-between px-2 py-1">
        <span className="text-primary text-lg font-bold lowercase italic">{language}</span>
        <div className="flex items-center py-1">
          <Button
            className="hover:bg-border text-xs focus-visible:ring-1 focus-visible:ring-offset-0"
            onClick={handleCopy}
            size="xs"
            variant="ghost"
          >
            {isCopied ? <Check className="h-4 w-4" /> : <Copy className="h-4 w-4" />}
            <span className="sr-only">Copy code</span>
          </Button>
        </div>
      </div>
      <SyntaxHighlighter
        codeTagProps={{style: {display: 'block', fontFamily: 'var(--font-mono)', fontSize: '0.75rem'}}}
        customStyle={{background: 'transparent', margin: 0, padding: '0.5rem', width: '100%'}}
        language={language}
        PreTag="div"
        style={oneDark}
      >
        {value}
      </SyntaxHighlighter>
    </div>
  )
})
CodeBlock.displayName = 'CodeBlock'

// ── Markdown helpers ───────────────────────────────────────────────────────

const MemoizedReactMarkdown: FC<Options> = memo(
  ReactMarkdown,
  (prevProps, nextProps) => prevProps.children === nextProps.children,
)

const isTextElement = (child: ReactNode): child is ReactElement =>
  isValidElement(child) &&
  typeof child.type !== 'string' &&
  ['h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'p'].includes((child.type as {name?: string}).name ?? '')

const isChecklist = (children: ReactNode) =>
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  Array.isArray(children) && children.some((child: any) => child?.props?.className === 'task-list-item')

const transformListItemChildren = (children: ReactNode) =>
  Children.map(children, (child) =>
    isTextElement(child) ? (
      <div className="mb-1 inline-flex">{createElement(child.type, {...(child.props as object)})}</div>
    ) : (
      child
    ),
  )

// Stable references — avoids re-creating on every render
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const REMARK_PLUGINS: any[] = [[remarkFrontmatter, ['yaml', 'toml']], remarkGfm]

const MARKDOWN_COMPONENTS: Components = {
  a({children, href}) {
    return href ? (
      <a className="underline" href={href} rel="noopener noreferrer" target="_blank">
        {children}
      </a>
    ) : (
      <>{children}</>
    )
  },
  blockquote({children}) {
    return <blockquote className="border-input border-l-4 pl-4 italic">{children}</blockquote>
  },
  code({children, className: codeClassName}) {
    const languageMatch = /language-(\w+)/.exec(codeClassName ?? '')
    const language = languageMatch ? languageMatch[1] : ''
    const codeContent = String(children).replace(/\n$/, '')
    const isMultiLine = codeContent.includes('\n')

    return language || isMultiLine ? (
      <CodeBlock language={language} value={codeContent} />
    ) : (
      <code className="border-input bg-secondary rounded border px-1 py-0.5 text-amber-500">{codeContent}</code>
    )
  },
  h1({children}) {
    return <h1 className="text-2xl font-bold">{children}</h1>
  },
  h2({children}) {
    return <h2 className="text-xl font-bold">{children}</h2>
  },
  h3({children}) {
    return <h3 className="text-lg font-bold">{children}</h3>
  },
  h4({children}) {
    return <h4 className="text-base font-bold">{children}</h4>
  },
  h5({children}) {
    return <h5 className="text-sm font-bold">{children}</h5>
  },
  h6({children}) {
    return <h6 className="text-xs font-bold">{children}</h6>
  },
  hr() {
    return <hr className="my-4" />
  },
  li({children}) {
    return <li className="mt-1 [&>ol]:pl-4 [&>ul]:pl-4">{transformListItemChildren(children)}</li>
  },
  ol({children}) {
    return <ol className="list-inside list-decimal">{children}</ol>
  },
  p({children}) {
    return <p className="mb-2 whitespace-pre-wrap last:mb-0">{children}</p>
  },
  pre({children}) {
    return <pre className="rounded p-2">{children}</pre>
  },
  table({children}) {
    return (
      <div className="border-input overflow-x-auto rounded text-xs">
        <table className="min-w-full divide-y">{children}</table>
      </div>
    )
  },
  tbody({children}) {
    return <tbody className="divide-border divide-y">{children}</tbody>
  },
  td({children}) {
    return <td className="whitespace-nowrap px-4 py-2">{children}</td>
  },
  th({children}) {
    return <th className="px-4 py-2 text-left text-xs font-medium uppercase tracking-wider">{children}</th>
  },
  thead({children}) {
    return <thead>{children}</thead>
  },
  tr({children}) {
    return <tr>{children}</tr>
  },
  ul({children}) {
    if (isChecklist(children)) return <ul className="list-none">{children}</ul>
    return <ul className="list-inside list-disc">{children}</ul>
  },
}

// ── MarkdownView ───────────────────────────────────────────────────────────

interface MarkdownViewProps {
  className?: string
  content: string
}

/**
 * Renders file content as monospace text with conflict-marker LINES highlighted
 * (amber background). Content lines between markers stay un-tinted so the user
 * can focus on the markers themselves.
 */
function ConflictView({content}: {content: string}) {
  const lines = content.split('\n')
  let region: 'none' | 'ours' | 'theirs' = 'none'

  return (
    <pre className="bg-card overflow-x-auto rounded-md py-2 font-mono text-xs leading-6">
      {lines.map((line, i) => {
        let cls = 'block px-3 whitespace-pre-wrap break-all'
        if (line.startsWith('<<<<<<<')) {
          cls += ' bg-[#4f3422] text-[#ffc53d] font-semibold'
          region = 'ours'
        } else if (line.startsWith('=======') && region !== 'none') {
          cls += ' bg-[#4f3422] text-[#ffc53d] font-semibold'
          region = 'theirs'
        } else if (line.startsWith('>>>>>>>')) {
          cls += ' bg-[#4f3422] text-[#ffc53d] font-semibold'
          region = 'none'
        }

        return <span className={cls} key={i}>{line || '\u00A0'}</span>
      })}
    </pre>
  )
}

export function MarkdownView({className, content}: MarkdownViewProps) {
  const wrapperClass = className ?? 'bg-card text-secondary-foreground mx-auto min-h-0 w-full flex-1 space-y-2 overflow-y-auto break-words text-sm leading-7'

  // Markdown rendering breaks on conflict markers (`=======` is a setext heading underline,
  // `<<<<<<<` may be parsed as autolink), producing a misleading preview. Render a structured
  // conflict view instead so users can see exactly what's in each side of the conflict.
  if (hasConflictMarkers(content)) {
    return (
      <div className={wrapperClass}>
        <div className="bg-[#4f3422] text-[#ffc53d] mb-2 flex items-center gap-2 rounded-md px-3 py-2 text-xs">
          <AlertTriangle className="size-3.5 shrink-0" />
          <span>Unresolved conflict markers — showing raw content with side highlighting.</span>
        </div>
        <ConflictView content={content} />
      </div>
    )
  }

  return (
    <div className={wrapperClass}>
      <MemoizedReactMarkdown components={MARKDOWN_COMPONENTS} remarkPlugins={REMARK_PLUGINS}>
        {content}
      </MemoizedReactMarkdown>
    </div>
  )
}
