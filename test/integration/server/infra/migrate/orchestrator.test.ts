/**
 * End-to-end orchestrator tests: build a real tree on disk in a tmp
 * dir, run the migrator, assert post-state.
 */

import {expect} from 'chai'
import {existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, unlinkSync, writeFileSync} from 'node:fs'
import {tmpdir} from 'node:os'
import {join} from 'node:path'

import {
  ARCHIVE_FOLDER_PREFIX,
  BRV_DIR,
  CONTEXT_TREE_DIR,
  MIGRATIONS_DIR,
  PRE_EXISTING_HTML_MANIFEST,
  SUMMARY_INDEX_FILE,
} from '../../../../../src/server/infra/migrate/constants.js'
import {
  rollback,
  runMigration,
  summarizeReport,
} from '../../../../../src/server/infra/migrate/orchestrator.js'

function mkProject(): string {
  return mkdtempSync(join(tmpdir(), 'brv-migrate-test-'))
}

function writeTree(projectRoot: string, files: Record<string, string>): void {
  for (const [rel, content] of Object.entries(files)) {
    const abs = join(projectRoot, BRV_DIR, CONTEXT_TREE_DIR, ...rel.split('/'))
    mkdirSync(join(abs, '..'), {recursive: true})
    writeFileSync(abs, content, 'utf8')
  }
}

describe('migrate/orchestrator', () => {
  describe('runMigration', () => {
    it('returns empty report when no context-tree exists', () => {
      const project = mkProject()
      try {
        const r = runMigration({projectRoot: project})
        expect(r.archiveRoot).to.equal(undefined)
        expect(r.summary).to.deep.equal({archived: 0, failed: 0, migrated: 0, skipped: 0})
      } finally {
        rmSync(project, {force: true, recursive: true})
      }
    })

    it('migrates a topic, archives the source, writes the HTML sibling', () => {
      const project = mkProject()
      try {
        writeTree(project, {
          'topic-a.md': '---\ntitle: A\n---\n\n## Reason\nbecause',
        })
        const r = runMigration({projectRoot: project})
        expect(r.summary.migrated).to.equal(1)
        expect(r.summary.archived).to.equal(0)
        expect(r.summary.failed).to.equal(0)
        // HTML sibling exists
        const htmlPath = join(project, BRV_DIR, CONTEXT_TREE_DIR, 'topic-a.html')
        expect(existsSync(htmlPath)).to.equal(true)
        // Source archived
        const mdPath = join(project, BRV_DIR, CONTEXT_TREE_DIR, 'topic-a.md')
        expect(existsSync(mdPath)).to.equal(false)
        // Archive folder named correctly
        expect(r.archiveRoot).to.match(new RegExp(`${ARCHIVE_FOLDER_PREFIX}\\d{4}-\\d{2}-\\d{2}$`))
      } finally {
        rmSync(project, {force: true, recursive: true})
      }
    })

    it('classifies _index.md as derived (archived without HTML emit)', () => {
      const project = mkProject()
      try {
        writeTree(project, {
          [SUMMARY_INDEX_FILE]: '# Index',
          'topic.md': '---\ntitle: T\n---\n## Reason\nx',
        })
        const r = runMigration({projectRoot: project})
        expect(r.summary.migrated).to.equal(1)
        expect(r.summary.archived).to.equal(1)
      } finally {
        rmSync(project, {force: true, recursive: true})
      }
    })

    it('archives a topic when an HTML sibling already exists', () => {
      const project = mkProject()
      try {
        writeTree(project, {
          'topic.html': '<bv-topic ...>existing</bv-topic>',
          'topic.md': '---\ntitle: T\n---\n## Reason\nx',
        })
        const r = runMigration({projectRoot: project})
        expect(r.summary.archived).to.equal(1)
        expect(r.summary.migrated).to.equal(0)
        // The preserve manifest records the .md whose .html pre-existed.
        const manifestPath = join(
          project,
          BRV_DIR,
          MIGRATIONS_DIR,
          (r.archiveRoot ?? '').split('/').pop() ?? '',
          PRE_EXISTING_HTML_MANIFEST,
        )
        const manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as {
          preserve_html_siblings: string[]
        }
        expect(manifest.preserve_html_siblings).to.deep.equal(['topic.md'])
      } finally {
        rmSync(project, {force: true, recursive: true})
      }
    })

    it('honors --dry-run: writes nothing to disk', () => {
      const project = mkProject()
      try {
        writeTree(project, {
          'topic.md': '---\ntitle: T\n---\n## Reason\nx',
        })
        const r = runMigration({dryRun: true, projectRoot: project})
        expect(r.dryRun).to.equal(true)
        expect(r.summary.migrated).to.equal(1)
        // Source still exists
        const mdPath = join(project, BRV_DIR, CONTEXT_TREE_DIR, 'topic.md')
        expect(existsSync(mdPath)).to.equal(true)
        // No HTML
        const htmlPath = join(project, BRV_DIR, CONTEXT_TREE_DIR, 'topic.html')
        expect(existsSync(htmlPath)).to.equal(false)
        // No archive dir
        const archiveDir = join(project, BRV_DIR, MIGRATIONS_DIR)
        expect(existsSync(archiveDir)).to.equal(false)
      } finally {
        rmSync(project, {force: true, recursive: true})
      }
    })

    it('marks empty topics as failed and archives them', () => {
      const project = mkProject()
      try {
        writeTree(project, {
          'empty.md': '   \n\n',
        })
        const r = runMigration({projectRoot: project})
        expect(r.summary.failed).to.equal(1)
        expect(r.files[0]?.reason).to.equal('empty-file')
      } finally {
        rmSync(project, {force: true, recursive: true})
      }
    })

    it('writes the preserve manifest BEFORE archiving (Ctrl+C-safe)', () => {
      const project = mkProject()
      try {
        writeTree(project, {
          'a.md': '---\ntitle: A\n---\n## Reason\nx',
          'b.html': '<bv-topic>pre-existing</bv-topic>',
          'b.md': '---\ntitle: B\n---\n## Reason\ny',
        })
        const r = runMigration({projectRoot: project})
        const archiveRoot = r.archiveRoot ?? ''
        const manifest = JSON.parse(
          readFileSync(join(archiveRoot, PRE_EXISTING_HTML_MANIFEST), 'utf8'),
        ) as {preserve_html_siblings: string[]}
        expect(manifest.preserve_html_siblings).to.deep.equal(['b.md'])
      } finally {
        rmSync(project, {force: true, recursive: true})
      }
    })
  })

  describe('rollback', () => {
    it('throws when no archive exists', () => {
      const project = mkProject()
      try {
        expect(() => rollback({projectRoot: project})).to.throw(/No archive to roll back/)
      } finally {
        rmSync(project, {force: true, recursive: true})
      }
    })

    it('restores archived files and deletes generated HTML siblings', () => {
      const project = mkProject()
      try {
        writeTree(project, {
          'topic.md': '---\ntitle: T\n---\n## Reason\nx',
        })
        runMigration({projectRoot: project})

        const mdPath = join(project, BRV_DIR, CONTEXT_TREE_DIR, 'topic.md')
        const htmlPath = join(project, BRV_DIR, CONTEXT_TREE_DIR, 'topic.html')
        expect(existsSync(mdPath)).to.equal(false)
        expect(existsSync(htmlPath)).to.equal(true)

        const r = rollback({projectRoot: project})
        expect(r.restored).to.equal(1)
        expect(r.deletedHtml.length).to.equal(1)
        expect(existsSync(mdPath)).to.equal(true)
        expect(existsSync(htmlPath)).to.equal(false)
      } finally {
        rmSync(project, {force: true, recursive: true})
      }
    })

    it('preserves pre-existing HTML siblings during rollback', () => {
      const project = mkProject()
      try {
        writeTree(project, {
          'topic.html': '<bv-topic>pre-existing</bv-topic>',
          'topic.md': '---\ntitle: T\n---\n## Reason\nx',
        })
        runMigration({projectRoot: project})
        const r = rollback({projectRoot: project})
        expect(r.preservedHtml).to.deep.equal(['topic.md'])
        expect(r.deletedHtml.length).to.equal(0)
        // Pre-existing HTML still present
        const htmlPath = join(project, BRV_DIR, CONTEXT_TREE_DIR, 'topic.html')
        expect(existsSync(htmlPath)).to.equal(true)
        expect(readFileSync(htmlPath, 'utf8')).to.include('pre-existing')
      } finally {
        rmSync(project, {force: true, recursive: true})
      }
    })

    it('skips .html deletion when the preserve manifest is missing', () => {
      const project = mkProject()
      try {
        writeTree(project, {'topic.md': '---\ntitle: T\n---\n## Reason\nx'})
        runMigration({projectRoot: project})

        // Locate the archive root and remove the manifest so rollback hits
        // the "missing manifest" branch. PR #706 review #5: when we don't
        // know which .html siblings genuinely pre-existed, we must NOT
        // delete any of them. The skipped paths are surfaced on the
        // report so the operator can clean up manually.
        const migrationsDir = join(project, BRV_DIR, MIGRATIONS_DIR)
        const archiveName = readdirSync(migrationsDir).find((n) =>
          n.startsWith(ARCHIVE_FOLDER_PREFIX),
        )
        if (archiveName === undefined) throw new Error('no archive created')
        const manifestPath = join(migrationsDir, archiveName, PRE_EXISTING_HTML_MANIFEST)
        unlinkSync(manifestPath)

        const r = rollback({projectRoot: project})
        expect(r.restored).to.equal(1)
        // Warning explains why we kept the html, plus a summary count.
        expect(r.warnings).to.have.lengthOf(2)
        expect(r.warnings[0]).to.match(/no preserve-list manifest/)
        expect(r.warnings[1]).to.match(/skipped deletion of 1 \.html sibling/)
        // The .html sibling stays in the tree.
        expect(r.skippedHtml).to.have.lengthOf(1)
        expect(r.deletedHtml).to.have.lengthOf(0)
        const htmlPath = join(project, BRV_DIR, CONTEXT_TREE_DIR, 'topic.html')
        expect(existsSync(htmlPath)).to.equal(true)
      } finally {
        rmSync(project, {force: true, recursive: true})
      }
    })

    it('skips .html deletion when the preserve manifest is unreadable JSON', () => {
      const project = mkProject()
      try {
        writeTree(project, {'topic.md': '---\ntitle: T\n---\n## Reason\nx'})
        runMigration({projectRoot: project})

        const migrationsDir = join(project, BRV_DIR, MIGRATIONS_DIR)
        const archiveName = readdirSync(migrationsDir).find((n) =>
          n.startsWith(ARCHIVE_FOLDER_PREFIX),
        )
        if (archiveName === undefined) throw new Error('no archive created')
        const manifestPath = join(migrationsDir, archiveName, PRE_EXISTING_HTML_MANIFEST)
        writeFileSync(manifestPath, '{not valid json', 'utf8')

        const r = rollback({projectRoot: project})
        expect(r.warnings[0]).to.match(/preserve-list manifest.+unreadable/)
        expect(r.warnings[1]).to.match(/skipped deletion of 1 \.html sibling/)
        expect(r.skippedHtml).to.have.lengthOf(1)
        expect(r.deletedHtml).to.have.lengthOf(0)
      } finally {
        rmSync(project, {force: true, recursive: true})
      }
    })

    it('still deletes .html siblings when the manifest is valid-but-empty (common case)', () => {
      // PR #706 review #5: empty manifest is a legitimate state (no
      // pre-existing siblings), not a defensive-skip trigger. Deletion
      // must still proceed normally here.
      const project = mkProject()
      try {
        writeTree(project, {'topic.md': '---\ntitle: T\n---\n## Reason\nx'})
        runMigration({projectRoot: project})

        const r = rollback({projectRoot: project})
        expect(r.restored).to.equal(1)
        expect(r.deletedHtml).to.have.lengthOf(1)
        expect(r.skippedHtml).to.have.lengthOf(0)
        expect(r.warnings).to.have.lengthOf(0)
        const htmlPath = join(project, BRV_DIR, CONTEXT_TREE_DIR, 'topic.html')
        expect(existsSync(htmlPath)).to.equal(false)
      } finally {
        rmSync(project, {force: true, recursive: true})
      }
    })

    it('skips .html deletion when the preserve manifest contains non-string entries', () => {
      // PR #706 pre-push Codex P1: `{"preserve_html_siblings": [123]}`
      // used to slip through (Array.isArray was true; the .filter then
      // dropped every non-string) — silently leaving an empty preserve
      // set with manifestMissing=false, so deletion proceeded. Now we
      // require every element to be a string or treat the manifest as
      // corrupt.
      const project = mkProject()
      try {
        writeTree(project, {'topic.md': '---\ntitle: T\n---\n## Reason\nx'})
        runMigration({projectRoot: project})

        const migrationsDir = join(project, BRV_DIR, MIGRATIONS_DIR)
        const archiveName = readdirSync(migrationsDir).find((n) =>
          n.startsWith(ARCHIVE_FOLDER_PREFIX),
        )
        if (archiveName === undefined) throw new Error('no archive created')
        const manifestPath = join(migrationsDir, archiveName, PRE_EXISTING_HTML_MANIFEST)
        writeFileSync(manifestPath, '{"preserve_html_siblings": [123]}', 'utf8')

        const r = rollback({projectRoot: project})
        expect(r.warnings[0]).to.match(/contains non-string entries/)
        expect(r.warnings[1]).to.match(/skipped deletion of 1 \.html sibling/)
        expect(r.skippedHtml).to.have.lengthOf(1)
        expect(r.deletedHtml).to.have.lengthOf(0)
      } finally {
        rmSync(project, {force: true, recursive: true})
      }
    })

    it('issue #1: refuses to re-run when today\'s archive already exists', () => {
      // PR #706 review #1 (Codex P1): same-UTC-day re-run would overwrite
      // the preserve manifest and silently destroy pre-existing .html
      // siblings on later rollback. We refuse instead, and the error
      // message hands the operator the recovery command.
      const project = mkProject()
      try {
        writeTree(project, {'topic.md': '---\ntitle: T\n---\n## Reason\nx'})
        runMigration({projectRoot: project})

        // Second run on the same day must throw with the sentinel phrase
        // the CLI matches on for clean rendering.
        writeTree(project, {'another.md': '---\ntitle: B\n---\n## Reason\ny'})
        expect(() => runMigration({projectRoot: project})).to.throw(
          /Migration already ran today/,
        )
        // Error message guides the operator to rollback first.
        expect(() => runMigration({projectRoot: project})).to.throw(
          /brv migrate --rollback/,
        )
      } finally {
        rmSync(project, {force: true, recursive: true})
      }
    })

    it('issue #1: dry-run still works after today\'s archive exists', () => {
      // PR #706 pre-push Codex medium: the same-day archive guard must
      // gate on `!dryRun` — dry-run is in-memory and never writes, so an
      // existing archive isn't a hazard. Without this gate, operators
      // can't preview a migration after running one earlier the same day.
      const project = mkProject()
      try {
        writeTree(project, {'topic.md': '---\ntitle: T\n---\n## Reason\nx'})
        runMigration({projectRoot: project})

        writeTree(project, {'another.md': '---\ntitle: B\n---\n## Reason\ny'})
        const r = runMigration({dryRun: true, projectRoot: project})
        expect(r.dryRun).to.equal(true)
        // The new topic is visible to the classifier — it was found and
        // marked migrated in the dry-run report.
        expect(r.summary.migrated).to.be.greaterThan(0)
      } finally {
        rmSync(project, {force: true, recursive: true})
      }
    })

    it('--dry-run does not touch disk', () => {
      const project = mkProject()
      try {
        writeTree(project, {'topic.md': '---\ntitle: T\n---\n## Reason\nx'})
        runMigration({projectRoot: project})
        const mdPath = join(project, BRV_DIR, CONTEXT_TREE_DIR, 'topic.md')
        const htmlPath = join(project, BRV_DIR, CONTEXT_TREE_DIR, 'topic.html')
        const beforeMd = existsSync(mdPath)
        const beforeHtml = existsSync(htmlPath)
        const r = rollback({dryRun: true, projectRoot: project})
        expect(r.dryRun).to.equal(true)
        expect(r.restored).to.equal(1)
        // Nothing actually moved/deleted
        expect(existsSync(mdPath)).to.equal(beforeMd)
        expect(existsSync(htmlPath)).to.equal(beforeHtml)
      } finally {
        rmSync(project, {force: true, recursive: true})
      }
    })
  })

  describe('summarizeReport', () => {
    it('formats applied report', () => {
      const r = summarizeReport({
        archiveRoot: '/x',
        completedAt: '',
        dryRun: false,
        files: [],
        projectRoot: '/p',
        startedAt: '',
        summary: {archived: 2, failed: 1, migrated: 3, skipped: 4},
      })
      expect(r).to.equal('[applied] migrated=3 archived=2 skipped=4 failed=1')
    })

    it('formats dry-run report', () => {
      const r = summarizeReport({
        archiveRoot: undefined,
        completedAt: '',
        dryRun: true,
        files: [],
        projectRoot: '/p',
        startedAt: '',
        summary: {archived: 0, failed: 0, migrated: 0, skipped: 0},
      })
      expect(r).to.equal('[dry-run] migrated=0 archived=0 skipped=0 failed=0')
    })
  })
})
