/* eslint-disable camelcase */
import {expect} from 'chai'

import {CurateRunCompletedSchema} from '../../../../../src/shared/analytics/events/curate-run-completed.js'

const baseValid = {
  duration_ms: 5000,
  operations_added: 1,
  operations_deleted: 0,
  operations_failed: 0,
  operations_merged: 0,
  operations_updated: 2,
  outcome: 'completed' as const,
  pending_review_count: 0,
  task_id: 'task-uuid-123',
  task_type: 'curate' as const,
}

describe('CurateRunCompletedSchema', () => {
  describe('valid payloads', () => {
    it('accepts the minimal required payload', () => {
      expect(CurateRunCompletedSchema.safeParse(baseValid).success).to.equal(true)
    })

    it('accepts each task_type enum value', () => {
      for (const task_type of ['curate', 'curate-folder'] as const) {
        expect(CurateRunCompletedSchema.safeParse({...baseValid, task_type}).success).to.equal(true)
      }
    })

    it('accepts each outcome enum value', () => {
      for (const outcome of ['completed', 'partial', 'cancelled', 'error'] as const) {
        expect(CurateRunCompletedSchema.safeParse({...baseValid, outcome}).success).to.equal(true)
      }
    })

    it('accepts zero counts and duration_ms=0', () => {
      const zeroed = {
        ...baseValid,
        duration_ms: 0,
        operations_added: 0,
        operations_deleted: 0,
        operations_failed: 0,
        operations_merged: 0,
        operations_updated: 0,
        pending_review_count: 0,
      }
      expect(CurateRunCompletedSchema.safeParse(zeroed).success).to.equal(true)
    })
  })

  describe('invalid payloads', () => {
    it('rejects missing required fields', () => {
      // eslint-disable-next-line @typescript-eslint/no-unused-vars
      const {outcome: _o, ...withoutOutcome} = baseValid
      expect(CurateRunCompletedSchema.safeParse(withoutOutcome).success).to.equal(false)
      // eslint-disable-next-line @typescript-eslint/no-unused-vars
      const {task_id: _t, ...withoutTaskId} = baseValid
      expect(CurateRunCompletedSchema.safeParse(withoutTaskId).success).to.equal(false)
    })

    it('rejects out-of-enum outcome', () => {
      expect(CurateRunCompletedSchema.safeParse({...baseValid, outcome: 'mystery'}).success).to.equal(false)
    })

    it('rejects out-of-enum task_type', () => {
      expect(CurateRunCompletedSchema.safeParse({...baseValid, task_type: 'query'}).success).to.equal(false)
    })

    it('rejects negative counts and duration_ms', () => {
      expect(CurateRunCompletedSchema.safeParse({...baseValid, duration_ms: -1}).success).to.equal(false)
      expect(CurateRunCompletedSchema.safeParse({...baseValid, operations_added: -1}).success).to.equal(false)
      expect(CurateRunCompletedSchema.safeParse({...baseValid, pending_review_count: -1}).success).to.equal(false)
    })

    it('rejects non-integer counts', () => {
      expect(CurateRunCompletedSchema.safeParse({...baseValid, operations_added: 1.5}).success).to.equal(false)
      expect(CurateRunCompletedSchema.safeParse({...baseValid, duration_ms: 1.5}).success).to.equal(false)
    })

    it('rejects empty task_id', () => {
      expect(CurateRunCompletedSchema.safeParse({...baseValid, task_id: ''}).success).to.equal(false)
    })

    it('rejects unknown extra fields (strict)', () => {
      expect(CurateRunCompletedSchema.safeParse({...baseValid, mystery_field: 'oops'}).success).to.equal(false)
    })
  })
})
