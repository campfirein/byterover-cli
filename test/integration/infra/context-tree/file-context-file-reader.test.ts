import {expect} from 'chai'
import {mkdir, rm, writeFile} from 'node:fs/promises'
import {tmpdir} from 'node:os'
import {join} from 'node:path'

import {BRV_DIR, CONTEXT_TREE_DIR} from '../../../../src/server/constants.js'
import {FileContextFileReader} from '../../../../src/server/infra/context-tree/file-context-file-reader.js'

describe('FileContextFileReader', () => {
  let testDir: string
  let contextTreeDir: string
  let reader: FileContextFileReader

  beforeEach(async () => {
    testDir = join(tmpdir(), `brv-test-${Date.now()}`)
    contextTreeDir = join(testDir, BRV_DIR, CONTEXT_TREE_DIR)
    await mkdir(contextTreeDir, {recursive: true})
    reader = new FileContextFileReader({baseDirectory: testDir})
  })

  afterEach(async () => {
    await rm(testDir, {force: true, recursive: true})
  })

  describe('constructor', () => {
    it('should use process.cwd() when no baseDirectory provided', async () => {
      const defaultReader = new FileContextFileReader()
      // Should not throw when calling methods (will use cwd)
      const result = await defaultReader.read('nonexistent/context.md')
      expect(result).to.be.undefined
    })

    it('should use provided baseDirectory', async () => {
      const domainDir = join(contextTreeDir, 'test')
      await mkdir(domainDir, {recursive: true})
      await writeFile(join(domainDir, 'context.md'), '# Test')

      const result = await reader.read('test/context.md')
      expect(result).to.not.be.undefined
      expect(result!.title).to.equal('Test')
    })
  })

  describe('read', () => {
    describe('title extraction', () => {
      it('should extract title from first level-1 heading', async () => {
        const domainDir = join(contextTreeDir, 'design')
        await mkdir(domainDir, {recursive: true})
        await writeFile(join(domainDir, 'context.md'), '# My Title\n\nSome content here')

        const result = await reader.read('design/context.md')

        expect(result).to.not.be.undefined
        expect(result!.title).to.equal('My Title')
      })

      it('should trim whitespace from extracted title', async () => {
        const domainDir = join(contextTreeDir, 'design')
        await mkdir(domainDir, {recursive: true})
        await writeFile(join(domainDir, 'context.md'), '#   Spaced Title   \n\nContent')

        const result = await reader.read('design/context.md')

        expect(result).to.not.be.undefined
        expect(result!.title).to.equal('Spaced Title')
      })

      it('should use first heading even if not on first line', async () => {
        const domainDir = join(contextTreeDir, 'design')
        await mkdir(domainDir, {recursive: true})
        await writeFile(join(domainDir, 'context.md'), 'Some preamble text\n\n# First Heading\n\n## Second Heading')

        const result = await reader.read('design/context.md')

        expect(result).to.not.be.undefined
        expect(result!.title).to.equal('First Heading')
      })

      it('should ignore level-2 headings when extracting title', async () => {
        const domainDir = join(contextTreeDir, 'design')
        await mkdir(domainDir, {recursive: true})
        await writeFile(join(domainDir, 'context.md'), '## Level 2 Heading\n\nContent')

        const result = await reader.read('design/context.md')

        expect(result).to.not.be.undefined
        expect(result!.title).to.equal('design/context.md')
      })

      it('should fall back to relative path when no heading found', async () => {
        const domainDir = join(contextTreeDir, 'structure')
        await mkdir(domainDir, {recursive: true})
        await writeFile(join(domainDir, 'context.md'), 'Just plain text without any heading')

        const result = await reader.read('structure/context.md')

        expect(result).to.not.be.undefined
        expect(result!.title).to.equal('structure/context.md')
      })

      it('should fall back to relative path for empty file', async () => {
        const domainDir = join(contextTreeDir, 'empty')
        await mkdir(domainDir, {recursive: true})
        await writeFile(join(domainDir, 'context.md'), '')

        const result = await reader.read('empty/context.md')

        expect(result).to.not.be.undefined
        expect(result!.title).to.equal('empty/context.md')
      })

      it('should handle nested paths in title fallback', async () => {
        const nestedDir = join(contextTreeDir, 'domain', 'topic', 'subtopic')
        await mkdir(nestedDir, {recursive: true})
        await writeFile(join(nestedDir, 'context.md'), 'No heading here')

        const result = await reader.read('domain/topic/subtopic/context.md')

        expect(result).to.not.be.undefined
        expect(result!.title).to.equal('domain/topic/subtopic/context.md')
      })
    })

    describe('content reading', () => {
      it('should return the full file content', async () => {
        const content = '# Title\n\nParagraph 1\n\nParagraph 2'
        const domainDir = join(contextTreeDir, 'design')
        await mkdir(domainDir, {recursive: true})
        await writeFile(join(domainDir, 'context.md'), content)

        const result = await reader.read('design/context.md')

        expect(result).to.not.be.undefined
        expect(result!.content).to.equal(content)
      })

      it('should preserve newlines and formatting', async () => {
        const content = '# Title\n\n- Item 1\n- Item 2\n\n```typescript\nconst x = 1;\n```'
        const domainDir = join(contextTreeDir, 'code')
        await mkdir(domainDir, {recursive: true})
        await writeFile(join(domainDir, 'context.md'), content)

        const result = await reader.read('code/context.md')

        expect(result).to.not.be.undefined
        expect(result!.content).to.equal(content)
      })
    })

    describe('path handling', () => {
      it('should return the path as-is from input', async () => {
        const domainDir = join(contextTreeDir, 'design')
        await mkdir(domainDir, {recursive: true})
        await writeFile(join(domainDir, 'context.md'), '# Test')

        const result = await reader.read('design/context.md')

        expect(result).to.not.be.undefined
        expect(result!.path).to.equal('design/context.md')
      })

      it('should preserve nested path structure', async () => {
        const nestedDir = join(contextTreeDir, 'a', 'b', 'c')
        await mkdir(nestedDir, {recursive: true})
        await writeFile(join(nestedDir, 'context.md'), '# Nested')

        const result = await reader.read('a/b/c/context.md')

        expect(result).to.not.be.undefined
        expect(result!.path).to.equal('a/b/c/context.md')
      })
    })

    describe('error handling', () => {
      it('should return undefined for non-existent file', async () => {
        const result = await reader.read('nonexistent/context.md')

        expect(result).to.be.undefined
      })

      it('should return undefined for non-existent directory', async () => {
        const result = await reader.read('missing/deeply/nested/context.md')

        expect(result).to.be.undefined
      })

      it('should return undefined when reading a directory instead of file', async () => {
        const domainDir = join(contextTreeDir, 'design')
        await mkdir(domainDir, {recursive: true})

        const result = await reader.read('design')

        expect(result).to.be.undefined
      })
    })

    describe('directory parameter', () => {
      it('should use directory parameter over baseDirectory', async () => {
        const otherDir = join(tmpdir(), `brv-other-${Date.now()}`)
        const otherContextDir = join(otherDir, BRV_DIR, CONTEXT_TREE_DIR, 'design')
        await mkdir(otherContextDir, {recursive: true})
        await writeFile(join(otherContextDir, 'context.md'), '# Other Dir')

        try {
          // File only exists in otherDir, not in testDir
          const resultInBase = await reader.read('design/context.md')
          expect(resultInBase).to.be.undefined

          const resultInOther = await reader.read('design/context.md', otherDir)
          expect(resultInOther).to.not.be.undefined
          expect(resultInOther!.title).to.equal('Other Dir')
        } finally {
          await rm(otherDir, {force: true, recursive: true})
        }
      })
    })

    describe('HTML topic extraction (bv-* vocabulary)', () => {
      // Reference fixture covering every field documented in the
      // ContextFileContent contract — keeps the per-test setup tight.
      const FULL_HTML_TOPIC = `<bv-topic path="security/auth" title="JWT authentication" summary="JWT design and refresh flow" tags="security,authentication" keywords="jwt,refresh,token" related="@security/oauth">
  <bv-reason>Document JWT design.</bv-reason>
  <bv-task>Capture JWT design decisions.</bv-task>
  <bv-changes><ul><li>Migrated from HS256 to RS256.</li><li>Added JWKS endpoint.</li></ul></bv-changes>
  <bv-files><ul><li>src/middleware/auth.ts</li><li>docs/auth-design.md</li></ul></bv-files>
  <bv-flow>request → middleware → validate signature → attach user</bv-flow>
  <bv-timestamp>2026-04-01</bv-timestamp>
  <bv-author>Andy</bv-author>
  <bv-pattern flags="g" description="email">[\\w.+-]+@[\\w.-]+</bv-pattern>
  <bv-pattern description="Bearer header">Bearer (\\S+)</bv-pattern>
  <bv-structure>Auth module in src/auth/.</bv-structure>
  <bv-dependencies>Requires @anthropic-ai/sdk ^0.27.</bv-dependencies>
  <bv-highlights>Sub-100ms validation.</bv-highlights>
  <bv-rule severity="must" id="r-validate">Always validate JWT signatures.</bv-rule>
  <bv-rule severity="should" id="r-rotate">Rotate signing keys every 30 days.</bv-rule>
  <bv-examples>jwt.verify(token, key)</bv-examples>
  <bv-diagram type="mermaid" title="lifecycle">sequenceDiagram\nClient->>API: Bearer</bv-diagram>
  <bv-fact subject="signing_algorithm" category="convention" value="RS256">All service-to-service JWTs are signed with RS256.</bv-fact>
</bv-topic>`

      // AC: <bv-topic title> overrides the filename fallback.
      it('extracts title from <bv-topic title="…"> attribute', async () => {
        await mkdir(join(contextTreeDir, 'security'), {recursive: true})
        await writeFile(join(contextTreeDir, 'security/auth.html'), FULL_HTML_TOPIC)

        const result = await reader.read('security/auth.html')

        expect(result).to.not.be.undefined
        expect(result!.title).to.equal('JWT authentication')
      })

      // AC: tags is comma-split + trimmed.
      it('parses tags from <bv-topic tags="…"> as comma-split array', async () => {
        await mkdir(join(contextTreeDir, 'security'), {recursive: true})
        await writeFile(join(contextTreeDir, 'security/auth.html'), FULL_HTML_TOPIC)

        const result = await reader.read('security/auth.html')

        expect(result!.tags).to.deep.equal(['security', 'authentication'])
      })

      // AC: keywords is comma-split + trimmed.
      it('parses keywords from <bv-topic keywords="…"> as comma-split array', async () => {
        await mkdir(join(contextTreeDir, 'security'), {recursive: true})
        await writeFile(join(contextTreeDir, 'security/auth.html'), FULL_HTML_TOPIC)

        const result = await reader.read('security/auth.html')

        expect(result!.keywords).to.deep.equal(['jwt', 'refresh', 'token'])
      })

      // AC: rawConcept.task is the <bv-task> inner text.
      it('extracts rawConcept.task from <bv-task>', async () => {
        await mkdir(join(contextTreeDir, 'security'), {recursive: true})
        await writeFile(join(contextTreeDir, 'security/auth.html'), FULL_HTML_TOPIC)

        const result = await reader.read('security/auth.html')

        expect(result!.rawConcept?.task).to.equal('Capture JWT design decisions.')
      })

      // AC: rawConcept.changes is the <li> list inside <bv-changes>.
      it('extracts rawConcept.changes as <li> items from <bv-changes>', async () => {
        await mkdir(join(contextTreeDir, 'security'), {recursive: true})
        await writeFile(join(contextTreeDir, 'security/auth.html'), FULL_HTML_TOPIC)

        const result = await reader.read('security/auth.html')

        expect(result!.rawConcept?.changes).to.deep.equal([
          'Migrated from HS256 to RS256.',
          'Added JWKS endpoint.',
        ])
      })

      // AC: rawConcept.files is the <li> list inside <bv-files>.
      it('extracts rawConcept.files as <li> items from <bv-files>', async () => {
        await mkdir(join(contextTreeDir, 'security'), {recursive: true})
        await writeFile(join(contextTreeDir, 'security/auth.html'), FULL_HTML_TOPIC)

        const result = await reader.read('security/auth.html')

        expect(result!.rawConcept?.files).to.deep.equal([
          'src/middleware/auth.ts',
          'docs/auth-design.md',
        ])
      })

      // AC: rawConcept.flow / timestamp / author come from their respective elements.
      it('extracts rawConcept.flow, .timestamp, .author from their respective bv-* elements', async () => {
        await mkdir(join(contextTreeDir, 'security'), {recursive: true})
        await writeFile(join(contextTreeDir, 'security/auth.html'), FULL_HTML_TOPIC)

        const result = await reader.read('security/auth.html')

        expect(result!.rawConcept?.flow).to.equal('request → middleware → validate signature → attach user')
        expect(result!.rawConcept?.timestamp).to.equal('2026-04-01')
        expect(result!.rawConcept?.author).to.equal('Andy')
      })

      // AC: rawConcept.patterns carries pattern + flags + description per <bv-pattern> sibling.
      it('extracts rawConcept.patterns with flags + description from <bv-pattern> siblings', async () => {
        await mkdir(join(contextTreeDir, 'security'), {recursive: true})
        await writeFile(join(contextTreeDir, 'security/auth.html'), FULL_HTML_TOPIC)

        const result = await reader.read('security/auth.html')

        expect(result!.rawConcept?.patterns).to.deep.equal([
          {description: 'email', flags: 'g', pattern: String.raw`[\w.+-]+@[\w.-]+`},
          {description: 'Bearer header', pattern: String.raw`Bearer (\S+)`},
        ])
      })

      // AC: narrative.structure / dependencies / highlights / examples from their elements.
      it('extracts narrative.structure, .dependencies, .highlights, .examples', async () => {
        await mkdir(join(contextTreeDir, 'security'), {recursive: true})
        await writeFile(join(contextTreeDir, 'security/auth.html'), FULL_HTML_TOPIC)

        const result = await reader.read('security/auth.html')

        expect(result!.narrative?.structure).to.equal('Auth module in src/auth/.')
        expect(result!.narrative?.dependencies).to.equal('Requires @anthropic-ai/sdk ^0.27.')
        expect(result!.narrative?.highlights).to.equal('Sub-100ms validation.')
        expect(result!.narrative?.examples).to.equal('jwt.verify(token, key)')
      })

      // AC: narrative.rules aggregates <bv-rule> siblings into a bullet list
      // mirroring the markdown-writer's `### Rules` render.
      it('aggregates <bv-rule> siblings into narrative.rules bullet list with severity + id', async () => {
        await mkdir(join(contextTreeDir, 'security'), {recursive: true})
        await writeFile(join(contextTreeDir, 'security/auth.html'), FULL_HTML_TOPIC)

        const result = await reader.read('security/auth.html')

        const rules = result!.narrative?.rules ?? ''
        expect(rules).to.include('[must] (r-validate): Always validate JWT signatures.')
        expect(rules).to.include('[should] (r-rotate): Rotate signing keys every 30 days.')
      })

      // AC: narrative.diagrams gets a structured array.
      it('extracts narrative.diagrams as a list with type + title + content', async () => {
        await mkdir(join(contextTreeDir, 'security'), {recursive: true})
        await writeFile(join(contextTreeDir, 'security/auth.html'), FULL_HTML_TOPIC)

        const result = await reader.read('security/auth.html')

        expect(result!.narrative?.diagrams).to.have.lengthOf(1)
        const diagram = result!.narrative!.diagrams![0]
        expect(diagram.type).to.equal('mermaid')
        expect(diagram.title).to.equal('lifecycle')
        expect(diagram.content).to.include('Client')
      })

      // AC: raw content survives intact regardless of extraction.
      it('returns the source HTML bytes in content unchanged', async () => {
        await mkdir(join(contextTreeDir, 'security'), {recursive: true})
        await writeFile(join(contextTreeDir, 'security/auth.html'), FULL_HTML_TOPIC)

        const result = await reader.read('security/auth.html')

        expect(result!.content).to.equal(FULL_HTML_TOPIC)
      })

      // AC: minimal topic produces sensible defaults.
      it('handles a minimal <bv-topic> with only path + title — empty tags/keywords, no rawConcept/narrative', async () => {
        await mkdir(join(contextTreeDir, 'misc'), {recursive: true})
        await writeFile(
          join(contextTreeDir, 'misc/x.html'),
          '<bv-topic path="misc/x" title="Empty topic"></bv-topic>',
        )

        const result = await reader.read('misc/x.html')

        expect(result!.title).to.equal('Empty topic')
        expect(result!.tags).to.deep.equal([])
        expect(result!.keywords).to.deep.equal([])
        expect(result!.rawConcept).to.equal(undefined)
        expect(result!.narrative).to.equal(undefined)
      })

      // AC: malformed HTML (no bv-topic root) — falls back to filename title,
      //      empty fields. Doesn't throw.
      it('falls back gracefully when there is no <bv-topic> root', async () => {
        await mkdir(join(contextTreeDir, 'broken'), {recursive: true})
        await writeFile(join(contextTreeDir, 'broken/y.html'), '<p>just html, no bv-topic</p>')

        const result = await reader.read('broken/y.html')

        expect(result).to.not.be.undefined
        expect(result!.title).to.equal('broken/y.html') // falls back to path
        expect(result!.tags).to.deep.equal([])
        expect(result!.keywords).to.deep.equal([])
      })

      // AC (review #1): id-only <bv-rule> renders without a double space.
      it('renders <bv-rule> with id but no severity correctly (no double space)', async () => {
        const html = `<bv-topic path="x/y" title="t">
  <bv-rule id="r-foo">id only.</bv-rule>
</bv-topic>`
        await mkdir(join(contextTreeDir, 'x'), {recursive: true})
        await writeFile(join(contextTreeDir, 'x/y.html'), html)

        const result = await reader.read('x/y.html')

        // Exactly one space after the dash; no double space.
        expect(result!.narrative?.rules).to.equal('- (r-foo): id only.')
        expect(result!.narrative?.rules).to.not.match(/^- {2}/)
      })

      // AC (review #1): severity-only <bv-rule> formats cleanly.
      it('renders <bv-rule> with severity but no id correctly', async () => {
        const html = `<bv-topic path="x/y" title="t">
  <bv-rule severity="info">severity only.</bv-rule>
</bv-topic>`
        await mkdir(join(contextTreeDir, 'x'), {recursive: true})
        await writeFile(join(contextTreeDir, 'x/y.html'), html)

        const result = await reader.read('x/y.html')

        expect(result!.narrative?.rules).to.equal('- [info]: severity only.')
      })

      // AC (review #1): <bv-rule> with neither severity nor id — no prefix.
      it('renders <bv-rule> with no attributes as a plain bullet (no prefix)', async () => {
        const html = `<bv-topic path="x/y" title="t">
  <bv-rule>bare rule text.</bv-rule>
</bv-topic>`
        await mkdir(join(contextTreeDir, 'x'), {recursive: true})
        await writeFile(join(contextTreeDir, 'x/y.html'), html)

        const result = await reader.read('x/y.html')

        expect(result!.narrative?.rules).to.equal('- bare rule text.')
      })

      // AC (review): <bv-diagram> without `type` defaults to 'other'.
      it('defaults <bv-diagram type> to "other" when the attribute is absent', async () => {
        const html = `<bv-topic path="x/y" title="t">
  <bv-diagram>no type attr</bv-diagram>
</bv-topic>`
        await mkdir(join(contextTreeDir, 'x'), {recursive: true})
        await writeFile(join(contextTreeDir, 'x/y.html'), html)

        const result = await reader.read('x/y.html')

        expect(result!.narrative?.diagrams).to.deep.equal([
          {content: 'no type attr', type: 'other'},
        ])
      })

      // AC (review #3): bv-* elements outside <bv-topic> must NOT be pulled in.
      it('ignores bv-* elements outside the <bv-topic> root (scope guard)', async () => {
        const html = `<bv-task>stray task outside</bv-task>
<bv-topic path="x/y" title="t">
  <bv-task>real task inside</bv-task>
</bv-topic>
<bv-rule>stray rule outside</bv-rule>`
        await mkdir(join(contextTreeDir, 'x'), {recursive: true})
        await writeFile(join(contextTreeDir, 'x/y.html'), html)

        const result = await reader.read('x/y.html')

        expect(result!.rawConcept?.task).to.equal('real task inside')
        expect(result!.narrative?.rules).to.equal(undefined)
      })

      // AC (review #5): HTML branch ignores `# H1` lines inside the body.
      // A markdown-styled heading inside <bv-examples> must NOT leak into
      // the title (was a fallback path before this fix).
      it('does not use a stray "# heading" inside HTML body as fallback title', async () => {
        const html = `<bv-topic path="security/auth" title="Real title">
  <bv-examples># Looks like a markdown heading inside an example</bv-examples>
</bv-topic>`
        await mkdir(join(contextTreeDir, 'security'), {recursive: true})
        await writeFile(join(contextTreeDir, 'security/leak.html'), html)

        const result = await reader.read('security/leak.html')

        expect(result!.title).to.equal('Real title')
      })

      // AC (review #5 — companion): missing-title HTML uses relative path, NOT a body H1.
      it('uses relativePath as fallback title when <bv-topic title> is absent (not body H1)', async () => {
        const html = `<bv-topic path="x/y">
  <bv-examples># H1 in body</bv-examples>
</bv-topic>`
        await mkdir(join(contextTreeDir, 'x'), {recursive: true})
        await writeFile(join(contextTreeDir, 'x/no-title.html'), html)

        const result = await reader.read('x/no-title.html')

        expect(result!.title).to.equal('x/no-title.html')
      })

      // AC: HTML routing is extension-based — doesn't interfere with the MD path.
      it('does not affect .md topics — markdown path still runs', async () => {
        const mdContent = '---\ntitle: MD topic\ntags: [legacy]\nkeywords: [old]\n---\n\n# MD topic'
        await mkdir(join(contextTreeDir, 'legacy'), {recursive: true})
        await writeFile(join(contextTreeDir, 'legacy/old.md'), mdContent)

        const result = await reader.read('legacy/old.md')

        expect(result!.title).to.equal('MD topic')
        expect(result!.tags).to.deep.equal(['legacy'])
        expect(result!.keywords).to.deep.equal(['old'])
      })
    })
  })

  describe('readMany', () => {
    it('should read multiple files', async () => {
      const designDir = join(contextTreeDir, 'design')
      const codeDir = join(contextTreeDir, 'code')
      await mkdir(designDir, {recursive: true})
      await mkdir(codeDir, {recursive: true})
      await writeFile(join(designDir, 'context.md'), '# Design')
      await writeFile(join(codeDir, 'context.md'), '# Code')

      const results = await reader.readMany(['design/context.md', 'code/context.md'])

      expect(results).to.have.length(2)
      expect(results.map((r) => r.title)).to.include.members(['Design', 'Code'])
    })

    it('should return empty array for empty input', async () => {
      const results = await reader.readMany([])

      expect(results).to.be.an('array').that.is.empty
    })

    it('should skip files that cannot be read', async () => {
      const designDir = join(contextTreeDir, 'design')
      await mkdir(designDir, {recursive: true})
      await writeFile(join(designDir, 'context.md'), '# Design')

      const results = await reader.readMany(['design/context.md', 'nonexistent/context.md', 'also-missing/context.md'])

      expect(results).to.have.length(1)
      expect(results[0].title).to.equal('Design')
    })

    it('should return empty array when all files are missing', async () => {
      const results = await reader.readMany(['missing1/context.md', 'missing2/context.md'])

      expect(results).to.be.an('array').that.is.empty
    })

    it('should preserve order of successfully read files', async () => {
      const aDir = join(contextTreeDir, 'a')
      const bDir = join(contextTreeDir, 'b')
      const cDir = join(contextTreeDir, 'c')
      await mkdir(aDir, {recursive: true})
      await mkdir(bDir, {recursive: true})
      await mkdir(cDir, {recursive: true})
      await writeFile(join(aDir, 'context.md'), '# A')
      await writeFile(join(bDir, 'context.md'), '# B')
      await writeFile(join(cDir, 'context.md'), '# C')

      const results = await reader.readMany(['a/context.md', 'b/context.md', 'c/context.md'])

      expect(results).to.have.length(3)
      expect(results[0].title).to.equal('A')
      expect(results[1].title).to.equal('B')
      expect(results[2].title).to.equal('C')
    })

    it('should use directory parameter', async () => {
      const otherDir = join(tmpdir(), `brv-other-${Date.now()}`)
      const otherContextDir = join(otherDir, BRV_DIR, CONTEXT_TREE_DIR, 'design')
      await mkdir(otherContextDir, {recursive: true})
      await writeFile(join(otherContextDir, 'context.md'), '# Other Dir')

      try {
        const results = await reader.readMany(['design/context.md'], otherDir)

        expect(results).to.have.length(1)
        expect(results[0].title).to.equal('Other Dir')
      } finally {
        await rm(otherDir, {force: true, recursive: true})
      }
    })

    it('should read files concurrently', async () => {
      // Create multiple files
      const dirs = ['dir1', 'dir2', 'dir3', 'dir4', 'dir5']
      for (const dir of dirs) {
        const fullDir = join(contextTreeDir, dir)
        // eslint-disable-next-line no-await-in-loop
        await mkdir(fullDir, {recursive: true})
        // eslint-disable-next-line no-await-in-loop
        await writeFile(join(fullDir, 'context.md'), `# ${dir}`)
      }

      const paths = dirs.map((d) => `${d}/context.md`)
      const results = await reader.readMany(paths)

      expect(results).to.have.length(5)
    })
  })
})
