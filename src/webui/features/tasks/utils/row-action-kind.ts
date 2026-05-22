import type {TaskListItemStatus} from '../../../../shared/transport/events/task-events'

import {isTerminalStatus} from './task-status'

export type RowActionKind = 'cancel' | 'delete'

export function rowActionKind(status: TaskListItemStatus): RowActionKind {
  return isTerminalStatus(status) ? 'delete' : 'cancel'
}
