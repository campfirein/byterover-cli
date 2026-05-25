import {expect} from 'chai'

import type {AgentChangeOperation} from '../../../../../../src/shared/transport/events/review-events'
import type {ChangeFile} from '../../../../../../src/webui/features/vc/types'

import {joinAgentMeta} from '../../../../../../src/webui/features/vc/utils/join-agent-meta'

function makeFile(path: string, overrides: Partial<ChangeFile> = {}): ChangeFile {
  return {isStaged: false, path, status: 'modified', ...overrides}
}

function makeOp(filePath: string, overrides: Partial<AgentChangeOperation> = {}): AgentChangeOperation {
  return {
    filePath,
    opCreatedAt: 100,
    taskId: 'task-1',
    type: 'UPSERT',
    ...overrides,
  }
}

describe('joinAgentMeta', () => {
  it('returns the input files unchanged when no operations are provided', () => {
    const files = [makeFile('a.md'), makeFile('b.md')]
    const result = joinAgentMeta(files, [])
    expect(result).to.have.lengthOf(2)
    expect(result[0].agentMeta).to.be.undefined
    expect(result[1].agentMeta).to.be.undefined
  })

  it('attaches agentMeta to files whose path matches an operation', () => {
    const files = [makeFile('a.md'), makeFile('b.md')]
    const ops: AgentChangeOperation[] = [
      makeOp('a.md', {impact: 'high', reason: 'because', reviewStatus: 'pending', summary: 'summary-a'}),
    ]

    const result = joinAgentMeta(files, ops)
    expect(result[0].agentMeta).to.deep.equal({
      impact: 'high',
      opCreatedAt: 100,
      reason: 'because',
      reviewStatus: 'pending',
      summary: 'summary-a',
      taskId: 'task-1',
      type: 'UPSERT',
    })
    expect(result[1].agentMeta).to.be.undefined
  })

  it('keeps the latest op (highest opCreatedAt) when multiple ops target the same file', () => {
    const files = [makeFile('a.md')]
    const ops: AgentChangeOperation[] = [
      makeOp('a.md', {opCreatedAt: 100, summary: 'older', taskId: 'task-old'}),
      makeOp('a.md', {opCreatedAt: 300, summary: 'newer', taskId: 'task-new'}),
      makeOp('a.md', {opCreatedAt: 200, summary: 'middle', taskId: 'task-mid'}),
    ]

    const result = joinAgentMeta(files, ops)
    expect(result[0].agentMeta?.summary).to.equal('newer')
    expect(result[0].agentMeta?.opCreatedAt).to.equal(300)
    expect(result[0].agentMeta?.taskId).to.equal('task-new')
  })

  it('does not attach metadata for ops that target files not in the input list', () => {
    const files = [makeFile('a.md')]
    const ops: AgentChangeOperation[] = [makeOp('b.md', {summary: 'orphan'})]

    const result = joinAgentMeta(files, ops)
    expect(result[0].agentMeta).to.be.undefined
  })

  it('does not mutate the input file objects', () => {
    const files = [makeFile('a.md')]
    const ops: AgentChangeOperation[] = [makeOp('a.md', {summary: 'attached'})]

    const result = joinAgentMeta(files, ops)
    expect(files[0].agentMeta, 'original input must not be mutated').to.be.undefined
    expect(result[0].agentMeta?.summary).to.equal('attached')
  })

  it('preserves all existing ChangeFile fields when attaching agentMeta', () => {
    const files = [makeFile('a.md', {hasMarkers: true, isStaged: true, status: 'unmerged'})]
    const ops: AgentChangeOperation[] = [makeOp('a.md', {summary: 's'})]

    const result = joinAgentMeta(files, ops)
    expect(result[0].path).to.equal('a.md')
    expect(result[0].isStaged).to.be.true
    expect(result[0].status).to.equal('unmerged')
    expect(result[0].hasMarkers).to.be.true
    expect(result[0].agentMeta?.summary).to.equal('s')
  })
})
