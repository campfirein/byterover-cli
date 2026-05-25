import type {Socket} from 'socket.io-client'

import {expect} from 'chai'

import {BrvApiClient} from '../../../../src/webui/lib/api-client.js'

function makeStubSocket(
  ack: {code?: string; error?: string; success: boolean} | {data: unknown; success: true},
): Socket {
  return {
    connected: true,
    emit(_event: string, _data: unknown, callback: (response: unknown) => void) {
      callback(ack)
      return this
    },
    off() {
      return this
    },
    once() {
      return this
    },
  } as unknown as Socket
}

interface ControllableSocket extends Socket {
  offCalls: Array<{event: string; handler: () => void}>
  triggerDisconnect: () => void
}

function makeControllableSocket(options: {connected?: boolean; emitAck?: boolean} = {}): ControllableSocket {
  const {connected = true, emitAck = false} = options
  let disconnectHandler: (() => void) | undefined
  const offCalls: Array<{event: string; handler: () => void}> = []
  const socket = {
    connected,
    emit(_event: string, _data: unknown, callback: (response: unknown) => void) {
      if (emitAck) callback({data: 'ok', success: true})
      return socket
    },
    off(event: string, handler: () => void) {
      offCalls.push({event, handler})
      disconnectHandler = undefined
      return socket
    },
    offCalls,
    once(event: string, handler: () => void) {
      if (event === 'disconnect') disconnectHandler = handler
      return socket
    },
    triggerDisconnect() {
      disconnectHandler?.()
    },
  } as unknown as ControllableSocket
  return socket
}

describe('BrvApiClient.request', () => {
  it('rejects with an Error whose .code property matches the server code', async () => {
    const client = new BrvApiClient(
      makeStubSocket({code: 'ERR_VC_AUTH_FAILED', error: 'Authentication failed.', success: false}),
    )

    try {
      await client.request('vc:push')
      expect.fail('request should have rejected')
    } catch (error) {
      expect(error).to.be.instanceOf(Error)
      expect((error as Error).message).to.equal('Authentication failed.')
      expect((error as Error & {code?: string}).code).to.equal('ERR_VC_AUTH_FAILED')
    }
  })

  it('rejects without a .code when the server response omits one', async () => {
    const client = new BrvApiClient(makeStubSocket({error: 'Request failed', success: false}))

    try {
      await client.request('vc:push')
      expect.fail('request should have rejected')
    } catch (error) {
      expect(error).to.be.instanceOf(Error)
      expect((error as Error & {code?: string}).code).to.be.undefined
    }
  })

  it('rejects synchronously when socket is not connected', async () => {
    const client = new BrvApiClient(makeControllableSocket({connected: false}))
    try {
      await client.request('vc:push')
      expect.fail('request should have rejected')
    } catch (error) {
      expect((error as Error).message).to.match(/not connected/i)
    }
  })

  it('rejects fast when socket disconnects before the ack arrives', async () => {
    const socket = makeControllableSocket({connected: true, emitAck: false})
    const client = new BrvApiClient(socket)
    const requestPromise = client.request('vc:push')
    socket.triggerDisconnect()
    try {
      await requestPromise
      expect.fail('request should have rejected')
    } catch (error) {
      expect((error as Error).message).to.match(/disconnected/i)
    }
  })

  it('resolves normally when the ack arrives before disconnect', async () => {
    const socket = makeControllableSocket({connected: true, emitAck: true})
    const client = new BrvApiClient(socket)
    const result = await client.request<string>('vc:push')
    expect(result).to.equal('ok')
  })

  it('removes the disconnect listener after a successful ack', async () => {
    const socket = makeControllableSocket({connected: true, emitAck: true})
    const client = new BrvApiClient(socket)
    await client.request<string>('vc:push')
    expect(socket.offCalls.some((c) => c.event === 'disconnect')).to.equal(true)
  })

  it('removes the disconnect listener after a timeout', async () => {
    const socket = makeControllableSocket({connected: true, emitAck: false})
    const client = new BrvApiClient(socket)
    try {
      await client.request('vc:push', undefined, {timeout: 5})
      expect.fail('request should have rejected')
    } catch (error) {
      expect((error as Error).message).to.match(/timed out/i)
      expect(socket.offCalls.some((c) => c.event === 'disconnect')).to.equal(true)
    }
  })
})
