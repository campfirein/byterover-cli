import {curateHtmlDirectRowTitle, isCurateHtmlDirectType} from './curate-tool-mode'
import {isQueryToolModeType, queryToolModeRowTitle} from './query-tool-mode-results'

export function taskDisplayTitle(task: {content: string; type: string}): string | undefined {
  if (isCurateHtmlDirectType(task.type)) return curateHtmlDirectRowTitle(task.content)
  if (isQueryToolModeType(task.type)) return queryToolModeRowTitle(task.content) ?? task.content
  return task.content
}
