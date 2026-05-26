/* eslint-disable camelcase */
import type {ITransportClient} from '@campfirein/brv-transport-client'

import {expect} from 'chai'
import {stub} from 'sinon'

import type {CliInvocationProps} from '../../../../src/shared/analytics/events/cli-invocation.js'

import {emitAnalytics} from '../../../../src/shared/analytics/emit.js'
import {AnalyticsEventNames} from '../../../../src/shared/analytics/event-names.js'
import {AnalyticsEvents} from '../../../../src/shared/transport/events/analytics-events.js'

function makeStubClient(overrides: Partial<ITransportClient> = {}): ITransportClient {
  return {
    connect: stub(),
    disconnect: stub(),
    getClientId: stub(),
    getState: stub(),
    isConnected: stub().resolves(true),
    joinRoom: stub(),
    leaveRoom: stub(),
    on: stub().returns(() => {}),
    once: stub(),
    onStateChange: stub().returns(() => {}),
    request: stub(),
    requestWithAck: stub(),
    ...overrides,
  } as unknown as ITransportClient
}

const fullCliInvocation: CliInvocationProps = {
  client_sent_at: 1_700_000_000_000,
  command_id: 'status',
  flag_names: [],
  is_ci: false,
  is_tty: true,
  package_manager: 'npm',
  runtime: 'node',
}

describe('emitAnalytics', () => {
  it('should call client.request with analytics:track and the expected payload (typed event + props)', () => {
    const client = makeStubClient()

    emitAnalytics(client, AnalyticsEventNames.CLI_INVOCATION, fullCliInvocation)

    const requestStub = client.request as ReturnType<typeof stub>
    expect(requestStub.calledOnce).to.equal(true)
    expect(requestStub.firstCall.args[0]).to.equal(AnalyticsEvents.TRACK)
    expect(requestStub.firstCall.args[1]).to.deep.equal({
      event: AnalyticsEventNames.CLI_INVOCATION,
      properties: fullCliInvocation,
    })
  })

  it('should accept the daemon_start event with no properties argument', () => {
    const client = makeStubClient()

    // daemon_start has empty `{}` schema; the typed PropsArg makes properties
    // optional in this case so callers do not have to pass `{}` explicitly.
    emitAnalytics(client, AnalyticsEventNames.DAEMON_START)

    const requestStub = client.request as ReturnType<typeof stub>
    expect(requestStub.calledOnce).to.equal(true)
    expect(requestStub.firstCall.args[1]).to.deep.equal({
      event: AnalyticsEventNames.DAEMON_START,
      properties: undefined,
    })
  })

  it('should NOT throw when client.request throws (e.g. TransportNotConnectedError)', () => {
    const client = makeStubClient({
      request: stub().throws(new Error('not connected')) as unknown as ITransportClient['request'],
    })

    expect(() => emitAnalytics(client, AnalyticsEventNames.DAEMON_START)).to.not.throw()
  })

  it('should emit exactly ONE event per call', () => {
    const client = makeStubClient()

    emitAnalytics(client, AnalyticsEventNames.DAEMON_START)
    emitAnalytics(client, AnalyticsEventNames.CLI_INVOCATION, fullCliInvocation)

    const requestStub = client.request as ReturnType<typeof stub>
    expect(requestStub.callCount).to.equal(2)
  })
})
