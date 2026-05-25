import {AcpFrameDecoder, encodeAcpFrame} from './acp-framing.js'

/**
 * Bidirectional JSON-RPC 2.0 over an injected line-based transport.
 *
 * The transport is responsible for byte/line plumbing (typically the
 * stdin/stdout of an ACP child process); this client owns request/response
 * correlation, server-initiated request handling, and notification routing.
 */
export interface AcpRpcTransport {
  onClose(handler: () => void): void
  onLine(handler: (line: string) => void): void
  send(line: string): void
}

export type AcpRpcRequestHandler = (params: unknown) => Promise<unknown> | unknown
export type AcpRpcNotificationHandler = (params: unknown) => void

export class AcpRpcError extends Error {
  public readonly code: number
  public readonly data: unknown

  constructor(code: number, message: string, data?: unknown) {
    super(message)
    this.name = 'AcpRpcError'
    this.code = code
    this.data = data
  }
}

type Pending = {
  reject(error: unknown): void
  resolve(value: unknown): void
}

type JsonRpcMessage = {
  error?: {code: number; data?: unknown; message: string}
  id?: null | number | string
  jsonrpc?: '2.0'
  method?: string
  params?: unknown
  result?: unknown
}

let monotonicId = 0
const nextId = (): string => {
  monotonicId += 1
  return `c-${monotonicId}`
}

export class AcpRpcClient {
  private closed = false
  private readonly decoder = new AcpFrameDecoder()
  private readonly notificationHandlers = new Map<string, AcpRpcNotificationHandler>()
  private readonly pending = new Map<number | string, Pending>()
  private readonly requestHandlers = new Map<string, AcpRpcRequestHandler>()
  private readonly transport: AcpRpcTransport

  constructor(transport: AcpRpcTransport) {
    this.transport = transport
    this.transport.onLine((line) => {
      this.onLine(line)
    })
    this.transport.onClose(() => {
      this.onClose()
    })
  }

  call(method: string, params: unknown): Promise<unknown> {
    if (this.closed) return Promise.reject(new Error('AcpRpcClient: transport is closed'))
    const id = nextId()
    return new Promise<unknown>((resolve, reject) => {
      this.pending.set(id, {reject, resolve})
      this.transport.send(encodeAcpFrame({id, jsonrpc: '2.0', method, params}))
    })
  }

  /**
   * Push raw bytes into the decoder. Useful when the caller drives the
   * transport directly (e.g. a child_process stdout pipe).
   */
  ingest(chunk: Buffer | string): void {
    const messages = this.decoder.push(chunk)
    for (const msg of messages) this.handleMessage(msg as JsonRpcMessage)
  }

  notify(method: string, params: unknown): void {
    if (this.closed) return
    this.transport.send(encodeAcpFrame({jsonrpc: '2.0', method, params}))
  }

  onNotification(method: string, handler: AcpRpcNotificationHandler): void {
    this.notificationHandlers.set(method, handler)
  }

  onRequest(method: string, handler: AcpRpcRequestHandler): void {
    this.requestHandlers.set(method, handler)
  }

  private handleMessage(msg: JsonRpcMessage): void {
    // Response to one of our outbound calls.
    if (msg.id !== undefined && msg.id !== null && msg.method === undefined) {
      const pending = this.pending.get(msg.id)
      if (pending === undefined) return
      this.pending.delete(msg.id)
      if (msg.error === undefined) {
        pending.resolve(msg.result)
      } else {
        pending.reject(new AcpRpcError(msg.error.code, msg.error.message, msg.error.data))
      }

      return
    }

    // Incoming notification.
    if ((msg.id === undefined || msg.id === null) && typeof msg.method === 'string') {
      const handler = this.notificationHandlers.get(msg.method)
      if (handler !== undefined) handler(msg.params)
      return
    }

    // Incoming server-initiated request.
    if (msg.id !== undefined && msg.id !== null && typeof msg.method === 'string') {
      const handler = this.requestHandlers.get(msg.method)
      if (handler === undefined) {
        this.transport.send(
          encodeAcpFrame({
            error: {code: -32_601, message: `method not found: ${msg.method}`},
            id: msg.id,
            jsonrpc: '2.0',
          }),
        )
        return
      }

      Promise.resolve()
        .then(() => handler(msg.params))
        .then(
          (result) => {
            this.transport.send(encodeAcpFrame({id: msg.id, jsonrpc: '2.0', result}))
          },
          (error: unknown) => {
            const message = error instanceof Error ? error.message : String(error)
            this.transport.send(
              encodeAcpFrame({error: {code: -32_000, message}, id: msg.id, jsonrpc: '2.0'}),
            )
          },
        )
    }
  }

  private onClose(): void {
    this.closed = true
    const err = new Error('AcpRpcClient: transport closed before response')
    for (const pending of this.pending.values()) {
      pending.reject(err)
    }

    this.pending.clear()
  }

  private onLine(line: string): void {
    if (line.trim() === '') return
    let msg: JsonRpcMessage
    try {
      msg = JSON.parse(line) as JsonRpcMessage
    } catch {
      return
    }

    this.handleMessage(msg)
  }
}
