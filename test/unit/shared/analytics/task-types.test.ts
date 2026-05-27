
/* eslint-disable camelcase */
import {expect} from 'chai'

import {CurateRunCompletedSchema} from '../../../../src/shared/analytics/events/curate-run-completed.js'
import {QueryCompletedSchema} from '../../../../src/shared/analytics/events/query-completed.js'
import {TaskCompletedSchema} from '../../../../src/shared/analytics/events/task-completed.js'
import {TaskCreatedSchema} from '../../../../src/shared/analytics/events/task-created.js'
import {TaskFailedSchema} from '../../../../src/shared/analytics/events/task-failed.js'
import {TASK_TYPE_VALUES, type TaskType, TaskTypes} from '../../../../src/shared/analytics/task-types.js'

describe('TaskTypes', () => {
  it('should expose every v4.0 daemon task type', () => {
    expect(Object.keys(TaskTypes).sort()).to.deep.equal([
      'CURATE',
      'CURATE_FOLDER',
      'CURATE_TOOL_MODE',
      'DREAM',
      'DREAM_FINALIZE',
      'DREAM_SCAN',
      'QUERY',
      'QUERY_TOOL_MODE',
      'SEARCH',
    ])
  })

  it('should map each key to the wire string used by the daemon TaskInfo.type', () => {
    expect(TaskTypes.CURATE).to.equal('curate')
    expect(TaskTypes.CURATE_FOLDER).to.equal('curate-folder')
    expect(TaskTypes.CURATE_TOOL_MODE).to.equal('curate-tool-mode')
    expect(TaskTypes.DREAM).to.equal('dream')
    expect(TaskTypes.DREAM_FINALIZE).to.equal('dream-finalize')
    expect(TaskTypes.DREAM_SCAN).to.equal('dream-scan')
    expect(TaskTypes.QUERY).to.equal('query')
    expect(TaskTypes.QUERY_TOOL_MODE).to.equal('query-tool-mode')
    expect(TaskTypes.SEARCH).to.equal('search')
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

  describe('v4.0 tool-mode types validate through task_* schemas', () => {
    const newTypes = [
      TaskTypes.CURATE_TOOL_MODE,
      TaskTypes.QUERY_TOOL_MODE,
      TaskTypes.DREAM_SCAN,
      TaskTypes.DREAM_FINALIZE,
    ] as const

    for (const taskType of newTypes) {
      it(`TaskCreatedSchema accepts task_type='${taskType}'`, () => {
        const parsed = TaskCreatedSchema.parse({
          has_files: false,
          has_folder: false,
          task_id: 't-1',
          task_type: taskType,
        })
        expect(parsed.task_type).to.equal(taskType)
      })

      it(`TaskCompletedSchema accepts task_type='${taskType}'`, () => {
        const parsed = TaskCompletedSchema.parse({
          duration_ms: 100,
          task_id: 't-1',
          task_type: taskType,
        })
        expect(parsed.task_type).to.equal(taskType)
      })

      it(`TaskFailedSchema accepts task_type='${taskType}'`, () => {
        const parsed = TaskFailedSchema.parse({
          duration_ms: 100,
          task_id: 't-1',
          task_type: taskType,
        })
        expect(parsed.task_type).to.equal(taskType)
      })
    }

    it('rejects an unknown task_type on all three task_* schemas', () => {
      const bad = {
        duration_ms: 0,
        has_files: false,
        has_folder: false,
        task_id: 't-1',
        task_type: 'not-a-real-type' as unknown as TaskType,
      }
      expect(() => TaskCreatedSchema.parse(bad)).to.throw()
      expect(() => TaskCompletedSchema.parse(bad)).to.throw()
      expect(() => TaskFailedSchema.parse(bad)).to.throw()
    })
  })

  // The M12 schemas hardcode literal task_type values and still REJECT
  // the new tool-mode types. M14.2 is the follow-up that migrates them
  // to z.enum(TASK_TYPE_VALUES); until then these regressions are
  // EXPECTED and documented as such in M14.1's TDD.
  describe('M12 schemas still reject tool-mode types (M14.2 follow-up)', () => {
    const curatePayload = {
      duration_ms: 100,
      operations_added: 0,
      operations_deleted: 0,
      operations_failed: 0,
      operations_merged: 0,
      operations_updated: 0,
      outcome: 'completed' as const,
      pending_review_count: 0,
      task_id: 't-1',
    }

    it('CurateRunCompletedSchema still rejects curate-tool-mode', () => {
      expect(() =>
        CurateRunCompletedSchema.parse({...curatePayload, task_type: TaskTypes.CURATE_TOOL_MODE}),
      ).to.throw()
    })

    it('QueryCompletedSchema still rejects query-tool-mode', () => {
      const queryPayload = {
        cache_hit: false,
        duration_ms: 100,
        matched_doc_count: 0,
        outcome: 'completed' as const,
        read_doc_count: 0,
        read_tool_call_count: 0,
        search_call_count: 0,
        task_id: 't-1',
      }
      expect(() =>
        QueryCompletedSchema.parse({...queryPayload, task_type: TaskTypes.QUERY_TOOL_MODE}),
      ).to.throw()
    })
  })
})
