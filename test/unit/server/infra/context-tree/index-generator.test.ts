/**
 * Context-tree index generator tests.
 */

import {expect} from 'chai'
import {mkdir, mkdtemp, readFile, rm, writeFile} from 'node:fs/promises'
import {tmpdir} from 'node:os'
import {join} from 'node:path'

import {generateContextTreeIndex} from '../../../../../src/server/infra/context-tree/index-generator.js'
import {validateHtmlIndex} from '../../../../../src/server/infra/render/index-elements/index.js'

function htmlTopic(path: string, title: string, summary: string, tags = ''): string {
  const tagsAttr = tags ? ` tags="${tags}"` : ''
  return `<bv-topic path="${path}" title="${title}" summary="${summary}"${tagsAttr}>
  <bv-reason>test fixture</bv-reason>
</bv-topic>`
}

function mdTopic(title: string, summary: string): string {
  return `---
title: ${title}
summary: ${summary}
tags: []
---
## Reason
fixture
`
}

async function write(root: string, relPath: string, content: string): Promise<void> {
  const full = join(root, relPath)
  await mkdir(join(full, '..'), {recursive: true})
  await writeFile(full, content, 'utf8')
}

/** Drop the nondeterministic generatedat so two runs can be compared. */
function stripGeneratedAt(s: string): string {
  return s.replace(/generatedat="[^"]*"/, 'generatedat="X"')
}

describe('generateContextTreeIndex', () => {
  let root: string

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'index-generator-test-'))
  })

  afterEach(async () => {
    await rm(root, {force: true, recursive: true})
  })

  it('writes a valid <bv-index> for a mixed html + markdown tree', async () => {
    await write(root, 'features/auth.html', htmlTopic('features/auth', 'Auth', 'JWT auth.', 'security,jwt'))
    await write(root, 'architecture/api.md', mdTopic('API', 'REST endpoints.'))

    const result = await generateContextTreeIndex({contextTreeRoot: root, projectName: 'demo'})
    expect(result.ok).to.equal(true)
    if (!result.ok) return

    expect(result.topicCount).to.equal(2)
    expect(result.domainCount).to.equal(2)

    const written = await readFile(join(root, 'index.html'), 'utf8')
    expect(validateHtmlIndex(written).ok).to.equal(true)
    expect(written).to.contain('format="html"')
    expect(written).to.contain('format="markdown"')
    expect(written).to.contain('project="demo"')
  })

  it('groups topics by first path segment and sorts deterministically', async () => {
    await write(root, 'zeta/topic.html', htmlTopic('zeta/topic', 'Z', 'z.'))
    await write(root, 'alpha/two.html', htmlTopic('alpha/two', 'Two', 't.'))
    await write(root, 'alpha/one.html', htmlTopic('alpha/one', 'One', 'o.'))

    const result = await generateContextTreeIndex({contextTreeRoot: root, projectName: 'demo'})
    expect(result.ok).to.equal(true)
    if (!result.ok) return
    expect(result.domainCount).to.equal(2)

    const written = await readFile(join(root, 'index.html'), 'utf8')
    // alpha domain section before zeta
    expect(written.indexOf('name="alpha"')).to.be.lessThan(written.indexOf('name="zeta"'))
    // within alpha, one before two (sorted by path)
    expect(written.indexOf('alpha/one.html')).to.be.lessThan(written.indexOf('alpha/two.html'))
  })

  it('extracts summary and tags into the entry', async () => {
    await write(root, 'features/x.html', htmlTopic('features/x', 'X', 'A summary line.', 'a,b'))
    const result = await generateContextTreeIndex({contextTreeRoot: root, projectName: 'demo'})
    expect(result.ok).to.equal(true)

    const written = await readFile(join(root, 'index.html'), 'utf8')
    expect(written).to.contain('A summary line.')
    expect(written).to.contain('tags="a,b"')
  })

  it('handles a topic with no summary without crashing', async () => {
    await write(root, 'features/y.html', '<bv-topic path="features/y" title="Y"><bv-reason>r</bv-reason></bv-topic>')
    const result = await generateContextTreeIndex({contextTreeRoot: root, projectName: 'demo'})
    expect(result.ok).to.equal(true)
    if (!result.ok) return
    expect(result.topicCount).to.equal(1)
  })

  it('excludes derived artifacts from the index', async () => {
    await write(root, 'features/real.html', htmlTopic('features/real', 'Real', 'real.'))
    await write(root, 'index.html', '<bv-index project="stale" generatedat="2020-01-01T00:00:00.000Z"></bv-index>')
    await write(root, '_manifest.json', '{}')
    await write(root, '_index.md', '# stale legacy index')

    const result = await generateContextTreeIndex({contextTreeRoot: root, projectName: 'demo'})
    expect(result.ok).to.equal(true)
    if (!result.ok) return
    expect(result.topicCount).to.equal(1)
  })

  it('excludes the _archived/ subtree', async () => {
    await write(root, 'features/live.html', htmlTopic('features/live', 'Live', 'live.'))
    await write(root, '_archived/old/dead.html', htmlTopic('old/dead', 'Dead', 'dead.'))

    const result = await generateContextTreeIndex({contextTreeRoot: root, projectName: 'demo'})
    expect(result.ok).to.equal(true)
    if (!result.ok) return
    expect(result.topicCount).to.equal(1)
  })

  it('writes a valid empty index for a tree with no topics', async () => {
    const result = await generateContextTreeIndex({contextTreeRoot: root, projectName: 'empty'})
    expect(result.ok).to.equal(true)
    if (!result.ok) return
    expect(result.topicCount).to.equal(0)
    expect(result.domainCount).to.equal(0)

    const written = await readFile(join(root, 'index.html'), 'utf8')
    expect(validateHtmlIndex(written).ok).to.equal(true)
    expect(written).to.contain('topiccount="0"')
  })

  it('produces deterministic output (stable except generatedat)', async () => {
    await write(root, 'features/auth.html', htmlTopic('features/auth', 'Auth', 'jwt.'))
    await generateContextTreeIndex({contextTreeRoot: root, projectName: 'demo'})
    const first = await readFile(join(root, 'index.html'), 'utf8')
    await generateContextTreeIndex({contextTreeRoot: root, projectName: 'demo'})
    const second = await readFile(join(root, 'index.html'), 'utf8')

    expect(stripGeneratedAt(first)).to.equal(stripGeneratedAt(second))
  })

  it('escapes special characters in attributes and summary text', async () => {
    await write(
      root,
      'features/esc.html',
      htmlTopic('features/esc', 'Title &amp; &lt;tag&gt;', 'Summary with &amp; ampersand.'),
    )
    const result = await generateContextTreeIndex({contextTreeRoot: root, projectName: 'demo'})
    expect(result.ok).to.equal(true)

    const written = await readFile(join(root, 'index.html'), 'utf8')
    // The generated index is itself parseable / valid — escaping held.
    expect(validateHtmlIndex(written).ok).to.equal(true)
  })
})
