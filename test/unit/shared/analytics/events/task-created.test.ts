/* eslint-disable camelcase */
import {expect} from 'chai'

import {TaskCreatedSchema} from '../../../../../src/shared/analytics/events/task-created.js'

const baseValid = {
  has_files: false,
  has_folder: false,
  task_id: '550e8400-e29b-41d4-a716-446655440000',
  task_type: 'curate' as const,
}

describe('TaskCreatedSchema', () => {
  describe('valid payloads', () => {
    it('should accept all task_type values', () => {
      for (const t of ['curate', 'curate-folder', 'query', 'search', 'dream']) {
        expect(TaskCreatedSchema.safeParse({...baseValid, task_type: t}).success).to.equal(true)
      }
    })

    it('should accept has_files=true and has_folder=true', () => {
      expect(TaskCreatedSchema.safeParse({...baseValid, has_files: true, has_folder: true}).success).to.equal(true)
    })
  })

  describe('invalid payloads', () => {
    it('should reject unknown task_type', () => {
      expect(TaskCreatedSchema.safeParse({...baseValid, task_type: 'mystery'}).success).to.equal(false)
    })

    it('should reject empty task_id', () => {
      expect(TaskCreatedSchema.safeParse({...baseValid, task_id: ''}).success).to.equal(false)
    })

    it('should reject non-boolean has_files', () => {
      expect(TaskCreatedSchema.safeParse({...baseValid, has_files: 'yes'}).success).to.equal(false)
    })

    it('should reject non-boolean has_folder', () => {
      expect(TaskCreatedSchema.safeParse({...baseValid, has_folder: 1}).success).to.equal(false)
    })

    it('should reject unknown extra fields (strict)', () => {
      expect(TaskCreatedSchema.safeParse({...baseValid, file_path: '/leaked'}).success).to.equal(false)
    })

    it('should reject missing required field', () => {
      // eslint-disable-next-line @typescript-eslint/no-unused-vars
      const {task_id: _, ...withoutTaskId} = baseValid
      expect(TaskCreatedSchema.safeParse(withoutTaskId).success).to.equal(false)
    })
  })
})
