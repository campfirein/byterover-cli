/* eslint-disable camelcase */
 
import {expect} from 'chai'
import {stub} from 'sinon'

import type {AnalyticsBatch} from '../../../../../src/server/core/domain/analytics/batch.js'
import type {AuthToken} from '../../../../../src/server/core/domain/entities/auth-token.js'
import type {
  AnalyticsHttpHeaders,
  AnalyticsHttpSendResult,
  IAnalyticsHttpClient,
} from '../../../../../src/server/core/interfaces/analytics/i-analytics-http-client.js'
import type {IAuthStateReader} from '../../../../../src/server/core/interfaces/analytics/i-identity-resolver.js'
import type {IGlobalConfigStore} from '../../../../../src/server/core/interfaces/storage/i-global-config-store.js'
import type {StoredAnalyticsRecord} from '../../../../../src/shared/analytics/stored-record.js'

import {GlobalConfig} from '../../../../../src/server/core/domain/entities/global-config.js'
import {HttpAnalyticsSender} from '../../../../../src/server/infra/analytics/http-analytics-sender.js'

const validDeviceId = '550e8400-e29b-41d4-a716-446655440000'

function makeRecord(overrides: Partial<StoredAnalyticsRecord> = {}): StoredAnalyticsRecord {
  return {
    attempts: 0,
    created_at: '2023-11-14T22:13:20+00:00',
    id: overrides.id ?? '11111111-1111-1111-1111-111111111111',
    identity: {device_id: validDeviceId, user_id: 'user-123'},
    name: 'daemon_start',
    properties: {cli_version: '3.12.0'},
    status: 'pending',
    timestamp: 1_700_000_000_000,
    ...overrides,
  }
}

function makeStubConfigStore(deviceId: string = validDeviceId): IGlobalConfigStore {
  const config = GlobalConfig.fromJson({analytics: true, deviceId, version: '0.0.1'})
  if (!config) throw new Error('fixture: GlobalConfig.fromJson must succeed')
  return {read: stub().resolves(config), write: stub().resolves()}
}

function makeAuthReader(token?: AuthToken): IAuthStateReader {
  return {getToken: () => token}
}

type RecordedSend = {batch: AnalyticsBatch; headers: AnalyticsHttpHeaders}

type CapturingHttpClient = IAnalyticsHttpClient & {readonly calls: RecordedSend[]}

function makeCapturingHttpClient(result: AnalyticsHttpSendResult): CapturingHttpClient {
  const calls: RecordedSend[] = []
  return {
    calls,
    async send(batch, headers) {
      calls.push({batch, headers})
      return result
    },
  }
}

describe('HttpAnalyticsSender', () => {
  describe('happy path', () => {
    it('sends a batch built from the input records and returns succeeded ids', async () => {
      const httpClient = makeCapturingHttpClient({ok: true})
      const sender = new HttpAnalyticsSender({
        authStateReader: makeAuthReader(),
        globalConfigStore: makeStubConfigStore(),
        httpClient,
        userAgent: 'brv-cli/3.12.0',
      })

      const r1 = makeRecord({id: 'r1', name: 'event_a'})
      const r2 = makeRecord({id: 'r2', name: 'event_b'})
      const result = await sender.send([r1, r2])

      expect(result).to.deep.equal({failed: [], succeeded: ['r1', 'r2']})
      expect(httpClient.calls).to.have.lengthOf(1)
      const [{batch}] = httpClient.calls
      expect(batch.events).to.have.lengthOf(2)
      expect(batch.events[0].name).to.equal('event_a')
      expect(batch.events[1].name).to.equal('event_b')
    })

    it('stamps deviceId from GlobalConfig + userAgent from the constructor', async () => {
      const httpClient = makeCapturingHttpClient({ok: true})
      const sender = new HttpAnalyticsSender({
        authStateReader: makeAuthReader(),
        globalConfigStore: makeStubConfigStore('dev-from-config'),
        httpClient,
        userAgent: 'brv-cli/9.9.9',
      })

      await sender.send([makeRecord()])

      const [{headers}] = httpClient.calls
      expect(headers.deviceId).to.equal('dev-from-config')
      expect(headers.userAgent).to.equal('brv-cli/9.9.9')
    })

    it('stamps sessionId from AuthStateReader when authenticated', async () => {
      const token = {sessionKey: 'sess-abc'} as AuthToken
      const httpClient = makeCapturingHttpClient({ok: true})
      const sender = new HttpAnalyticsSender({
        authStateReader: makeAuthReader(token),
        globalConfigStore: makeStubConfigStore(),
        httpClient,
        userAgent: 'brv-cli/3.12.0',
      })

      await sender.send([makeRecord()])

      const [{headers}] = httpClient.calls
      expect(headers.sessionId).to.equal('sess-abc')
    })

    it('omits sessionId when anonymous (no auth token)', async () => {
      const httpClient = makeCapturingHttpClient({ok: true})
      const sender = new HttpAnalyticsSender({
        authStateReader: makeAuthReader(),
        globalConfigStore: makeStubConfigStore(),
        httpClient,
        userAgent: 'brv-cli/3.12.0',
      })

      await sender.send([makeRecord()])

      const [{headers}] = httpClient.calls
      expect(headers.sessionId).to.equal(undefined)
    })
  })

  describe('empty input', () => {
    it('returns empty result without calling the http client for an empty batch', async () => {
      const httpClient = makeCapturingHttpClient({ok: true})
      const sender = new HttpAnalyticsSender({
        authStateReader: makeAuthReader(),
        globalConfigStore: makeStubConfigStore(),
        httpClient,
        userAgent: 'brv-cli/3.12.0',
      })

      const result = await sender.send([])

      expect(result).to.deep.equal({failed: [], succeeded: []})
      expect(httpClient.calls).to.have.lengthOf(0)
    })
  })

  describe('failure mapping', () => {
    it('returns all ids as failed when http client reports http_5xx (carries reason for M4.5 backoff)', async () => {
      const httpClient = makeCapturingHttpClient({ok: false, reason: 'http_5xx', status: 503})
      const sender = new HttpAnalyticsSender({
        authStateReader: makeAuthReader(),
        globalConfigStore: makeStubConfigStore(),
        httpClient,
        userAgent: 'brv-cli/3.12.0',
      })

      const r1 = makeRecord({id: 'r1'})
      const r2 = makeRecord({id: 'r2'})
      const result = await sender.send([r1, r2])

      expect(result).to.deep.equal({failed: ['r1', 'r2'], reason: 'http_5xx', succeeded: []})
    })

    it('returns all ids as failed when http client reports timeout (carries reason)', async () => {
      const httpClient = makeCapturingHttpClient({ok: false, reason: 'timeout'})
      const sender = new HttpAnalyticsSender({
        authStateReader: makeAuthReader(),
        globalConfigStore: makeStubConfigStore(),
        httpClient,
        userAgent: 'brv-cli/3.12.0',
      })

      const result = await sender.send([makeRecord({id: 'only'})])

      expect(result).to.deep.equal({failed: ['only'], reason: 'timeout', succeeded: []})
    })

    it('returns all ids as failed when http client reports network failure (carries reason)', async () => {
      const httpClient = makeCapturingHttpClient({ok: false, reason: 'network'})
      const sender = new HttpAnalyticsSender({
        authStateReader: makeAuthReader(),
        globalConfigStore: makeStubConfigStore(),
        httpClient,
        userAgent: 'brv-cli/3.12.0',
      })

      const result = await sender.send([makeRecord({id: 'only'})])

      expect(result).to.deep.equal({failed: ['only'], reason: 'network', succeeded: []})
    })

    it('returns http_4xx reason verbatim (caller uses this to decide NOT to advance backoff)', async () => {
      const httpClient = makeCapturingHttpClient({ok: false, reason: 'http_4xx', status: 400})
      const sender = new HttpAnalyticsSender({
        authStateReader: makeAuthReader(),
        globalConfigStore: makeStubConfigStore(),
        httpClient,
        userAgent: 'brv-cli/3.12.0',
      })

      const result = await sender.send([makeRecord({id: 'only'})])

      expect(result).to.deep.equal({failed: ['only'], reason: 'http_4xx', succeeded: []})
    })

    it('does NOT set reason on a successful send (M4.5 caller treats absence as success)', async () => {
      const httpClient = makeCapturingHttpClient({ok: true})
      const sender = new HttpAnalyticsSender({
        authStateReader: makeAuthReader(),
        globalConfigStore: makeStubConfigStore(),
        httpClient,
        userAgent: 'brv-cli/3.12.0',
      })

      const result = await sender.send([makeRecord({id: 'r1'})])

      expect(result).to.deep.equal({failed: [], succeeded: ['r1']})
      expect(Object.hasOwn(result, 'reason'), 'reason key must be absent on success').to.equal(false)
    })
  })

  describe('crash safety', () => {
    it('does NOT throw if globalConfigStore.read() rejects; treats the batch as failed', async () => {
      const failingStore: IGlobalConfigStore = {
        read: stub().rejects(new Error('disk full')),
        write: stub().resolves(),
      }
      const httpClient = makeCapturingHttpClient({ok: true})
      const sender = new HttpAnalyticsSender({
        authStateReader: makeAuthReader(),
        globalConfigStore: failingStore,
        httpClient,
        userAgent: 'brv-cli/3.12.0',
      })

      let threw = false
      let result
      try {
        result = await sender.send([makeRecord({id: 'r1'})])
      } catch {
        threw = true
      }

      expect(threw, 'sender must NOT throw on collaborator failure').to.equal(false)
      // M4.5: collaborator throws are tagged `network` so the M4.5
      // backoff treats them as transient (caller will advance backoff).
      expect(result).to.deep.equal({failed: ['r1'], reason: 'network', succeeded: []})
      expect(httpClient.calls).to.have.lengthOf(0)
    })

    it('treats missing deviceId as an http_4xx failure (anonymous batches still need a device id per backend contract)', async () => {
      // GlobalConfigStore returns undefined (first-run before the daemon
      // has provisioned a device id). Per the backend contract, batches
      // without `x-byterover-device-id` are 400-rejected; the sender refuses
      // to ship and classifies the failure as `http_4xx` (a payload-shape
      // problem, not a transient signal) so the M4.5 backoff policy does not
      // churn on a daemon-side misconfig, while the flush mirror (M10.2)
      // still increments attempts toward the retry cap.
      const emptyStore: IGlobalConfigStore = {
        read: stub().resolves(),
        write: stub().resolves(),
      }
      const httpClient = makeCapturingHttpClient({ok: true})
      const sender = new HttpAnalyticsSender({
        authStateReader: makeAuthReader(),
        globalConfigStore: emptyStore,
        httpClient,
        userAgent: 'brv-cli/3.12.0',
      })

      const result = await sender.send([makeRecord({id: 'r1'})])

      expect(result).to.deep.equal({failed: ['r1'], reason: 'http_4xx', succeeded: []})
      expect(httpClient.calls).to.have.lengthOf(0)
    })
  })
})
