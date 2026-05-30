/* eslint-disable camelcase */
 
import {expect} from 'chai'
import nock from 'nock'
import {stub} from 'sinon'

import type {AuthToken} from '../../../../../src/server/core/domain/entities/auth-token.js'
import type {IAuthStateReader} from '../../../../../src/server/core/interfaces/analytics/i-identity-resolver.js'
import type {IGlobalConfigStore} from '../../../../../src/server/core/interfaces/storage/i-global-config-store.js'
import type {StoredAnalyticsRecord} from '../../../../../src/shared/analytics/stored-record.js'

import {GlobalConfig} from '../../../../../src/server/core/domain/entities/global-config.js'
import {DrainingAnalyticsSender} from '../../../../../src/server/infra/analytics/draining-analytics-sender.js'
import {wireAnalyticsHttpSender} from '../../../../../src/server/infra/process/wire-analytics-http-sender.js'

/**
 * Integration test for the M4.2 composition-root binding that wires
 * AnalyticsClient → IAnalyticsSender. The helper composes
 * AxiosAnalyticsHttpClient + HttpAnalyticsSender; this test exercises
 * the chain end-to-end through a nocked HTTP boundary so a future
 * misconfigured wiring (wrong base URL, dropped header, swapped
 * collaborator) is caught at unit-test speed without booting the
 * whole daemon.
 *
 * Mirrors the M4.1 `wire-analytics-auth-transition.test.ts` precedent:
 * every composition-root binding gets a focused integration test that
 * locks-in the wiring shape.
 */

const validDeviceId = '550e8400-e29b-41d4-a716-446655440000'
const baseUrl = 'https://telemetry-test.byterover.dev'

function makeConfigStore(deviceId: string = validDeviceId): IGlobalConfigStore {
  const config = GlobalConfig.fromJson({analytics: true, deviceId, version: '0.0.1'})
  if (!config) throw new Error('fixture: GlobalConfig.fromJson must succeed')
  return {read: stub().resolves(config), write: stub().resolves()}
}

function makeAuthReader(token?: AuthToken): IAuthStateReader {
  return {getToken: () => token}
}

function makeRecord(overrides: Partial<StoredAnalyticsRecord> = {}): StoredAnalyticsRecord {
  return {
    attempts: 0,
    id: overrides.id ?? '11111111-1111-1111-1111-111111111111',
    identity: {device_id: validDeviceId, user_id: 'user-123'},
    name: 'daemon_start',
    properties: {cli_version: '3.12.0'},
    status: 'pending',
    timestamp: 1_700_000_000_000,
    ...overrides,
  }
}

describe('M4.2 wireAnalyticsHttpSender (integration)', () => {
  beforeEach(() => {
    nock.cleanAll()
    nock.disableNetConnect()
  })

  afterEach(() => {
    nock.cleanAll()
    nock.enableNetConnect()
  })

  it('composes a sender that POSTs to <baseUrl>/v1/events on send()', async () => {
    const scope = nock(baseUrl).post('/v1/events').reply(200, {accepted: 1, rejected: 0})

    const sender = wireAnalyticsHttpSender({
      analyticsBaseUrl: baseUrl,
      authStateReader: makeAuthReader(),
      globalConfigStore: makeConfigStore(),
      version: '3.12.0',
    })

    const result = await sender.send([makeRecord({id: 'r1'})])

    expect(result).to.deep.equal({failed: [], succeeded: ['r1']})
    expect(scope.isDone(), 'sender must POST to /v1/events').to.equal(true)
  })

  it('stamps headers from the wiring (device-id, user-agent, optional session-id)', async () => {
    const token = {sessionKey: 'sess-from-wiring'} as AuthToken
    const scope = nock(baseUrl)
      .post('/v1/events')
      .matchHeader('x-byterover-device-id', 'dev-from-config')
      .matchHeader('x-byterover-session-id', 'sess-from-wiring')
      .matchHeader('user-agent', 'brv-cli/3.12.0')
      .matchHeader('content-type', /application\/json/)
      .reply(200, {})

    const sender = wireAnalyticsHttpSender({
      analyticsBaseUrl: baseUrl,
      authStateReader: makeAuthReader(token),
      globalConfigStore: makeConfigStore('dev-from-config'),
      version: '3.12.0',
    })

    const result = await sender.send([makeRecord()])

    expect(result.succeeded).to.have.lengthOf(1)
    expect(scope.isDone()).to.equal(true)
  })

  it('omits session-id when no auth token is present', async () => {
    let recordedHeaders: Record<string, string | string[]> | undefined
    const scope = nock(baseUrl)
      .post('/v1/events')
      .reply(function () {
        recordedHeaders = this.req.headers
        return [200, {}]
      })

    const sender = wireAnalyticsHttpSender({
      analyticsBaseUrl: baseUrl,
      authStateReader: makeAuthReader(),
      globalConfigStore: makeConfigStore(),
      version: '3.12.0',
    })

    await sender.send([makeRecord()])

    expect(scope.isDone()).to.equal(true)
    expect(recordedHeaders, 'session header must not leak on anonymous batches').to.not.have.property('x-byterover-session-id')
  })

  it('returns failed=ids when the backend returns 5xx (sender swap surface preserved)', async () => {
    nock(baseUrl).post('/v1/events').reply(503, {})

    const sender = wireAnalyticsHttpSender({
      analyticsBaseUrl: baseUrl,
      authStateReader: makeAuthReader(),
      globalConfigStore: makeConfigStore(),
      version: '3.12.0',
    })

    const result = await sender.send([makeRecord({id: 'a'}), makeRecord({id: 'b'})])

    // M4.5: 5xx now propagates `reason` so the M4.5 backoff can advance.
    expect(result).to.deep.equal({failed: ['a', 'b'], reason: 'http_5xx', succeeded: []})
  })

  it('returns empty result without HTTP traffic for an empty batch', async () => {
    // Strict: no nock scope registered. If the sender hits the wire,
    // `nock.disableNetConnect` throws and the test fails loudly — that
    // is exactly the regression we want to lock in.
    const sender = wireAnalyticsHttpSender({
      analyticsBaseUrl: baseUrl,
      authStateReader: makeAuthReader(),
      globalConfigStore: makeConfigStore(),
      version: '3.12.0',
    })

    const result = await sender.send([])

    expect(result).to.deep.equal({failed: [], succeeded: []})
  })

  it('treats missing deviceId from config as an http_4xx batch failure (no HTTP traffic)', async () => {
    // Same disable-net-connect guard: a missing device id means HTTP must
    // not fire. The failure is classified `http_4xx` (payload-shape) so the
    // M4.5 backoff policy does not churn on the daemon-side misconfig.
    const emptyStore: IGlobalConfigStore = {
      read: stub().resolves(),
      write: stub().resolves(),
    }
    const sender = wireAnalyticsHttpSender({
      analyticsBaseUrl: baseUrl,
      authStateReader: makeAuthReader(),
      globalConfigStore: emptyStore,
      version: '3.12.0',
    })

    const result = await sender.send([makeRecord({id: 'r1'})])

    expect(result).to.deep.equal({failed: ['r1'], reason: 'http_4xx', succeeded: []})
  })

  it('returns a DrainingAnalyticsSender when analyticsBaseUrl is undefined (no HTTP traffic, all ids drained)', async () => {
    // Strict: no nock scope registered. With `disableNetConnect`, any
    // axios construction that actually issues a request would throw.
    // We additionally assert the sender's class identity to lock-in
    // the wiring swap at the composition root.
    const sender = wireAnalyticsHttpSender({
      analyticsBaseUrl: undefined,
      authStateReader: makeAuthReader(),
      globalConfigStore: makeConfigStore(),
      version: '3.12.0',
    })

    expect(sender).to.be.instanceOf(DrainingAnalyticsSender)

    const result = await sender.send([makeRecord({id: 'r1'}), makeRecord({id: 'r2'})])
    expect(result).to.deep.equal({failed: [], succeeded: ['r1', 'r2']})
  })

  it('normalises a trailing slash on the base URL (axios baseURL hygiene)', async () => {
    // Without normalisation, axios's baseURL='http://x.com/' + path='/v1/events'
    // emits a POST to '//v1/events' on some axios versions. The helper
    // delegates normalisation to AxiosAnalyticsHttpClient; this test
    // pins the contract so a refactor doesn't accidentally drop it.
    const scope = nock(baseUrl).post('/v1/events').reply(200, {})

    const sender = wireAnalyticsHttpSender({
      analyticsBaseUrl: `${baseUrl}/`,
      authStateReader: makeAuthReader(),
      globalConfigStore: makeConfigStore(),
      version: '3.12.0',
    })

    const result = await sender.send([makeRecord()])

    expect(result.succeeded).to.have.lengthOf(1)
    expect(scope.isDone()).to.equal(true)
  })
})
