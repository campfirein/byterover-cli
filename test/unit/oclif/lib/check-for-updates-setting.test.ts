import {expect} from 'chai'
import {mkdirSync, mkdtempSync, rmSync, writeFileSync} from 'node:fs'
import {tmpdir} from 'node:os'
import {join} from 'node:path'

import {checkForUpdatesSetting} from '../../../../src/oclif/lib/check-for-updates-setting.js'

describe('checkForUpdatesSetting (T7)', () => {
  let tempDir: string
  let priorBrvDataDir: string | undefined

  beforeEach(() => {
    priorBrvDataDir = process.env.BRV_DATA_DIR
    tempDir = mkdtempSync(join(tmpdir(), 'brv-checkforupdates-'))
    process.env.BRV_DATA_DIR = tempDir
  })

  afterEach(() => {
    rmSync(tempDir, {force: true, recursive: true})
    if (priorBrvDataDir === undefined) delete process.env.BRV_DATA_DIR
    else process.env.BRV_DATA_DIR = priorBrvDataDir
  })

  it('returns true (default) when the settings file is missing', () => {
    expect(checkForUpdatesSetting()).to.equal(true)
  })

  it('returns true when the settings file exists but the key is absent', () => {
    writeFileSync(join(tempDir, 'settings.json'), JSON.stringify({values: {'agentPool.maxSize': 25}, version: '2'}))
    expect(checkForUpdatesSetting()).to.equal(true)
  })

  it('returns true when the key is explicitly set to true', () => {
    writeFileSync(
      join(tempDir, 'settings.json'),
      JSON.stringify({values: {'update.checkForUpdates': true}, version: '2'}),
    )
    expect(checkForUpdatesSetting()).to.equal(true)
  })

  it('returns false when the key is explicitly set to false', () => {
    writeFileSync(
      join(tempDir, 'settings.json'),
      JSON.stringify({values: {'update.checkForUpdates': false}, version: '2'}),
    )
    expect(checkForUpdatesSetting()).to.equal(false)
  })

  it('returns true (fallback) when the file is invalid JSON', () => {
    writeFileSync(join(tempDir, 'settings.json'), 'this is not json')
    expect(checkForUpdatesSetting()).to.equal(true)
  })

  it('returns true (fallback) when the top-level JSON is not an object', () => {
    writeFileSync(join(tempDir, 'settings.json'), JSON.stringify([1, 2, 3]))
    expect(checkForUpdatesSetting()).to.equal(true)
  })

  it('returns true (fallback) when values is not an object', () => {
    writeFileSync(join(tempDir, 'settings.json'), JSON.stringify({values: 'not-an-object', version: '2'}))
    expect(checkForUpdatesSetting()).to.equal(true)
  })

  it('returns true (fallback) when the value is the wrong type (string)', () => {
    writeFileSync(
      join(tempDir, 'settings.json'),
      JSON.stringify({values: {'update.checkForUpdates': 'no'}, version: '2'}),
    )
    expect(checkForUpdatesSetting()).to.equal(true)
  })

  it('reads from a v1 file the same way (key may or may not exist)', () => {
    writeFileSync(
      join(tempDir, 'settings.json'),
      JSON.stringify({values: {'update.checkForUpdates': false}, version: '1'}),
    )
    expect(checkForUpdatesSetting()).to.equal(false)
  })

  it('falls back to true when BRV_DATA_DIR points to a non-existent directory', () => {
    const missing = join(tempDir, 'does-not-exist')
    process.env.BRV_DATA_DIR = missing
    // sanity: nothing on disk
    expect(() => mkdirSync(missing)).to.not.throw()
    rmSync(missing, {force: true, recursive: true})
    expect(checkForUpdatesSetting()).to.equal(true)
  })
})
