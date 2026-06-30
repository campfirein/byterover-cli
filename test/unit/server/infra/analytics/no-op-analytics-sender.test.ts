/* eslint-disable camelcase */
import {expect} from 'chai'
import {randomUUID} from 'node:crypto'

import type {SendResult} from '../../../../../src/server/core/interfaces/analytics/i-analytics-sender.js'
import type {StoredAnalyticsRecord} from '../../../../../src/shared/analytics/stored-record.js'

import {NoOpAnalyticsSender} from '../../../../../src/server/infra/analytics/no-op-analytics-sender.js'

const validIdentity = {device_id: '550e8400-e29b-41d4-a716-446655440000'}

function makeRecord(overrides: Partial<StoredAnalyticsRecord> = {}): StoredAnalyticsRecord {
  return {
    attempts: 0,
    id: randomUUID(),
    identity: validIdentity,
    name: 'cli_invocation',
    properties: {},
    status: 'pending',
    timestamp: 0,
    ...overrides,
  }
}

describe('NoOpAnalyticsSender', () => {
  describe('send()', () => {
    it('should return both arrays empty for empty input', async () => {
      const sender = new NoOpAnalyticsSender()

      const result = await sender.send([])

      expect(result).to.deep.equal({failed: [], succeeded: []})
    })

    it('should return both arrays empty for a single-record input', async () => {
      const sender = new NoOpAnalyticsSender()

      const result = await sender.send([makeRecord({id: 'r1'})])

      expect(result).to.deep.equal({failed: [], succeeded: []})
    })

    it('should return both arrays empty for a many-record input', async () => {
      const sender = new NoOpAnalyticsSender()
      const records = Array.from({length: 50}, (_, i) => makeRecord({id: `r${i}`}))

      const result = await sender.send(records)

      expect(result).to.deep.equal({failed: [], succeeded: []})
    })

    it('should leave JSONL state untouched when result is piped through a fake updateStatus recorder', async () => {
      // Locked decision: NoOpAnalyticsSender must be semantically inert under M10.2's mirror wiring.
      // Piping its result into updateStatus(succeeded, 'sent') + updateStatus(failed, 'failed')
      // must produce ZERO status mutations, so JSONL rows stay at status='pending' until M4.2
      // wires the real HTTP sender. This guards the data-loss hazard called out in M10/README.md.
      const sender = new NoOpAnalyticsSender()
      const records = [makeRecord({id: 'r1'}), makeRecord({id: 'r2'}), makeRecord({id: 'r3'})]

      const recorder: Array<{ids: readonly string[]; status: 'failed' | 'sent'}> = []
      const fakeUpdateStatus = async (ids: readonly string[], status: 'failed' | 'sent'): Promise<void> => {
        if (ids.length === 0) return
        recorder.push({ids, status})
      }

      const result: SendResult = await sender.send(records)
      await fakeUpdateStatus(result.succeeded, 'sent')
      await fakeUpdateStatus(result.failed, 'failed')

      expect(recorder, 'NoOp must not produce any status mutation').to.deep.equal([])
    })
  })
})
