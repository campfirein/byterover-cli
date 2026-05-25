/**
 * BrvApiClient (browser version)
 *
 * Typed wrapper around socket.io-client Socket.
 * Provides request/response and event subscription primitives.
 * Mirror of src/tui/lib/api-client.ts without Node.js transport logger.
 */

import type {Socket} from 'socket.io-client'

interface AckResponse<T> {
  code?: string
  data: T
  error?: string
  success: boolean
}

export interface RequestOptions {
  timeout?: number
}

export const DEFAULT_REQUEST_TIMEOUT_MS = 5000

export class BrvApiClient {
  constructor(private readonly socket: Socket) {}

  on<T>(event: string, handler: (data: T) => void): () => void {
    this.socket.on(event, handler as (...args: unknown[]) => void)
    return () => {
      this.socket.off(event, handler as (...args: unknown[]) => void)
    }
  }

  async request<TResponse, TRequest = unknown>(
    event: string,
    data?: TRequest,
    options?: RequestOptions,
  ): Promise<TResponse> {
    if (!this.socket.connected) {
      throw new Error(`Socket not connected — cannot send ${event}`)
    }

    return new Promise<TResponse>((resolve, reject) => {
      let didFinish = false
      const timeout = options?.timeout ?? DEFAULT_REQUEST_TIMEOUT_MS
      const timeoutId = globalThis.setTimeout(() => {
        if (didFinish) return
        didFinish = true
        this.socket.off('disconnect', onDisconnect)
        reject(new Error(`Request timed out after ${timeout}ms`))
      }, timeout)

      const onDisconnect = () => {
        if (didFinish) return
        didFinish = true
        globalThis.clearTimeout(timeoutId)
        reject(new Error(`Socket disconnected before ${event} acked`))
      }

      this.socket.once('disconnect', onDisconnect)

      this.socket.emit(event, data, (response: AckResponse<TResponse>) => {
        if (didFinish) return

        didFinish = true
        globalThis.clearTimeout(timeoutId)
        this.socket.off('disconnect', onDisconnect)

        if (response.success) {
          resolve(response.data)
        } else {
          const err = Object.assign(
            new Error(response.error ?? 'Request failed'),
            response.code ? {code: response.code} : {},
          )
          reject(err)
        }
      })
    })
  }
}
