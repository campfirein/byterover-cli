/* eslint-disable camelcase */
import {expect} from 'chai'

import {TaskFailedSchema} from '../../../../../src/shared/analytics/events/task-failed.js'

const baseValid = {
  duration_ms: 9000,
  task_id: '550e8400-e29b-41d4-a716-446655440000',
  task_type: 'curate' as const,
}

describe('TaskFailedSchema', () => {
  it('should accept a valid payload', () => {
    expect(TaskFailedSchema.safeParse(baseValid).success).to.equal(true)
  })

  it('should accept duration_ms=0', () => {
    expect(TaskFailedSchema.safeParse({...baseValid, duration_ms: 0}).success).to.equal(true)
  })

  it('should reject negative duration_ms', () => {
    expect(TaskFailedSchema.safeParse({...baseValid, duration_ms: -1}).success).to.equal(false)
  })

  it('should reject unknown task_type', () => {
    expect(TaskFailedSchema.safeParse({...baseValid, task_type: 'mystery'}).success).to.equal(false)
  })

  it('should reject empty task_id', () => {
    expect(TaskFailedSchema.safeParse({...baseValid, task_id: ''}).success).to.equal(false)
  })

  it('should reject error_message field — privacy lock (strict)', () => {
    expect(TaskFailedSchema.safeParse({...baseValid, error_message: 'EACCES /home/u/secret.txt'}).success).to.equal(false)
  })

  it('should reject unknown extra fields (strict)', () => {
    expect(TaskFailedSchema.safeParse({...baseValid, stack: 'at Foo:bar'}).success).to.equal(false)
  })

  it('should reject missing required field', () => {
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    const {task_id: _, ...withoutTaskId} = baseValid
    expect(TaskFailedSchema.safeParse(withoutTaskId).success).to.equal(false)
  })
})
