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

const baseEntry = {
  keywords: [],
  related_paths: [],
  relative_path: '.brv/notes/a.md',
  tags: [],
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

    it('accepts read_paths_with_metadata entries with empty metadata arrays', () => {
      const entries = [
        {...baseEntry, relative_path: '.brv/a.md'},
        {...baseEntry, relative_path: '.brv/b.md'},
      ]
      expect(QueryCompletedSchema.safeParse({...baseValid, read_paths_with_metadata: entries}).success).to.equal(true)
    })

    it('accepts entries with populated keywords, tags, and structured related_paths', () => {
      const entries = [
        {
          keywords: ['k1'],
          related_paths: [{keywords: [], relative_path: 'r1', tags: []}],
          relative_path: '.brv/a.md',
          tags: ['t1'],
        },
      ]
      expect(QueryCompletedSchema.safeParse({...baseValid, read_paths_with_metadata: entries}).success).to.equal(true)
    })

    it('accepts read_paths_with_metadata with exactly 10 entries', () => {
      const entries = Array.from({length: 10}, (_, i) => ({...baseEntry, relative_path: `.brv/file-${i}.md`}))
      expect(QueryCompletedSchema.safeParse({...baseValid, read_paths_with_metadata: entries}).success).to.equal(true)
    })

    it('accepts entries with keywords / tags at the 50-entry cap and 256-char strings', () => {
      const fifty = Array.from({length: 50}, (_, i) => `entry-${i}`)
      const at256 = 'x'.repeat(256)
      const entries = [
        {
          keywords: fifty,
          related_paths: [{keywords: [], relative_path: at256, tags: []}],
          relative_path: '.brv/a.md',
          tags: fifty,
        },
      ]
      expect(QueryCompletedSchema.safeParse({...baseValid, read_paths_with_metadata: entries}).success).to.equal(true)
    })

    it('accepts a populated space_id', () => {
      expect(QueryCompletedSchema.safeParse({...baseValid, space_id: 'space-uuid-abc'}).success).to.equal(true)
    })

    it('accepts payloads omitting space_id (standalone project)', () => {
      expect(QueryCompletedSchema.safeParse(baseValid).success).to.equal(true)
    })

    it('accepts related_paths with up to 50 structured entries', () => {
      const fifty = Array.from({length: 50}, (_, i) => ({
        keywords: [],
        relative_path: `notes/related-${i}`,
        tags: [],
      }))
      const entries = [{...baseEntry, related_paths: fifty}]
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

    it('rejects an unknown task_type but accepts every canonical TASK_TYPE_VALUES entry', () => {
      // M14.2 widened task_type from z.literal('query') to the canonical
      // TASK_TYPE_VALUES tuple so query-tool-mode round-trips the wire
      // boundary. Genuinely unknown values still reject.
      expect(QueryCompletedSchema.safeParse({...baseValid, task_type: 'not-a-real-type'}).success).to.equal(false)
      expect(QueryCompletedSchema.safeParse({...baseValid, task_type: 'query-tool-mode'}).success).to.equal(true)
      expect(QueryCompletedSchema.safeParse({...baseValid, task_type: 'curate'}).success).to.equal(true)
    })

    it('rejects negative or non-integer counts', () => {
      expect(QueryCompletedSchema.safeParse({...baseValid, matched_doc_count: -1}).success).to.equal(false)
      expect(QueryCompletedSchema.safeParse({...baseValid, read_tool_call_count: 1.5}).success).to.equal(false)
    })

    it('rejects read_paths_with_metadata with more than 10 entries', () => {
      const entries = Array.from({length: 11}, (_, i) => ({...baseEntry, relative_path: `.brv/file-${i}.md`}))
      expect(QueryCompletedSchema.safeParse({...baseValid, read_paths_with_metadata: entries}).success).to.equal(false)
    })

    it('rejects entries with empty relative_path', () => {
      const entries = [{...baseEntry, relative_path: ''}]
      expect(QueryCompletedSchema.safeParse({...baseValid, read_paths_with_metadata: entries}).success).to.equal(false)
    })

    it('rejects entries missing required keywords / tags arrays', () => {
      // eslint-disable-next-line @typescript-eslint/no-unused-vars
      const {keywords: _k, ...withoutKeywords} = baseEntry
      // eslint-disable-next-line @typescript-eslint/no-unused-vars
      const {tags: _t, ...withoutTags} = baseEntry
      expect(
        QueryCompletedSchema.safeParse({...baseValid, read_paths_with_metadata: [withoutKeywords]}).success,
      ).to.equal(false)
      expect(QueryCompletedSchema.safeParse({...baseValid, read_paths_with_metadata: [withoutTags]}).success).to.equal(
        false,
      )
    })

    it('rejects entries with more than 50 tags / keywords', () => {
      const fiftyOne = Array.from({length: 51}, (_, i) => `entry-${i}`)
      const tagsEntry = [{...baseEntry, tags: fiftyOne}]
      expect(QueryCompletedSchema.safeParse({...baseValid, read_paths_with_metadata: tagsEntry}).success).to.equal(false)
    })

    it('rejects entries with tag / keyword string longer than 256 chars', () => {
      const at257 = 'x'.repeat(257)
      const entries = [{...baseEntry, keywords: [at257]}]
      expect(QueryCompletedSchema.safeParse({...baseValid, read_paths_with_metadata: entries}).success).to.equal(false)
    })

    it('rejects related_paths entries missing keywords / tags / relative_path', () => {
      const entries = [{...baseEntry, related_paths: [{relative_path: 'r1'}]}]
      expect(QueryCompletedSchema.safeParse({...baseValid, read_paths_with_metadata: entries}).success).to.equal(false)
    })

    it('rejects unknown extra fields at top level (strict)', () => {
      expect(QueryCompletedSchema.safeParse({...baseValid, mystery_field: 'oops'}).success).to.equal(false)
    })

    it('rejects empty / over-cap space_id', () => {
      expect(QueryCompletedSchema.safeParse({...baseValid, space_id: ''}).success).to.equal(false)
      expect(QueryCompletedSchema.safeParse({...baseValid, space_id: 'x'.repeat(65)}).success).to.equal(false)
    })

    it('rejects unknown extra fields inside an entry (strict)', () => {
      const entries = [{...baseEntry, mystery: 'oops'}]
      expect(QueryCompletedSchema.safeParse({...baseValid, read_paths_with_metadata: entries}).success).to.equal(false)
    })
  })
})
