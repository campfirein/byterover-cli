/* eslint-disable camelcase */
/* eslint-disable unicorn/prefer-event-target */
// Wire-shape field names mirror the claude stream-json format and are
// intentionally snake_case in the test fixtures below.
// EventEmitter is used here as a fake ChildProcess; EventTarget cannot
// emit named events like 'data'/'close' that the ChildProcess interface uses.

import {expect} from 'chai'
import {type ChildProcess} from 'node:child_process'
import {EventEmitter} from 'node:events'
import {mkdtemp, rm} from 'node:fs/promises'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import {Writable} from 'node:stream'

import {ClaudeCodeHeadlessAdapter} from '../../../../../../../src/server/infra/channel/bridge/adapters/claude-code-headless-adapter.js'
import {
  createFileBackedSessionStore,
  type ParleyAdapterSessionKey,
  type ParleyAdapterSessionStore,
} from '../../../../../../../src/server/infra/channel/bridge/parley-adapter-session-store.js'
import {type ParleyAdapterContext} from '../../../../../../../src/server/infra/channel/bridge/parley-adapter.js'
import {ParleyResponseError} from '../../../../../../../src/server/infra/channel/bridge/parley-response-generator.js'
import {createProfileConcurrencyGate} from '../../../../../../../src/server/infra/channel/bridge/profile-concurrency-gate.js'

// ─── Fake subprocess helpers ─────────────────────────────────────────────────

/** Minimal fake `ChildProcess` that lets us emit stdout/stderr/close events. */
class FakeChild extends EventEmitter {
  public readonly stderr: EventEmitter & {on: (event: string, listener: (chunk: Buffer) => void) => void}
  public readonly stdin: Writable
  public readonly stdout: EventEmitter & {on: (event: string, listener: (chunk: Buffer) => void) => void}
private readonly _stderr = new EventEmitter()
  private readonly _stdin: Writable
  private readonly _stdout = new EventEmitter()

  public constructor() {
    super()
    this._stdin = new Writable({write(_, __, cb) { cb() }})
    this.stdin = this._stdin
    this.stdout = this._stdout as unknown as FakeChild['stdout']
    this.stderr = this._stderr as unknown as FakeChild['stderr']
  }

  public emitClose(code: null | number = 0): void {
    this.emit('close', code)
  }

  public emitStderr(data: string): void {
    this._stderr.emit('data', Buffer.from(data))
  }

  public emitStdout(data: string): void {
    this._stdout.emit('data', Buffer.from(data))
  }

  public kill(_signal?: string): boolean {
    this.emitClose(null)
    return true
  }
}

/** Build canned stream-json lines for a happy-path turn. */
function happyPathLines(sessionId = 'new-sess-1'): string[] {
  return [
    JSON.stringify({session_id: 'new-sess-1', subtype: 'init', type: 'system'}),
    JSON.stringify({message: {content: [{text: 'Hello', type: 'text'}]}, type: 'assistant'}),
    JSON.stringify({is_error: false, session_id: sessionId, type: 'result'}),
  ]
}

// ─── Context factory ─────────────────────────────────────────────────────────

/* eslint-disable camelcase */
function makeContext(override?: Partial<ParleyAdapterContext>): ParleyAdapterContext {
  const base = {
    abortSignal: override?.abortSignal ?? new AbortController().signal,
    channelId: override?.channelId ?? 'ch-test',
    envelope: override?.envelope ?? ({
      channel_id: 'ch-test',
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
        sender_peer_id: 'peer-abc',
        timestamp: new Date().toISOString(),
        tree_cert: undefined,
      },
      prompt: [{text: 'what is 2+2?', type: 'text'}],
      protocol: 'query',
      turn_id: 'turn-1',
    } as unknown as ParleyAdapterContext['envelope']),
    logger: override?.logger ?? (() => {}),
    memberHandle: override?.memberHandle ?? '@laptop',
    projectRoot: override?.projectRoot ?? '/proj/test',
    senderPeerId: override?.senderPeerId ?? 'peer-abc',
    turnId: override?.turnId ?? 'turn-1',
  }
  return base
}

// ─── Store factory ────────────────────────────────────────────────────────────

async function makeSessionStore(
  dir: string,
): Promise<{dir: string; store: ParleyAdapterSessionStore;}> {
  const store = createFileBackedSessionStore({
    filePath: join(dir, 'sessions.json'),
    log() {},
  })
  return {dir, store}
}

// ─── Adapter factory ──────────────────────────────────────────────────────────

function makeAdapter(args: {
  pathProbe?: (b: string) => Promise<boolean>
  sessionStore: ParleyAdapterSessionStore
  spawnChild?: FakeChild
}): ClaudeCodeHeadlessAdapter {
  const gate = createProfileConcurrencyGate({maxConcurrent: 1})
  const spawnFn = args.spawnChild
    ? () => args.spawnChild as unknown as ChildProcess
    : undefined

  return new ClaudeCodeHeadlessAdapter({
    claudeBinary: 'claude',
    concurrencyGate: gate,
    log() {},
    pathProbe: args.pathProbe,
    sessionStore: args.sessionStore,
    spawn: spawnFn,
  })
}

async function collectChunks(
  gen: AsyncIterable<{content: string; kind: string;}>,
): Promise<Array<{content: string; kind: string;}>> {
  const chunks: Array<{content: string; kind: string;}> = []
  for await (const c of gen) chunks.push(c)
  return chunks
}

// ─── Tests ────────────────────────────────────────────────────────────────────

describe('ClaudeCodeHeadlessAdapter (phase 9.5.3)', () => {
  let tmpDir: string

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), 'brv-cc-adapter-'))
  })

  afterEach(async () => {
    await rm(tmpDir, {force: true, recursive: true})
  })

  // ── warm() ──────────────────────────────────────────────────────────────────

  describe('warm()', () => {
    it('returns {available: false} when binary is missing', async () => {
      const {store} = await makeSessionStore(tmpDir)
      const adapter = makeAdapter({
        pathProbe: () => Promise.resolve(false),
        sessionStore: store,
      })
      const result = await adapter.warm()
      expect(result.available).to.equal(false)
      expect((result as {available: false; reason: string}).reason).to.include('claude binary not on PATH')
    })

    it('returns {available: true} when binary is present', async () => {
      const {store} = await makeSessionStore(tmpDir)
      const adapter = makeAdapter({
        pathProbe: () => Promise.resolve(true),
        sessionStore: store,
      })
      const result = await adapter.warm()
      expect(result.available).to.equal(true)
    })
  })

  // ── profile / kind ────────────────────────────────────────────────────────

  it('has profile="claude-code" and kind="sdk-headless"', async () => {
    const {store} = await makeSessionStore(tmpDir)
    const adapter = makeAdapter({sessionStore: store})
    expect(adapter.profile).to.equal('claude-code')
    expect(adapter.kind).to.equal('sdk-headless')
  })

  // ── generate() happy path ─────────────────────────────────────────────────

  describe('generate() happy path', () => {
    it('yields agent_message_chunk from assistant text delta', async () => {
      const child = new FakeChild()
      const {store} = await makeSessionStore(tmpDir)
      const adapter = makeAdapter({sessionStore: store, spawnChild: child})

      const ctx = makeContext()
      const genPromise = collectChunks(adapter.generate(ctx))

      // Emit the canned lines.
      setImmediate(() => {
        for (const line of happyPathLines()) child.emitStdout(line + '\n')
        child.emitClose(0)
      })

      const chunks = await genPromise
      expect(chunks).to.have.lengthOf(1)
      expect(chunks[0]).to.deep.equal({content: 'Hello', kind: 'agent_message_chunk'})
    })

    it('yields agent_thought_chunk for tool_use blocks', async () => {
      const child = new FakeChild()
      const {store} = await makeSessionStore(tmpDir)
      const adapter = makeAdapter({sessionStore: store, spawnChild: child})

      const ctx = makeContext()
      const genPromise = collectChunks(adapter.generate(ctx))

      setImmediate(() => {
        child.emitStdout(
          JSON.stringify({session_id: 's1', subtype: 'init', type: 'system'}) + '\n' +
          JSON.stringify({message: {content: [{input: {}, name: 'bash', type: 'tool_use'}]}, type: 'assistant'}) + '\n' +
          JSON.stringify({is_error: false, session_id: 's1', type: 'result'}) + '\n',
        )
        child.emitClose(0)
      })

      const chunks = await genPromise
      expect(chunks).to.have.lengthOf(1)
      expect(chunks[0].kind).to.equal('agent_thought_chunk')
      expect(chunks[0].content).to.include('[tool_use: bash]')
    })

    it('persists the new sessionId after a successful turn', async () => {
      const child = new FakeChild()
      const {store} = await makeSessionStore(tmpDir)
      const adapter = makeAdapter({sessionStore: store, spawnChild: child})

      const ctx = makeContext()
      const genPromise = collectChunks(adapter.generate(ctx))

      setImmediate(() => {
        for (const line of happyPathLines('sess-persisted')) child.emitStdout(line + '\n')
        child.emitClose(0)
      })

      await genPromise

      const key: ParleyAdapterSessionKey = {
        adapterProfile: 'claude-code',
        channelId: ctx.channelId,
        projectRoot: ctx.projectRoot,
        senderPeerId: ctx.senderPeerId,
      }
      expect(store.get(key)).to.equal('sess-persisted')
    })

    it('passes multiple prompt blocks joined by newline', async () => {
      const child = new FakeChild()
      let stdinData = ''
      // Intercept end() to capture the prompt sent to stdin.
      ;(child.stdin as unknown as {end: (chunk: string, encoding: string) => void}).end = (
        chunk: string,
        _encoding: string,
      ) => {
        stdinData += String(chunk)
      }

      const {store} = await makeSessionStore(tmpDir)
      const adapter = makeAdapter({sessionStore: store, spawnChild: child})

      const ctx = makeContext()
      ;(ctx.envelope as unknown as {prompt: {text: string; type: string}[]}).prompt = [
        {text: 'line one', type: 'text'},
        {text: 'line two', type: 'text'},
      ]

      const genPromise = collectChunks(adapter.generate(ctx))

      setImmediate(() => {
        for (const line of happyPathLines()) child.emitStdout(line + '\n')
        child.emitClose(0)
      })

      await genPromise
      expect(stdinData).to.include('line one\nline two')
    })
  })

  // ── generate() error paths ────────────────────────────────────────────────

  describe('generate() error paths', () => {
    // Fix 2b — spawn 'error' event (ENOENT/EACCES) must be caught and
    // translated to ADAPTER_SUBPROCESS_FAILED (codex K79P0sTCkPTOaaZefPoh1).
    it('rejects with ADAPTER_SUBPROCESS_FAILED when spawn emits an error event (ENOENT)', async () => {
      const {store} = await makeSessionStore(tmpDir)
      const gate = createProfileConcurrencyGate({maxConcurrent: 1})

      const adapter = new ClaudeCodeHeadlessAdapter({
        claudeBinary: 'claude',
        concurrencyGate: gate,
        log() {},
        sessionStore: store,
        spawn() {
          const child = new FakeChild()
          // Simulate ENOENT — error fires asynchronously (one tick later,
          // before any stdout/close events).
          setImmediate(() => {
            const err = Object.assign(new Error('spawn ENOENT'), {code: 'ENOENT'})
            child.emit('error', err)
          })
          return child as unknown as ChildProcess
        },
      })

      let caught: unknown
      try {
        await collectChunks(adapter.generate(makeContext()))
      } catch (error) {
        caught = error
      }

      expect(caught).to.be.instanceOf(ParleyResponseError)
      expect((caught as ParleyResponseError).code).to.equal('ADAPTER_SUBPROCESS_FAILED')
      expect((caught as ParleyResponseError).message).to.include('claude binary missing or not executable')
      expect((caught as ParleyResponseError).message).to.include('ENOENT')
    })

    it('throws ParleyResponseError on result.is_error=true', async () => {
      const child = new FakeChild()
      const {store} = await makeSessionStore(tmpDir)
      const adapter = makeAdapter({sessionStore: store, spawnChild: child})

      const ctx = makeContext()
      const genPromise = collectChunks(adapter.generate(ctx))

      setImmediate(() => {
        child.emitStdout(
          JSON.stringify({session_id: 's1', subtype: 'init', type: 'system'}) + '\n' +
          JSON.stringify({is_error: true, type: 'result'}) + '\n',
        )
        child.emitClose(0)
      })

      let caught: unknown
      try {
        await genPromise
      } catch (error) {
        caught = error
      }

      expect(caught).to.be.instanceOf(ParleyResponseError)
      expect((caught as ParleyResponseError).code).to.equal('ADAPTER_SUBPROCESS_FAILED')
    })

    it('throws ParleyResponseError when subprocess exits without a result event', async () => {
      const child = new FakeChild()
      const {store} = await makeSessionStore(tmpDir)
      const adapter = makeAdapter({sessionStore: store, spawnChild: child})

      const genPromise = collectChunks(adapter.generate(makeContext()))

      setImmediate(() => {
        // No result event, just close.
        child.emitClose(1)
      })

      let caught: unknown
      try {
        await genPromise
      } catch (error) {
        caught = error
      }

      expect(caught).to.be.instanceOf(ParleyResponseError)
      expect((caught as ParleyResponseError).code).to.equal('ADAPTER_SUBPROCESS_FAILED')
    })
  })

  // ── stale session retry ───────────────────────────────────────────────────

  describe('stale session-id retry', () => {
    it('retries without --resume when stderr says "session not found"', async () => {
      const {store} = await makeSessionStore(tmpDir)

      // Pre-seed a stale session.
      const key: ParleyAdapterSessionKey = {
        adapterProfile: 'claude-code',
        channelId: 'ch-test',
        projectRoot: '/proj/test',
        senderPeerId: 'peer-abc',
      }
      await store.set(key, 'stale-sess')

      let callCount = 0
      const children: FakeChild[] = []
      const gate = createProfileConcurrencyGate({maxConcurrent: 1})

      const adapter = new ClaudeCodeHeadlessAdapter({
        claudeBinary: 'claude',
        concurrencyGate: gate,
        log() {},
        sessionStore: store,
        spawn() {
          callCount++
          const child = new FakeChild()
          children.push(child)

          if (callCount === 1) {
            // First call: fail with stale session error.
            setImmediate(() => {
              child.emitStderr('session not found: stale-sess\n')
              child.emitClose(1)
            })
          } else {
            // Second call (retry without --resume): succeed.
            setImmediate(() => {
              for (const line of happyPathLines('fresh-sess')) child.emitStdout(line + '\n')
              child.emitClose(0)
            })
          }

          return child as unknown as ChildProcess
        },
      })

      const chunks = await collectChunks(adapter.generate(makeContext()))
      expect(callCount).to.equal(2)
      expect(chunks).to.have.lengthOf(1)
      expect(store.get(key)).to.equal('fresh-sess')
    })
  })

  // ── abortSignal ──────────────────────────────────────────────────────────

  describe('abortSignal', () => {
    it('SIGTERMs the child when abortSignal fires and returns without throwing', async () => {
      const child = new FakeChild()
      let killCalled = false
      child.kill = (_signal?: string) => {
        killCalled = true
        // Simulate process dying after SIGTERM.
        setImmediate(() => child.emitClose(null))
        return true
      }

      const {store} = await makeSessionStore(tmpDir)
      const adapter = makeAdapter({sessionStore: store, spawnChild: child})

      const ac = new AbortController()
      const ctx = makeContext({abortSignal: ac.signal})
      const genPromise = collectChunks(adapter.generate(ctx))

      // Abort after a tick.
      setImmediate(() => ac.abort())

      // Should resolve without throwing (parley-server emits cancel seal).
      const chunks = await genPromise
      expect(killCalled).to.equal(true)
      // No chunks from an aborted stream.
      expect(chunks).to.have.lengthOf(0)
    })
  })

  // ── concurrency gate ──────────────────────────────────────────────────────

  describe('concurrency gate', () => {
    it('two parallel generate() calls on the same profile are gated to maxConcurrent=1', async () => {
      const {store} = await makeSessionStore(tmpDir)
      const gate = createProfileConcurrencyGate({maxConcurrent: 1})
      const completionOrder: number[] = []

      // Two children — child1 takes longer.
      const child1 = new FakeChild()
      const child2 = new FakeChild()
      let spawnCall = 0

      const adapter = new ClaudeCodeHeadlessAdapter({
        claudeBinary: 'claude',
        concurrencyGate: gate,
        log() {},
        sessionStore: store,
        spawn() {
          spawnCall++
          return (spawnCall === 1 ? child1 : child2) as unknown as ChildProcess
        },
      })

      const ctx1 = makeContext({channelId: 'ch-1'})
      const ctx2 = makeContext({channelId: 'ch-2'})

      // Start both — with maxConcurrent=1, the second should wait.
      const p1 = collectChunks(adapter.generate(ctx1)).then((chunks) => {
        completionOrder.push(1)
        return chunks
      })
      const p2 = collectChunks(adapter.generate(ctx2)).then((chunks) => {
        completionOrder.push(2)
        return chunks
      })

      // Let child1 complete first.
      await new Promise<void>((resolve) => { setImmediate(resolve) })
      for (const line of happyPathLines('s1')) child1.emitStdout(line + '\n')
      child1.emitClose(0)

      await p1

      // Now child2 should be unblocked.
      for (const line of happyPathLines('s2')) child2.emitStdout(line + '\n')
      child2.emitClose(0)

      await p2

      expect(completionOrder).to.deep.equal([1, 2])
      // child2 was spawned only after child1 released the slot.
      expect(spawnCall).to.equal(2)
    })

    it('skips spawn entirely when the signal aborts while queued behind the concurrency gate (codex round 4)', async () => {
      // Regression test for the codex round-4 finding:
      // ClaudeCodeHeadlessAdapter.generate() can still spawn `claude` after
      // the request was already aborted while waiting on
      // ProfileConcurrencyGate.acquire(). The abort listener used to only be
      // installed inside runOnce() AFTER acquire resolved, so a request
      // aborted while queued would still proceed to spawn once it got the
      // slot. Fix: check ctx.abortSignal.aborted immediately after acquire
      // (and again before spawn), short-circuit if aborted.
      const {store} = await makeSessionStore(tmpDir)
      const gate = createProfileConcurrencyGate({maxConcurrent: 1})
      let spawnCall = 0
      const childA = new FakeChild()

      const adapter = new ClaudeCodeHeadlessAdapter({
        claudeBinary: 'claude',
        concurrencyGate: gate,
        log() {},
        sessionStore: store,
        spawn() {
          spawnCall++
          // Only the first request (A) should ever reach spawn(). The
          // second request (B) is aborted while queued — its turn through
          // the gate must short-circuit before spawn.
          if (spawnCall === 1) return childA as unknown as ChildProcess
          throw new Error('spawn called for queued-aborted request — adapter did not honour abortSignal post-acquire')
        },
      })

      // Request A holds the slot.
      const ctxA = makeContext({channelId: 'ch-a'})
      const pA = collectChunks(adapter.generate(ctxA))

      // Request B queues behind A.
      const abortB = new AbortController()
      const ctxB = makeContext({abortSignal: abortB.signal, channelId: 'ch-b'})
      const pB = collectChunks(adapter.generate(ctxB))

      // Yield once so B is parked on the gate's acquire promise.
      await new Promise<void>((resolve) => { setImmediate(resolve) })

      // Abort B while it's still queued.
      abortB.abort()

      // Now complete A. The gate releases, B's acquire resolves, and the
      // adapter MUST see the aborted signal and return without spawning.
      for (const line of happyPathLines('sA')) childA.emitStdout(line + '\n')
      childA.emitClose(0)

      await pA
      const bChunks = await pB

      // B got the slot but skipped spawn — no chunks yielded, no second spawn call.
      expect(spawnCall).to.equal(1)
      expect(bChunks).to.deep.equal([])
    })
  })

  // ── shutdown ─────────────────────────────────────────────────────────────

  it('shutdown() resolves without throwing', async () => {
    const {store} = await makeSessionStore(tmpDir)
    const adapter = makeAdapter({sessionStore: store})
    await adapter.shutdown()
  })
})
