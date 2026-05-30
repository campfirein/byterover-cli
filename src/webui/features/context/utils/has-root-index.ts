import type {ContextTreeNodeDTO} from '../../../../shared/transport/events'

export const ROOT_INDEX_PATH = 'index.html'

export function hasRootIndex(nodes: ContextTreeNodeDTO[], selectedPath: string): boolean {
  if (selectedPath) return false
  return nodes.some((node) => node.path === ROOT_INDEX_PATH && node.type === 'blob')
}
