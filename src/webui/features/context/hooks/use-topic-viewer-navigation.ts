import {useMemo} from 'react'
import {toast} from 'sonner'

import {createTopicViewerNavigation} from '../utils/topic-viewer-navigation'
import {findNodeByPath} from '../utils/tree-utils'
import {useContextTree} from './use-context-tree'

export function useTopicViewerNavigation() {
  const {navigateToPath, nodes} = useContextTree()

  return useMemo(
    () =>
      createTopicViewerNavigation({
        navigate: navigateToPath,
        onStalePath: (path) => toast.error(`Path not found in context tree: ${path}`),
        pathExists: (path) => findNodeByPath(nodes, path) !== undefined,
      }),
    [navigateToPath, nodes],
  )
}
