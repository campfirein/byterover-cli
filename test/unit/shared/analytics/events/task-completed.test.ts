/* eslint-disable camelcase */
import {expect} from 'chai'

import {TaskCompletedSchema} from '../../../../../src/shared/analytics/events/task-completed.js'

const baseValid = {
  duration_ms: 250,
  task_id: '550e8400-e29b-41d4-a716-446655440000',
  task_type: 'query' as const,
}

describe('TaskCompletedSchema', () => {
  it('should accept a valid payload', () => {
    expect(TaskCompletedSchema.safeParse(baseValid).success).to.equal(true)
  })

  it('should accept duration_ms=0', () => {
    expect(TaskCompletedSchema.safeParse({...baseValid, duration_ms: 0}).success).to.equal(true)
  })

  it('should reject negative duration_ms', () => {
    expect(TaskCompletedSchema.safeParse({...baseValid, duration_ms: -1}).success).to.equal(false)
  })

  it('should reject non-integer duration_ms', () => {
    expect(TaskCompletedSchema.safeParse({...baseValid, duration_ms: 1.5}).success).to.equal(false)
  })

  it('should reject unknown task_type', () => {
    expect(TaskCompletedSchema.safeParse({...baseValid, task_type: 'mystery'}).success).to.equal(false)
  })

  it('should reject empty task_id', () => {
    expect(TaskCompletedSchema.safeParse({...baseValid, task_id: ''}).success).to.equal(false)
  })

  it('should reject unknown extra fields (strict)', () => {
    expect(TaskCompletedSchema.safeParse({...baseValid, result: 'leaked output'}).success).to.equal(false)
  })

  it('should reject missing required field', () => {
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    const {duration_ms: _, ...withoutDuration} = baseValid
    expect(TaskCompletedSchema.safeParse(withoutDuration).success).to.equal(false)
  })
})
