import {AlertTriangle} from 'lucide-react'

export const DEFAULT_WRAPPER_CLASS =
  'bg-card text-secondary-foreground mx-auto min-h-0 w-full flex-1 space-y-2 overflow-y-auto break-words text-sm leading-7'

interface ConflictContentViewProps {
  className?: string
  content: string
}

export function ConflictContentView({className, content}: ConflictContentViewProps) {
  return (
    <div className={className ?? DEFAULT_WRAPPER_CLASS}>
      <div className="bg-[#4f3422] text-[#ffc53d] mb-2 flex items-center gap-2 rounded-md px-3 py-2 text-xs">
        <AlertTriangle className="size-3.5 shrink-0" />
        <span>Unresolved conflict markers — showing raw content with marker lines highlighted.</span>
      </div>
      <ConflictRawView content={content} />
    </div>
  )
}

function classifyMarkerLines(lines: string[]): boolean[] {
  let insideConflict = false
  return lines.map((line) => {
    if (line.startsWith('<<<<<<<')) {
      insideConflict = true
      return true
    }

    if (line.startsWith('>>>>>>>')) {
      insideConflict = false
      return true
    }

    return insideConflict && line.startsWith('=======')
  })
}

function ConflictRawView({content}: {content: string}) {
  const lines = content.split('\n')
  const isMarker = classifyMarkerLines(lines)

  return (
    <pre className="bg-card overflow-x-auto rounded-md py-2 font-mono text-xs leading-6">
      {lines.map((line, i) => {
        const cls = isMarker[i]
          ? 'block px-3 whitespace-pre-wrap break-all bg-[#4f3422] text-[#ffc53d] font-semibold'
          : 'block px-3 whitespace-pre-wrap break-all'
        return (
          <span className={cls} key={i}>
            {line || '\u00A0'}
          </span>
        )
      })}
    </pre>
  )
}
