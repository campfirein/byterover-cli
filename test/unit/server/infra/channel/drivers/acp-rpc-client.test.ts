import {expect} from 'chai'

import {
  AcpRpcClient,
  AcpRpcError,
  type AcpRpcTransport,
} from '../../../../../../src/server/infra/channel/drivers/acp-rpc-client.js'

// Bidirectional JSON-RPC 2.0 over an injected line transport. The client owns
// request/response correlation, server-initiated request handling, and
// notification routing; the transport owns byte/line plumbing.

/** In-memory transport that captures outbound frames and lets tests inject inbound ones. */
class FakeTransport implements AcpRpcTransport {
  public readonly sent: string[] = []
  private closeHandler: (() => void) | undefined
  private lineHandler: ((line: string) => void) | undefined

  emitClose(): void {
    this.closeHandler?.()
  }

  emitLine(line: string): void {
    this.lineHandler?.(line)
  }

  lastSent(): Record<string, unknown> {
    return JSON.parse(this.sent.at(-1) ?? '{}')
  }

  onClose(handler: () => void): void {
    this.closeHandler = handler
  }

  onLine(handler: (line: string) => void): void {
    this.lineHandler = handler
  }

  send(line: string): void {
    this.sent.push(line)
  }
}

const nextTick = (): Promise<void> =>
  new Promise((resolve) => {
    setImmediate(resolve)
  })

describe('AcpRpcClient', () => {
  it('sends a framed JSON-RPC request and resolves on the matching id', async () => {
    const transport = new FakeTransport()
    const client = new AcpRpcClient(transport)
    const promise = client.call('initialize', {protocolVersion: 1})

    const req = transport.lastSent()
    expect(req.jsonrpc).to.equal('2.0')
    expect(req.method).to.equal('initialize')
    expect(req.params).to.deep.equal({protocolVersion: 1})

    transport.emitLine(JSON.stringify({id: req.id, jsonrpc: '2.0', result: {ok: true}}))
    expect(await promise).to.deep.equal({ok: true})
  })

  it('rejects with AcpRpcError when the response carries an error', async () => {
    const transport = new FakeTransport()
    const client = new AcpRpcClient(transport)
    const promise = client.call('session/new', {})
    const {id} = transport.lastSent()

    transport.emitLine(
      JSON.stringify({error: {code: -32_602, data: {field: 'cwd'}, message: 'bad params'}, id, jsonrpc: '2.0'}),
    )

    let caught: unknown
    await promise.catch((error: unknown) => {
      caught = error
    })
    expect(caught).to.be.instanceOf(AcpRpcError)
    const err = caught as AcpRpcError
    expect(err.code).to.equal(-32_602)
    expect(err.message).to.equal('bad params')
    expect(err.data).to.deep.equal({field: 'cwd'})
  })

  it('routes an incoming notification to its registered handler', () => {
    const transport = new FakeTransport()
    const client = new AcpRpcClient(transport)
    let received: unknown
    client.onNotification('session/update', (params) => {
      received = params
    })

    transport.emitLine(JSON.stringify({jsonrpc: '2.0', method: 'session/update', params: {sessionUpdate: 'x'}}))
    expect(received).to.deep.equal({sessionUpdate: 'x'})
  })

  it('answers a server-initiated request with the handler result', async () => {
    const transport = new FakeTransport()
    const client = new AcpRpcClient(transport)
    client.onRequest('session/request_permission', () => ({outcome: 'allow'}))

    transport.emitLine(
      JSON.stringify({id: 'srv-1', jsonrpc: '2.0', method: 'session/request_permission', params: {}}),
    )
    await nextTick()

    expect(transport.lastSent()).to.deep.equal({id: 'srv-1', jsonrpc: '2.0', result: {outcome: 'allow'}})
  })

  it('replies method-not-found to an unhandled server request', () => {
    const transport = new FakeTransport()
    const client = new AcpRpcClient(transport)
    client.onRequest('known/method', () => ({}))

    transport.emitLine(JSON.stringify({id: 'srv-2', jsonrpc: '2.0', method: 'unknown/method', params: {}}))

    const reply = transport.lastSent()
    expect(reply.id).to.equal('srv-2')
    expect(reply.error).to.deep.equal({code: -32_601, message: 'method not found: unknown/method'})
  })

  it('rejects all pending calls when the transport closes', async () => {
    const transport = new FakeTransport()
    const client = new AcpRpcClient(transport)
    const promise = client.call('initialize', {})

    transport.emitClose()

    let caught: unknown
    await promise.catch((error: unknown) => {
      caught = error
    })
    expect(caught).to.be.instanceOf(Error)
    expect((caught as Error).message).to.contain('closed')
  })

  it('rejects a call made after the transport has closed', async () => {
    const transport = new FakeTransport()
    const client = new AcpRpcClient(transport)
    transport.emitClose()

    let caught: unknown
    await client.call('x', {}).catch((error: unknown) => {
      caught = error
    })
    expect(caught).to.be.instanceOf(Error)
  })

  it('correlates responses fed through ingest()', async () => {
    const transport = new FakeTransport()
    const client = new AcpRpcClient(transport)
    const promise = client.call('initialize', {})
    const {id} = transport.lastSent()

    client.ingest(`${JSON.stringify({id, jsonrpc: '2.0', result: {via: 'ingest'}})}\n`)
    expect(await promise).to.deep.equal({via: 'ingest'})
  })

  it('notify() sends a method frame with no id', () => {
    const transport = new FakeTransport()
    const client = new AcpRpcClient(transport)
    client.notify('session/cancel', {sessionId: 's1'})

    const sent = transport.lastSent()
    expect(sent.method).to.equal('session/cancel')
    expect(sent.id).to.equal(undefined)
    expect(sent.params).to.deep.equal({sessionId: 's1'})
  })
})
