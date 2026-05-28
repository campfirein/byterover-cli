import {expect} from 'chai'

import type {Task} from '../../../../../../src/tui/features/tasks/stores/tasks-store.js'

import {selectCancelTargetTaskId} from '../../../../../../src/tui/features/tasks/hooks/select-cancel-target.js'

function makeTask(overrides: Partial<Task> & Pick<Task, 'status' | 'taskId' | 'type'>): Task {
  return {
    content: 'irrelevant',
    createdAt: 0,
    input: 'irrelevant',
    toolCalls: [],
    ...overrides,
  }
}

describe('selectCancelTargetTaskId', () => {
  it('returns undefined when there are no tasks', () => {
    const tasks = new Map<string, Task>()
    expect(selectCancelTargetTaskId(tasks)).to.equal(undefined)
  })

  it('returns undefined when every task is terminal', () => {
    const tasks = new Map<string, Task>([
      ['a', makeTask({status: 'completed', taskId: 'a', type: 'curate'})],
      ['b', makeTask({status: 'cancelled', taskId: 'b', type: 'query'})],
      ['c', makeTask({status: 'error', taskId: 'c', type: 'curate'})],
    ])
    expect(selectCancelTargetTaskId(tasks)).to.equal(undefined)
  })

  it('returns the only running task when exactly one is non-terminal', () => {
    const tasks = new Map<string, Task>([
      ['a', makeTask({status: 'completed', taskId: 'a', type: 'curate'})],
      ['b', makeTask({createdAt: 5, status: 'started', taskId: 'b', type: 'curate'})],
    ])
    expect(selectCancelTargetTaskId(tasks)).to.equal('b')
  })

  it('returns the OLDEST running task when several are concurrently running', () => {
    // Policy: Ctrl+Q stops what is currently happening. Among running tasks,
    // pick the oldest — it has occupied the agent slot longest and is the
    // most natural "active" task in the user's mental model.
    const tasks = new Map<string, Task>([
      ['mid', makeTask({createdAt: 200, status: 'started', taskId: 'mid', type: 'query'})],
      ['new', makeTask({createdAt: 300, status: 'started', taskId: 'new', type: 'curate'})],
      ['old', makeTask({createdAt: 100, status: 'started', taskId: 'old', type: 'curate'})],
    ])
    expect(selectCancelTargetTaskId(tasks)).to.equal('old')
  })

  it('prefers a running task over any queued (created-status) task', () => {
    // Regression for the multi-curate bug: ctrl+q must stop the running task,
    // not the most-recently-queued one. Cancelling the runner also frees the
    // slot so the queue drains naturally.
    const tasks = new Map<string, Task>([
      ['queued-newer', makeTask({createdAt: 300, status: 'created', taskId: 'queued-newer', type: 'curate'})],
      ['queued-older', makeTask({createdAt: 150, status: 'created', taskId: 'queued-older', type: 'curate'})],
      ['running', makeTask({createdAt: 100, status: 'started', taskId: 'running', type: 'curate'})],
    ])
    expect(selectCancelTargetTaskId(tasks)).to.equal('running')
  })

  it('falls back to the OLDEST queued task when nothing is running yet', () => {
    // Cold-start scenario: the agent has not yet picked anything up. The
    // oldest queued task is closest to dispatch, so cancelling it is the
    // FIFO-consistent choice (matches what the user just submitted first).
    const tasks = new Map<string, Task>([
      ['a', makeTask({createdAt: 100, status: 'created', taskId: 'a', type: 'curate'})],
      ['b', makeTask({createdAt: 200, status: 'created', taskId: 'b', type: 'curate'})],
      ['c', makeTask({createdAt: 300, status: 'created', taskId: 'c', type: 'curate'})],
    ])
    expect(selectCancelTargetTaskId(tasks)).to.equal('a')
  })

  it('treats `created` status as non-terminal (still cancellable before task:started)', () => {
    const tasks = new Map<string, Task>([
      ['a', makeTask({createdAt: 10, status: 'created', taskId: 'a', type: 'curate'})],
    ])
    expect(selectCancelTargetTaskId(tasks)).to.equal('a')
  })

  it('ignores terminal siblings even when newer than running ones', () => {
    const tasks = new Map<string, Task>([
      ['fresh-but-done', makeTask({createdAt: 200, status: 'completed', taskId: 'fresh-but-done', type: 'curate'})],
      ['running', makeTask({createdAt: 100, status: 'started', taskId: 'running', type: 'curate'})],
    ])
    expect(selectCancelTargetTaskId(tasks)).to.equal('running')
  })
})
