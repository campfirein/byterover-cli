import {toast} from 'sonner'

import type {TaskCreateRequest} from '../../../../shared/transport/events/task-events'
import type {ComposerType} from '../components/task-composer-types'

import {generateUuid} from '../../../lib/uuid'
import {useCreateTask} from '../api/create-task'

/**
 * Encapsulates the create-task mutation, the provider gate redirect, and the
 * toast plumbing so the composer body stays focused on layout.
 */
export function useComposerSubmit(args: {
  content: string
  hasActiveProvider: boolean
  onClose: () => void
  onProviderRequired: () => void
  onSubmitted?: (taskId: string, openDetail: boolean) => void
  openDetailAfter: boolean
  projectPath: string
  type: ComposerType
}) {
  const createMutation = useCreateTask()
  const canSubmit = args.content.trim().length > 0
  const {isPending} = createMutation

  const submit = async () => {
    if (!canSubmit || isPending) return

    if (!args.hasActiveProvider) {
      args.onProviderRequired()
      return
    }

    const taskId = generateUuid()
    const payload: TaskCreateRequest = {
      ...(args.projectPath ? {clientCwd: args.projectPath, projectPath: args.projectPath} : {}),
      content: args.content.trim(),
      taskId,
      type: args.type,
    }

    try {
      await createMutation.mutateAsync(payload)
      const verb = args.type === 'query' ? 'Query' : 'Curate'
      toast.success(`${verb} task queued`)
      args.onSubmitted?.(taskId, args.openDetailAfter)
      args.onClose()
    } catch (error) {
      toast.error(error instanceof Error ? error.message : 'Failed to create task')
    }
  }

  return {canSubmit, isPending, submit}
}
