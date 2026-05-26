/* eslint-disable camelcase */
 
import {expect} from 'chai'
import nock from 'nock'

import {AnalyticsBatch} from '../../../../../src/server/core/domain/analytics/batch.js'
import {AxiosAnalyticsHttpClient} from '../../../../../src/server/infra/analytics/axios-analytics-http-client.js'

const validDeviceId = '550e8400-e29b-41d4-a716-446655440000'
const baseUrl = 'https://telemetry-test.byterover.dev'

function makeEvent(name = 'daemon_start') {
  return {
    identity: {device_id: validDeviceId, user_id: 'user-123'},
    name,
    properties: {cli_version: '3.12.0'},
    timestamp: 1_700_000_000_000,
  }
}

function makeBatch(eventCount = 1): AnalyticsBatch {
  return AnalyticsBatch.create(Array.from({length: eventCount}, (_, i) => makeEvent(`event_${String(i)}`)))
}

describe('AxiosAnalyticsHttpClient', () => {
  beforeEach(() => {
    nock.cleanAll()
    nock.disableNetConnect()
  })

  afterEach(() => {
    nock.cleanAll()
    nock.enableNetConnect()
  })

  describe('happy path', () => {
    it('POSTs the batch to /v1/events and returns ok=true on 2xx', async () => {
      let receivedBody: unknown
      const scope = nock(baseUrl)
        .post('/v1/events', (body) => {
          receivedBody = body
          return true
        })
        .matchHeader('x-byterover-device-id', validDeviceId)
        .matchHeader('content-type', /application\/json/)
        .matchHeader('user-agent', 'brv-cli/3.12.0')
        .reply(200, {accepted: 1, rejected: 0})

      const client = new AxiosAnalyticsHttpClient({baseUrl})
      const result = await client.send(makeBatch(1), {
        deviceId: validDeviceId,
        userAgent: 'brv-cli/3.12.0',
      })

      expect(result).to.deep.equal({ok: true})
      expect(scope.isDone()).to.equal(true)
      // Body matches the AnalyticsBatch.toJson() wire shape.
      expect(receivedBody).to.have.property('schema_version', 1)
      expect(receivedBody).to.have.nested.property('events.0.name', 'event_0')
    })

    it('stamps x-byterover-session-id when sessionId is provided', async () => {
      const scope = nock(baseUrl)
        .post('/v1/events')
        .matchHeader('x-byterover-session-id', 'sess-abc')
        .matchHeader('x-byterover-device-id', validDeviceId)
        .reply(200, {})

      const client = new AxiosAnalyticsHttpClient({baseUrl})
      const result = await client.send(makeBatch(1), {
        deviceId: validDeviceId,
        sessionId: 'sess-abc',
        userAgent: 'brv-cli/3.12.0',
      })

      expect(result.ok).to.equal(true)
      expect(scope.isDone()).to.equal(true)
    })

    it('does NOT send an authorization header (analytics works anonymous)', async () => {
      let recordedHeaders: Record<string, string | string[]> | undefined
      const scope = nock(baseUrl)
        .post('/v1/events')
        .reply(function () {
          recordedHeaders = this.req.headers
          return [200, {}]
        })

      const client = new AxiosAnalyticsHttpClient({baseUrl})
      await client.send(makeBatch(1), {
        deviceId: validDeviceId,
        userAgent: 'brv-cli/3.12.0',
      })

      expect(scope.isDone()).to.equal(true)
      expect(recordedHeaders).to.not.have.property('authorization')
    })
  })

  describe('failure classification', () => {
    it('returns ok=false reason=http_4xx with status for a 400', async () => {
      nock(baseUrl).post('/v1/events').reply(400, {message: 'bad request'})
      const client = new AxiosAnalyticsHttpClient({baseUrl})

      const result = await client.send(makeBatch(1), {
        deviceId: validDeviceId,
        userAgent: 'brv-cli/3.12.0',
      })

      expect(result).to.deep.equal({ok: false, reason: 'http_4xx', status: 400})
    })

    it('returns ok=false reason=http_4xx with status for a 429', async () => {
      nock(baseUrl).post('/v1/events').reply(429, {message: 'too many requests'})
      const client = new AxiosAnalyticsHttpClient({baseUrl})

      const result = await client.send(makeBatch(1), {
        deviceId: validDeviceId,
        userAgent: 'brv-cli/3.12.0',
      })

      expect(result).to.deep.equal({ok: false, reason: 'http_4xx', status: 429})
    })

    it('returns ok=false reason=http_5xx with status for a 503', async () => {
      nock(baseUrl).post('/v1/events').reply(503, {message: 'unavailable'})
      const client = new AxiosAnalyticsHttpClient({baseUrl})

      const result = await client.send(makeBatch(1), {
        deviceId: validDeviceId,
        userAgent: 'brv-cli/3.12.0',
      })

      expect(result).to.deep.equal({ok: false, reason: 'http_5xx', status: 503})
    })

    it('returns ok=false reason=network when the connection cannot be established', async () => {
      // Point axios at an unreachable port; nock + disableNetConnect would
      // surface the same network-level failure but with timing variance
      // across CI runs. Targeting localhost:1 yields a deterministic
      // connect refusal that axios classifies as a non-response error
      // (not a timeout, since the request never enters the timeout window).
      nock.enableNetConnect('127.0.0.1')
      const client = new AxiosAnalyticsHttpClient({baseUrl: 'http://127.0.0.1:1'})

      const result = await client.send(makeBatch(1), {
        deviceId: validDeviceId,
        userAgent: 'brv-cli/3.12.0',
      })

      expect(result.ok).to.equal(false)
      if (result.ok) throw new Error('unreachable')
      expect(result.reason).to.equal('network')
      nock.disableNetConnect()
    })

    it('returns ok=false reason=timeout when the server is too slow', async () => {
      // 100ms timeout for the test; nock delay > timeout to force ETIMEDOUT.
      nock(baseUrl).post('/v1/events').delay(500).reply(200, {})
      const client = new AxiosAnalyticsHttpClient({baseUrl, timeoutMs: 100})

      const result = await client.send(makeBatch(1), {
        deviceId: validDeviceId,
        userAgent: 'brv-cli/3.12.0',
      })

      expect(result.ok).to.equal(false)
      if (result.ok) throw new Error('unreachable')
      expect(result.reason).to.equal('timeout')
    })
  })

  describe('contract guarantees', () => {
    it('does NOT throw on any failure path', async () => {
      // Combine the slowest failure mode (timeout) with a tight client
      // budget so the assertion completes in <200ms instead of the
      // default 5s. The point is to prove the catch path returns a
      // tagged result rather than propagating an exception.
      nock(baseUrl).post('/v1/events').delay(400).reply(500, {})
      const client = new AxiosAnalyticsHttpClient({baseUrl, timeoutMs: 100})

      let threw = false
      try {
        await client.send(makeBatch(1), {
          deviceId: validDeviceId,
          userAgent: 'brv-cli/3.12.0',
        })
      } catch {
        threw = true
      }

      expect(threw, 'send() must never throw').to.equal(false)
    })

    it('sends the full batch body unchanged (round-trips through AnalyticsBatch.fromJson)', async () => {
      let receivedBody: unknown
      nock(baseUrl)
        .post('/v1/events', (body) => {
          receivedBody = body
          return true
        })
        .reply(200, {})

      const batch = makeBatch(3)
      const client = new AxiosAnalyticsHttpClient({baseUrl})
      await client.send(batch, {deviceId: validDeviceId, userAgent: 'brv-cli/3.12.0'})

      const restored = AnalyticsBatch.fromJson(receivedBody)
      expect(restored, 'wire body must parse back as AnalyticsBatch').to.not.equal(undefined)
      expect(restored?.events).to.have.lengthOf(3)
    })
  })

  describe('abort support (M4.4)', () => {
    it('returns ok=false reason=network when the signal is aborted mid-flight', async () => {
      // Server takes 500ms to reply; we abort after the request is in
      // flight. Without abort plumbing the client would wait the full
      // 5s timeout and the test would slow the suite.
      nock(baseUrl).post('/v1/events').delay(500).reply(200, {})
      const client = new AxiosAnalyticsHttpClient({baseUrl})
      const controller = new AbortController()

      const sendPromise = client.send(
        makeBatch(1),
        {deviceId: validDeviceId, userAgent: 'brv-cli/3.12.0'},
        {signal: controller.signal},
      )
      // Give axios a tick to dispatch the request, then abort.
      await new Promise((resolve) => {
        setTimeout(resolve, 20)
      })
      controller.abort()
      const result = await sendPromise

      expect(result.ok).to.equal(false)
      if (result.ok) throw new Error('unreachable')
      // Aborted requests classify as `network` (not `timeout`) — they
      // were terminated client-side, the server never replied.
      expect(result.reason).to.equal('network')
    })

    it('returns ok=false reason=network when the signal is already aborted before send', async () => {
      // No nock interceptor — if axios honored the pre-aborted signal it
      // never hits the network. If it didn't, this would 503 with
      // "Nock: No match" and fail the assertion below.
      const client = new AxiosAnalyticsHttpClient({baseUrl})
      const controller = new AbortController()
      controller.abort()

      const result = await client.send(
        makeBatch(1),
        {deviceId: validDeviceId, userAgent: 'brv-cli/3.12.0'},
        {signal: controller.signal},
      )

      expect(result.ok).to.equal(false)
      if (result.ok) throw new Error('unreachable')
      expect(result.reason).to.equal('network')
    })

    it('completes normally when an unaborted signal is passed', async () => {
      nock(baseUrl).post('/v1/events').reply(200, {accepted: 1})
      const client = new AxiosAnalyticsHttpClient({baseUrl})
      const controller = new AbortController() // never abort()

      const result = await client.send(
        makeBatch(1),
        {deviceId: validDeviceId, userAgent: 'brv-cli/3.12.0'},
        {signal: controller.signal},
      )

      expect(result.ok, 'unaborted signal must not block a healthy send').to.equal(true)
    })
  })
})
