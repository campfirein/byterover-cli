import {expect} from 'chai'

import type {
  BridgeConnectDeps,
  BridgeConnectStepResult,
  ChannelCreateResult,
  ChannelInviteResult,
  PinResult,
  VerifyResult,
} from '../../../../src/oclif/lib/bridge-connect.js'

import {
  BridgeConnectInvalidMultiaddrError,
  runBridgeConnect,
} from '../../../../src/oclif/lib/bridge-connect.js'

// Phase 9.5.6 — `brv bridge connect` orchestration lib.
//
// The lib bundles pin + verify + channel-new + channel-invite into one
// idempotent operation. These tests exercise the orchestration logic
// without touching libp2p / the daemon, by injecting fakes for the four
// underlying primitives.

const ALICE_PEER = '12D3KooWKLAM7RBXrJKyiZi3P1sZF2NeFNUmxihYtWRHZkXt75t7'
const ALICE_MA = `/ip4/100.68.28.21/tcp/60001/p2p/${ALICE_PEER}`
const ALICE_MA_NEW_PORT = `/ip4/100.68.28.21/tcp/60002/p2p/${ALICE_PEER}`

interface FakeState {
  // Per-call tallies so tests can assert idempotency:
  calls: {channelCreate: number; channelInvite: number; pin: number; verify: number;}
  channels: Map<string, Set<string>>  // channelId → set of peerIds invited
  pinned: Map<string, {multiaddr: string; pinState: 'auto-tofu' | 'ca-bound' | 'user-confirmed'}>
}

function makeFakes(state?: Partial<FakeState>): {deps: BridgeConnectDeps; state: FakeState} {
  const s: FakeState = {
    calls: {channelCreate: 0, channelInvite: 0, pin: 0, verify: 0},
    channels: state?.channels ?? new Map(),
    pinned: state?.pinned ?? new Map(),
  }

  const deps: BridgeConnectDeps = {
    async channelCreate(channelId: string): Promise<ChannelCreateResult> {
      s.calls.channelCreate++
      if (s.channels.has(channelId)) return {status: 'already-exists'}
      s.channels.set(channelId, new Set())
      return {status: 'created'}
    },
    async channelExists(channelId: string): Promise<boolean> {
      return s.channels.has(channelId)
    },
    async channelHasMember(channelId: string, peerId: string): Promise<boolean> {
      return s.channels.get(channelId)?.has(peerId) ?? false
    },
    async channelInvite(args): Promise<ChannelInviteResult> {
      s.calls.channelInvite++
      const set = s.channels.get(args.channelId)
      if (!set) throw new Error(`channel ${args.channelId} does not exist`)
      if (set.has(args.peerId)) return {status: 'already-member'}
      set.add(args.peerId)
      return {status: 'added'}
    },
    async pin(multiaddr: string, peerId: string): Promise<PinResult> {
      s.calls.pin++
      const existing = s.pinned.get(peerId)
      if (existing) {
        // Re-dial silently picks up the new addr; record stays the same
        // by peer_id, so status is "already-pinned" regardless of addr change.
        s.pinned.set(peerId, {...existing, multiaddr})
        return {peerId, pinState: existing.pinState, resolvedMultiaddr: multiaddr, status: 'already-pinned'}
      }

      s.pinned.set(peerId, {multiaddr, pinState: 'auto-tofu'})
      return {peerId, pinState: 'auto-tofu', resolvedMultiaddr: multiaddr, status: 'added'}
    },
    async verify(peerId: string): Promise<VerifyResult> {
      s.calls.verify++
      const existing = s.pinned.get(peerId)
      if (!existing) throw new Error(`peer ${peerId} not pinned`)
      if (existing.pinState === 'user-confirmed') return {status: 'already-user-confirmed'}
      if (existing.pinState === 'ca-bound') return {status: 'ca-bound'}
      s.pinned.set(peerId, {...existing, pinState: 'user-confirmed'})
      return {status: 'user-confirmed'}
    },
  }

  return {deps, state: s}
}

function assertSuccess(r: BridgeConnectStepResult): asserts r is Extract<BridgeConnectStepResult, {success: true}> {
  expect(r.success, `expected success=true, got: ${JSON.stringify(r)}`).to.equal(true)
}

function assertFailure(r: BridgeConnectStepResult): asserts r is Extract<BridgeConnectStepResult, {success: false}> {
  expect(r.success, `expected success=false, got: ${JSON.stringify(r)}`).to.equal(false)
}

describe('runBridgeConnect (phase 9.5.6)', () => {
  describe('multiaddr validation', () => {
    it('throws BridgeConnectInvalidMultiaddrError when /p2p/<id> suffix is missing', async () => {
      const {deps} = makeFakes()
      let caught: unknown
      try {
        await runBridgeConnect({multiaddr: '/ip4/100.68.28.21/tcp/60001', verify: false}, deps)
      } catch (error) {
        caught = error
      }

      expect(caught).to.be.instanceOf(BridgeConnectInvalidMultiaddrError)
      expect((caught as BridgeConnectInvalidMultiaddrError).code).to.equal('BRIDGE_CONNECT_INVALID_MULTIADDR')
    })

    it('validates BEFORE calling any dep (no side effects on bad input)', async () => {
      const {deps, state} = makeFakes()
      try {
        await runBridgeConnect({channelId: 'cc-chat', multiaddr: 'bogus', verify: true}, deps)
      } catch { /* expected */ }

      expect(state.calls).to.deep.equal({channelCreate: 0, channelInvite: 0, pin: 0, verify: 0})
    })
  })

  describe('happy path', () => {
    it('pin + verify + channelCreate + channelInvite all succeed on first run', async () => {
      const {deps, state} = makeFakes()
      const result = await runBridgeConnect(
        {alias: '@gcp', channelId: 'cc-chat', multiaddr: ALICE_MA, verify: true},
        deps,
      )

      assertSuccess(result)
      expect(result.peerId).to.equal(ALICE_PEER)
      expect(result.alias).to.equal('@gcp')
      expect(result.channelId).to.equal('cc-chat')
      expect(result.steps).to.deep.equal({
        channelCreate: 'created',
        channelInvite: 'added',
        pin: 'added',
        verify: 'user-confirmed',
      })

      expect(state.calls).to.deep.equal({channelCreate: 1, channelInvite: 1, pin: 1, verify: 1})
      expect(state.pinned.get(ALICE_PEER)?.pinState).to.equal('user-confirmed')
      expect(state.channels.get('cc-chat')?.has(ALICE_PEER)).to.equal(true)
    })
  })

  describe('idempotent re-run', () => {
    it('re-running on a fully-connected peer returns "already X" for every step', async () => {
      const {deps, state} = makeFakes()
      // First run.
      await runBridgeConnect({alias: '@gcp', channelId: 'cc-chat', multiaddr: ALICE_MA, verify: true}, deps)
      const beforeRerun = {...state.calls}

      // Second run — should be a no-op success.
      const result = await runBridgeConnect(
        {alias: '@gcp', channelId: 'cc-chat', multiaddr: ALICE_MA, verify: true},
        deps,
      )

      assertSuccess(result)
      expect(result.steps).to.deep.equal({
        channelCreate: 'already-exists',
        channelInvite: 'already-member',
        pin: 'already-pinned',
        verify: 'already-user-confirmed',
      })

      // Each underlying op was called exactly once more (the lib doesn't skip the call,
      // it just trusts the dep to report the already-done status).
      expect(state.calls.pin).to.equal(beforeRerun.pin + 1)
      expect(state.calls.verify).to.equal(beforeRerun.verify + 1)
      expect(state.calls.channelCreate).to.equal(beforeRerun.channelCreate + 1)
      expect(state.calls.channelInvite).to.equal(beforeRerun.channelInvite + 1)
    })
  })

  describe('partial failure + retry hint', () => {
    it('failure at channelCreate stops the flow, lists completed steps, retry hint omits already-done flags', async () => {
      const {deps} = makeFakes()
      // Replace channelCreate with one that throws.
      const channelCreateError = new Error('CHANNEL_REQUEST_FAILED: storage unavailable')
      const failingDeps: BridgeConnectDeps = {
        ...deps,
        async channelCreate() {
          throw channelCreateError
        },
      }

      const result = await runBridgeConnect(
        {alias: '@gcp', channelId: 'cc-chat', multiaddr: ALICE_MA, verify: true},
        failingDeps,
      )

      assertFailure(result)
      expect(result.peerId).to.equal(ALICE_PEER)
      expect(result.completed).to.deep.equal(['pin', 'verify'])
      expect(result.failedAt).to.equal('channelCreate')
      expect(result.error.message).to.include('storage unavailable')

      // retryHint omits --verify (peer already user-confirmed) but keeps --channel + --alias.
      expect(result.retryHint).to.include('brv bridge connect')
      expect(result.retryHint).to.include(ALICE_MA)
      expect(result.retryHint).to.include('--channel cc-chat')
      expect(result.retryHint).to.include('--alias @gcp')
      expect(result.retryHint).to.not.include('--verify')
    })

    it('failure at pin produces a retryHint that still includes --verify', async () => {
      const {deps} = makeFakes()
      const failingDeps: BridgeConnectDeps = {
        ...deps,
        async pin() {
          throw new Error('BRIDGE_PIN_FAILED: connection refused')
        },
      }

      const result = await runBridgeConnect(
        {alias: '@gcp', channelId: 'cc-chat', multiaddr: ALICE_MA, verify: true},
        failingDeps,
      )

      assertFailure(result)
      expect(result.completed).to.deep.equal([])
      expect(result.failedAt).to.equal('pin')
      expect(result.retryHint).to.include('--verify')
    })
  })

  describe('optional flags', () => {
    it('--verify=false: pin completes but verify step is null', async () => {
      const {deps, state} = makeFakes()
      const result = await runBridgeConnect(
        {alias: '@gcp', channelId: 'cc-chat', multiaddr: ALICE_MA, verify: false},
        deps,
      )

      assertSuccess(result)
      expect(result.steps.pin).to.equal('added')
      expect(result.steps.verify).to.equal(null)
      expect(result.steps.channelCreate).to.equal('created')
      expect(state.calls.verify).to.equal(0)
      expect(state.pinned.get(ALICE_PEER)?.pinState).to.equal('auto-tofu')
    })

    it('--channel omitted: channelCreate + channelInvite steps are both null', async () => {
      const {deps, state} = makeFakes()
      const result = await runBridgeConnect({multiaddr: ALICE_MA, verify: true}, deps)

      assertSuccess(result)
      expect(result.steps.channelCreate).to.equal(null)
      expect(result.steps.channelInvite).to.equal(null)
      expect(state.calls.channelCreate).to.equal(0)
      expect(state.calls.channelInvite).to.equal(0)
    })
  })

  describe('multiaddr change (same peer, new port)', () => {
    it('pre-pinned peer at addr A, connect with addr B → steps.pin = "already-pinned" (TofuStore tracks by peerId, not multiaddr)', async () => {
      // The underlying TofuStore identifies peers by peer_id alone — the
      // multiaddr is just a dial target. When the peer rebinds on a new
      // port, the next bridge connect re-dials the new addr and re-
      // upserts the same cert; the pin record fingerprint is unchanged,
      // so we report "already-pinned". The dial succeeds either way.
      const pinned = new Map([
        [ALICE_PEER, {multiaddr: ALICE_MA, pinState: 'user-confirmed' as const}],
      ])
      const {deps} = makeFakes({pinned})

      const result = await runBridgeConnect(
        {multiaddr: ALICE_MA_NEW_PORT, verify: false},
        deps,
      )

      assertSuccess(result)
      expect(result.steps.pin).to.equal('already-pinned')
    })
  })
})
