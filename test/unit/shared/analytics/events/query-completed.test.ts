/* eslint-disable camelcase */
import {expect} from 'chai'

import {QueryCompletedSchema} from '../../../../../src/shared/analytics/events/query-completed.js'

const baseValid = {
  cache_hit: false,
  duration_ms: 1234,
  matched_doc_count: 5,
  outcome: 'completed' as const,
  read_doc_count: 2,
  read_paths_with_metadata: [],
  read_tool_call_count: 3,
  search_call_count: 1,
  task_id: 'task-uuid-456',
  task_type: 'query' as const,
}

describe('QueryCompletedSchema', () => {
  describe('valid payloads', () => {
    it('accepts the minimal required payload with empty read_paths_with_metadata', () => {
      expect(QueryCompletedSchema.safeParse(baseValid).success).to.equal(true)
    })

    it('accepts payloads omitting read_paths_with_metadata (optional outer array)', () => {
      // eslint-disable-next-line @typescript-eslint/no-unused-vars
      const {read_paths_with_metadata: _r, ...withoutReadPaths} = baseValid
      expect(QueryCompletedSchema.safeParse(withoutReadPaths).success).to.equal(true)
    })

    it('accepts each outcome enum value', () => {
      for (const outcome of ['completed', 'cancelled', 'error'] as const) {
        expect(QueryCompletedSchema.safeParse({...baseValid, outcome}).success).to.equal(true)
      }
    })

    it('accepts each tier literal value (0..4)', () => {
      for (const tier of [0, 1, 2, 3, 4] as const) {
        expect(QueryCompletedSchema.safeParse({...baseValid, tier}).success).to.equal(true)
      }
    })

    it('accepts payloads omitting tier', () => {
      expect(QueryCompletedSchema.safeParse({...baseValid}).success).to.equal(true)
    })

    it('accepts cache_hit=true', () => {
      expect(QueryCompletedSchema.safeParse({...baseValid, cache_hit: true}).success).to.equal(true)
    })

    it('accepts read_paths_with_metadata entries with no metadata', () => {
      const entries = [{absolute_path: '/a.md'}, {absolute_path: '/b.md'}]
      expect(QueryCompletedSchema.safeParse({...baseValid, read_paths_with_metadata: entries}).success).to.equal(true)
    })

    it('accepts entries with full optional metadata', () => {
      const entries = [{absolute_path: '/a.md', keywords: ['k1'], related: ['r1'], tags: ['t1']}]
      expect(QueryCompletedSchema.safeParse({...baseValid, read_paths_with_metadata: entries}).success).to.equal(true)
    })

    it('accepts read_paths_with_metadata with exactly 10 entries', () => {
      const entries = Array.from({length: 10}, (_, i) => ({absolute_path: `/file-${i}.md`}))
      expect(QueryCompletedSchema.safeParse({...baseValid, read_paths_with_metadata: entries}).success).to.equal(true)
    })

    it('accepts entries with tags / keywords / related at the 50-entry cap and 256-char cap', () => {
      const fifty = Array.from({length: 50}, (_, i) => `entry-${i}`)
      const at256 = 'x'.repeat(256)
      const entries = [{absolute_path: '/a.md', keywords: fifty, related: [at256], tags: fifty}]
      expect(QueryCompletedSchema.safeParse({...baseValid, read_paths_with_metadata: entries}).success).to.equal(true)
    })
  })

  describe('invalid payloads', () => {
    it('rejects missing required fields', () => {
      // eslint-disable-next-line @typescript-eslint/no-unused-vars
      const {outcome: _o, ...withoutOutcome} = baseValid
      expect(QueryCompletedSchema.safeParse(withoutOutcome).success).to.equal(false)
      // eslint-disable-next-line @typescript-eslint/no-unused-vars
      const {task_id: _t, ...withoutTaskId} = baseValid
      expect(QueryCompletedSchema.safeParse(withoutTaskId).success).to.equal(false)
    })

    it('rejects out-of-enum outcome', () => {
      expect(QueryCompletedSchema.safeParse({...baseValid, outcome: 'partial'}).success).to.equal(false)
    })

    it('rejects tier outside 0..4', () => {
      expect(QueryCompletedSchema.safeParse({...baseValid, tier: 5}).success).to.equal(false)
      expect(QueryCompletedSchema.safeParse({...baseValid, tier: -1}).success).to.equal(false)
    })

    it('rejects task_type other than literal "query"', () => {
      expect(QueryCompletedSchema.safeParse({...baseValid, task_type: 'curate'}).success).to.equal(false)
    })

    it('rejects negative or non-integer counts', () => {
      expect(QueryCompletedSchema.safeParse({...baseValid, matched_doc_count: -1}).success).to.equal(false)
      expect(QueryCompletedSchema.safeParse({...baseValid, read_tool_call_count: 1.5}).success).to.equal(false)
    })

    it('rejects read_paths_with_metadata with more than 10 entries', () => {
      const entries = Array.from({length: 11}, (_, i) => ({absolute_path: `/file-${i}.md`}))
      expect(QueryCompletedSchema.safeParse({...baseValid, read_paths_with_metadata: entries}).success).to.equal(false)
    })

    it('rejects entries with empty absolute_path', () => {
      const entries = [{absolute_path: ''}]
      expect(QueryCompletedSchema.safeParse({...baseValid, read_paths_with_metadata: entries}).success).to.equal(false)
    })

    it('rejects entries with more than 50 tags / keywords / related', () => {
      const fiftyOne = Array.from({length: 51}, (_, i) => `entry-${i}`)
      const tagsEntry = [{absolute_path: '/a.md', tags: fiftyOne}]
      expect(QueryCompletedSchema.safeParse({...baseValid, read_paths_with_metadata: tagsEntry}).success).to.equal(
        false,
      )
    })

    it('rejects entries with tag / keyword / related string longer than 256 chars', () => {
      const at257 = 'x'.repeat(257)
      const entries = [{absolute_path: '/a.md', keywords: [at257]}]
      expect(QueryCompletedSchema.safeParse({...baseValid, read_paths_with_metadata: entries}).success).to.equal(false)
    })

    it('rejects unknown extra fields at top level (strict)', () => {
      expect(QueryCompletedSchema.safeParse({...baseValid, mystery_field: 'oops'}).success).to.equal(false)
    })

    it('rejects unknown extra fields inside an entry (strict)', () => {
      const entries = [{absolute_path: '/a.md', mystery: 'oops'}]
      expect(QueryCompletedSchema.safeParse({...baseValid, read_paths_with_metadata: entries}).success).to.equal(false)
    })
  })
})
