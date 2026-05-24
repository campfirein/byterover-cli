/**
 * html-writer tests.
 *
 * Two surfaces:
 *   - `validateHtmlTopic(html)` — pure validation, no I/O. Covers the
 *     full class of failures the writer must catch before disk: missing
 *     <bv-topic>, multiple roots, missing required attrs, unknown
 *     elements, invalid attribute values.
 *   - `writeHtmlTopic({contextTreeRoot, rawHtml})` — validation +
 *     atomic write. Covers fence-stripping, path resolution, atomic
 *     semantics (no partial file on validation failure), path
 *     traversal rejection.
 */

import {expect} from 'chai'
import {existsSync, readFileSync} from 'node:fs'
import {mkdtemp, readdir, rm} from 'node:fs/promises'
import {tmpdir} from 'node:os'
import {join} from 'node:path'

import {validateHtmlTopic, writeHtmlTopic} from '../../../../../../src/server/infra/render/writer/html-writer.js'

function extractAttribute(html: string, name: string): null | string {
  const tagMatch = html.match(/<bv-topic\b[^>]*>/)
  if (!tagMatch) return null
  const attrMatch = tagMatch[0].match(new RegExp(`\\s${name}="([^"]*)"`, 'i'))
  return attrMatch ? attrMatch[1] : null
}

const VALID_TOPIC = `<bv-topic path="security/auth" title="JWT auth">
  <bv-reason>Document JWT auth design.</bv-reason>
  <bv-rule severity="must" id="r-1">Always validate signatures.</bv-rule>
</bv-topic>`

describe('html-writer', () => {
  describe('validateHtmlTopic', () => {
    describe('valid', () => {
      it('accepts a minimal valid topic', () => {
        const result = validateHtmlTopic(VALID_TOPIC)
        expect(result.ok).to.equal(true)
        if (result.ok) {
          expect(result.topicPath).to.equal('security/auth')
        }
      })

      it('accepts a topic with only required attrs', () => {
        const html = '<bv-topic path="x" title="t"></bv-topic>'
        expect(validateHtmlTopic(html).ok).to.equal(true)
      })
    })

    describe('invalid', () => {
      it('rejects HTML with no <bv-topic>', () => {
        const result = validateHtmlTopic('<p>just prose</p>')
        expect(result.ok).to.equal(false)
        if (!result.ok) {
          expect(result.errors[0].kind).to.equal('missing-bv-topic')
        }
      })

      it('rejects HTML with multiple <bv-topic> roots', () => {
        const html = '<bv-topic path="a" title="t1"></bv-topic><bv-topic path="b" title="t2"></bv-topic>'
        const result = validateHtmlTopic(html)
        expect(result.ok).to.equal(false)
        if (!result.ok) {
          expect(result.errors[0].kind).to.equal('multiple-bv-topic')
        }
      })

      it('rejects <bv-topic> missing the path attribute', () => {
        const result = validateHtmlTopic('<bv-topic title="t"></bv-topic>')
        expect(result.ok).to.equal(false)
        if (!result.ok) {
          // The schema validator catches missing `path` first as an
          // attribute-validation error; either kind is acceptable.
          const kinds = new Set(result.errors.map((e) => e.kind))
          expect(kinds.has('attribute-validation') || kinds.has('missing-path-attribute')).to.equal(true)
        }
      })

      it('rejects unknown bv- elements (closed vocabulary)', () => {
        const html = '<bv-topic path="x" title="t"><bv-unknown-thing></bv-unknown-thing></bv-topic>'
        const result = validateHtmlTopic(html)
        expect(result.ok).to.equal(false)
        if (!result.ok) {
          const unknown = result.errors.find((e) => e.kind === 'unknown-bv-element')
          expect(unknown, 'expected unknown-bv-element error').to.not.equal(undefined)
        }
      })

      it('rejects malformed attribute values (e.g. severity outside enum)', () => {
        const html = '<bv-topic path="x" title="t"><bv-rule severity="urgent">x</bv-rule></bv-topic>'
        const result = validateHtmlTopic(html)
        expect(result.ok).to.equal(false)
        if (!result.ok) {
          const attrErr = result.errors.find((e) => e.kind === 'attribute-validation')
          expect(attrErr, 'expected attribute-validation error').to.not.equal(undefined)
        }
      })

      it('rejects path-traversal in bv-topic[path] as an unsafe-path error', () => {
        // Path-traversal must surface as a structured validation error,
        // not a downstream throw — standalone callers (preview, dry-run)
        // need to know the topic isn't safe before they touch disk.
        const html = '<bv-topic path="../../../etc/passwd" title="t"></bv-topic>'
        const result = validateHtmlTopic(html)
        expect(result.ok).to.equal(false)
        if (!result.ok) {
          const unsafe = result.errors.find((e) => e.kind === 'unsafe-path')
          expect(unsafe, 'expected unsafe-path error').to.not.equal(undefined)
        }
      })

      it('rejects single-dot segments as unsafe-path', () => {
        const html = '<bv-topic path="domain/./topic" title="t"></bv-topic>'
        const result = validateHtmlTopic(html)
        expect(result.ok).to.equal(false)
        if (!result.ok) {
          expect(result.errors.some((e) => e.kind === 'unsafe-path')).to.equal(true)
        }
      })
    })
  })

  describe('writeHtmlTopic', () => {
    let tmpRoot: string

    beforeEach(async () => {
      tmpRoot = await mkdtemp(join(tmpdir(), 'html-writer-test-'))
    })

    afterEach(async () => {
      await rm(tmpRoot, {force: true, recursive: true})
    })

    it('atomically writes a valid topic to <root>/<path>.html', async () => {
      const result = await writeHtmlTopic({contextTreeRoot: tmpRoot, rawHtml: VALID_TOPIC})
      expect(result.ok).to.equal(true)
      if (result.ok) {
        expect(result.filePath).to.equal(join(tmpRoot, 'security/auth.html'))
        expect(existsSync(result.filePath)).to.equal(true)
        // The on-disk file is the LLM's HTML plus system-injected
        // `createdat` / `updatedat`. Body content is preserved verbatim;
        // the bv-topic opening tag has the timestamp attributes added.
        const written = readFileSync(result.filePath, 'utf8')
        expect(written).to.include('<bv-reason>Document JWT auth design.</bv-reason>')
        expect(written).to.include('<bv-rule severity="must" id="r-1">Always validate signatures.</bv-rule>')
        expect(written).to.match(/createdat="[^"]+"/)
        expect(written).to.match(/updatedat="[^"]+"/)
      }
    })

    it('strips a wrapping ```html fence before writing', async () => {
      const wrapped = '```html\n' + VALID_TOPIC + '\n```'
      const result = await writeHtmlTopic({contextTreeRoot: tmpRoot, rawHtml: wrapped})
      expect(result.ok).to.equal(true)
      if (result.ok) {
        // Fence is stripped; system timestamps are then injected onto bv-topic.
        const written = readFileSync(result.filePath, 'utf8')
        expect(written.startsWith('```')).to.equal(false)
        expect(written).to.include('<bv-rule severity="must" id="r-1">Always validate signatures.</bv-rule>')
        expect(written).to.match(/createdat="[^"]+"/)
        expect(written).to.match(/updatedat="[^"]+"/)
      }
    })

    it('strips a wrapping ```xml fence before writing', async () => {
      const wrapped = '```xml\n' + VALID_TOPIC + '\n```'
      const result = await writeHtmlTopic({contextTreeRoot: tmpRoot, rawHtml: wrapped})
      expect(result.ok).to.equal(true)
    })

    it('writes nothing on validation failure (no partial file)', async () => {
      const result = await writeHtmlTopic({
        contextTreeRoot: tmpRoot,
        rawHtml: '<p>not html topic</p>',
      })
      expect(result.ok).to.equal(false)
      const filesUnderRoot = await readdir(tmpRoot)
      expect(filesUnderRoot, 'no files should be written on failure').to.have.lengthOf(0)
    })

    it('rejects path-traversal attempts in bv-topic[path] as a validation failure', async () => {
      // Path-traversal surfaces as a structured `unsafe-path` validation
      // error from `validateHtmlTopic`. The writer never reaches disk;
      // no file is written.
      const evil = '<bv-topic path="../../../etc/passwd" title="t"></bv-topic>'
      const result = await writeHtmlTopic({contextTreeRoot: tmpRoot, rawHtml: evil})
      expect(result.ok).to.equal(false)
      if (!result.ok) {
        expect(result.errors.some((e) => e.kind === 'unsafe-path')).to.equal(true)
      }

      const filesUnderRoot = await readdir(tmpRoot)
      expect(filesUnderRoot, 'no file should be written on traversal').to.have.lengthOf(0)
    })

    it('rejects absolute path-traversal attempts (path starting with /)', async () => {
      const evil = '<bv-topic path="/etc/passwd" title="t"></bv-topic>'
      // The leading slash should be stripped, but the resulting path
      // (etc/passwd) lands inside tmpRoot — not a traversal. Just
      // verify it writes inside the root, not at / itself.
      const result = await writeHtmlTopic({contextTreeRoot: tmpRoot, rawHtml: evil})
      expect(result.ok).to.equal(true)
      if (result.ok) {
        expect(result.filePath.startsWith(tmpRoot)).to.equal(true)
      }
    })

    it('handles nested topic paths (creates intermediate directories)', async () => {
      const html = '<bv-topic path="domain/subdomain/topic" title="t"></bv-topic>'
      const result = await writeHtmlTopic({contextTreeRoot: tmpRoot, rawHtml: html})
      expect(result.ok).to.equal(true)
      if (result.ok) {
        expect(result.filePath).to.equal(join(tmpRoot, 'domain/subdomain/topic.html'))
        expect(existsSync(result.filePath)).to.equal(true)
      }
    })

    it('does not leave a *.tmp file behind on success', async () => {
      const result = await writeHtmlTopic({contextTreeRoot: tmpRoot, rawHtml: VALID_TOPIC})
      expect(result.ok).to.equal(true)
      if (result.ok) {
        const dir = join(tmpRoot, 'security')
        const entries = await readdir(dir)
        expect(entries.some((e) => e.endsWith('.tmp')), 'no .tmp leftover').to.equal(false)
      }
    })

    describe('system-managed timestamps', () => {
      it('injects createdat and updatedat onto bv-topic on first write', async () => {
        const before = new Date().toISOString()
        const result = await writeHtmlTopic({contextTreeRoot: tmpRoot, rawHtml: VALID_TOPIC})
        const after = new Date().toISOString()
        expect(result.ok).to.equal(true)

        if (result.ok) {
          const written = readFileSync(result.filePath, 'utf8')
          const createdAt = extractAttribute(written, 'createdat')
          const updatedAt = extractAttribute(written, 'updatedat')
          expect(createdAt, 'createdat should be set').to.not.equal(null)
          expect(updatedAt, 'updatedat should be set').to.not.equal(null)
          // Both should be ISO-8601 datetimes within the test window.
          // ISO-8601 strings sort lexicographically the same as datetime.
          expect(createdAt! >= before, `createdat (${createdAt!}) should be >= before (${before})`).to.equal(true)
          expect(createdAt! <= after, `createdat (${createdAt!}) should be <= after (${after})`).to.equal(true)
          expect(updatedAt! >= before, `updatedat (${updatedAt!}) should be >= before (${before})`).to.equal(true)
          expect(updatedAt! <= after, `updatedat (${updatedAt!}) should be <= after (${after})`).to.equal(true)
        }
      })

      it('preserves createdat across confirmed re-writes; updatedat advances', async () => {
        // Re-writes to a path that already has a topic require explicit
        // `confirmOverwrite: true` after the path-exists guard landed.
        // The timestamp semantics under that consent flag are unchanged:
        // createdat is preserved from the prior file, updatedat advances.
        const first = await writeHtmlTopic({contextTreeRoot: tmpRoot, rawHtml: VALID_TOPIC})
        expect(first.ok).to.equal(true)
        if (!first.ok) return

        const firstCreatedAt = extractAttribute(readFileSync(first.filePath, 'utf8'), 'createdat')
        const firstUpdatedAt = extractAttribute(readFileSync(first.filePath, 'utf8'), 'updatedat')
        expect(firstCreatedAt).to.not.equal(null)
        expect(firstUpdatedAt).to.not.equal(null)

        // Wait long enough to guarantee a distinct ISO instant on the
        // second write (Date.now() resolution is 1ms; an ISO string
        // includes milliseconds).
        await new Promise<void>((resolve) => {
          setTimeout(resolve, 5)
        })

        const second = await writeHtmlTopic({confirmOverwrite: true, contextTreeRoot: tmpRoot, rawHtml: VALID_TOPIC})
        expect(second.ok).to.equal(true)
        if (!second.ok) return

        const secondCreatedAt = extractAttribute(readFileSync(second.filePath, 'utf8'), 'createdat')
        const secondUpdatedAt = extractAttribute(readFileSync(second.filePath, 'utf8'), 'updatedat')

        expect(secondCreatedAt, 'createdat must be preserved across re-writes').to.equal(firstCreatedAt)
        expect(secondUpdatedAt, 'updatedat must advance on every write').to.not.equal(firstUpdatedAt)
        expect(
          secondUpdatedAt! >= firstUpdatedAt!,
          `secondUpdatedAt (${secondUpdatedAt!}) should be >= firstUpdatedAt (${firstUpdatedAt!})`,
        ).to.equal(true)
      })

      it('rejects LLM-supplied createdat/updatedat at validation (schema reserves them for the system)', async () => {
        const llmAuthored = `<bv-topic path="security/auth" title="JWT auth" createdat="1999-01-01T00:00:00.000Z" updatedat="1999-01-01T00:00:00.000Z">
  <bv-reason>x</bv-reason>
</bv-topic>`
        const result = await writeHtmlTopic({contextTreeRoot: tmpRoot, rawHtml: llmAuthored})
        expect(result.ok).to.equal(false)
        if (result.ok) return

        const reservedFields = result.errors
          .filter((e) => e.kind === 'attribute-validation' && e.tag === 'bv-topic')
          .map((e) => (e as {field: string}).field)
        expect(reservedFields).to.include.members(['createdat', 'updatedat'])
      })
    })

    describe('overwrite guard', () => {
      // Background: tool-mode curate can route the calling agent to author
      // a topic whose `path` collides with an existing file. The writer's
      // default policy is "refuse to clobber" — surface a structured
      // `path-exists` error with the existing content so the calling
      // agent can merge instead of silently losing prior facts. An
      // explicit `confirmOverwrite: true` is the only way to clobber.
      const ALT_TOPIC = `<bv-topic path="security/auth" title="JWT auth — replaced">
  <bv-reason>Replacement reason after intentional overwrite.</bv-reason>
</bv-topic>`

      it('returns a path-exists error when writing to an existing topic without confirmOverwrite', async () => {
        const first = await writeHtmlTopic({contextTreeRoot: tmpRoot, rawHtml: VALID_TOPIC})
        expect(first.ok).to.equal(true)

        const second = await writeHtmlTopic({contextTreeRoot: tmpRoot, rawHtml: VALID_TOPIC})
        expect(second.ok).to.equal(false)
        if (!second.ok) {
          const pathExists = second.errors.find((e) => e.kind === 'path-exists')
          expect(pathExists, 'expected path-exists error').to.not.equal(undefined)
        }
      })

      it('carries the existing file content + topicPath on the path-exists error', async () => {
        const first = await writeHtmlTopic({contextTreeRoot: tmpRoot, rawHtml: VALID_TOPIC})
        expect(first.ok).to.equal(true)
        if (!first.ok) return
        const onDisk = readFileSync(first.filePath, 'utf8')

        const second = await writeHtmlTopic({contextTreeRoot: tmpRoot, rawHtml: ALT_TOPIC})
        expect(second.ok).to.equal(false)
        if (!second.ok) {
          const pathExists = second.errors.find((e) => e.kind === 'path-exists')
          expect(pathExists, 'expected path-exists error').to.not.equal(undefined)
          if (pathExists && pathExists.kind === 'path-exists') {
            expect(pathExists.existingContent).to.equal(onDisk)
            expect(pathExists.topicPath).to.equal('security/auth')
          }
        }
      })

      it('does not modify the existing file when path-exists blocks the write', async () => {
        const first = await writeHtmlTopic({contextTreeRoot: tmpRoot, rawHtml: VALID_TOPIC})
        expect(first.ok).to.equal(true)
        if (!first.ok) return
        const originalBytes = readFileSync(first.filePath, 'utf8')

        // Distinct ISO millisecond — if the writer mistakenly went
        // through, `updatedat` would shift.
        await new Promise<void>((resolve) => {
          setTimeout(resolve, 5)
        })

        const second = await writeHtmlTopic({contextTreeRoot: tmpRoot, rawHtml: ALT_TOPIC})
        expect(second.ok).to.equal(false)

        const afterBytes = readFileSync(first.filePath, 'utf8')
        expect(afterBytes, 'existing file must be untouched on path-exists block').to.equal(originalBytes)
      })

      it('writes through when confirmOverwrite=true; preserves createdat, advances updatedat', async () => {
        const first = await writeHtmlTopic({contextTreeRoot: tmpRoot, rawHtml: VALID_TOPIC})
        expect(first.ok).to.equal(true)
        if (!first.ok) return
        const firstCreatedAt = extractAttribute(readFileSync(first.filePath, 'utf8'), 'createdat')
        const firstUpdatedAt = extractAttribute(readFileSync(first.filePath, 'utf8'), 'updatedat')

        await new Promise<void>((resolve) => {
          setTimeout(resolve, 5)
        })

        const second = await writeHtmlTopic({confirmOverwrite: true, contextTreeRoot: tmpRoot, rawHtml: ALT_TOPIC})
        expect(second.ok).to.equal(true)
        if (!second.ok) return

        const written = readFileSync(second.filePath, 'utf8')
        expect(written).to.include('Replacement reason after intentional overwrite.')
        expect(extractAttribute(written, 'createdat'), 'createdat preserved').to.equal(firstCreatedAt)
        const newUpdatedAt = extractAttribute(written, 'updatedat')
        expect(newUpdatedAt, 'updatedat advanced').to.not.equal(firstUpdatedAt)
      })

      it('first write to a new path with confirmOverwrite=true succeeds (no false positive)', async () => {
        // confirmOverwrite is a no-op when nothing is on disk to clobber.
        const result = await writeHtmlTopic({confirmOverwrite: true, contextTreeRoot: tmpRoot, rawHtml: VALID_TOPIC})
        expect(result.ok).to.equal(true)
      })

      it('surfaces related-ref warnings alongside a successful write', async () => {
        // The warner runs after the atomic write, never blocks it.
        // Broken refs are reported as `warnings` on a successful write
        // so the calling agent sees them in the curate envelope. The
        // write itself is never rejected — refs are advisory.
        // Seed `security/oauth.html` so the `.html` ref resolves cleanly
        // and only the broken one surfaces.
        await writeHtmlTopic({
          contextTreeRoot: tmpRoot,
          rawHtml: '<bv-topic path="security/oauth" title="OAuth"></bv-topic>',
        })

        const html = `<bv-topic path="security/jwt" title="JWT" related="@security/oauth.html, @security/missing">
  <bv-reason>Document JWT.</bv-reason>
</bv-topic>`
        const result = await writeHtmlTopic({contextTreeRoot: tmpRoot, rawHtml: html})
        expect(result.ok).to.equal(true)
        if (result.ok) {
          expect(result.warnings).to.have.lengthOf(1)
          expect(result.warnings[0]).to.include('@security/missing')
        }
      })

      it('returns an empty warnings array when every related ref resolves', async () => {
        // Seed the target topic so the `.html` ref resolves cleanly.
        await writeHtmlTopic({
          contextTreeRoot: tmpRoot,
          rawHtml: '<bv-topic path="security/oauth" title="OAuth"></bv-topic>',
        })

        const html = `<bv-topic path="security/jwt" title="JWT" related="@security/oauth.html">
  <bv-reason>Document JWT.</bv-reason>
</bv-topic>`
        const result = await writeHtmlTopic({contextTreeRoot: tmpRoot, rawHtml: html})
        expect(result.ok).to.equal(true)
        if (result.ok) {
          expect(result.warnings).to.have.lengthOf(0)
        }
      })

      it('does not affect writes to a different path (collision is exact-path scoped)', async () => {
        const first = await writeHtmlTopic({contextTreeRoot: tmpRoot, rawHtml: VALID_TOPIC})
        expect(first.ok).to.equal(true)

        const otherTopic = `<bv-topic path="security/oauth" title="OAuth">
  <bv-reason>Different topic.</bv-reason>
</bv-topic>`
        const second = await writeHtmlTopic({contextTreeRoot: tmpRoot, rawHtml: otherTopic})
        expect(second.ok).to.equal(true)
      })

      it('surfaces existingContent as undefined when the prior file exists but is unreadable', async () => {
        // Edge case raised in PR review: if existsSync succeeds but
        // readFileSync throws (perms change, concurrent unlink, broken
        // symlink), the guard MUST NOT emit `existingContent: ''` —
        // that would lead a downstream merge-then-overwrite path to
        // produce new-only HTML and silently clobber the prior file
        // (the same data-loss class this guard prevents, through a
        // different door). Verify by chmod-ing the file unreadable
        // before triggering the guard.
        const first = await writeHtmlTopic({contextTreeRoot: tmpRoot, rawHtml: VALID_TOPIC})
        expect(first.ok).to.equal(true)
        if (!first.ok) return

        const {chmodSync} = await import('node:fs')
        chmodSync(first.filePath, 0)
        try {
          const second = await writeHtmlTopic({contextTreeRoot: tmpRoot, rawHtml: VALID_TOPIC})
          expect(second.ok).to.equal(false)
          if (!second.ok) {
            const pathExists = second.errors.find((e) => e.kind === 'path-exists')
            expect(pathExists, 'expected path-exists error').to.not.equal(undefined)
            if (pathExists && pathExists.kind === 'path-exists') {
              expect(pathExists.existingContent, 'existingContent must be undefined for unreadable prior file').to.equal(undefined)
              expect(pathExists.message).to.include('could not be read')
            }
          }
        } finally {
          chmodSync(first.filePath, 0o644)
        }
      })
    })

    describe('path normalization (idempotent .html stripping)', () => {
      // Background: dream-scan emits candidate paths with the `.html`
      // suffix (e.g. "auth/jwt.html") and the documented dream→curate
      // merge workflow tells the agent to write the survivor at that
      // path. Without this normalization the writer doubled the
      // extension into `auth/jwt.html.html`, reported `ok: true`, and
      // silently bypassed the path-exists guard — producing a stale
      // survivor while the agent archived the loser thinking the merge
      // had taken effect. Both bare and `.html`-suffixed forms must
      // resolve to the same on-disk file.

      it('writes path="x/y.html" to <root>/x/y.html (not x/y.html.html)', async () => {
        const html = '<bv-topic path="security/oauth.html" title="OAuth"><bv-rule severity="must" id="r-1">Use PKCE.</bv-rule></bv-topic>'
        const result = await writeHtmlTopic({contextTreeRoot: tmpRoot, rawHtml: html})
        expect(result.ok).to.equal(true)
        if (result.ok) {
          expect(result.filePath).to.equal(join(tmpRoot, 'security/oauth.html'))
          expect(existsSync(result.filePath)).to.equal(true)
          expect(
            existsSync(join(tmpRoot, 'security/oauth.html.html')),
            'doubled-extension file must not be created',
          ).to.equal(false)
        }
      })

      it('treats path="x/y" and path="x/y.html" as the same target (path-exists triggers across forms)', async () => {
        const bare = '<bv-topic path="security/oauth" title="OAuth"><bv-rule severity="must" id="r-1">Use PKCE.</bv-rule></bv-topic>'
        const first = await writeHtmlTopic({contextTreeRoot: tmpRoot, rawHtml: bare})
        expect(first.ok).to.equal(true)

        const suffixed = '<bv-topic path="security/oauth.html" title="OAuth v2"><bv-rule severity="must" id="r-2">Reject implicit flow.</bv-rule></bv-topic>'
        const second = await writeHtmlTopic({contextTreeRoot: tmpRoot, rawHtml: suffixed})
        expect(second.ok).to.equal(false)
        if (!second.ok) {
          const pathExists = second.errors.find((e) => e.kind === 'path-exists')
          expect(pathExists, 'expected path-exists when .html form targets bare-form file').to.not.equal(undefined)
        }
      })

      it('treats path="x/y.html" first then path="x/y" as the same target (reverse order)', async () => {
        const suffixed = '<bv-topic path="security/oauth.html" title="OAuth"><bv-rule severity="must" id="r-1">Use PKCE.</bv-rule></bv-topic>'
        const first = await writeHtmlTopic({contextTreeRoot: tmpRoot, rawHtml: suffixed})
        expect(first.ok).to.equal(true)

        const bare = '<bv-topic path="security/oauth" title="OAuth v2"><bv-rule severity="must" id="r-2">Reject implicit flow.</bv-rule></bv-topic>'
        const second = await writeHtmlTopic({contextTreeRoot: tmpRoot, rawHtml: bare})
        expect(second.ok).to.equal(false)
        if (!second.ok) {
          const pathExists = second.errors.find((e) => e.kind === 'path-exists')
          expect(pathExists, 'expected path-exists when bare form targets .html-form file').to.not.equal(undefined)
        }
      })

      it('confirmOverwrite works regardless of which form was used first', async () => {
        const bare = '<bv-topic path="security/oauth" title="OAuth"><bv-rule severity="must" id="r-1">Use PKCE.</bv-rule></bv-topic>'
        await writeHtmlTopic({contextTreeRoot: tmpRoot, rawHtml: bare})

        const suffixed = '<bv-topic path="security/oauth.html" title="OAuth v2"><bv-rule severity="must" id="r-2">Reject implicit flow.</bv-rule></bv-topic>'
        const result = await writeHtmlTopic({confirmOverwrite: true, contextTreeRoot: tmpRoot, rawHtml: suffixed})
        expect(result.ok).to.equal(true)

        const filesUnderSecurity = await readdir(join(tmpRoot, 'security'))
        const htmlFiles = filesUnderSecurity.filter((f) => f.endsWith('.html'))
        expect(htmlFiles, 'only one .html file should exist under security/').to.have.lengthOf(1)
        expect(htmlFiles[0]).to.equal('oauth.html')
      })
    })
  })
})
