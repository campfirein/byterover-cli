/* eslint-disable camelcase */
import {expect} from 'chai'

import {NoOpAnalyticsClient} from '../../../../../src/server/infra/analytics/no-op-analytics-client.js'
import {AnalyticsEventNames} from '../../../../../src/shared/analytics/event-names.js'

describe('NoOpAnalyticsClient', () => {
  describe('track()', () => {
    it('should return void without throwing across every catalog event', () => {
      const client = new NoOpAnalyticsClient()

      // DAEMON_START has no required properties.
      expect(() => client.track(AnalyticsEventNames.DAEMON_START)).to.not.throw()

      // CURATE_OPERATION_APPLIED with a minimal valid payload.
      expect(() =>
        client.track(AnalyticsEventNames.CURATE_OPERATION_APPLIED, {
          absolute_path: '/tmp/x.md',
          knowledge_path: 'kg/x.md',
          needs_review: false,
          operation_type: 'ADD',
          task_id: 't-1',
        }),
      ).to.not.throw()

      // QUERY_COMPLETED with a minimal valid payload.
      expect(() =>
        client.track(AnalyticsEventNames.QUERY_COMPLETED, {
          cache_hit: false,
          duration_ms: 0,
          matched_doc_count: 0,
          outcome: 'completed',
          read_doc_count: 0,
          read_tool_call_count: 0,
          search_call_count: 0,
          task_id: 't-1',
          task_type: 'query',
        }),
      ).to.not.throw()
    })

    it('should remain a no-op under burst load', () => {
      const client = new NoOpAnalyticsClient()

      for (let i = 0; i < 1000; i++) {
        expect(() => client.track(AnalyticsEventNames.DAEMON_START)).to.not.throw()
      }
    })
  })

  describe('flush()', () => {
    it('should resolve to an empty batch with schema_version: 1', async () => {
      const client = new NoOpAnalyticsClient()

      const batch = await client.flush()

      expect(batch.schema_version).to.equal(1)
      expect(batch.events).to.deep.equal([])
    })

    it('should still return an empty batch after many track() calls (track is truly a no-op)', async () => {
      const client = new NoOpAnalyticsClient()

      for (let i = 0; i < 100; i++) {
        client.track(AnalyticsEventNames.DAEMON_START)
      }

      const batch = await client.flush()

      expect(batch.events).to.deep.equal([])
    })
  })
})
