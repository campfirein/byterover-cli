import {expect} from 'chai'
import {mkdir, readdir, rm, symlink, writeFile} from 'node:fs/promises'
import {tmpdir} from 'node:os'
import path from 'node:path'
import * as sinon from 'sinon'

import {tidyUpdatePluginClientCache} from '../../../src/oclif/hooks/postrun/after-update.js'

describe('tidyUpdatePluginClientCache', () => {
  let root: string
  let logStub: sinon.SinonStub

  beforeEach(async () => {
    root = path.join(tmpdir(), `tidy-update-plugin-client-cache-test-${Date.now()}-${Math.random()}`)
    await mkdir(root, {recursive: true})
    logStub = sinon.stub()
  })

  afterEach(async () => {
    await rm(root, {force: true, recursive: true})
  })

  const seedVersion = async (name: string): Promise<void> => {
    const dir = path.join(root, name)
    await mkdir(dir, {recursive: true})
    // Marker file proves rm succeeded when the dir is gone.
    await writeFile(path.join(dir, 'package.json'), '{}')
  }

  it('deletes stale version dirs but keeps the one pointed to by current', async () => {
    await seedVersion('3.12.0-aaa')
    await seedVersion('3.13.0-bbb')
    await seedVersion('3.14.0-ccc')
    await symlink('./3.14.0-ccc', path.join(root, 'current'))

    await tidyUpdatePluginClientCache({logFn: logStub, root})

    const remaining = await readdir(root)
    expect(remaining.sort()).to.deep.equal(['3.14.0-ccc', 'current'])
  })

  it('keeps the bin/ directory alongside current and active version', async () => {
    await seedVersion('3.13.0-aaa')
    await seedVersion('3.14.0-bbb')
    await mkdir(path.join(root, 'bin'))
    await writeFile(path.join(root, 'bin', 'brv'), '#!/bin/sh\n')
    await symlink('./3.14.0-bbb', path.join(root, 'current'))

    await tidyUpdatePluginClientCache({logFn: logStub, root})

    const remaining = await readdir(root)
    expect(remaining.sort()).to.deep.equal(['3.14.0-bbb', 'bin', 'current'])
  })

  it('no-ops when root does not exist', async () => {
    const missing = path.join(root, 'does-not-exist')

    await tidyUpdatePluginClientCache({logFn: logStub, root: missing})

    const parent = await readdir(root)
    expect(parent).to.deep.equal([])
  })

  it('no-ops when current symlink is missing (safety: cannot identify active)', async () => {
    await seedVersion('3.13.0-aaa')
    await seedVersion('3.14.0-bbb')

    await tidyUpdatePluginClientCache({logFn: logStub, root})

    const remaining = await readdir(root)
    expect(remaining.sort()).to.deep.equal(['3.13.0-aaa', '3.14.0-bbb'])
  })

  it('no-ops when current is a dangling symlink (safety: target does not exist)', async () => {
    await seedVersion('3.13.0-aaa')
    await seedVersion('3.14.0-bbb')
    await symlink('./3.99.0-ghost', path.join(root, 'current'))

    await tidyUpdatePluginClientCache({logFn: logStub, root})

    const remaining = await readdir(root)
    expect(remaining.sort()).to.deep.equal(['3.13.0-aaa', '3.14.0-bbb', 'current'])
  })

  it('no-ops when current is a regular file rather than a symlink', async () => {
    await seedVersion('3.13.0-aaa')
    await seedVersion('3.14.0-bbb')
    await writeFile(path.join(root, 'current'), '3.14.0-bbb')

    await tidyUpdatePluginClientCache({logFn: logStub, root})

    const remaining = await readdir(root)
    expect(remaining.sort()).to.deep.equal(['3.13.0-aaa', '3.14.0-bbb', 'current'])
  })

  it('does nothing when the only version dir is the active one', async () => {
    await seedVersion('3.14.0-ccc')
    await symlink('./3.14.0-ccc', path.join(root, 'current'))

    await tidyUpdatePluginClientCache({logFn: logStub, root})

    const remaining = await readdir(root)
    expect(remaining.sort()).to.deep.equal(['3.14.0-ccc', 'current'])
  })

  it('continues deleting other entries when one rm fails', async () => {
    await seedVersion('3.12.0-aaa')
    await seedVersion('3.13.0-bbb')
    await seedVersion('3.14.0-ccc')
    await symlink('./3.14.0-ccc', path.join(root, 'current'))

    const failingPath = path.join(root, '3.12.0-aaa')

    await tidyUpdatePluginClientCache({
      logFn: logStub,
      async rmFn(p) {
        if (p === failingPath) {
          throw new Error('simulated EACCES')
        }

        await rm(p, {force: true, recursive: true})
      },
      root,
    })

    const remaining = await readdir(root)
    expect(remaining.sort()).to.deep.equal(['3.12.0-aaa', '3.14.0-ccc', 'current'])
    expect(logStub.called).to.be.true
  })
})
