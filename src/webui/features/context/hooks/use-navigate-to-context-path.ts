import {useNavigate} from 'react-router-dom'
import {toast} from 'sonner'

import {useGetContextNodes} from '../api/get-context-nodes'
import {stalePathMessage} from '../utils/topic-viewer-navigation'
import {findNodeByPath} from '../utils/tree-utils'

export function useNavigateToContextPath() {
  const navigate = useNavigate()
  const {data} = useGetContextNodes()
  const nodes = data?.nodes ?? []

  return (path: string) => {
    if (findNodeByPath(nodes, path)) {
      navigate(`/contexts?path=${encodeURIComponent(path)}`)
    } else {
      toast.error(stalePathMessage(path))
    }
  }
}
