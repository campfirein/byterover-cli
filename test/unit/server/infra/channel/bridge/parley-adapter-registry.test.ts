/* eslint-disable camelcase */
// Wire-shape field names mirror parley-types.ts on-wire JSON and are
// intentionally snake_case in the stub envelope below.

import {expect} from 'chai'
import {stub} from 'sinon'

import {AcpAdapter, type AcpAdapterArgs} from '../../../../../../src/server/infra/channel/bridge/adapters/acp-adapter.js'
import {MockEchoAdapter} from '../../../../../../src/server/infra/channel/bridge/adapters/mock-echo-adapter.js'
import {
  BUILTIN_PARLEY_PROFILE_NAMES,
  createDefaultRegistry,
  InMemoryParleyAdapterRegistry,
  ParleyAdapterNotFoundError,
} from '../../../../../../src/server/infra/channel/bridge/parley-adapter-registry.js'
import {type ParleyAdapter, type ParleyAdapterContext} from '../../../../../../src/server/infra/channel/bridge/parley-adapter.js'
import {
  type ParleyResponseDataChunk,
  ParleyResponseError,
} from '../../../../../../src/server/infra/channel/bridge/parley-response-generator.js'

// Phase 9.5.2 — unit tests for ParleyAdapterRegistry + built-in adapters.

// Minimal stub for ParleyAdapterContext — only the fields actually used
// by MockEchoAdapter (envelope.prompt) need real values; the rest are
// stubs so we don't have to construct a full ParleyQueryEnvelope.
function makeContext(promptText: string): ParleyAdapterContext {
  return {
    abortSignal: new AbortController().signal,
    channelId: 'ch-1',
    envelope: {
      channel_id: 'ch-1',
      delivery_id: 'del-1',
      handshake: {
        install_cert: {
          cert_kind: 'install',
          display_handle: '@laptop',
          expires_at: new Date(Date.now() + 3_600_000).toISOString(),
          issued_at: new Date().toISOString(),
          public_key: {alg: 'ed25519', pub: 'AAAA'},
          signature: 'sig',
        },
        nonce: 'nonce-1',
        sender_peer_id: 'peer-1',
        timestamp: new Date().toISOString(),
        tree_cert: undefined,
      },
      prompt: [{text: promptText, type: 'text'}],
      protocol: 'query',
      turn_id: 'turn-1',
    } as unknown as ParleyAdapterContext['envelope'],
    logger() {},
    memberHandle: '@laptop',
    projectRoot: '/proj/test',
    senderPeerId: 'peer-1',
    turnId: 'turn-1',
  }
}

async function collectChunks(
  gen: AsyncIterable<ParleyResponseDataChunk>,
): Promise<ParleyResponseDataChunk[]> {
  const chunks: ParleyResponseDataChunk[] = []
  for await (const chunk of gen) chunks.push(chunk)
  return chunks
}

// ────────────────────────────────────────────────────────────────────────────
// All suites nested under a single top-level describe per mocha rules.
// ────────────────────────────────────────────────────────────────────────────

describe('Parley adapter registry (phase 9.5.2)', () => {
  // ── InMemoryParleyAdapterRegistry ───────────────────────────────────────

  describe('InMemoryParleyAdapterRegistry', () => {
    it('resolve() returns undefined for an unknown profile', () => {
      const registry = new InMemoryParleyAdapterRegistry()
      expect(registry.resolve('unknown')).to.equal(undefined)
    })

    it('register() + resolve() round-trips a registered adapter', () => {
      const registry = new InMemoryParleyAdapterRegistry()
      const adapter = new MockEchoAdapter()
      registry.register(adapter)
      expect(registry.resolve('mock-echo')).to.equal(adapter)
    })

    it('list() returns kind + profile for every registered adapter', () => {
      const registry = new InMemoryParleyAdapterRegistry()
      registry.register(new MockEchoAdapter())
      const list = registry.list()
      expect(list).to.have.lengthOf(1)
      expect(list[0]).to.deep.equal({kind: 'mock', profile: 'mock-echo'})
    })

    it('list() returns an empty array when no adapters are registered', () => {
      const registry = new InMemoryParleyAdapterRegistry()
      expect(registry.list()).to.deep.equal([])
    })

    it('registering a second adapter with the same profile overwrites the first', () => {
      const registry = new InMemoryParleyAdapterRegistry()

      class AltMockAdapter implements ParleyAdapter {
        public readonly kind = 'mock' as const
        public readonly profile = 'mock-echo'

        public async *generate(): AsyncIterable<ParleyResponseDataChunk> {}
      }

      registry.register(new MockEchoAdapter())
      const alt = new AltMockAdapter()
      registry.register(alt)
      expect(registry.resolve('mock-echo')).to.equal(alt)
      expect(registry.list()).to.have.lengthOf(1)
    })
  })

  // ── MockEchoAdapter ──────────────────────────────────────────────────────

  describe('MockEchoAdapter', () => {
    it('has profile="mock-echo" and kind="mock"', () => {
      const adapter = new MockEchoAdapter()
      expect(adapter.profile).to.equal('mock-echo')
      expect(adapter.kind).to.equal('mock')
    })

    it('generate() yields one agent_message_chunk echoing the prompt text', async () => {
      const adapter = new MockEchoAdapter()
      const chunks = await collectChunks(adapter.generate(makeContext('hello bridge')))
      expect(chunks).to.have.lengthOf(1)
      expect(chunks[0]).to.deep.equal({content: 'hello bridge', kind: 'agent_message_chunk'})
    })

    it('generate() joins multi-block prompts with newlines', async () => {
      const adapter = new MockEchoAdapter()
      const ctx = makeContext('line one')
      ;(ctx.envelope as unknown as {prompt: {text: string; type: string}[]}).prompt = [
        {text: 'line one', type: 'text'},
        {text: 'line two', type: 'text'},
      ]
      const chunks = await collectChunks(adapter.generate(ctx))
      expect(chunks[0].content).to.equal('line one\nline two')
    })
  })

  // ── createDefaultRegistry ────────────────────────────────────────────────

  describe('createDefaultRegistry', () => {
    const logs: string[] = []
    const log = (msg: string): number => logs.push(msg)

    beforeEach(() => {
      logs.length = 0
    })

    it('always registers MockEchoAdapter under profile "mock-echo"', () => {
      const registry = createDefaultRegistry({log})
      const adapter = registry.resolve('mock-echo')
      expect(adapter).to.be.instanceOf(MockEchoAdapter)
    })

    it('does not register AcpAdapter when bridgeDriverPool is absent', () => {
      const registry = createDefaultRegistry({log, profileName: 'codex'})
      const list = registry.list()
      expect(list.map((a) => a.kind)).to.not.include('acp')
    })

    it('does not register AcpAdapter when profileName is absent', () => {
      const registry = createDefaultRegistry({log})
      const list = registry.list()
      expect(list.map((a) => a.kind)).to.not.include('acp')
    })

    // Fix 2a — warm() should be callable on the resolved adapter to allow
    // daemon startup to call it for pre-flight checks (codex K79P0sTCkPTOaaZefPoh1).
    it('resolved claude-code adapter exposes a warm() method when BRV_BRIDGE_CLAUDE_UNSAFE=1', async () => {
      // We need a concurrencyGate + sessionStore — use a minimal stub.
      const {createProfileConcurrencyGate} = await import('../../../../../../src/server/infra/channel/bridge/profile-concurrency-gate.js')
      const {createFileBackedSessionStore} = await import('../../../../../../src/server/infra/channel/bridge/parley-adapter-session-store.js')
      const {mkdtemp: mkTemp, rm: rmDir} = await import('node:fs/promises')
      const {tmpdir} = await import('node:os')
      const {join} = await import('node:path')

      const dir = await mkTemp(join(tmpdir(), 'brv-registry-warm-'))
      try {
        const gate = createProfileConcurrencyGate({maxConcurrent: 1})
        const store = createFileBackedSessionStore({filePath: join(dir, 'sessions.json'), log() {}})

        const registry = createDefaultRegistry({
          concurrencyGate: gate,
          env: {BRV_BRIDGE_CLAUDE_UNSAFE: '1'},
          log,
          sessionStore: store,
        })

        const adapter = registry.resolve('claude-code')
        expect(adapter, 'claude-code adapter must be registered').to.not.equal(undefined)
        expect(adapter!.warm, 'adapter must expose warm()').to.be.a('function')

        // warm() with a fake pathProbe — we can't control the probe here
        // but we verify the method exists and is callable.
        const result = await adapter!.warm!({log() {}})
        // warm() will return available:true or available:false depending
        // on whether 'claude' is on PATH in CI — either is acceptable.
        expect(result).to.have.property('available')
      } finally {
        await rmDir(dir, {force: true, recursive: true})
      }
    })
  })

  // ── BUILTIN_PARLEY_PROFILE_NAMES + §3.1 reserved-name guard ─────────────

  describe('BUILTIN_PARLEY_PROFILE_NAMES (phase 9.5.7 §3.1)', () => {
    it('is a ReadonlySet<string>', () => {
      expect(BUILTIN_PARLEY_PROFILE_NAMES).to.be.instanceOf(Set)
    })

    it('contains "mock-echo"', () => {
      expect(BUILTIN_PARLEY_PROFILE_NAMES.has('mock-echo')).to.be.true
    })

    it('contains "claude-code"', () => {
      expect(BUILTIN_PARLEY_PROFILE_NAMES.has('claude-code')).to.be.true
    })

    it('does NOT contain arbitrary names', () => {
      expect(BUILTIN_PARLEY_PROFILE_NAMES.has('my-custom-agent')).to.be.false
      expect(BUILTIN_PARLEY_PROFILE_NAMES.has('codex')).to.be.false
    })
  })

  describe('createDefaultRegistry — reserved-name ACP guard (phase 9.5.7 §3.1)', () => {
    const logs: string[] = []
    const log = (msg: string): number => logs.push(msg)

    beforeEach(() => {
      logs.length = 0
    })

    it('does NOT register AcpAdapter under "claude-code" even when all ACP args are supplied', () => {
      // This is the failure-#1 bug: previously AcpAdapter registered under
      // 'claude-code', shadowing the built-in. Now it must be skipped.
      const fakePool = {} as unknown as Parameters<typeof createDefaultRegistry>[0]['bridgeDriverPool']
      const fakeStore = {
        get: stub().resolves(),
        list: stub().resolves([]),
        remove: stub().resolves(false),
        upsert: stub().resolves(),
      }
      const registry = createDefaultRegistry({
        bridgeDriverPool: fakePool,
        driverFactory: stub() as unknown as Parameters<typeof createDefaultRegistry>[0]['driverFactory'],
        log,
        profileName: 'claude-code',
        profileStore: fakeStore,
      })
      // Must not register an ACP adapter under 'claude-code'
      expect(registry.resolve('claude-code')).to.equal(undefined)
      // A warning log must be emitted
      expect(logs.some((l) => l.includes('claude-code'))).to.be.true
    })

    it('resolve("claude-code") returns undefined when only ACP args are supplied (no CLAUDE_UNSAFE)', () => {
      const registry = createDefaultRegistry({
        log,
        profileName: 'claude-code',
      })
      expect(registry.resolve('claude-code')).to.equal(undefined)
    })

    it('ClaudeCodeHeadlessAdapter IS still registered when BRV_BRIDGE_CLAUDE_UNSAFE=1 and ACP name collides', async () => {
      // This validates the non-return semantics: the ACP skip-block must NOT
      // `return` — downstream ClaudeCodeHeadlessAdapter registration continues.
      const {createProfileConcurrencyGate} = await import('../../../../../../src/server/infra/channel/bridge/profile-concurrency-gate.js')
      const {createFileBackedSessionStore} = await import('../../../../../../src/server/infra/channel/bridge/parley-adapter-session-store.js')
      const {mkdtemp: mkTemp, rm: rmDir} = await import('node:fs/promises')
      const {tmpdir} = await import('node:os')
      const {join} = await import('node:path')

      const dir = await mkTemp(join(tmpdir(), 'brv-registry-931-'))
      try {
        const gate = createProfileConcurrencyGate({maxConcurrent: 1})
        const store = createFileBackedSessionStore({filePath: join(dir, 'sessions.json'), log() {}})
        const fakeAcpStore = {
          get: stub().resolves(),
          list: stub().resolves([]),
          remove: stub().resolves(false),
          upsert: stub().resolves(),
        }
        const fakePool = {} as unknown as Parameters<typeof createDefaultRegistry>[0]['bridgeDriverPool']
        const registry = createDefaultRegistry({
          bridgeDriverPool: fakePool,
          concurrencyGate: gate,
          driverFactory: stub() as unknown as Parameters<typeof createDefaultRegistry>[0]['driverFactory'],
          env: {BRV_BRIDGE_CLAUDE_UNSAFE: '1'},
          log,
          profileName: 'claude-code',  // collision with built-in
          profileStore: fakeAcpStore,
          sessionStore: store,
        })
        // The ClaudeCodeHeadlessAdapter (kind=sdk-headless) must still register
        const adapter = registry.resolve('claude-code')
        expect(adapter, 'claude-code built-in must register despite ACP name collision').to.not.equal(undefined)
        expect(adapter!.kind).to.equal('sdk-headless')
      } finally {
        await rmDir(dir, {force: true, recursive: true})
      }
    })
  })

  // ── ParleyAdapterNotFoundError ───────────────────────────────────────────

  describe('ParleyAdapterNotFoundError (strict registry resolution)', () => {
    it('has code = "PARLEY_ADAPTER_NOT_FOUND"', () => {
      const err = new ParleyAdapterNotFoundError('unknown-profile', [])
      expect(err.code).to.equal('PARLEY_ADAPTER_NOT_FOUND')
    })

    it('has name = "ParleyAdapterNotFoundError"', () => {
      const err = new ParleyAdapterNotFoundError('unknown-profile', [])
      expect(err.name).to.equal('ParleyAdapterNotFoundError')
    })

    it('message includes the requested profile name', () => {
      const err = new ParleyAdapterNotFoundError('my-custom-profile', [])
      expect(err.message).to.include('my-custom-profile')
    })

    it('message lists available profile names', () => {
      const available = [
        {kind: 'mock' as const, profile: 'mock-echo'},
        {kind: 'acp' as const, profile: 'codex'},
      ]
      const err = new ParleyAdapterNotFoundError('unknown', available)
      expect(err.message).to.include('"mock-echo"')
      expect(err.message).to.include('"codex"')
    })

    it('message says "none" when no adapters are registered', () => {
      const err = new ParleyAdapterNotFoundError('ghost', [])
      expect(err.message).to.include('none')
    })

    it('exposes the profile name on the error instance', () => {
      const err = new ParleyAdapterNotFoundError('target-profile', [])
      expect(err.profile).to.equal('target-profile')
    })

    it('is an instance of Error', () => {
      const err = new ParleyAdapterNotFoundError('x', [])
      expect(err).to.be.instanceOf(Error)
    })

    // Strict resolution: registry itself returns undefined for unknown
    // profiles; the DAEMON is responsible for throwing
    // ParleyAdapterNotFoundError (plan §2.3).
    it('InMemoryParleyAdapterRegistry.resolve() returns undefined for an unregistered profile', () => {
      const registry = new InMemoryParleyAdapterRegistry()
      registry.register(new MockEchoAdapter())
      expect(registry.resolve('not-real')).to.equal(undefined)
    })

    // Fix 3 — BRV_BRIDGE_CLAUDE_UNSAFE hint (codex K79P0sTCkPTOaaZefPoh1)
    it('message includes BRV_BRIDGE_CLAUDE_UNSAFE hint for the "claude-code" profile', () => {
      const err = new ParleyAdapterNotFoundError('claude-code', [{kind: 'mock' as const, profile: 'mock-echo'}])
      expect(err.message).to.include('BRV_BRIDGE_CLAUDE_UNSAFE')
    })

    it('message does NOT include the unsafe-env hint for other profiles (no false positives)', () => {
      const err = new ParleyAdapterNotFoundError('mock-echo', [])
      expect(err.message).to.not.include('BRV_BRIDGE_CLAUDE_UNSAFE')
    })

    it('BRV_BRIDGE_CLAUDE_UNSAFE hint includes §2.5 plan reference', () => {
      const err = new ParleyAdapterNotFoundError('claude-code', [])
      expect(err.message).to.include('§2.5')
    })
  })

  // ── AcpAdapter ───────────────────────────────────────────────────────────

  describe('AcpAdapter', () => {
    it('has kind = "acp"', () => {
      const adapter = new AcpAdapter({
        driverFactory: stub() as unknown as AcpAdapterArgs['driverFactory'],
        profileName: 'codex',
        profileStore: {
          get: stub().resolves(),
          list: stub().resolves([]),
          remove: stub().resolves(false),
          upsert: stub().resolves(),
        },
      })
      expect(adapter.kind).to.equal('acp')
    })

    it('profile matches the profileName constructor arg', () => {
      const adapter = new AcpAdapter({
        driverFactory: stub() as unknown as AcpAdapterArgs['driverFactory'],
        profileName: 'my-agent',
        profileStore: {
          get: stub().resolves(),
          list: stub().resolves([]),
          remove: stub().resolves(false),
          upsert: stub().resolves(),
        },
      })
      expect(adapter.profile).to.equal('my-agent')
    })

    it('generate() throws PARLEY_LOCAL_AGENT_PROFILE_MISSING when the profile is not in the store', async () => {
      const adapter = new AcpAdapter({
        driverFactory: stub() as unknown as AcpAdapterArgs['driverFactory'],
        profileName: 'absent-profile',
        profileStore: {
          get: stub().resolves(),
          list: stub().resolves([]),
          remove: stub().resolves(false),
          upsert: stub().resolves(),
        },
      })

      let caught: unknown
      try {
        // Drain the generator; the adapter throws before yielding any chunk
        // when profile is missing.
        await collectChunks(adapter.generate(makeContext('hello')))
      } catch (error) {
        caught = error
      }

      expect(caught).to.be.instanceOf(ParleyResponseError)
      expect((caught as ParleyResponseError).code).to.equal('PARLEY_LOCAL_AGENT_PROFILE_MISSING')
    })

    it('generate() yields chunks from a pool-less driver when pool is absent', async () => {
      const stubChunks = [
        {content: 'chunk one', kind: 'agent_message_chunk' as const},
        {content: 'chunk two', kind: 'agent_thought_chunk' as const},
      ]
      const fakeDriver = {
        prompt: stub().returns(
          (function* () {
            for (const c of stubChunks) yield c
          })(),
        ),
        start: stub().resolves(),
        stop: stub().resolves(),
      }
      const fakeInvocation = {args: [], command: 'fake', cwd: '/tmp'}
      const fakeProfile = {
        displayName: 'Test Agent',
        driverClass: 'A' as const,
        invocation: fakeInvocation,
        name: 'test-agent',
      }

      const adapter = new AcpAdapter({
        driverFactory: stub().returns(fakeDriver) as unknown as AcpAdapterArgs['driverFactory'],
        profileName: 'test-agent',
        profileStore: {
          get: stub().resolves(fakeProfile),
          list: stub().resolves([fakeProfile]),
          remove: stub().resolves(false),
          upsert: stub().resolves(),
        },
      })

      const chunks = await collectChunks(adapter.generate(makeContext('test prompt')))
      expect(chunks).to.have.lengthOf(2)
      expect(chunks[0]).to.deep.equal(stubChunks[0])
      expect(chunks[1]).to.deep.equal(stubChunks[1])
      expect(fakeDriver.start.calledOnce).to.be.true
      expect(fakeDriver.stop.calledOnce).to.be.true
    })
  })
})
