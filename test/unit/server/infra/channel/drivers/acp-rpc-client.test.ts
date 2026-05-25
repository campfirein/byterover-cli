import {expect} from 'chai'

import {AcpRpcClient, AcpRpcError} from '../../../../../../src/server/infra/channel/drivers/acp-rpc-client.js'

// Slice 2.2 — bidirectional JSON-RPC 2.0 client. Speaks NDJSON via an
// injected transport so the unit test never spawns a child process.

type SentLine = string

const makeFakeTransport = () => {
  const sent: SentLine[] = []
  let lineHandler: ((line: string) => void) | undefined
  let closeHandler: (() => void) | undefined
  return {
    receive(line: string): void {
      lineHandler?.(line)
    },
    sent,
    transport: {
      onClose(handler: () => void): void {
        closeHandler = handler
      },
      onLine(handler: (line: string) => void): void {
        lineHandler = handler
      },
      send(line: string): void {
        sent.push(line)
      },
    },
    triggerClose(): void {
      closeHandler?.()
    },
  }
}

describe('AcpRpcClient', () => {
  it('round-trips call(method, params) → response via id matching', async () => {
    const fake = makeFakeTransport()
    const client = new AcpRpcClient(fake.transport)

    const pending = client.call('initialize', {protocolVersion: 1})
    expect(fake.sent).to.have.lengthOf(1)
    const sentMsg = JSON.parse(fake.sent[0]) as {id: string; method: string; params: unknown}
    expect(sentMsg.method).to.equal('initialize')
    expect(sentMsg.params).to.deep.equal({protocolVersion: 1})

    fake.receive(JSON.stringify({id: sentMsg.id, jsonrpc: '2.0', result: {protocolVersion: 1}}))
    const result = await pending
    expect(result).to.deep.equal({protocolVersion: 1})
  })

  it('notify(method, params) sends a request without an id and expects no response', () => {
    const fake = makeFakeTransport()
    const client = new AcpRpcClient(fake.transport)

    client.notify('session/update', {sessionId: 's', update: {sessionUpdate: 'agent_message_chunk'}})
    expect(fake.sent).to.have.lengthOf(1)
    const sent = JSON.parse(fake.sent[0]) as {id?: unknown; method: string}
    expect(sent.id).to.equal(undefined)
    expect(sent.method).to.equal('session/update')
  })

  it('rejects call() when the response carries an error', async () => {
    const fake = makeFakeTransport()
    const client = new AcpRpcClient(fake.transport)

    const pending = client.call('initialize', {})
    const sentMsg = JSON.parse(fake.sent[0]) as {id: string}
    fake.receive(
      JSON.stringify({error: {code: -32_601, data: {foo: 'bar'}, message: 'method not found'}, id: sentMsg.id, jsonrpc: '2.0'}),
    )

    try {
      await pending
      expect.fail('expected AcpRpcError')
    } catch (error) {
      expect(error).to.be.instanceOf(AcpRpcError)
      expect((error as AcpRpcError).code).to.equal(-32_601)
      expect((error as AcpRpcError).message).to.equal('method not found')
      expect((error as AcpRpcError).data).to.deep.equal({foo: 'bar'})
    }
  })

  it('routes server-initiated requests to a registered request handler and replies', async () => {
    const fake = makeFakeTransport()
    const client = new AcpRpcClient(fake.transport)

    client.onRequest('session/request_permission', async () => ({outcome: {outcome: 'cancelled'}}))

    fake.receive(
      JSON.stringify({id: 'p-1', jsonrpc: '2.0', method: 'session/request_permission', params: {sessionId: 's'}}),
    )

    // Allow the handler microtask to run.
    await new Promise((resolve) => {
      setImmediate(resolve)
    })

    const response = fake.sent.map((line) => JSON.parse(line)).find((m) => m.id === 'p-1')
    expect(response).to.not.equal(undefined)
    expect(response.result).to.deep.equal({outcome: {outcome: 'cancelled'}})
  })

  it('routes incoming notifications to a registered notification handler', async () => {
    const fake = makeFakeTransport()
    const client = new AcpRpcClient(fake.transport)
    const received: unknown[] = []
    client.onNotification('session/update', (params) => {
      received.push(params)
    })

    fake.receive(JSON.stringify({jsonrpc: '2.0', method: 'session/update', params: {sessionId: 's', update: {}}}))
    expect(received).to.have.lengthOf(1)
    expect((received[0] as {sessionId: string}).sessionId).to.equal('s')
  })

  it('rejects in-flight call() promises when the transport closes', async () => {
    const fake = makeFakeTransport()
    const client = new AcpRpcClient(fake.transport)
    const pending = client.call('initialize', {})
    fake.triggerClose()
    try {
      await pending
      expect.fail('expected rejection')
    } catch (error) {
      expect((error as Error).message).to.match(/closed|disconnect/i)
    }
  })
})
