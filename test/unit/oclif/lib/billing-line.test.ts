import type {ITransportClient} from '@campfirein/brv-transport-client'

import {expect} from 'chai'
import sinon, {restore, stub} from 'sinon'

import type {StatusBillingDTO} from '../../../../src/shared/transport/types/dto.js'

import {printBillingLine} from '../../../../src/oclif/lib/billing-line.js'
import {BillingEvents} from '../../../../src/shared/transport/events/billing-events.js'

function stripAnsi(value: string): string {
  // eslint-disable-next-line no-control-regex
  return value.replaceAll(/\u001B\[[0-9;]*m/g, '')
}

describe('printBillingLine', () => {
  let mockClient: sinon.SinonStubbedInstance<ITransportClient>
  let logged: string[]

  beforeEach(() => {
    logged = []
    mockClient = {
      requestWithAck: stub().resolves({}),
    } as unknown as sinon.SinonStubbedInstance<ITransportClient>
  })

  afterEach(() => {
    restore()
  })

  function setBilling(billing: StatusBillingDTO): void {
    ;(mockClient.requestWithAck as sinon.SinonStub).withArgs(BillingEvents.RESOLVE).resolves({billing})
  }

  it('does not log in json format but still returns the billing payload', async () => {
    const billing = {organizationId: 'org-acme', remaining: 100, source: 'paid' as const, tier: 'PRO' as const, total: 1000}
    setBilling(billing)

    const result = await printBillingLine({
      client: mockClient as unknown as ITransportClient,
      format: 'json',
      log: (m) => logged.push(m),
    })

    expect(logged).to.deep.equal([])
    expect(result).to.deep.equal(billing)
  })

  it('returns the billing payload when logging in text mode', async () => {
    const billing = {organizationId: 'org-acme', organizationName: 'Acme Corp', remaining: 87_600, source: 'paid' as const, tier: 'PRO' as const, total: 100_000}
    setBilling(billing)

    const result = await printBillingLine({
      client: mockClient as unknown as ITransportClient,
      format: 'text',
      log: (m) => logged.push(m),
    })

    expect(result).to.deep.equal(billing)
  })

  it('logs the formatted line for a paid source', async () => {
    setBilling({
      organizationId: 'org-acme',
      organizationName: 'Acme Corp',
      remaining: 87_600,
      source: 'paid',
      tier: 'PRO',
      total: 100_000,
    })

    await printBillingLine({
      client: mockClient as unknown as ITransportClient,
      format: 'text',
      log: (m) => logged.push(m),
    })

    expect(logged).to.have.lengthOf(1)
    expect(stripAnsi(logged[0])).to.equal('Billing: Acme Corp (87,600 credits, PRO)')
  })

  it('skips logging for other-provider', async () => {
    setBilling({activeProvider: 'openai', source: 'other-provider'})

    await printBillingLine({
      client: mockClient as unknown as ITransportClient,
      format: 'text',
      log: (m) => logged.push(m),
    })

    expect(logged).to.deep.equal([])
  })

  it('skips logging when billing is undefined (unauthenticated / service unavailable)', async () => {
    ;(mockClient.requestWithAck as sinon.SinonStub).withArgs(BillingEvents.RESOLVE).resolves({})

    await printBillingLine({
      client: mockClient as unknown as ITransportClient,
      format: 'text',
      log: (m) => logged.push(m),
    })

    expect(logged).to.deep.equal([])
  })

  it('does not throw when the daemon call rejects', async () => {
    ;(mockClient.requestWithAck as sinon.SinonStub).withArgs(BillingEvents.RESOLVE).rejects(new Error('boom'))

    await printBillingLine({
      client: mockClient as unknown as ITransportClient,
      format: 'text',
      log: (m) => logged.push(m),
    })

    expect(logged).to.deep.equal([])
  })
})
