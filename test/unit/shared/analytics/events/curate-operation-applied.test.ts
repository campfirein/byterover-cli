/* eslint-disable camelcase */
import {expect} from 'chai'

import {CurateOperationAppliedSchema} from '../../../../../src/shared/analytics/events/curate-operation-applied.js'

const baseValid = {
  absolute_path: '/Users/dev/project/.brv/context-tree/notes/test.md',
  knowledge_path: 'notes/test',
  needs_review: false,
  operation_type: 'ADD' as const,
  task_id: 'task-uuid-123',
}

describe('CurateOperationAppliedSchema', () => {
  describe('valid payloads', () => {
    it('accepts the minimal required payload', () => {
      expect(CurateOperationAppliedSchema.safeParse(baseValid).success).to.equal(true)
    })

    it('accepts each operation_type enum value', () => {
      for (const operation_type of ['ADD', 'UPDATE', 'DELETE', 'MERGE', 'UPSERT'] as const) {
        expect(CurateOperationAppliedSchema.safeParse({...baseValid, operation_type}).success).to.equal(true)
      }
    })

    it('accepts optional impact and confidence enum values', () => {
      expect(CurateOperationAppliedSchema.safeParse({...baseValid, confidence: 'high', impact: 'low'}).success).to.equal(
        true,
      )
    })

    it('accepts needs_review=true', () => {
      expect(CurateOperationAppliedSchema.safeParse({...baseValid, needs_review: true}).success).to.equal(true)
    })

    it('accepts payloads omitting any/all of tags, keywords, related', () => {
      expect(CurateOperationAppliedSchema.safeParse({...baseValid}).success).to.equal(true)
      expect(CurateOperationAppliedSchema.safeParse({...baseValid, tags: ['a']}).success).to.equal(true)
      expect(CurateOperationAppliedSchema.safeParse({...baseValid, keywords: ['k']}).success).to.equal(true)
      expect(CurateOperationAppliedSchema.safeParse({...baseValid, related: ['r']}).success).to.equal(true)
      expect(
        CurateOperationAppliedSchema.safeParse({...baseValid, keywords: ['k'], related: ['r'], tags: ['t']}).success,
      ).to.equal(true)
    })

    it('accepts tags / keywords / related with exactly 50 entries each', () => {
      const fifty = Array.from({length: 50}, (_, i) => `entry-${i}`)
      expect(
        CurateOperationAppliedSchema.safeParse({...baseValid, keywords: fifty, related: fifty, tags: fifty}).success,
      ).to.equal(true)
    })

    it('accepts tags / keywords / related entries up to 256 chars each', () => {
      const at256 = 'x'.repeat(256)
      expect(CurateOperationAppliedSchema.safeParse({...baseValid, tags: [at256]}).success).to.equal(true)
    })
  })

  describe('invalid payloads', () => {
    it('rejects missing required fields', () => {
      // eslint-disable-next-line @typescript-eslint/no-unused-vars
      const {operation_type: _omit, ...withoutOpType} = baseValid
      expect(CurateOperationAppliedSchema.safeParse(withoutOpType).success).to.equal(false)
      // eslint-disable-next-line @typescript-eslint/no-unused-vars
      const {task_id: _omit2, ...withoutTaskId} = baseValid
      expect(CurateOperationAppliedSchema.safeParse(withoutTaskId).success).to.equal(false)
    })

    it('rejects out-of-enum operation_type', () => {
      expect(CurateOperationAppliedSchema.safeParse({...baseValid, operation_type: 'RENAME'}).success).to.equal(false)
    })

    it('rejects out-of-enum impact and confidence', () => {
      expect(CurateOperationAppliedSchema.safeParse({...baseValid, impact: 'medium'}).success).to.equal(false)
      expect(CurateOperationAppliedSchema.safeParse({...baseValid, confidence: 'maybe'}).success).to.equal(false)
    })

    it('rejects empty absolute_path / knowledge_path / task_id', () => {
      expect(CurateOperationAppliedSchema.safeParse({...baseValid, absolute_path: ''}).success).to.equal(false)
      expect(CurateOperationAppliedSchema.safeParse({...baseValid, knowledge_path: ''}).success).to.equal(false)
      expect(CurateOperationAppliedSchema.safeParse({...baseValid, task_id: ''}).success).to.equal(false)
    })

    it('rejects tags / keywords / related with more than 50 entries', () => {
      const fiftyOne = Array.from({length: 51}, (_, i) => `entry-${i}`)
      expect(CurateOperationAppliedSchema.safeParse({...baseValid, tags: fiftyOne}).success).to.equal(false)
      expect(CurateOperationAppliedSchema.safeParse({...baseValid, keywords: fiftyOne}).success).to.equal(false)
      expect(CurateOperationAppliedSchema.safeParse({...baseValid, related: fiftyOne}).success).to.equal(false)
    })

    it('rejects tags / keywords / related entries longer than 256 chars', () => {
      const at257 = 'x'.repeat(257)
      expect(CurateOperationAppliedSchema.safeParse({...baseValid, tags: [at257]}).success).to.equal(false)
      expect(CurateOperationAppliedSchema.safeParse({...baseValid, keywords: [at257]}).success).to.equal(false)
      expect(CurateOperationAppliedSchema.safeParse({...baseValid, related: [at257]}).success).to.equal(false)
    })

    it('rejects unknown extra fields (strict)', () => {
      expect(CurateOperationAppliedSchema.safeParse({...baseValid, mystery_field: 'oops'}).success).to.equal(false)
    })
  })
})
