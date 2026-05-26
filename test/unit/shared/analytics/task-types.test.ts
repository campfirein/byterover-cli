 
import {expect} from 'chai'

import {TASK_TYPE_VALUES, type TaskType, TaskTypes} from '../../../../src/shared/analytics/task-types.js'

describe('TaskTypes', () => {
  it('should expose exactly the five daemon task types', () => {
    expect(Object.keys(TaskTypes).sort()).to.deep.equal([
      'CURATE',
      'CURATE_FOLDER',
      'DREAM',
      'QUERY',
      'SEARCH',
    ])
  })

  it('should map each key to the wire string used by the daemon TaskInfo.type', () => {
    expect(TaskTypes.CURATE).to.equal('curate')
    expect(TaskTypes.CURATE_FOLDER).to.equal('curate-folder')
    expect(TaskTypes.QUERY).to.equal('query')
    expect(TaskTypes.SEARCH).to.equal('search')
    expect(TaskTypes.DREAM).to.equal('dream')
  })

  it('should expose TaskType as the union of values', () => {
    const sample: TaskType = TaskTypes.CURATE
    expect(sample).to.equal('curate')
  })

  describe('TASK_TYPE_VALUES', () => {
    it('should contain every TaskTypes value exactly once', () => {
      expect([...TASK_TYPE_VALUES].sort()).to.deep.equal(Object.values(TaskTypes).sort())
    })

    it('should be a runtime tuple usable by z.enum', () => {
      // Smoke check: TASK_TYPE_VALUES is intended as the source for
      // `z.enum(TASK_TYPE_VALUES)` in per-event schemas. Length must be
      // non-zero (zod rejects empty enum tuples).
      expect(TASK_TYPE_VALUES.length).to.be.greaterThan(0)
    })
  })
})
