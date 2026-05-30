import {AuthorInfo} from '@campfirein/byterover-packages/components/contexts/author-info'
import {DetailBody} from '@campfirein/byterover-packages/components/contexts/detail-body'
import {Skeleton} from '@campfirein/byterover-packages/components/skeleton'
import {TopicEditor} from '@campfirein/byterover-packages/components/topic-viewer/topic-editor'
import {TopicViewer} from '@campfirein/byterover-packages/components/topic-viewer/topic-viewer'
import {formatDistanceToNow} from 'date-fns'
import {useCallback, useState} from 'react'

import {hasConflictMarkers} from '../../../../shared/utils/conflict-markers'
import {noop} from '../../../lib/noop'
import {useGetContextFile} from '../api/get-context-file'
import {useGetContextHistory} from '../api/get-context-history'
import {useUpdateContextFile} from '../api/update-context-file'
import {useContextTree} from '../hooks/use-context-tree'
import {useTopicViewerNavigation} from '../hooks/use-topic-viewer-navigation'
import {ROOT_INDEX_PATH} from '../utils/has-root-index'
import {ConflictContentView} from './conflict-content-view'
import {ContextBreadcrumb} from './context-breadcrumb'

interface RootIndexDetailProps {
  onToggleHistory?: () => void
}

export function RootIndexDetail({onToggleHistory}: RootIndexDetailProps) {
  const {branch} = useContextTree()
  const {onBreadcrumbClick, onEntryClick, onRelatedClick} = useTopicViewerNavigation()

  const {data: fileResponse, isFetching: isFetchingFile} = useGetContextFile({
    branch,
    path: ROOT_INDEX_PATH,
  })
  const fileData = fileResponse?.file

  const {data: historyData, isPending: isHistoryPending} = useGetContextHistory({path: ROOT_INDEX_PATH})
  const lastCommit = historyData?.pages[0]?.commits[0]

  const [isEditMode, setIsEditMode] = useState(false)
  const [editContent, setEditContent] = useState('')
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
    if (!isEditMode) return
    await updateMutation.mutateAsync({content: editContent, path: ROOT_INDEX_PATH})
    setIsEditMode(false)
  }, [editContent, isEditMode, updateMutation])

  const hasChanges = isEditMode && fileData !== undefined && editContent !== fileData.content

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
            ) : (
              <TopicViewer
                breadcrumb={{onBreadcrumbClick}}
                html={fileData.content}
                index={{onEntryClick}}
                related={{onRelatedClick}}
              />
            )
          ) : undefined
        }
        editContent={editContent}
        editView={
          isEditMode ? (
            <TopicEditor disabled={updateMutation.isPending} language="html" onChange={setEditContent} value={editContent} />
          ) : undefined
        }
        fileName={fileData?.title ?? ROOT_INDEX_PATH}
        hasChanges={hasChanges}
        headerClassName="py-4"
        isEditMode={isEditMode}
        isHistoryVisible={false}
        isLoading={isFetchingFile}
        isUpdating={updateMutation.isPending}
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
              description={`${lastCommit.author.name} updated ${ROOT_INDEX_PATH}`}
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
