/**
 * read-topic tests.
 *
 * Pin the contract `brv read` exposes:
 *   - HTML topics route through the html-renderer (clean markdown,
 *     element semantics preserved, no raw <bv-*> markup leaks).
 *   - Markdown topics pass through unchanged.
 *   - `--raw` returns source bytes regardless of format.
 *   - Path traversal / absolute paths / missing files return
 *     structured errors (not throws).
 */

import {expect} from 'chai'
import {mkdir, mkdtemp, rm, writeFile} from 'node:fs/promises'
import {tmpdir} from 'node:os'
import {join} from 'node:path'

import {readTopic} from '../../../../src/oclif/lib/read-topic.js'
import {BRV_DIR, CONTEXT_TREE_DIR} from '../../../../src/server/constants.js'

const VALID_HTML_TOPIC = `<bv-topic path="security/auth" title="JWT authentication" summary="JWT design.">
  <bv-reason>Document JWT.</bv-reason>
  <bv-rule severity="must" id="r-validate">Always validate JWT signatures.</bv-rule>
  <bv-decision id="d-rs256">Use RS256.</bv-decision>
</bv-topic>`

const MD_TOPIC = `# Legacy onboarding

Step 1: install brv.
Step 2: run \`brv init\`.`

describe('readTopic', () => {
  let projectRoot: string

  beforeEach(async () => {
    projectRoot = await mkdtemp(join(tmpdir(), 'read-topic-'))
    const ctRoot = join(projectRoot, BRV_DIR, CONTEXT_TREE_DIR)
    await mkdir(join(ctRoot, 'security'), {recursive: true})
    await mkdir(join(ctRoot, 'legacy'), {recursive: true})
    await writeFile(join(ctRoot, 'security/auth.html'), VALID_HTML_TOPIC, 'utf8')
    await writeFile(join(ctRoot, 'legacy/onboarding.md'), MD_TOPIC, 'utf8')
  })

  afterEach(async () => {
    await rm(projectRoot, {force: true, recursive: true})
  })

  describe('HTML topics', () => {
    it('renders an HTML topic to structured markdown by default', async () => {
      const result = await readTopic(projectRoot, 'security/auth.html')

      expect(result.ok).to.equal(true)
      if (result.ok) {
        expect(result.format).to.equal('html')
        expect(result.path).to.equal('security/auth.html')
        // bv-* markup must be stripped; element semantics survive.
        expect(result.content).to.not.match(/<bv-/)
        expect(result.content).to.include('- **Rule** [must] (r-validate): Always validate JWT signatures.')
        expect(result.content).to.include('- **Decision** (d-rs256): Use RS256.')
      }
    })

    it('returns source HTML bytes verbatim when raw=true', async () => {
      const result = await readTopic(projectRoot, 'security/auth.html', {raw: true})

      expect(result.ok).to.equal(true)
      if (result.ok) {
        expect(result.format).to.equal('html')
        expect(result.content).to.equal(VALID_HTML_TOPIC)
      }
    })
  })

  describe('Markdown topics', () => {
    it('passes markdown through unchanged regardless of raw flag', async () => {
      for (const opts of [{}, {raw: true}, {raw: false}]) {
        // eslint-disable-next-line no-await-in-loop
        const result = await readTopic(projectRoot, 'legacy/onboarding.md', opts)

        expect(result.ok, `opts=${JSON.stringify(opts)}`).to.equal(true)
        if (result.ok) {
          expect(result.format).to.equal('markdown')
          expect(result.content).to.equal(MD_TOPIC)
        }
      }
    })
  })

  describe('error paths', () => {
    it('returns not-found for a missing file', async () => {
      const result = await readTopic(projectRoot, 'does/not/exist.html')

      expect(result.ok).to.equal(false)
      if (!result.ok) {
        expect(result.error.kind).to.equal('not-found')
        expect(result.error.message).to.include('does/not/exist.html')
      }
    })

    it('rejects empty path', async () => {
      const result = await readTopic(projectRoot, '')

      expect(result.ok).to.equal(false)
      if (!result.ok) {
        expect(result.error.kind).to.equal('unsafe-path')
      }
    })

    it('rejects absolute paths', async () => {
      const result = await readTopic(projectRoot, '/etc/passwd')

      expect(result.ok).to.equal(false)
      if (!result.ok) {
        expect(result.error.kind).to.equal('unsafe-path')
        expect(result.error.message).to.match(/absolute/i)
      }
    })

    it('rejects traversal segments (..) at any position', async () => {
      const cases = [
        '../../etc/passwd',
        'security/../../etc/passwd',
        '..',
        '../sibling-project/file',
      ]

      for (const path of cases) {
        // eslint-disable-next-line no-await-in-loop
        const result = await readTopic(projectRoot, path)
        expect(result.ok, `case: ${path}`).to.equal(false)
        if (!result.ok) {
          expect(result.error.kind, `case: ${path}`).to.equal('unsafe-path')
        }
      }
    })

    it('rejects current-dir segments (.) anywhere in the path', async () => {
      const result = await readTopic(projectRoot, 'security/./auth.html')

      expect(result.ok).to.equal(false)
      if (!result.ok) {
        expect(result.error.kind).to.equal('unsafe-path')
      }
    })
  })
})
