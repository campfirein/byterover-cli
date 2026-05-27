import {createContext, type ReactNode, useCallback, useContext, useEffect, useMemo, useState} from 'react'
import {useSearchParams} from 'react-router-dom'

import type {ContextTreeNodeDTO} from '../../../../shared/transport/events'

import {useGetContextFile} from '../api/get-context-file'
import {useGetContextNodes} from '../api/get-context-nodes'
import {useUpdateContextFile} from '../api/update-context-file'
import {findNodeByPath, flattenTree, getExpandedPathsForPath, isFilePath} from '../utils/tree-utils'

interface ContextTreeContextValue {
  branch?: string
  cancelEdit: () => void
  editContent: string
  enterEditMode: () => void
  expandedPaths: Set<string>
  fileData: undefined | {content: string; path: string; tags: string[]; title: string}
  flattenedNodes: ReturnType<typeof flattenTree>
  handleSelect: (node: ContextTreeNodeDTO) => void
  handleToggle: (node: ContextTreeNodeDTO) => void
  hasChanges: boolean
  isEditMode: boolean
  isFetchingFile: boolean
  isFetchingTree: boolean
  isUpdating: boolean
  navigateHome: () => void
  navigateToPath: (path: string) => void
  nodes: ContextTreeNodeDTO[]
  saveChanges: () => Promise<void>
  selectedNode: ContextTreeNodeDTO | undefined
  selectedPath: string
  setEditContent: (content: string) => void
}

const ContextTreeContext = createContext<ContextTreeContextValue | undefined>(undefined)

export function ContextTreeProvider({children}: {children: ReactNode}) {
  const [searchParams, setSearchParams] = useSearchParams()
  const branch = searchParams.get('branch') ?? undefined
  const selectedPath = searchParams.get('path') ?? ''

  const [expandedPaths, setExpandedPaths] = useState<Set<string>>(() => getExpandedPathsForPath(selectedPath))
  const [isEditMode, setIsEditMode] = useState(false)
  const [editContent, setEditContent] = useState('')

  const {data: nodesResponse, isFetching: isFetchingTree} = useGetContextNodes({branch})

  const {data: fileResponse, isFetching: isFetchingFile} = useGetContextFile({
    branch,
    path: selectedPath,
    queryConfig: {
      enabled: Boolean(selectedPath) && isFilePath(selectedPath),
    },
  })

  useEffect(() => {
    if (nodesResponse?.branch && !searchParams.has('branch')) {
      setSearchParams(
        (prev) => {
          const next = new URLSearchParams(prev)
          next.set('branch', nodesResponse.branch)
          return next
        },
        {replace: true},
      )
    }
  }, [nodesResponse?.branch, searchParams, setSearchParams])

  const nodes = useMemo(() => nodesResponse?.nodes ?? [], [nodesResponse])
  const selectedNode = useMemo(
    () => (selectedPath ? findNodeByPath(nodes, selectedPath) : undefined),
    [nodes, selectedPath],
  )
  const flattenedNodes = useMemo(() => flattenTree(nodes, expandedPaths), [nodes, expandedPaths])
  const fileData = fileResponse?.file

  const expandNestedPath = useCallback((path: string) => {
    const pathsToExpand = getExpandedPathsForPath(path)
    setExpandedPaths((prev) => new Set([...pathsToExpand, ...prev]))
  }, [])

  const handleToggle = useCallback((node: ContextTreeNodeDTO) => {
    setExpandedPaths((prev) => {
      const next = new Set(prev)
      if (next.has(node.path)) {
        next.delete(node.path)
      } else {
        next.add(node.path)
      }

      return next
    })
  }, [])

  const navigateToPath = useCallback(
    (path: string) => {
      expandNestedPath(path)

      setSearchParams(
        (prev) => {
          const next = new URLSearchParams(prev)
          next.set('path', path)
          return next
        },
        {replace: true},
      )

      setIsEditMode(false)
      setEditContent('')
    },
    [expandNestedPath, setSearchParams],
  )

  const handleSelect = useCallback((node: ContextTreeNodeDTO) => navigateToPath(node.path), [navigateToPath])

  const navigateHome = useCallback(() => {
    setSearchParams(
      (prev) => {
        const next = new URLSearchParams(prev)
        next.delete('path')
        return next
      },
      {replace: true},
    )
    setIsEditMode(false)
    setEditContent('')
  }, [setSearchParams])

  const updateMutation = useUpdateContextFile()

  const enterEditMode = useCallback(() => {
    if (fileData) {
      setEditContent(fileData.content)
      setIsEditMode(true)
    }
  }, [fileData])

  const cancelEdit = useCallback(() => {
    setIsEditMode(false)
    setEditContent('')
  }, [])

  const saveChanges = useCallback(async () => {
    if (!selectedPath || !isEditMode) return

    await updateMutation.mutateAsync({
      content: editContent,
      path: selectedPath,
    })

    setIsEditMode(false)
  }, [editContent, isEditMode, selectedPath, updateMutation])

  const hasChanges = isEditMode && fileData !== undefined && editContent !== fileData.content

  const value: ContextTreeContextValue = {
    branch: nodesResponse?.branch ?? branch,
    cancelEdit,
    editContent,
    enterEditMode,
    expandedPaths,
    fileData,
    flattenedNodes,
    handleSelect,
    handleToggle,
    hasChanges,
    isEditMode,
    isFetchingFile,
    isFetchingTree,
    isUpdating: updateMutation.isPending,
    navigateHome,
    navigateToPath,
    nodes,
    saveChanges,
    selectedNode,
    selectedPath,
    setEditContent,
  }

  return <ContextTreeContext.Provider value={value}>{children}</ContextTreeContext.Provider>
}

export function useContextTree(): ContextTreeContextValue {
  const context = useContext(ContextTreeContext)
  if (!context) {
    throw new Error('useContextTree must be used within a ContextTreeProvider')
  }

  return context
}
