import {AuthorInfo} from '@campfirein/byterover-packages/components/contexts/author-info'
import {DetailBody} from '@campfirein/byterover-packages/components/contexts/detail-body'
import {FolderDetail, type FolderNode} from '@campfirein/byterover-packages/components/contexts/folder-detail'
import {Skeleton} from '@campfirein/byterover-packages/components/skeleton'
import {TopicEditor, type TopicEditorLanguage} from '@campfirein/byterover-packages/components/topic-viewer/topic-editor'
import {TopicViewer} from '@campfirein/byterover-packages/components/topic-viewer/topic-viewer'
import {formatDistanceToNow} from 'date-fns'
import {useMemo} from 'react'

import type {ContextNode} from '../types'

import {hasConflictMarkers} from '../../../../shared/utils/conflict-markers'
import {noop} from '../../../lib/noop'
import {useGetContextFileMetadata} from '../api/get-context-file-metadata'
import {useGetContextHistory} from '../api/get-context-history'
import {useContextTree} from '../hooks/use-context-tree'
import {useTopicViewerNavigation} from '../hooks/use-topic-viewer-navigation'
import {hasRootIndex} from '../utils/has-root-index'
import {isFilePath} from '../utils/tree-utils'
import {ConflictContentView} from './conflict-content-view'
import {ContextBreadcrumb} from './context-breadcrumb'
import {MarkdownView} from './markdown-view'
import {RootIndexDetail} from './root-index-detail'

const isHtmlPath = (path: string | undefined): boolean => Boolean(path && path.toLowerCase().endsWith('.html'))

const editorLanguageFor = (path: string | undefined): TopicEditorLanguage => {
  if (!path) return 'text'
  const lower = path.toLowerCase()
  if (lower.endsWith('.html')) return 'html'
  if (lower.endsWith('.md')) return 'markdown'
  return 'text'
}

interface ContextDetailPanelProps {
  onToggleHistory?: () => void
}

export function ContextDetailPanel({onToggleHistory}: ContextDetailPanelProps) {
  const {
    cancelEdit,
    editContent,
    enterEditMode,
    fileData,
    handleSelect,
    hasChanges,
    isEditMode,
    isFetchingFile,
    isUpdating,
    navigateHome,
    nodes,
    saveChanges,
    selectedNode,
    selectedPath,
    setEditContent,
  } = useContextTree()
  const {onBreadcrumbClick, onEntryClick, onRelatedClick} = useTopicViewerNavigation()

  const {data: historyData, isPending: isHistoryPending} = useGetContextHistory({
    enabled: Boolean(selectedPath) && isFilePath(selectedPath),
    path: selectedPath,
  })

  const lastCommit = historyData?.pages[0]?.commits[0]

  const folderChildren = useMemo(() => {
    if (!selectedNode || selectedNode.type !== 'tree') {
      return selectedNode ? [] : nodes
    }

    return selectedNode.children ?? []
  }, [selectedNode, nodes])

  const metadataPaths = useMemo(
    () => folderChildren.map((n) => n.path),
    [folderChildren],
  )

  const {data: metadataResponse} = useGetContextFileMetadata({
    enabled: metadataPaths.length > 0,
    paths: metadataPaths,
  })

  const folderNodes: FolderNode[] = useMemo(() => {
    const metadataMap = new Map((metadataResponse?.files ?? []).map((f) => [f.path, f]))

    return folderChildren.map((node) => {
      const meta = metadataMap.get(node.path)
      return {
        lastUpdatedBy: meta?.lastUpdatedBy,
        lastUpdatedWhen: meta?.lastUpdatedWhen
          ? formatDistanceToNow(new Date(meta.lastUpdatedWhen), {addSuffix: true})
          : undefined,
        name: node.name,
        path: node.path,
        type: node.type,
      }
    })
  }, [folderChildren, metadataResponse])

  const handleFolderNodeClick = (folderNode: FolderNode) => {
    const original = folderChildren.find((n) => n.path === folderNode.path)
    if (original) handleSelect(original)
  }

  const handleBack = () => {
    if (!selectedPath) return

    const parts = selectedPath.split('/').filter(Boolean)
    if (parts.length <= 1) {
      navigateHome()
      return
    }

    const parentPath = parts.slice(0, -1).join('/')
    const parentNode: ContextNode = {
      children: [],
      name: '..',
      path: parentPath,
      type: 'tree',
    }

    handleSelect(parentNode)
  }

  if (selectedNode?.type === 'blob') {
    const isHtml = isHtmlPath(selectedNode.path)
    return (
      <div className="flex h-full flex-1 flex-col">
        <div className="px-5 pt-5">
          <ContextBreadcrumb />
        </div>
        <DetailBody
          canEdit
          content={fileData?.content ?? ''}
          contentView={
            !isEditMode && fileData?.content ? (
              hasConflictMarkers(fileData.content) ? (
                <ConflictContentView content={fileData.content} />
              ) : isHtml ? (
                <TopicViewer
                  breadcrumb={{onBreadcrumbClick}}
                  html={fileData.content}
                  index={{onEntryClick}}
                  related={{onRelatedClick}}
                />
              ) : (
                <MarkdownView content={fileData.content} />
              )
            ) : undefined
          }
          editContent={editContent}
          editView={
            isEditMode ? (
              <TopicEditor
                disabled={isUpdating}
                language={editorLanguageFor(selectedNode.path)}
                onChange={setEditContent}
                value={editContent}
              />
            ) : undefined
          }
          fileName={fileData?.title ?? selectedNode.name}
          hasChanges={hasChanges}
          headerClassName={isHtml ? 'py-4' : 'pt-4 pb-0'}
          isEditMode={isEditMode}
          isHistoryVisible={false}
          isLoading={isFetchingFile}
          isUpdating={isUpdating}
          onCancelEdit={cancelEdit}
          onContentChange={setEditContent}
          onEnterEditMode={enterEditMode}
          onSaveChanges={saveChanges}
          onToggleHistory={onToggleHistory ?? noop}
          showTags={false}
          tags={fileData?.tags}
          timeline={
            lastCommit ? (
              <AuthorInfo
                className="mx-5 mb-5"
                description={`${lastCommit.author.name} updated ${selectedNode.name}`}
                name={lastCommit.author.name}
                timestamp={formatDistanceToNow(new Date(lastCommit.timestamp), {addSuffix: true})}
              />
            ) : isHistoryPending ? (
              <div className="border-border mx-5 mb-5 flex items-center gap-2 border-b py-2">
                <Skeleton className="size-6 shrink-0 rounded-full" />
                <Skeleton className="h-4 w-56" />
              </div>
            ) : undefined
          }
        />
      </div>
    )
  }

  if (hasRootIndex(nodes, selectedPath)) {
    return <RootIndexDetail onToggleHistory={onToggleHistory} />
  }

  return (
    <div className="flex-1 h-full flex-col flex p-5 gap-4">
      <ContextBreadcrumb />
      <FolderDetail
        nodes={folderNodes}
        onBack={handleBack}
        onNodeClick={handleFolderNodeClick}
        showBack={Boolean(selectedPath)}
      />
    </div>
  )
}
