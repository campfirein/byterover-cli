import type {FlattenedTreeNode} from '@campfirein/byterover-packages/components/contexts/tree-view'

import type {ContextNode} from '../types'

/** Returns `true` if the path points to a context-tree file (`.md` or `.html`). */
export const isFilePath = (path: string): boolean => path.endsWith('.md') || path.endsWith('.html')

/**
 * Returns all parent folder paths that need to be expanded to reveal a given path.
 * File paths exclude the file itself; folder paths include the folder.
 *
 * @example
 * getExpandedPathsForPath("docs/api/endpoint.md") // → Set(["docs", "docs/api"])
 * getExpandedPathsForPath("docs/folder")           // → Set(["docs", "docs/folder"])
 * getExpandedPathsForPath("")                       // → Set()
 */
export const getExpandedPathsForPath = (filePath: string): Set<string> => {
  const expanded = new Set<string>()
  if (!filePath) return expanded

  const parts = filePath.split('/').filter(Boolean)
  for (let i = 0; i < parts.length; i++) {
    const currentPath = parts.slice(0, i + 1).join('/')
    const isLast = i === parts.length - 1
    if (!(isLast && isFilePath(currentPath))) {
      expanded.add(currentPath)
    }
  }

  return expanded
}

/** Recursively searches a tree to find a node matching `targetPath`. */
export const findNodeByPath = (nodes: ContextNode[], targetPath: string): ContextNode | undefined => {
  for (const node of nodes) {
    if (node.path === targetPath) return node
    if (node.type === 'tree' && node.children && targetPath.startsWith(node.path + '/')) {
      const found = findNodeByPath(node.children, targetPath)
      if (found) return found
    }
  }

  return undefined
}

/**
 * Flattens a hierarchical tree into a list for `TreeView` consumption.
 * Only descends into folders present in `expandedPaths`.
 * Expects nodes to be pre-sorted by the server.
 */
export const flattenTree = (
  nodes: ContextNode[],
  expandedPaths: Set<string>,
  depth = 0,
  result: FlattenedTreeNode[] = [],
): FlattenedTreeNode[] => {
  for (const node of nodes) {
    result.push({depth, node})
    if (node.type === 'tree' && expandedPaths.has(node.path) && node.children) {
      flattenTree(node.children, expandedPaths, depth + 1, result)
    }
  }

  return result
}
