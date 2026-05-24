/**
 * curate-session orchestrator tests.
 *
 * TKT 02 wires the real state machine on top of TKT 01's protocol
 * surface: continuations run `validateHtmlTopic` + `writeHtmlTopic`
 * against the response; valid input writes the topic file and ends the
 * session with `done`; invalid input emits a `correct-html` step
 * carrying structured errors and keeps the session alive; after
 * MAX_ATTEMPTS (= 4: one generate + three corrections) the session
 * terminates `failed`.
 *
 * Tests cover the full state machine, retry cap, error mapping from
 * the writer to the wire envelope, path-traversal sessionId rejection,
 * corrupted state handling, and the documented envelope-shape contract.
 */

const VALID_TOPIC_HTML_RAW = '<bv-topic path="security/auth" title="JWT auth"><bv-reason>x</bv-reason></bv-topic>'
const TOPIC_WITHOUT_PATH_RAW = '<bv-topic title="JWT auth"></bv-topic>'

import {expect} from 'chai'
import {existsSync} from 'node:fs'
import {mkdir, mkdtemp, readFile, rm, writeFile} from 'node:fs/promises'
import {tmpdir} from 'node:os'
import {join} from 'node:path'

import type {CurateMeta} from '../../../../src/shared/curate-meta.js'

import {
  continueSession,
  CURATE_SESSION_PREFIX,
  CURATE_SESSIONS_DIR,
  kickoffSession,
  parseCurateResponse,
  resolveProjectRoot,
} from '../../../../src/oclif/lib/curate-session.js'
import {BRV_DIR} from '../../../../src/server/constants.js'
import {FileCurateLogStore} from '../../../../src/server/infra/storage/file-curate-log-store.js'
import {FileReviewBackupStore} from '../../../../src/server/infra/storage/file-review-backup-store.js'
import {getProjectDataDir} from '../../../../src/server/utils/path-utils.js'

/** Build the M4 JSON envelope shape expected by the continuation protocol. */
function envelope(html: string, meta?: CurateMeta): string {
  return meta === undefined ? JSON.stringify({html}) : JSON.stringify({html, meta})
}

const VALID_TOPIC_HTML = envelope(VALID_TOPIC_HTML_RAW)
const TOPIC_WITHOUT_PATH = envelope(TOPIC_WITHOUT_PATH_RAW)

async function readLogEntries(root: string) {
  const store = new FileCurateLogStore({baseDir: getProjectDataDir(root)})
  return store.list()
}

async function readBackup(root: string, relativePath: string): Promise<null | string> {
  const store = new FileReviewBackupStore(join(root, BRV_DIR))
  return store.read(relativePath)
}

const UUID_RE = /^[\da-f]{8}-[\da-f]{4}-[\da-f]{4}-[\da-f]{4}-[\da-f]{12}$/i

/**
 * Type-narrowing guard for optional envelope fields. Replaces
 * `value!.field` (non-null assertion) with a clear runtime error when
 * the field is missing, while also narrowing the TS type so the
 * subsequent access is statically safe.
 */
function assertDefined<T>(value: T | undefined, label: string): asserts value is T {
  if (value === undefined) throw new Error(`expected ${label} to be defined`)
}

/**
 * Seed an existing topic at `security/auth.html` for overwrite-guard
 * tests. Runs a full kickoff → valid-response cycle so the file lands
 * via the production code path.
 */
async function seedExistingTopic(projectRoot: string): Promise<void> {
  const kickoff = await kickoffSession({content: 'remember JWT', projectRoot})
  const done = await continueSession({projectRoot, response: VALID_TOPIC_HTML, sessionId: kickoff.sessionId!})
  expect(done.status).to.equal('done')
}

describe('curate-session placeholder', () => {
  let projectRoot: string

  beforeEach(async () => {
    projectRoot = await mkdtemp(join(tmpdir(), 'curate-session-'))
  })

  afterEach(async () => {
    await rm(projectRoot, {force: true, recursive: true})
  })

  describe('kickoffSession', () => {
    it('returns needs-llm-step with a fresh uuid sessionId', async () => {
      const envelope = await kickoffSession({content: 'remember we use RS256', projectRoot})

      expect(envelope.ok).to.equal(true)
      expect(envelope.status).to.equal('needs-llm-step')
      expect(envelope.step).to.equal('generate-html')
      expect(envelope.sessionId).to.be.a('string')
      expect(envelope.sessionId!).to.match(UUID_RE)
    })

    it('includes a stub prompt that embeds the user intent verbatim', async () => {
      const intent = 'remember the JWT signing rotation policy'
      const envelope = await kickoffSession({content: intent, projectRoot})

      expect(envelope.prompt).to.be.a('string')
      expect(envelope.prompt!).to.include(intent)
    })

    it('does not include filePath or errors on a kickoff envelope', async () => {
      const envelope = await kickoffSession({content: 'x', projectRoot})

      expect(envelope.filePath).to.equal(undefined)
      expect(envelope.errors).to.equal(undefined)
    })

    it('writes on-disk state at the documented path with the initial schema', async () => {
      const envelope = await kickoffSession({content: 'x', projectRoot})
      const statePath = join(
        projectRoot,
        BRV_DIR,
        CURATE_SESSIONS_DIR,
        `${CURATE_SESSION_PREFIX}${envelope.sessionId!}`,
        'state.json',
      )

      expect(existsSync(statePath)).to.equal(true)

      const state = JSON.parse(await readFile(statePath, 'utf8'))
      expect(state.userIntent).to.equal('x')
      expect(state.step).to.equal('awaiting-generate')
      expect(state.attempts).to.equal(0)
      expect(state.lastResponse).to.equal('')
      expect(state.createdAt).to.be.a('number')
    })

    it('two kickoffs against the same project return distinct sessionIds', async () => {
      const a = await kickoffSession({content: 'a', projectRoot})
      const b = await kickoffSession({content: 'b', projectRoot})

      expect(a.sessionId).to.not.equal(b.sessionId)
    })
  })

  describe('continueSession — happy path (valid HTML)', () => {
    it('writes the topic file and returns done with the relative path on first valid response', async () => {
      const kickoff = await kickoffSession({content: 'remember JWT', projectRoot})
      const sessionId = kickoff.sessionId!

      const envelope = await continueSession({projectRoot, response: VALID_TOPIC_HTML, sessionId})

      expect(envelope.ok).to.equal(true)
      expect(envelope.status).to.equal('done')
      // filePath is relative to .brv/context-tree/, derived from the bv-topic's path attribute
      expect(envelope.filePath).to.equal('security/auth.html')

      // File actually landed on disk
      const onDisk = join(projectRoot, BRV_DIR, 'context-tree', 'security', 'auth.html')
      expect(existsSync(onDisk)).to.equal(true)

      // Session cleared on success
      const stateDir = join(projectRoot, BRV_DIR, CURATE_SESSIONS_DIR, `${CURATE_SESSION_PREFIX}${sessionId}`)
      expect(existsSync(stateDir)).to.equal(false)
    })

    it('surfaces related-ref warnings on a done envelope when the resolver flagged a broken ref', async () => {
      // Curate a topic whose `related` points at a path that does NOT
      // exist on disk. The write itself succeeds (refs are advisory) but
      // the writer's read-only related-ref resolver flags the broken ref
      // and the CLI must plumb that warning into the done envelope so the
      // calling agent sees it.
      const html = '<bv-topic path="security/jwt" title="JWT" related="@security/missing"><bv-reason>x</bv-reason></bv-topic>'
      const kickoff = await kickoffSession({content: 'remember JWT', projectRoot})
      const envelope = await continueSession({projectRoot, response: JSON.stringify({html}), sessionId: kickoff.sessionId!})

      expect(envelope.status).to.equal('done')
      expect(envelope.warnings, 'warnings must be present').to.not.equal(undefined)
      expect(envelope.warnings).to.have.lengthOf(1)
      expect(envelope.warnings![0]).to.include('@security/missing')
    })

    it('omits the warnings field on a clean curate (every related ref resolves)', async () => {
      // Seed the peer topic first so the related ref resolves to an
      // existing file. The done envelope should have no `warnings` key.
      const seedKickoff = await kickoffSession({content: 'seed oauth', projectRoot})
      const seedHtml = '<bv-topic path="security/oauth" title="OAuth"><bv-reason>x</bv-reason></bv-topic>'
      const seedDone = await continueSession({projectRoot, response: JSON.stringify({html: seedHtml}), sessionId: seedKickoff.sessionId!})
      expect(seedDone.status).to.equal('done')

      const newKickoff = await kickoffSession({content: 'remember JWT', projectRoot})
      const html = '<bv-topic path="security/jwt" title="JWT" related="@security/oauth.html"><bv-reason>x</bv-reason></bv-topic>'
      const envelope = await continueSession({projectRoot, response: JSON.stringify({html}), sessionId: newKickoff.sessionId!})

      expect(envelope.status).to.equal('done')
      expect(envelope.warnings, 'warnings must be omitted on clean writes').to.equal(undefined)
    })

    it('second continuation against a completed sessionId returns unknown-session', async () => {
      const kickoff = await kickoffSession({content: 'x', projectRoot})
      const sessionId = kickoff.sessionId!

      // First continuation succeeds and clears state
      await continueSession({projectRoot, response: VALID_TOPIC_HTML, sessionId})

      // Second continuation must fail — done sessions are not resumable
      const envelope = await continueSession({projectRoot, response: VALID_TOPIC_HTML, sessionId})

      expect(envelope.status).to.equal('failed')
      expect(envelope.errors![0].kind).to.equal('unknown-session')
    })
  })

  describe('continueSession — correction loop (invalid HTML)', () => {
    it('emits correct-html with structured errors on first invalid response; session stays alive', async () => {
      const kickoff = await kickoffSession({content: 'x', projectRoot})
      const sessionId = kickoff.sessionId!

      const envelope = await continueSession({projectRoot, response: TOPIC_WITHOUT_PATH, sessionId})

      expect(envelope.ok).to.equal(false)
      expect(envelope.status).to.equal('needs-llm-step')
      expect(envelope.step).to.equal('correct-html')
      expect(envelope.sessionId).to.equal(sessionId)
      expect(envelope.prompt).to.be.a('string')

      // Errors carry the writer's missing-path-attribute kind
      expect(envelope.errors!.some((e) => e.kind === 'missing-path-attribute')).to.equal(true)

      // Session stays on disk for the retry
      const stateDir = join(projectRoot, BRV_DIR, CURATE_SESSIONS_DIR, `${CURATE_SESSION_PREFIX}${sessionId}`)
      expect(existsSync(stateDir)).to.equal(true)

      // State machine advanced to awaiting-correct + attempts=1
      const state = JSON.parse(await readFile(join(stateDir, 'state.json'), 'utf8'))
      expect(state.step).to.equal('awaiting-correct')
      expect(state.attempts).to.equal(1)
      expect(state.lastResponse).to.equal(TOPIC_WITHOUT_PATH)
    })

    it('accepts a corrected response after an invalid one and writes the file', async () => {
      const kickoff = await kickoffSession({content: 'x', projectRoot})
      const sessionId = kickoff.sessionId!

      // First: invalid → correct-html
      await continueSession({projectRoot, response: TOPIC_WITHOUT_PATH, sessionId})

      // Second: valid → done
      const envelope = await continueSession({projectRoot, response: VALID_TOPIC_HTML, sessionId})

      expect(envelope.status).to.equal('done')
      expect(envelope.filePath).to.equal('security/auth.html')
      const stateDir = join(projectRoot, BRV_DIR, CURATE_SESSIONS_DIR, `${CURATE_SESSION_PREFIX}${sessionId}`)
      expect(existsSync(stateDir)).to.equal(false)
    })

    it('terminates the session with retry-cap-exceeded after MAX_ATTEMPTS invalid responses', async () => {
      const kickoff = await kickoffSession({content: 'x', projectRoot})
      const sessionId = kickoff.sessionId!

      // Submit MAX_ATTEMPTS=4 invalid responses in a row. The first
      // three each move state machine to awaiting-correct; the fourth
      // exhausts the retry cap and terminates `failed`.
      const envelopes: Array<Awaited<ReturnType<typeof continueSession>>> = []
      for (let i = 0; i < 4; i++) {
        // eslint-disable-next-line no-await-in-loop
        const envelope = await continueSession({projectRoot, response: TOPIC_WITHOUT_PATH, sessionId})
        envelopes.push(envelope)
      }

      // First 3 invalid responses → correct-html, session alive
      for (let i = 0; i < 3; i++) {
        expect(envelopes[i].status, `attempt ${i + 1}`).to.equal('needs-llm-step')
        expect(envelopes[i].step, `attempt ${i + 1}`).to.equal('correct-html')
      }

      // 4th invalid response → terminal failed with retry-cap-exceeded
      const final = envelopes[3]
      expect(final.status).to.equal('failed')
      expect(final.errors!.some((e) => e.kind === 'retry-cap-exceeded')).to.equal(true)
      expect(final.sessionId).to.equal(undefined)

      // Session cleared on terminal failure
      const stateDir = join(projectRoot, BRV_DIR, CURATE_SESSIONS_DIR, `${CURATE_SESSION_PREFIX}${sessionId}`)
      expect(existsSync(stateDir)).to.equal(false)
    })

    it('correction-prompt embeds the previous response so the calling agent can target the fix', async () => {
      const kickoff = await kickoffSession({content: 'x', projectRoot})
      const envelope = await continueSession({projectRoot, response: TOPIC_WITHOUT_PATH, sessionId: kickoff.sessionId!})

      expect(envelope.prompt).to.include(TOPIC_WITHOUT_PATH)
    })

    it('maps writer error kinds into the envelope error shape', async () => {
      const kickoff = await kickoffSession({content: 'x', projectRoot})
      const sessionId = kickoff.sessionId!

      // Trigger unknown-bv-element error: a tag that isn't in the registry
      const html = '<bv-topic path="x/y" title="t"><bv-not-a-real-tag/></bv-topic>'
      const envelopeResult = await continueSession({projectRoot, response: envelope(html), sessionId})

      const unknown = envelopeResult.errors!.find((e) => e.kind === 'unknown-element')
      expect(unknown, 'expected unknown-element error in envelope').to.not.equal(undefined)
      expect(unknown!.tag).to.equal('bv-not-a-real-tag')
    })
  })

  describe('continueSession — non-HTML failures', () => {
    it('returns failed with unknown-session for an unknown sessionId', async () => {
      const envelope = await continueSession({
        projectRoot,
        response: VALID_TOPIC_HTML,
        sessionId: '00000000-0000-0000-0000-000000000000',
      })

      expect(envelope.ok).to.equal(false)
      expect(envelope.status).to.equal('failed')
      expect(envelope.errors).to.be.an('array').with.lengthOf(1)
      expect(envelope.errors![0].kind).to.equal('unknown-session')
    })

    it('returns failed with empty-response for an empty payload, keeps the session live', async () => {
      const kickoff = await kickoffSession({content: 'x', projectRoot})
      const sessionId = kickoff.sessionId!

      const envelope = await continueSession({projectRoot, response: '   ', sessionId})

      expect(envelope.status).to.equal('failed')
      expect(envelope.errors![0].kind).to.equal('empty-response')
      expect(envelope.sessionId).to.equal(sessionId)

      const stateDir = join(projectRoot, BRV_DIR, CURATE_SESSIONS_DIR, `${CURATE_SESSION_PREFIX}${sessionId}`)
      expect(existsSync(stateDir)).to.equal(true)
    })
  })

  describe('continueSession — security + robustness', () => {
    it('rejects path-traversal sessionId before any filesystem access', async () => {
      // `--session "../../../etc"` would, without validation, get
      // path-joined into `.brv/sessions/curate-../../../etc/state.json`
      // and resolve outside the project. The fix: validate against the
      // uuid shape up front. Either way the caller sees the same
      // `unknown-session` outcome — we don't leak that we're
      // path-traversal-checking.
      const traversalAttempts = [
        '../../../etc',
        '../sibling-project',
        '/absolute/path',
        '..',
        'curate-/../escape',
        '8609bc28-9a44-41a1-b52d-423213d5f59d/extra', // looks uuid-ish but trailing segment
      ]

      for (const sessionId of traversalAttempts) {
        // eslint-disable-next-line no-await-in-loop
        const envelope = await continueSession({projectRoot, response: 'x', sessionId})
        expect(envelope.status, `case: ${sessionId}`).to.equal('failed')
        expect(envelope.errors![0].kind, `case: ${sessionId}`).to.equal('unknown-session')
      }
    })

    it('treats a corrupted state.json as no session (type-guarded readback)', async () => {
      const kickoff = await kickoffSession({content: 'x', projectRoot})
      const sessionId = kickoff.sessionId!

      // Corrupt the on-disk state — schema-skewed shape that would have
      // sneaked through `as CurateSessionState`. The type guard treats
      // it as "no session" so the placeholder doesn't proceed with
      // garbage fields.
      const statePath = join(
        projectRoot,
        BRV_DIR,
        CURATE_SESSIONS_DIR,
        `${CURATE_SESSION_PREFIX}${sessionId}`,
        'state.json',
      )
      await writeFile(statePath, JSON.stringify({totally: 'wrong shape'}), 'utf8')

      const envelope = await continueSession({projectRoot, response: 'x', sessionId})
      expect(envelope.status).to.equal('failed')
      expect(envelope.errors![0].kind).to.equal('unknown-session')
    })

    it('treats unparseable state.json (truncated write) as no session', async () => {
      const kickoff = await kickoffSession({content: 'x', projectRoot})
      const sessionId = kickoff.sessionId!

      const statePath = join(
        projectRoot,
        BRV_DIR,
        CURATE_SESSIONS_DIR,
        `${CURATE_SESSION_PREFIX}${sessionId}`,
        'state.json',
      )
      await writeFile(statePath, '{ this is not json', 'utf8')

      const envelope = await continueSession({projectRoot, response: 'x', sessionId})
      expect(envelope.status).to.equal('failed')
      expect(envelope.errors![0].kind).to.equal('unknown-session')
    })
  })

  describe('resolveProjectRoot', () => {
    it('returns the directory that contains the .brv/ marker when called from a subdirectory', async () => {
      const project = await mkdtemp(join(tmpdir(), 'curate-session-root-'))
      try {
        await mkdir(join(project, BRV_DIR), {recursive: true})
        const nested = join(project, 'src', 'agent')
        await mkdir(nested, {recursive: true})

        expect(resolveProjectRoot(nested)).to.equal(project)
      } finally {
        await rm(project, {force: true, recursive: true})
      }
    })

    it('returns the input directory itself when it contains .brv/', async () => {
      const project = await mkdtemp(join(tmpdir(), 'curate-session-root-'))
      try {
        await mkdir(join(project, BRV_DIR), {recursive: true})
        expect(resolveProjectRoot(project)).to.equal(project)
      } finally {
        await rm(project, {force: true, recursive: true})
      }
    })

    it('falls back to the start directory when no .brv/ marker is found upward', async () => {
      // A fresh tmpdir with no .brv/ anywhere upward should fall back to
      // the start path — matches today's curate behavior of creating
      // .brv/ alongside cwd on first use.
      const project = await mkdtemp(join(tmpdir(), 'curate-session-no-brv-'))
      try {
        expect(resolveProjectRoot(project)).to.equal(project)
      } finally {
        await rm(project, {force: true, recursive: true})
      }
    })
  })

  describe('envelope contract (matches docs/curate-protocol.md)', () => {
    it('needs-llm-step envelope carries sessionId, step, prompt; not filePath or errors', async () => {
      const envelope = await kickoffSession({content: 'x', projectRoot})

      // Present
      expect(envelope.sessionId).to.be.a('string')
      expect(envelope.step).to.equal('generate-html')
      expect(envelope.prompt).to.be.a('string')

      // Absent
      expect(envelope.filePath).to.equal(undefined)
      expect(envelope.errors).to.equal(undefined)
    })

    it('done envelope carries filePath; not sessionId, step, prompt, or errors', async () => {
      const kickoff = await kickoffSession({content: 'x', projectRoot})
      const envelope = await continueSession({
        projectRoot,
        response: VALID_TOPIC_HTML,
        sessionId: kickoff.sessionId!,
      })

      // Present
      expect(envelope.filePath).to.be.a('string')

      // Absent
      expect(envelope.sessionId).to.equal(undefined)
      expect(envelope.step).to.equal(undefined)
      expect(envelope.prompt).to.equal(undefined)
      expect(envelope.errors).to.equal(undefined)
    })

    it('failed envelope carries errors[]; status === failed; ok === false', async () => {
      const envelope = await continueSession({
        projectRoot,
        response: 'x',
        sessionId: '00000000-0000-0000-0000-000000000000',
      })

      expect(envelope.ok).to.equal(false)
      expect(envelope.status).to.equal('failed')
      expect(envelope.errors).to.be.an('array').with.length.greaterThan(0)
    })
  })

  describe('continueSession — overwrite guard', () => {
    // Background: a second tool-mode curate that targets a path already
    // present in the context-tree must NOT silently overwrite. The
    // writer surfaces `path-exists`; the orchestrator maps it onto a
    // `correct-html` step carrying the existing content so the calling
    // agent can merge. An explicit `confirmOverwrite: true` on the
    // continuation bypasses the guard.

    it('blocks a second valid response on the same path; emits correct-html with path-exists', async () => {
      await seedExistingTopic(projectRoot)

      const kickoff2 = await kickoffSession({content: 'remember JWT again', projectRoot})
      const envelope = await continueSession({
        projectRoot,
        response: VALID_TOPIC_HTML,
        sessionId: kickoff2.sessionId!,
      })

      expect(envelope.ok).to.equal(false)
      expect(envelope.status).to.equal('needs-llm-step')
      expect(envelope.step).to.equal('correct-html')
      expect(envelope.sessionId).to.equal(kickoff2.sessionId)
      assertDefined(envelope.errors, 'envelope.errors')
      expect(envelope.errors.some((e) => e.kind === 'path-exists')).to.equal(true)
    })

    it('carries existingContent on the path-exists envelope error', async () => {
      await seedExistingTopic(projectRoot)
      const onDiskPath = join(projectRoot, BRV_DIR, 'context-tree', 'security', 'auth.html')
      const original = await readFile(onDiskPath, 'utf8')

      const kickoff2 = await kickoffSession({content: 'x', projectRoot})
      const envelope = await continueSession({
        projectRoot,
        response: VALID_TOPIC_HTML,
        sessionId: kickoff2.sessionId!,
      })

      assertDefined(envelope.errors, 'envelope.errors')
      const pathExists = envelope.errors.find((e) => e.kind === 'path-exists')
      assertDefined(pathExists, 'path-exists error')
      expect(pathExists.existingContent).to.equal(original)
    })

    it('correction prompt embeds the existing topic for merge context', async () => {
      await seedExistingTopic(projectRoot)

      const kickoff2 = await kickoffSession({content: 'x', projectRoot})
      const envelope = await continueSession({
        projectRoot,
        response: VALID_TOPIC_HTML,
        sessionId: kickoff2.sessionId!,
      })

      // The previously written file's body content should be inlined into
      // the correction prompt so the calling LLM can merge without parsing
      // structured JSON.
      assertDefined(envelope.prompt, 'envelope.prompt')
      expect(envelope.prompt).to.include('<bv-reason>x</bv-reason>')
    })

    it('path-exists block counts toward retry cap (state.attempts increments)', async () => {
      await seedExistingTopic(projectRoot)

      const kickoff2 = await kickoffSession({content: 'x', projectRoot})
      const sessionId = kickoff2.sessionId!
      await continueSession({projectRoot, response: VALID_TOPIC_HTML, sessionId})

      const statePath = join(
        projectRoot,
        BRV_DIR,
        CURATE_SESSIONS_DIR,
        `${CURATE_SESSION_PREFIX}${sessionId}`,
        'state.json',
      )
      const state = JSON.parse(await readFile(statePath, 'utf8'))
      expect(state.attempts).to.equal(1)
      expect(state.step).to.equal('awaiting-correct')
    })

    it('confirmOverwrite=true on continuation bypasses the guard and writes through', async () => {
      await seedExistingTopic(projectRoot)

      const kickoff2 = await kickoffSession({content: 'overwrite', projectRoot})
      const envelope = await continueSession({
        confirmOverwrite: true,
        projectRoot,
        response: VALID_TOPIC_HTML,
        sessionId: kickoff2.sessionId!,
      })

      expect(envelope.status).to.equal('done')
      expect(envelope.filePath).to.equal('security/auth.html')

      const stateDir = join(projectRoot, BRV_DIR, CURATE_SESSIONS_DIR, `${CURATE_SESSION_PREFIX}${kickoff2.sessionId!}`)
      expect(existsSync(stateDir), 'session cleared on overwrite success').to.equal(false)
    })

    it('after a path-exists block, a follow-up confirmOverwrite continuation writes through', async () => {
      // Real-world flow: agent sees path-exists, decides to clobber,
      // re-emits with --overwrite on the SAME session.
      await seedExistingTopic(projectRoot)

      const kickoff2 = await kickoffSession({content: 'x', projectRoot})
      const sessionId = kickoff2.sessionId!

      const blocked = await continueSession({projectRoot, response: VALID_TOPIC_HTML, sessionId})
      assertDefined(blocked.errors, 'blocked.errors')
      expect(blocked.errors.some((e) => e.kind === 'path-exists')).to.equal(true)

      const written = await continueSession({
        confirmOverwrite: true,
        projectRoot,
        response: VALID_TOPIC_HTML,
        sessionId,
      })
      expect(written.status).to.equal('done')
    })

    it('confirmOverwrite=true is a no-op on a path that does not yet exist', async () => {
      // A fresh kickoff using --overwrite shouldn't block or break.
      const kickoff = await kickoffSession({content: 'x', projectRoot})
      const envelope = await continueSession({
        confirmOverwrite: true,
        projectRoot,
        response: VALID_TOPIC_HTML,
        sessionId: kickoff.sessionId!,
      })
      expect(envelope.status).to.equal('done')
    })
  })

  // ── M4: parseCurateResponse — JSON envelope parsing ─────────────────────────

  describe('parseCurateResponse', () => {
    it('parses a well-formed envelope with html only', () => {
      const result = parseCurateResponse(envelope(VALID_TOPIC_HTML_RAW))
      expect(result.html).to.equal(VALID_TOPIC_HTML_RAW)
      expect(result.meta).to.be.undefined
    })

    it('parses a well-formed envelope with html and meta', () => {
      const result = parseCurateResponse(envelope(VALID_TOPIC_HTML_RAW, {impact: 'high', type: 'ADD'}))
      expect(result.html).to.equal(VALID_TOPIC_HTML_RAW)
      expect(result.meta).to.deep.equal({impact: 'high', type: 'ADD'})
    })

    it('throws invalid-response-format on malformed JSON', () => {
      let caught: unknown
      try {
        parseCurateResponse('not-json{')
      } catch (error) {
        caught = error
      }

      expect(caught).to.be.instanceOf(Error)
      const err = caught as Error & {kind?: string}
      expect(err.kind).to.equal('invalid-response-format')
      expect(err.message).to.match(/json/i)
    })

    it('throws invalid-response-format when html field is missing', () => {
      let caught: unknown
      try {
        parseCurateResponse(JSON.stringify({meta: {impact: 'high'}}))
      } catch (error) {
        caught = error
      }

      const err = caught as Error & {kind?: string}
      expect(err.kind).to.equal('invalid-response-format')
      expect(err.message).to.match(/html/i)
    })

    it('throws invalid-response-format when html is empty string', () => {
      let caught: unknown
      try {
        parseCurateResponse(JSON.stringify({html: ''}))
      } catch (error) {
        caught = error
      }

      expect((caught as Error & {kind?: string}).kind).to.equal('invalid-response-format')
    })

    it('throws invalid-response-format when meta has invalid enum value', () => {
      let caught: unknown
      try {
        parseCurateResponse(JSON.stringify({html: VALID_TOPIC_HTML_RAW, meta: {impact: 'severe'}}))
      } catch (error) {
        caught = error
      }

      expect((caught as Error & {kind?: string}).kind).to.equal('invalid-response-format')
    })

    it('throws invalid-response-format when meta has unknown keys (.strict)', () => {
      let caught: unknown
      try {
        parseCurateResponse(JSON.stringify({html: VALID_TOPIC_HTML_RAW, meta: {importance: 'high'}}))
      } catch (error) {
        caught = error
      }

      expect((caught as Error & {kind?: string}).kind).to.equal('invalid-response-format')
    })
  })

  // ── M4: continueSession with envelope — error path ──────────────────────────

  describe('continueSession — envelope validation errors', () => {
    it('returns invalid-response-format envelope when --response is not JSON', async () => {
      const kickoff = await kickoffSession({content: 'x', projectRoot})
      const result = await continueSession({
        projectRoot,
        response: '<bv-topic path="x/y"></bv-topic>', // raw HTML — was valid before M4
        sessionId: kickoff.sessionId!,
      })

      expect(result.status).to.equal('failed')
      expect(result.errors![0].kind).to.equal('invalid-response-format')
    })

    it('returns invalid-response-format when meta is invalid', async () => {
      const kickoff = await kickoffSession({content: 'x', projectRoot})
      const result = await continueSession({
        projectRoot,
        response: JSON.stringify({html: VALID_TOPIC_HTML_RAW, meta: {impact: 'severe'}}),
        sessionId: kickoff.sessionId!,
      })

      expect(result.status).to.equal('failed')
      expect(result.errors![0].kind).to.equal('invalid-response-format')
    })
  })

  // ── M4: curate-log persistence ──────────────────────────────────────────────

  describe('continueSession — curate-log persistence', () => {
    it('writes a log entry with needsReview=true when meta.impact = high', async () => {
      const kickoff = await kickoffSession({content: 'remember JWT', projectRoot})
      const result = await continueSession({
        projectRoot,
        response: envelope(VALID_TOPIC_HTML_RAW, {
          impact: 'high',
          reason: 'Locks JWT alg.',
          summary: 'JWT RS256.',
          type: 'ADD',
        }),
        sessionId: kickoff.sessionId!,
      })
      expect(result.status).to.equal('done')

      const entries = await readLogEntries(projectRoot)
      expect(entries).to.have.lengthOf(1)
      const entry = entries[0]
      expect(entry.status).to.equal('completed')
      expect(entry.operations).to.have.lengthOf(1)
      const op = entry.operations[0]
      expect(op.needsReview).to.equal(true)
      expect(op.reviewStatus).to.equal('pending')
      expect(op.impact).to.equal('high')
      expect(op.type).to.equal('ADD')
      expect(op.reason).to.equal('Locks JWT alg.')
    })

    it('writes a log entry without review surfacing when meta omitted', async () => {
      const kickoff = await kickoffSession({content: 'x', projectRoot})
      const result = await continueSession({
        projectRoot,
        response: envelope(VALID_TOPIC_HTML_RAW),
        sessionId: kickoff.sessionId!,
      })
      expect(result.status).to.equal('done')

      const entries = await readLogEntries(projectRoot)
      expect(entries).to.have.lengthOf(1)
      const op = entries[0].operations[0]
      expect(op.needsReview).to.be.undefined
      expect(op.reviewStatus).to.be.undefined
      expect(op.impact).to.be.undefined
    })

    it('suppresses needsReview when project has reviewDisabled=true', async () => {
      // Write a BrvConfig with reviewDisabled=true into .brv/config.json
      await mkdir(join(projectRoot, BRV_DIR), {recursive: true})
      await writeFile(
        join(projectRoot, BRV_DIR, 'config.json'),
        JSON.stringify({createdAt: new Date().toISOString(), reviewDisabled: true, version: '1'}),
        'utf8',
      )

      const kickoff = await kickoffSession({content: 'x', projectRoot})
      await continueSession({
        projectRoot,
        response: envelope(VALID_TOPIC_HTML_RAW, {impact: 'high', type: 'ADD'}),
        sessionId: kickoff.sessionId!,
      })

      const entries = await readLogEntries(projectRoot)
      const op = entries[0].operations[0]
      expect(op.needsReview).to.equal(false)
      expect(op.reviewStatus).to.be.undefined
      expect(op.impact).to.equal('high') // still recorded for telemetry
    })

    it('writes an error log entry on validation failure (still auditable)', async () => {
      const kickoff = await kickoffSession({content: 'x', projectRoot})
      await continueSession({
        projectRoot,
        response: envelope(TOPIC_WITHOUT_PATH_RAW, {impact: 'high', type: 'ADD'}),
        sessionId: kickoff.sessionId!,
      })

      const entries = await readLogEntries(projectRoot)
      expect(entries).to.have.lengthOf(1)
      const entry = entries[0]
      expect(entry.status).to.equal('error')
      const op = entry.operations[0]
      expect(op.status).to.equal('failed')
      expect(op.needsReview).to.equal(false)
    })

    it('does NOT write a log entry when envelope itself is unparseable', async () => {
      // Protocol-level failures (invalid JSON) happen before we have a
      // valid {html, meta} pair; nothing to log.
      const kickoff = await kickoffSession({content: 'x', projectRoot})
      await continueSession({projectRoot, response: 'not-json{', sessionId: kickoff.sessionId!})

      const entries = await readLogEntries(projectRoot)
      expect(entries).to.have.lengthOf(0)
    })
  })

  // ── M4: review-backup before destructive write (regression for `brv review reject` data loss) ──

  describe('continueSession — review backups before overwrite', () => {
    // Without seeding the backup store before `writeHtmlTopic` clobbers an existing
    // topic, `brv review reject` reads `backupStore.read()` → null →
    // review-handler.ts:152 treats null backup as ADD → `unlink(absolutePath)` →
    // user's prior knowledge is destroyed instead of restored. This contract is
    // identical to main's `backupBeforeWrite` in `curate-tool.ts`.

    it('seeds the review-backup store with prior content on UPDATE (confirmOverwrite=true over existing topic)', async () => {
      // Seed the topic via an initial ADD.
      const k1 = await kickoffSession({content: 'remember JWT', projectRoot})
      await continueSession({projectRoot, response: VALID_TOPIC_HTML, sessionId: k1.sessionId!})
      const initialContent = await readFile(
        join(projectRoot, BRV_DIR, 'context-tree', 'security', 'auth.html'),
        'utf8',
      )

      // UPDATE with confirmOverwrite=true. After this, the backup MUST hold the prior bytes
      // so a subsequent `brv review reject` can restore — not delete — the topic.
      const k2 = await kickoffSession({content: 'tighten JWT spec', projectRoot})
      await continueSession({
        confirmOverwrite: true,
        projectRoot,
        response: envelope(
          '<bv-topic path="security/auth" title="JWT auth"><bv-rule severity="must">Rotate keys every 90 days.</bv-rule><bv-reason>updated</bv-reason></bv-topic>',
          {impact: 'high', previousSummary: 'prior', summary: 'new', type: 'UPDATE'},
        ),
        sessionId: k2.sessionId!,
      })

      const backupContent = await readBackup(projectRoot, 'security/auth.html')
      expect(backupContent, 'backup must hold the prior bytes for restore-on-reject').to.equal(initialContent)
    })

    it('does NOT create a backup on ADD (no prior file at path)', async () => {
      // Fresh ADD — there's nothing to back up. Backup store should stay empty.
      const k = await kickoffSession({content: 'remember JWT', projectRoot})
      await continueSession({projectRoot, response: VALID_TOPIC_HTML, sessionId: k.sessionId!})

      const backupContent = await readBackup(projectRoot, 'security/auth.html')
      expect(backupContent).to.equal(null)
    })

    it('does NOT create a backup when project has reviewDisabled = true', async () => {
      // Seed the topic.
      const k1 = await kickoffSession({content: 'x', projectRoot})
      await continueSession({projectRoot, response: VALID_TOPIC_HTML, sessionId: k1.sessionId!})

      // Now turn off reviews.
      await mkdir(join(projectRoot, BRV_DIR), {recursive: true})
      await writeFile(
        join(projectRoot, BRV_DIR, 'config.json'),
        JSON.stringify({createdAt: new Date().toISOString(), reviewDisabled: true, version: '1'}),
        'utf8',
      )

      // UPDATE under reviewDisabled. No backup should appear (review-backups/ stays empty
      // so rejected curates aren't restorable — consistent with main's behaviour).
      const k2 = await kickoffSession({content: 'x', projectRoot})
      await continueSession({
        confirmOverwrite: true,
        projectRoot,
        response: envelope(VALID_TOPIC_HTML_RAW, {impact: 'high', type: 'UPDATE'}),
        sessionId: k2.sessionId!,
      })

      const backupContent = await readBackup(projectRoot, 'security/auth.html')
      expect(backupContent).to.equal(null)
    })

    it('first-write-wins: two consecutive UPDATEs between pushes preserve the snapshot-at-last-push', async () => {
      // Seed.
      const k1 = await kickoffSession({content: 'x', projectRoot})
      await continueSession({projectRoot, response: VALID_TOPIC_HTML, sessionId: k1.sessionId!})
      const originalSnapshot = await readFile(
        join(projectRoot, BRV_DIR, 'context-tree', 'security', 'auth.html'),
        'utf8',
      )

      // First UPDATE — backup captures the original snapshot.
      const k2 = await kickoffSession({content: 'update 1', projectRoot})
      await continueSession({
        confirmOverwrite: true,
        projectRoot,
        response: envelope(
          '<bv-topic path="security/auth" title="JWT auth"><bv-rule>v2</bv-rule><bv-reason>r</bv-reason></bv-topic>',
          {impact: 'high', type: 'UPDATE'},
        ),
        sessionId: k2.sessionId!,
      })

      // Second UPDATE — first-write-wins means the backup must still hold the ORIGINAL
      // snapshot, not the intermediate v2 content. Otherwise rejecting after multiple
      // curates would restore to a state that was never committed.
      const k3 = await kickoffSession({content: 'update 2', projectRoot})
      await continueSession({
        confirmOverwrite: true,
        projectRoot,
        response: envelope(
          '<bv-topic path="security/auth" title="JWT auth"><bv-rule>v3</bv-rule><bv-reason>r</bv-reason></bv-topic>',
          {impact: 'high', type: 'UPDATE'},
        ),
        sessionId: k3.sessionId!,
      })

      const backupContent = await readBackup(projectRoot, 'security/auth.html')
      expect(backupContent).to.equal(originalSnapshot)
    })
  })
})
