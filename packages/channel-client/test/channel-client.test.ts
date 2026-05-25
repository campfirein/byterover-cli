import {expect} from 'chai'

import {ChannelClient, ChannelClientError, type TurnEvent, discoverDaemon} from '../src/index.js'
import {startMockDaemon, type MockDaemon} from './helpers/mock-daemon.js'

// Slice 7.−1a — TS client unit tests, driven outside-in by the Pi
// extension's slash-command needs (see IMPLEMENTATION_PHASE_7.md).
//
// The tests use a real Socket.IO server on an ephemeral port — not a
// pure in-memory fake — so we exercise the actual handshake auth path
// + ack envelope serialization.

describe('ChannelClient (Slice 7.−1a)', () => {
  let daemon: MockDaemon

  beforeEach(async () => {
    daemon = await startMockDaemon()
  })

  afterEach(async () => {
    await daemon.stop()
  })

  describe('discoverDaemon', () => {
    it('reads daemonUrl + authToken from <dataDir>/daemon.json + state/daemon-auth-token', async () => {
      const discovered = await discoverDaemon({dataDir: daemon.dataDir})
      expect(discovered.daemonUrl).to.equal(daemon.daemonUrl)
      expect(discovered.authToken).to.equal(daemon.authToken)
    })

    it('throws BRV_DAEMON_NOT_INITIALISED when daemon.json is missing', async () => {
      let caught: unknown
      try {
        await discoverDaemon({dataDir: '/tmp/brv-test-nonexistent-' + Math.random()})
      } catch (error) {
        caught = error
      }

      expect(caught).to.be.instanceOf(ChannelClientError)
      expect((caught as ChannelClientError).code).to.equal('BRV_DAEMON_NOT_INITIALISED')
    })
  })

  describe('connect', () => {
    it('connects to the daemon URL discovered on disk + sends auth token in handshake', async () => {
      const client = await ChannelClient.connect({dataDir: daemon.dataDir})
      try {
        expect(client.connected).to.equal(true)
        expect(daemon.receivedAuthTokens).to.include(daemon.authToken)
      } finally {
        await client.close()
      }

      expect(client.connected).to.equal(false)
    })

    it('honours explicit daemonUrl + authToken overrides (skips disk discovery)', async () => {
      const client = await ChannelClient.connect({
        authToken: daemon.authToken,
        daemonUrl: daemon.daemonUrl,
      })
      try {
        expect(client.connected).to.equal(true)
      } finally {
        await client.close()
      }
    })

    it('rejects with CONNECT_FAILED when handshake auth is wrong', async () => {
      let caught: unknown
      try {
        await ChannelClient.connect({
          authToken: 'wrong-token',
          connectAttemptDelayMs: 5,
          daemonUrl: daemon.daemonUrl,
          maxConnectAttempts: 2,
        })
      } catch (error) {
        caught = error
      }

      expect(caught).to.be.instanceOf(ChannelClientError)
      expect((caught as ChannelClientError).code).to.equal('BRV_CHANNEL_CONNECT_FAILED')
    })
  })

  describe('request', () => {
    it('resolves with `data` on {success: true} ack', async () => {
      daemon.handle('channel:list', (_data, ack) => {
        ack?.({data: {channels: [{channelId: 'pi-test'}]}, success: true})
      })
      const client = await ChannelClient.connect({dataDir: daemon.dataDir})
      try {
        const result = await client.request<unknown, {channels: Array<{channelId: string}>}>(
          'channel:list',
          {},
        )
        expect(result.channels).to.have.lengthOf(1)
        expect(result.channels[0]!.channelId).to.equal('pi-test')
      } finally {
        await client.close()
      }
    })

    it('rejects with ChannelClientError carrying code/message/details on {success: false}', async () => {
      daemon.handle('channel:get', (_data, ack) => {
        ack?.({
          code: 'CHANNEL_NOT_FOUND',
          details: {channelId: 'ghost'},
          error: 'Channel #ghost not found',
          success: false,
        })
      })
      const client = await ChannelClient.connect({dataDir: daemon.dataDir})
      try {
        let caught: unknown
        try {
          await client.request('channel:get', {channelId: 'ghost'})
        } catch (error) {
          caught = error
        }

        expect(caught).to.be.instanceOf(ChannelClientError)
        const err = caught as ChannelClientError
        expect(err.code).to.equal('CHANNEL_NOT_FOUND')
        expect(err.message).to.equal('Channel #ghost not found')
        expect(err.details).to.deep.equal({channelId: 'ghost'})
      } finally {
        await client.close()
      }
    })

    it('rejects with REQUEST_TIMEOUT when the daemon never acks', async () => {
      // Handler registered but never calls `ack`.
      daemon.handle('channel:stuck', () => {})
      const client = await ChannelClient.connect({
        dataDir: daemon.dataDir,
        requestTimeoutMs: 150,
      })
      try {
        let caught: unknown
        try {
          await client.request('channel:stuck', {})
        } catch (error) {
          caught = error
        }

        expect(caught).to.be.instanceOf(ChannelClientError)
        expect((caught as ChannelClientError).code).to.equal('CHANNEL_REQUEST_TIMEOUT')
      } finally {
        await client.close()
      }
    })

    it('honours per-call timeoutMs override on request() (Bug 1 follow-up)', async () => {
      // Constructor default is 100ms (would time out). Per-call override
      // is 5000ms — handler delays 400ms then acks. Should succeed.
      daemon.handle('channel:slow', (_data, ack) => {
        setTimeout(() => ack?.({data: {ok: true}, success: true}), 400)
      })
      const client = await ChannelClient.connect({
        dataDir: daemon.dataDir,
        requestTimeoutMs: 100,
      })
      try {
        const out = await client.request<unknown, {ok: boolean}>('channel:slow', {}, {timeoutMs: 5000})
        expect(out.ok).to.equal(true)
      } finally {
        await client.close()
      }
    })
  })

  describe('mention (sync mode timeout — Bug 1 follow-up)', () => {
    it('mode: sync bumps the transport request timeout to (timeout + grace) so the daemon has time to settle', async () => {
      // Default transport timeout is 100ms; without the fix, this would
      // reject with CHANNEL_REQUEST_TIMEOUT before the daemon's 400ms
      // delay finishes. With the fix, mention() passes timeoutMs ~=
      // 5000+grace to request() and the call succeeds.
      daemon.handle('channel:mention', (_data, ack) => {
        setTimeout(() => {
          ack?.({
            data: {
              channelId: 'c1',
              durationMs: 400,
              endedState: 'completed',
              finalAnswer: 'sync ok',
              toolCalls: [],
              turnId: 't1',
            },
            success: true,
          })
        }, 400)
      })
      const client = await ChannelClient.connect({
        dataDir: daemon.dataDir,
        requestTimeoutMs: 100,
      })
      try {
        const out = await client.mention({
          channelId: 'c1',
          mode: 'sync',
          prompt: '@x hi',
          timeout: 5000,
        })
        expect((out as {finalAnswer: string}).finalAnswer).to.equal('sync ok')
      } finally {
        await client.close()
      }
    })

    it('mode: stream leaves the transport request timeout at the constructor default', async () => {
      // Stream mode acks immediately; the daemon-side turn-timeout flag
      // is unrelated to the transport timeout. If a stream-mode ack is
      // late, we DO want the default transport timeout to fire — this
      // test pins that behaviour so we don't accidentally bump stream
      // mode along with sync.
      daemon.handle('channel:mention', (_data, ack) => {
        setTimeout(() => ack?.({data: {turn: {turnId: 't1'}}, success: true}), 400)
      })
      const client = await ChannelClient.connect({
        dataDir: daemon.dataDir,
        requestTimeoutMs: 100,
      })
      try {
        let caught: unknown
        try {
          await client.mention({
            channelId: 'c1',
            mode: 'stream',
            prompt: '@x hi',
            timeout: 5000,
          })
        } catch (error) {
          caught = error
        }

        expect(caught).to.be.instanceOf(ChannelClientError)
        expect((caught as ChannelClientError).code).to.equal('CHANNEL_REQUEST_TIMEOUT')
      } finally {
        await client.close()
      }
    })

    it('mode: sync without an explicit timeout uses the wire default (300s) + grace as the transport timeout', async () => {
      // Caller omits `timeout`. Daemon-side turn timeout falls back to
      // 300s; transport timeout must follow suit so we never time out
      // the transport before the daemon's own turn limit.
      let observedDataReceived = false
      daemon.handle('channel:mention', (_data, ack) => {
        observedDataReceived = true
        // Ack quickly — we're only testing that the call doesn't
        // pre-emptively time out at the 100ms transport default.
        setTimeout(() => {
          ack?.({
            data: {channelId: 'c1', durationMs: 50, endedState: 'completed', finalAnswer: 'ok', toolCalls: [], turnId: 't1'},
            success: true,
          })
        }, 250)
      })
      const client = await ChannelClient.connect({
        dataDir: daemon.dataDir,
        requestTimeoutMs: 100,
      })
      try {
        const out = await client.mention({channelId: 'c1', mode: 'sync', prompt: '@x hi'})
        expect(observedDataReceived).to.equal(true)
        expect((out as {finalAnswer: string}).finalAnswer).to.equal('ok')
      } finally {
        await client.close()
      }
    })
  })

  describe('subscribeTurn', () => {
    it('yields each channel:turn-event for the named turn, ends on terminal turn_state_change', async () => {
      const channelId = 'pi-test'
      const turnId = '01HX-test'

      const client = await ChannelClient.connect({dataDir: daemon.dataDir})
      try {
        // Start consuming, then drive the daemon to emit events.
        const collectPromise = (async () => {
          const out: TurnEvent[] = []
          for await (const event of client.subscribeTurn(channelId, turnId)) {
            out.push(event)
          }

          return out
        })()
        // Wait for subscribeTurn's `await subscribe()` round-trip + listener
        // registration to complete before emitting events.
        await new Promise((r) => {
          setTimeout(r, 100)
        })
        // Broadcast to ALL connected sockets — simpler than room membership
        // since the client is the only socket and `subscribeTurn` filters by
        // turnId regardless of room.
        daemon.emit('channel:turn-event', {
          channelId,
          event: {channelId, deliveryId: 'd1', emittedAt: '2026-05-13T00:00:00Z', kind: 'agent_message_chunk', memberHandle: '@echo', seq: 1, turnId, content: 'hi'},
        })
        daemon.emit('channel:turn-event', {
          channelId,
          event: {channelId, deliveryId: 'd1', emittedAt: '2026-05-13T00:00:01Z', from: 'streaming', kind: 'delivery_state_change', memberHandle: '@echo', seq: 2, to: 'completed', turnId},
        })
        daemon.emit('channel:turn-event', {
          channelId,
          event: {channelId, deliveryId: null, emittedAt: '2026-05-13T00:00:02Z', from: 'dispatched', kind: 'turn_state_change', memberHandle: null, seq: 3, to: 'completed', turnId},
        })

        const collected = await collectPromise
        expect(collected).to.have.lengthOf(3)
        expect(collected[0]!.kind).to.equal('agent_message_chunk')
        expect((collected[0] as TurnEvent & {content: string}).content).to.equal('hi')
        expect(collected[2]!.kind).to.equal('turn_state_change')
        expect((collected[2] as TurnEvent & {to: string}).to).to.equal('completed')
      } finally {
        await client.close()
      }
    })

    it('ends the iterator if the underlying socket disconnects mid-turn', async () => {
      const channelId = 'pi-test'
      const turnId = '01HX-disconnect'
      const client = await ChannelClient.connect({dataDir: daemon.dataDir})
      try {
        const collectPromise = (async () => {
          const out: TurnEvent[] = []
          for await (const event of client.subscribeTurn(channelId, turnId)) {
            out.push(event)
          }

          return out
        })()
        // Wait for the listener to register, then yank the socket.
        await new Promise((r) => {
          setTimeout(r, 100)
        })
        // Disconnect the only client socket from the daemon side, simulating
        // a daemon crash or network blip mid-turn. subscribeTurn must wake
        // and return; without the disconnect listener it would hang.
        daemon.latestSocket()?.disconnect(true)

        const collected = await Promise.race([
          collectPromise,
          new Promise<'timeout'>((resolve) => {
            setTimeout(() => resolve('timeout'), 2000)
          }),
        ])
        expect(collected).to.not.equal('timeout')
        expect(collected).to.have.lengthOf(0)
      } finally {
        await client.close()
      }
    })

    it('does NOT yield events for other turns on the same channel', async () => {
      const channelId = 'pi-test'
      const wantedTurnId = '01HX-wanted'
      const otherTurnId = '01HX-other'

      const client = await ChannelClient.connect({dataDir: daemon.dataDir})
      try {
        const collectPromise = (async () => {
          const out: TurnEvent[] = []
          for await (const event of client.subscribeTurn(channelId, wantedTurnId)) {
            out.push(event)
          }

          return out
        })()
        await new Promise((r) => {
          setTimeout(r, 100)
        })
        // Noise: a chunk on a different turnId — must NOT be yielded.
        daemon.emit('channel:turn-event', {
          channelId,
          event: {channelId, deliveryId: 'd', emittedAt: 't', kind: 'agent_message_chunk', memberHandle: '@x', seq: 1, turnId: otherTurnId, content: 'noise'},
        })
        // Terminal for the wanted turn — must be yielded, ends the loop.
        daemon.emit('channel:turn-event', {
          channelId,
          event: {channelId, deliveryId: null, emittedAt: 't', from: 'dispatched', kind: 'turn_state_change', memberHandle: null, seq: 2, to: 'completed', turnId: wantedTurnId},
        })

        const collected = await collectPromise
        expect(collected).to.have.lengthOf(1)
        expect(collected[0]!.turnId).to.equal(wantedTurnId)
      } finally {
        await client.close()
      }
    })
  })
})
