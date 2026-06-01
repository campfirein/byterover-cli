/**
 * Command-level tests for `brv curate` continuation orchestration.
 *
 * Three consecutive PR review rounds caught a subtle regression in the
 * emitter / orchestration surface (unlink ordering, errors-vs-warnings
 * envelope shape, text-mode emit) that was visible only through manual
 * interactive verification. These tests pin those load-bearing
 * invariants by subclassing `Curate` and overriding the protected
 * seams (`dispatchContinuation`, `loadResponseFile`,
 * `deleteResponseFile`, `peekSession`, `resolveProjectRoot`) so the
 * full `handleContinuation` flow runs against in-memory doubles.
 *
 * Coverage focus:
 *   - Mutex between `--response` and `--response-file`
 *   - Kickoff-side rejection of continuation-only flags
 *   - "Parse → peek → dispatch → unlink" ordering
 *   - daemon-error throw → file preserved, NO unlink call
 *   - cleanup-failure-post-success → `done` envelope + appended `errors[]`
 *   - text-mode `done` branch iterates companion `errors[]` (regression
 *     introduced in `316ece0` and fixed in `60b613d`)
 */

import {Config as OclifConfig} from '@oclif/core'
import {expect} from 'chai'
import {mkdtempSync, rmSync} from 'node:fs'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import {restore, stub} from 'sinon'

import type {CurateSessionEnvelope} from '../../../src/oclif/lib/curate-session.js'

import Curate from '../../../src/oclif/commands/curate/index.js'
import {InvalidResponseFileError} from '../../../src/oclif/lib/curate-session.js'

type StubBehavior = {
  deleteResponseFileBehavior?: () => Promise<never> | Promise<void>
  dispatchBehavior?: (args: unknown) => Promise<CurateSessionEnvelope> | Promise<never>
  loadResponseFileBehavior?: (path: string) => Promise<never> | Promise<string>
  peekBehavior?: (root: string, id: string) => Promise<{kind: 'invalid-format'} | {kind: 'not-found'} | {kind: 'ok'}>
}

class TestableCurate extends Curate {
  public readonly deleteCalls: string[] = []
  public lastDispatchArgs?: unknown
  public readonly logs: string[] = []
  private readonly behavior: StubBehavior
  private readonly tmpRoot: string

  constructor(tmpRoot: string, behavior: StubBehavior, config: OclifConfig, argv: string[]) {
    super(argv, config)
    this.tmpRoot = tmpRoot
    this.behavior = behavior
  }

  protected override async deleteResponseFile(filePath: string): Promise<void> {
    this.deleteCalls.push(filePath)
    if (this.behavior.deleteResponseFileBehavior) {
      await this.behavior.deleteResponseFileBehavior()
    }
  }

  protected override async dispatchContinuation(args: {
    confirmOverwrite: boolean
    format: 'json' | 'text'
    projectRoot: string
    response: string
    sessionId: string
  }): Promise<CurateSessionEnvelope> {
    this.lastDispatchArgs = args
    if (!this.behavior.dispatchBehavior) {
      throw new Error('TestableCurate: no dispatchBehavior supplied for this scenario')
    }

    return this.behavior.dispatchBehavior(args)
  }

  protected override async loadResponseFile(filePath: string): Promise<string> {
    if (!this.behavior.loadResponseFileBehavior) {
      throw new Error('TestableCurate: no loadResponseFileBehavior supplied for this scenario')
    }

    return this.behavior.loadResponseFileBehavior(filePath)
  }

  public override log(message?: string): void {
    this.logs.push(message ?? '')
  }

  protected override async peekSession(
    projectRoot: string,
    sessionId: string,
  ): Promise<{kind: 'invalid-format'} | {kind: 'not-found'} | {kind: 'ok'}> {
    if (this.behavior.peekBehavior) return this.behavior.peekBehavior(projectRoot, sessionId)
    return {kind: 'ok'}
  }

  protected override resolveProjectRoot(): string {
    return this.tmpRoot
  }
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

const FIXTURE_SESSION_ID = '11111111-1111-1111-1111-111111111111'
const FIXTURE_HTML = '<bv-topic path="x/y" title="t"><bv-fact>z</bv-fact></bv-topic>'
const FIXTURE_ENVELOPE = JSON.stringify({html: FIXTURE_HTML, meta: {impact: 'low', type: 'ADD'}})

function doneEnvelope(filePath: string = 'x/y.html'): CurateSessionEnvelope {
  return {filePath, ok: true, status: 'done'}
}

function failedEnvelope(): CurateSessionEnvelope {
  return {
    errors: [{kind: 'retry-cap-exceeded', message: 'cap'}],
    ok: false,
    status: 'failed',
  }
}

function lastJsonLog(stdout: string[]): {data: Record<string, unknown>; success: boolean} {
  // Coalesce all stdout chunks (writeJsonResponse appends one chunk per call,
  // ending with '\n'), then take the LAST non-empty JSON line.
  const joined = stdout.join('')
  const lines = joined.split('\n').filter((l) => l.length > 0)
  const lastLine = lines.at(-1)
  if (lastLine === undefined) throw new Error('expected at least one stdout line')
  const parsed: unknown = JSON.parse(lastLine)
  if (typeof parsed !== 'object' || parsed === null) throw new Error('stdout was not JSON')
  return parsed as {data: Record<string, unknown>; success: boolean}
}

async function buildCmd(
  tmpRoot: string,
  behavior: StubBehavior,
  argv: string[],
): Promise<TestableCurate> {
  const config = await OclifConfig.load(process.cwd())
  return new TestableCurate(tmpRoot, behavior, config, argv)
}

// ─── Tests ───────────────────────────────────────────────────────────────────

describe('Curate command — continuation orchestration', () => {
  let tmpRoot: string
  let capturedStdout: string[]

  beforeEach(() => {
    tmpRoot = mkdtempSync(join(tmpdir(), 'curate-cmd-test-'))
    // Capture stdout because --format json writes via process.stdout.write
    // (writeJsonResponse), bypassing the command's `this.log` channel.
    capturedStdout = []
    stub(process.stdout, 'write').callsFake((chunk: string | Uint8Array) => {
      capturedStdout.push(typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString('utf8'))
      return true
    })
  })

  afterEach(() => {
    restore()
    rmSync(tmpRoot, {force: true, recursive: true})
  })

  describe('flag combinations', () => {
    it('--response and --response-file together → invalid-flag-combination', async () => {
      const cmd = await buildCmd(
        tmpRoot,
        {},
        ['--session', FIXTURE_SESSION_ID, '--response', FIXTURE_ENVELOPE, '--response-file', '/tmp/x.json', '--format', 'json'],
      )

      await cmd.run()

      const env = lastJsonLog(capturedStdout)
      const errs = env.data.errors as Array<{kind: string}>
      expect(env.success).to.equal(false)
      expect(errs[0]?.kind).to.equal('invalid-flag-combination')
      expect(cmd.lastDispatchArgs).to.equal(undefined)
      expect(cmd.deleteCalls).to.deep.equal([])
    })

    it('--delete-response-file without --response-file → invalid-flag-combination', async () => {
      const cmd = await buildCmd(
        tmpRoot,
        {},
        ['--session', FIXTURE_SESSION_ID, '--response', FIXTURE_ENVELOPE, '--delete-response-file', '--format', 'json'],
      )

      await cmd.run()

      const env = lastJsonLog(capturedStdout)
      const errs = env.data.errors as Array<{kind: string}>
      expect(errs[0]?.kind).to.equal('invalid-flag-combination')
      expect(cmd.lastDispatchArgs).to.equal(undefined)
      expect(cmd.deleteCalls).to.deep.equal([])
    })

    it('continuation-only flag on kickoff (no --session) → invalid-flag-combination', async () => {
      const cmd = await buildCmd(
        tmpRoot,
        {},
        ['some intent', '--response-file', '/tmp/x.json', '--format', 'json'],
      )

      await cmd.run()

      const env = lastJsonLog(capturedStdout)
      const errs = env.data.errors as Array<{kind: string; message: string}>
      expect(errs[0]?.kind).to.equal('invalid-flag-combination')
      expect(errs[0]?.message).to.match(/--response-file requires --session/)
      expect(cmd.lastDispatchArgs).to.equal(undefined)
      expect(cmd.deleteCalls).to.deep.equal([])
    })
  })

  describe('pre-dispatch local validation', () => {
    it('whitespace-only payload → empty-response (transient, session id preserved)', async () => {
      const cmd = await buildCmd(
        tmpRoot,
        {},
        ['--session', FIXTURE_SESSION_ID, '--response', '   ', '--format', 'json'],
      )

      await cmd.run()

      const env = lastJsonLog(capturedStdout)
      const errs = env.data.errors as Array<{kind: string}>
      expect(errs[0]?.kind).to.equal('empty-response')
      expect(env.data.sessionId).to.equal(FIXTURE_SESSION_ID)
      expect(cmd.lastDispatchArgs).to.equal(undefined)
    })

    it('invalid JSON envelope → invalid-response-format BEFORE any daemon call', async () => {
      const cmd = await buildCmd(
        tmpRoot,
        {},
        ['--session', FIXTURE_SESSION_ID, '--response', 'not-json{', '--format', 'json'],
      )

      await cmd.run()

      const env = lastJsonLog(capturedStdout)
      const errs = env.data.errors as Array<{kind: string}>
      expect(errs[0]?.kind).to.equal('invalid-response-format')
      expect(env.data.sessionId).to.equal(FIXTURE_SESSION_ID)
      expect(cmd.lastDispatchArgs).to.equal(undefined)
    })

    it('unknown session id → unknown-session BEFORE any unlink', async () => {
      const cmd = await buildCmd(
        tmpRoot,
        {
          loadResponseFileBehavior: async () => FIXTURE_ENVELOPE,
          peekBehavior: async () => ({kind: 'not-found'}),
        },
        ['--session', FIXTURE_SESSION_ID, '--response-file', '/tmp/x.json', '--delete-response-file', '--format', 'json'],
      )

      await cmd.run()

      const env = lastJsonLog(capturedStdout)
      const errs = env.data.errors as Array<{kind: string}>
      expect(errs[0]?.kind).to.equal('unknown-session')
      expect(cmd.lastDispatchArgs).to.equal(undefined)
      expect(cmd.deleteCalls).to.deep.equal([])
    })

    it('--response-file read error → response-file-read-error, no dispatch', async () => {
      const cmd = await buildCmd(
        tmpRoot,
        {
          async loadResponseFileBehavior() {
            throw new InvalidResponseFileError('response-file-read-error', 'ENOENT no such file')
          },
        },
        ['--session', FIXTURE_SESSION_ID, '--response-file', '/tmp/missing.json', '--format', 'json'],
      )

      await cmd.run()

      const env = lastJsonLog(capturedStdout)
      const errs = env.data.errors as Array<{kind: string}>
      expect(errs[0]?.kind).to.equal('response-file-read-error')
      expect(cmd.lastDispatchArgs).to.equal(undefined)
      expect(cmd.deleteCalls).to.deep.equal([])
    })
  })

  describe('daemon-error path preserves the response file (regression: abd82ba)', () => {
    it('dispatchContinuation throws → daemon-error envelope, NO unlink call', async () => {
      const envelopePath = join(tmpRoot, 'envelope.json')
      const cmd = await buildCmd(
        tmpRoot,
        {
          async dispatchBehavior() {
            throw new Error('transport timeout after 10 retries')
          },
          loadResponseFileBehavior: async () => FIXTURE_ENVELOPE,
        },
        ['--session', FIXTURE_SESSION_ID, '--response-file', envelopePath, '--delete-response-file', '--format', 'json'],
      )

      await cmd.run()

      const env = lastJsonLog(capturedStdout)
      const errs = env.data.errors as Array<{kind: string; message: string}>
      expect(errs[0]?.kind).to.equal('daemon-error')
      expect(errs[0]?.message).to.match(/transport timeout/)
      // The critical invariant: no unlink fired on the daemon-error
      // path. The previous-PR-version of this code unlinked before
      // dispatch and would have deleted the file before the throw.
      expect(cmd.deleteCalls).to.deep.equal([])
    })
  })

  describe('cleanup-failure-post-success → done with appended errors[] (regression: 316ece0)', () => {
    it('done envelope + unlink throws → ok=true status=done errors=[response-file-delete-error]', async () => {
      const envelopePath = join(tmpRoot, 'envelope.json')
      const cmd = await buildCmd(
        tmpRoot,
        {
          async deleteResponseFileBehavior() {
            throw new InvalidResponseFileError(
              'response-file-delete-error',
              'EACCES: permission denied',
            )
          },
          dispatchBehavior: async () => doneEnvelope('x/y.html'),
          loadResponseFileBehavior: async () => FIXTURE_ENVELOPE,
        },
        ['--session', FIXTURE_SESSION_ID, '--response-file', envelopePath, '--delete-response-file', '--format', 'json'],
      )

      await cmd.run()

      const env = lastJsonLog(capturedStdout)
      const errs = env.data.errors as Array<{kind: string; message: string}>
      // Critical contract from this round of review:
      // 1. success/status stay as the daemon set them
      // 2. cleanup error appears as STRUCTURED errors[] entry (not buried in warnings)
      // 3. consumers can switch on errors[0].kind programmatically
      expect(env.success).to.equal(true)
      expect(env.data.ok).to.equal(true)
      expect(env.data.status).to.equal('done')
      expect(env.data.filePath).to.equal('x/y.html')
      expect(errs[0]?.kind).to.equal('response-file-delete-error')
      expect(errs[0]?.message).to.match(/EACCES/)
      expect(cmd.deleteCalls).to.deep.equal([envelopePath])
    })

    it('failed envelope + unlink throws → existing errors PRESERVED, cleanup error APPENDED', async () => {
      const envelopePath = join(tmpRoot, 'envelope.json')
      const cmd = await buildCmd(
        tmpRoot,
        {
          async deleteResponseFileBehavior() {
            throw new InvalidResponseFileError('response-file-delete-error', 'EACCES')
          },
          dispatchBehavior: async () => failedEnvelope(),
          loadResponseFileBehavior: async () => FIXTURE_ENVELOPE,
        },
        ['--session', FIXTURE_SESSION_ID, '--response-file', envelopePath, '--delete-response-file', '--format', 'json'],
      )

      await cmd.run()

      const env = lastJsonLog(capturedStdout)
      const errs = env.data.errors as Array<{kind: string}>
      expect(env.data.status).to.equal('failed')
      // Both errors land in the envelope — daemon's failure first, cleanup second.
      expect(errs.map((e) => e.kind)).to.deep.equal(['retry-cap-exceeded', 'response-file-delete-error'])
    })

    it('done envelope + unlink succeeds → clean done envelope (no companion errors)', async () => {
      const envelopePath = join(tmpRoot, 'envelope.json')
      const cmd = await buildCmd(
        tmpRoot,
        {
          dispatchBehavior: async () => doneEnvelope('x/y.html'),
          loadResponseFileBehavior: async () => FIXTURE_ENVELOPE,
        },
        ['--session', FIXTURE_SESSION_ID, '--response-file', envelopePath, '--delete-response-file', '--format', 'json'],
      )

      await cmd.run()

      const env = lastJsonLog(capturedStdout)
      expect(env.data.status).to.equal('done')
      expect(env.data.filePath).to.equal('x/y.html')
      expect(env.data.errors).to.equal(undefined)
      expect(cmd.deleteCalls).to.deep.equal([envelopePath])
    })
  })

  describe('text-mode emitter surfaces companion errors on done envelopes (regression: 60b613d)', () => {
    it('text-mode done + cleanup error → prints ✓ Curated to AND ⚠ response-file-delete-error', async () => {
      const envelopePath = join(tmpRoot, 'envelope.json')
      const cmd = await buildCmd(
        tmpRoot,
        {
          async deleteResponseFileBehavior() {
            throw new InvalidResponseFileError('response-file-delete-error', 'EACCES: permission denied')
          },
          dispatchBehavior: async () => doneEnvelope('x/y.html'),
          loadResponseFileBehavior: async () => FIXTURE_ENVELOPE,
        },
        ['--session', FIXTURE_SESSION_ID, '--response-file', envelopePath, '--delete-response-file', '--format', 'text'],
      )

      await cmd.run()

      const combined = cmd.logs.join('\n')
      // Both lines must surface — the text-mode regression in 316ece0
      // silently dropped the cleanup error here.
      expect(combined).to.match(/✓ Curated to x\/y\.html/)
      expect(combined).to.include('response-file-delete-error')
      expect(combined).to.include('EACCES')
    })

    it('text-mode done + writer warnings → still surfaces warnings (existing behavior unchanged)', async () => {
      const cmd = await buildCmd(
        tmpRoot,
        {
          dispatchBehavior: async () => ({
            filePath: 'x/y.html',
            ok: true,
            status: 'done',
            warnings: ['broken related ref @other/topic.html'],
          }),
        },
        ['--session', FIXTURE_SESSION_ID, '--response', FIXTURE_ENVELOPE, '--format', 'text'],
      )

      await cmd.run()

      const combined = cmd.logs.join('\n')
      expect(combined).to.match(/✓ Curated to x\/y\.html/)
      expect(combined).to.include('broken related ref')
    })
  })
})

