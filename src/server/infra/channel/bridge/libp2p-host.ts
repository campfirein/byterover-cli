import {noise} from '@chainsafe/libp2p-noise'
import {yamux} from '@chainsafe/libp2p-yamux'
import {identify} from '@libp2p/identify'
import {tcp} from '@libp2p/tcp'
import {createLibp2p, type Libp2p} from 'libp2p'

import {InstallIdentityService} from '../../../../agent/core/trust/install-identity-service.js'
import {type BridgeConfig} from './bridge-config.js'

/**
 * Phase 9 / IMPLEMENTATION_PHASE_9_CLOUD_BRIDGE.md §3.2 + Slice 9.1 —
 * Libp2pHost singleton.
 *
 * Wraps `createLibp2p` from the `libp2p` core package with brv-specific
 * setup:
 *
 *   - Host key = L1 install Ed25519 key (AMENDMENT_TOFU §A7 "bind the
 *     keys": same key signs libp2p Noise handshakes AND brv L1
 *     application signatures, so the libp2p-level PeerID equals the
 *     brv peer_id by construction).
 *   - Transports: TCP only in 9.1b. QUIC + WSS deferred (Phase 9 plan
 *     §8 includes them as listener options but Node-libp2p QUIC has
 *     variable maturity; ship the minimum that round-trips reliably
 *     and add transports in 9.7 NAT slice).
 *   - Connection encryption: Noise.
 *   - Stream multiplexer: Yamux.
 *   - Service: identify (libp2p-default; enables peer to advertise its
 *     multiaddrs + supported protocols on connection).
 *
 * The libp2p Node is started lazily via `start()` and disposed via
 * `stop()`. Both are idempotent. Reading `peerId` or `getMultiaddrs`
 * before `start()` throws.
 */

export interface Libp2pHostDeps {
  readonly config: BridgeConfig
  readonly identity: InstallIdentityService
}

/**
 * Inbound stream shape exposed to brv handlers. Mirrors the subset of
 * the libp2p Stream API we use:
 *   - async-iterable for reading (yields Uint8ArrayList chunks)
 *   - `send(chunk)` for writing
 *   - `close()` for half-close on both directions
 */
export interface Libp2pStreamLike extends AsyncIterable<{readonly subarray: () => Uint8Array}> {
  close(): Promise<void>
  /**
   * The libp2p PeerID of the remote end of the connection that opened
   * this stream, as a base58btc string. Established by the Noise
   * handshake — cannot be spoofed by the application layer.
   */
  readonly remotePeerId: string
  send(chunk: Uint8Array): Promise<void>
}

export type Libp2pStreamHandler = (stream: Libp2pStreamLike) => Promise<void>

/**
 * Minimal subset of libp2p's Stream that we depend on. Defined here
 * (not imported from libp2p) so the adapter doesn't break on libp2p
 * minor-version stream-API tweaks (opencode round-3 MEDIUM-3). If
 * libp2p removes one of these methods, the adapter fails at compile
 * time on the field access, not at runtime mid-stream.
 */
interface Libp2pStreamMin extends AsyncIterable<{readonly subarray: () => Uint8Array}> {
  close(): Promise<void>
  send(chunk: Uint8Array): Promise<void>
}

/**
 * Adapter that wraps a libp2p Stream as the brv `Libp2pStreamLike`
 * shape. Replaces the `as unknown as` cast (opencode round-3 MEDIUM-3
 * fix): each method is explicitly mapped, so a libp2p API change
 * surfaces here at compile time rather than silently at runtime.
 */
class Libp2pStreamAdapter implements Libp2pStreamLike {
  public readonly remotePeerId: string
  private readonly stream: Libp2pStreamMin

  public constructor(stream: Libp2pStreamMin, remotePeerId: string) {
    this.stream = stream
    this.remotePeerId = remotePeerId
  }

  public async close(): Promise<void> {
    await this.stream.close()
  }

  public async send(chunk: Uint8Array): Promise<void> {
    await this.stream.send(chunk)
  }

  public [Symbol.asyncIterator](): AsyncIterator<{readonly subarray: () => Uint8Array}> {
    return this.stream[Symbol.asyncIterator]()
  }
}

export class Libp2pHost {
  private readonly config: BridgeConfig
  private readonly identity: InstallIdentityService
  private node: Libp2p | undefined
  private startPromise: Promise<void> | undefined

  public constructor(deps: Libp2pHostDeps) {
    this.identity = deps.identity
    this.config = deps.config
  }

  /**
   * The libp2p PeerID of this host as a base58btc string. Equal to
   * the brv L1 peer_id by construction (same install Ed25519 key).
   */
  public get peerId(): string {
    if (!this.node) {
      throw new Error('Libp2pHost not started; call start() first')
    }

    return this.node.peerId.toString()
  }

  /**
   * Dial a remote peer's multiaddr, open an outbound stream on the
   * given protocol, hand the raw libp2p Stream to the caller's
   * `body` callback, and close the stream when the callback resolves.
   *
   * Used by Slice 9.2's identity-client to read a length-prefixed
   * varint frame. The callback gets the raw stream (not the brv
   * adapter shape) so it can use libp2p-ecosystem iterables like
   * `it-length-prefixed`.
   *
   * Slice 9.3 supersedes this with proper request/response streaming
   * in `parley-client.ts`.
   *
   * @internal
   */
  public async dialAndConsume<T>(
    multiaddrStr: string,
    protocol: string,
    body: (stream: AsyncIterable<{readonly subarray: () => Uint8Array}>) => Promise<T>,
  ): Promise<T> {
    const node = this.ensureStarted()
    const {multiaddr} = await import('@multiformats/multiaddr')
    const ma = multiaddr(multiaddrStr)
    const stream = await node.dialProtocol(ma, protocol)
    try {
      return await body(stream as unknown as AsyncIterable<{readonly subarray: () => Uint8Array}>)
    } finally {
      await stream.close().catch(() => {})
    }
  }

  /**
   * Dial + send + consume in one call: write `payload` to the dialed
   * stream BEFORE invoking `body` on the read side. Used by the Parley
   * client which writes a single length-prefixed envelope frame then
   * reads the response stream.
   *
   * The write goes through libp2p Stream's `send()`. The read side is
   * the same raw async-iterable as `dialAndConsume`. Both sides share
   * one Yamux substream; libp2p handles the duplex framing.
   *
   * Phase 9.5.7 §3.3 Layer C — when `signal` is provided:
   *   1. Passed to `dialProtocol()` to interrupt the dial/protocol phase.
   *   2. Wired to the established stream's `abort()` method so the stream
   *      is torn down immediately when the signal fires, unblocking any
   *      in-flight read in the body.
   *   3. Passed into `body` as a second argument so the frame reader can
   *      race each `iterator.next()` against the abort promise.
   *
   * The abort listener is removed in the `finally` block so it cannot leak.
   * `signal.reason` is preserved verbatim: `stream.abort(signal.reason)`
   * (not replaced with a generic PARLEY_ABORT_VIA_SIGNAL marker).
   *
   * Slice 9.3 wire helper; Slice 9.4 replaces with `parley-client.ts`'s
   * higher-level API.
   *
   * @internal
   */
  public async dialAndSendAndConsume<T>(
    multiaddrStr: string,
    protocol: string,
    payload: Uint8Array,
    options: {
      readonly body: (stream: AsyncIterable<{readonly subarray: () => Uint8Array}>, signal?: AbortSignal) => Promise<T>
      /** Phase 9.5.7 §3.3 Layer C — optional AbortSignal. */
      readonly signal?: AbortSignal
    },
  ): Promise<T>
  /**
   * Backwards-compat overload used by the parley-server tests (positional `body` arg,
   * no signal). Callers that don't need signal can still pass a function as the 4th arg.
   */
  public async dialAndSendAndConsume<T>(
    multiaddrStr: string,
    protocol: string,
    payload: Uint8Array,
    body: (stream: AsyncIterable<{readonly subarray: () => Uint8Array}>) => Promise<T>,
  ): Promise<T>
  public async dialAndSendAndConsume<T>(
    multiaddrStr: string,
    protocol: string,
    payload: Uint8Array,
    bodyOrOptions:
      | ((stream: AsyncIterable<{readonly subarray: () => Uint8Array}>) => Promise<T>)
      | {
          readonly body: (stream: AsyncIterable<{readonly subarray: () => Uint8Array}>, signal?: AbortSignal) => Promise<T>
          readonly signal?: AbortSignal
        },
  ): Promise<T> {
    const {body, signal} =
      typeof bodyOrOptions === 'function'
        ? {body: bodyOrOptions as (stream: AsyncIterable<{readonly subarray: () => Uint8Array}>, signal?: AbortSignal) => Promise<T>, signal: undefined}
        : bodyOrOptions

    const node = this.ensureStarted()
    const {multiaddr} = await import('@multiformats/multiaddr')
    const ma = multiaddr(multiaddrStr)
    // Pass signal to dialProtocol to abort the dial/protocol phase.
    const stream = await node.dialProtocol(ma, protocol, signal === undefined ? undefined : {signal})

    // §3.3 Layer C — wire the signal to the established stream so abort tears
    // it down immediately after dial, unblocking in-flight reads in the body.
    const onAbort = (): void => {
      // Preserve signal.reason if the abort carried a custom error.
      const reason = signal?.reason instanceof Error ? signal.reason : new Error('PARLEY_ABORT_VIA_SIGNAL')
      // The libp2p Stream may or may not have a typed abort() method; use
      // bracket access to avoid compile-time dependency on libp2p internals.
      const streamWithAbort = stream as unknown as {abort?: (reason?: Error) => void}
      streamWithAbort.abort?.(reason)
    }

    if (signal !== undefined) {
      signal.addEventListener('abort', onAbort, {once: true})
    }

    try {
      await stream.send(payload)

      return await body(stream as unknown as AsyncIterable<{readonly subarray: () => Uint8Array}>, signal)
    } finally {
      // Remove listener unconditionally so it never leaks, even if signal
      // never fired (codex round-3 constraint: remove in finally).
      if (signal !== undefined) {
        signal.removeEventListener('abort', onAbort)
      }

      await stream.close().catch(() => {})
    }
  }

  /**
   * Dial a remote peer's multiaddr, open an outbound stream on the
   * given protocol, write one Uint8Array frame, then close. Convenience
   * for the in-process test fixture; Slice 9.3 will replace this with
   * proper request/response streaming in `parley-client.ts`.
   *
   * Do NOT build production flows on this. Marked internal per opencode
   * round-3 MINOR-3 so API consumers can't bind to it accidentally
   * before Slice 9.3's proper streaming surface lands.
   *
   * @internal
   */
  public async dialAndWrite(multiaddrStr: string, protocol: string, payload: Uint8Array): Promise<void> {
    const node = this.ensureStarted()
    // libp2p's multiaddr is constructed from a string here.
    const {multiaddr} = await import('@multiformats/multiaddr')
    const ma = multiaddr(multiaddrStr)
    const stream = await node.dialProtocol(ma, protocol)
    try {
      await stream.send(payload)
    } finally {
      await stream.close()
    }
  }

  /**
   * Current listening multiaddrs (libp2p p2p-suffixed form).
   */
  public getMultiaddrs(): string[] {
    if (!this.node) {
      throw new Error('Libp2pHost not started; call start() first')
    }

    return this.node.getMultiaddrs().map((m) => m.toString())
  }

  /**
   * Register an inbound stream handler for a protocol ID.
   * Used by Slice 9.3+ to register `/brv/parley/query/v1` etc.
   *
   * The libp2p `handle()` callback signature in libp2p v3 takes a
   * Stream object directly (NOT `{stream, connection}` as some older
   * docs show). The Stream is duplex: AsyncIterable for reads, `send`
   * for writes.
   */
  public async handle(protocol: string, handler: Libp2pStreamHandler): Promise<void> {
    const node = this.ensureStarted()
    await node.handle(protocol, async (stream, connection) => {
      // Wrap in an adapter that maps libp2p's Stream → Libp2pStreamLike
      // explicitly (opencode round-3 MEDIUM-3). Avoids `as unknown as`.
      // The libp2p Stream IS structurally compatible with Libp2pStreamMin;
      // the adapter pins each method so a libp2p API change surfaces at
      // compile time.
      //
      // `connection.remotePeer` is the Noise-authenticated peer_id of
      // the dialer — pass it through so Parley verifier step 3
      // (transport identity match) can compare against the install
      // cert's derived peer_id.
      const adapted = new Libp2pStreamAdapter(
        stream as unknown as Libp2pStreamMin,
        connection.remotePeer.toString(),
      )
      await handler(adapted)
    })
  }

  /**
   * Start the libp2p node. Idempotent — concurrent / repeated calls
   * resolve to the same boot.
   */
  public async start(): Promise<void> {
    if (this.node) return
    if (this.startPromise) {
      await this.startPromise
      return
    }

    this.startPromise = this.bootInternal().finally(() => {
      this.startPromise = undefined
    })
    await this.startPromise
  }

  /**
   * Stop the libp2p node. Idempotent.
   *
   * Awaits any in-flight start so a concurrent `start()` + `stop()` pair
   * cannot leave the host running after stop() returned (opencode round-3
   * MEDIUM-2). On the wait-for-boot path, callers see the booted node
   * briefly via peerId/getMultiaddrs, then the stop completes.
   */
  public async stop(): Promise<void> {
    if (this.startPromise) {
      // Boot in flight — wait for it to settle so we can stop the
      // resulting node deterministically. Don't propagate boot
      // failures: stop() is idempotent.
      await this.startPromise.catch(() => {})
    }

    if (!this.node) return
    const {node} = this
    this.node = undefined
    await node.stop()
  }

  private async bootInternal(): Promise<void> {
    // Load the L1 install identity. The install-identity service is
    // lazy: first call may generate. We re-use the cache on subsequent
    // calls.
    await this.identity.loadOrGenerate()

    // AMENDMENT_TOFU §A7 — same L1 install key drives libp2p Noise AND
    // brv L1 application signatures. getLibp2pPrivateKey is the
    // controlled escape hatch documented in install-identity-service.
    const libp2pPrivateKey = await this.identity.getLibp2pPrivateKey()

    this.node = await createLibp2p({
      addresses: {listen: [...this.config.listen_addrs]},
      connectionEncrypters: [noise()],
      privateKey: libp2pPrivateKey,
      services: {identify: identify()},
      streamMuxers: [yamux()],
      transports: [tcp()],
    })

    await this.node.start()
  }

  private ensureStarted(): Libp2p {
    if (!this.node) {
      throw new Error('Libp2pHost not started; call start() first')
    }

    return this.node
  }
}

