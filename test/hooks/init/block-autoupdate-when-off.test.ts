import {expect} from 'chai'
import {mkdtempSync, rmSync, writeFileSync} from 'node:fs'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import * as sinon from 'sinon'

import {handleBlockAutoupdateWhenOff} from '../../../src/oclif/hooks/init/block-autoupdate-when-off.js'

describe('block-autoupdate-when-off hook (T7)', () => {
  let tempDir: string
  let priorBrvDataDir: string | undefined
  let exitStub: sinon.SinonStub<[number], never>

  beforeEach(() => {
    priorBrvDataDir = process.env.BRV_DATA_DIR
    tempDir = mkdtempSync(join(tmpdir(), 'brv-blockauto-'))
    process.env.BRV_DATA_DIR = tempDir
    exitStub = sinon.stub<[number], never>()
  })

  afterEach(() => {
    rmSync(tempDir, {force: true, recursive: true})
    if (priorBrvDataDir === undefined) delete process.env.BRV_DATA_DIR
    else process.env.BRV_DATA_DIR = priorBrvDataDir
    sinon.restore()
  })

  function writeSetting(value: boolean): void {
    writeFileSync(
      join(tempDir, 'settings.json'),
      JSON.stringify({values: {'update.checkForUpdates': value}, version: '2'}),
    )
  }

  it('exits silently when commandId=update + --autoupdate flag + setting off', () => {
    writeSetting(false)
    handleBlockAutoupdateWhenOff({argv: ['--autoupdate'], commandId: 'update', exitFn: exitStub})
    expect(exitStub.calledOnce).to.equal(true)
    expect(exitStub.firstCall.args[0]).to.equal(0)
  })

  it('does NOT exit when commandId=update + --autoupdate flag + setting ON', () => {
    writeSetting(true)
    handleBlockAutoupdateWhenOff({argv: ['--autoupdate'], commandId: 'update', exitFn: exitStub})
    expect(exitStub.called).to.equal(false)
  })

  it('does NOT exit when commandId=update + --autoupdate flag + setting missing (default true)', () => {
    handleBlockAutoupdateWhenOff({argv: ['--autoupdate'], commandId: 'update', exitFn: exitStub})
    expect(exitStub.called).to.equal(false)
  })

  it('does NOT exit when commandId=update WITHOUT --autoupdate flag (manual update)', () => {
    writeSetting(false)
    handleBlockAutoupdateWhenOff({argv: [], commandId: 'update', exitFn: exitStub})
    expect(exitStub.called).to.equal(false)
  })

  it('does NOT exit when commandId is something else, even with --autoupdate in argv', () => {
    writeSetting(false)
    handleBlockAutoupdateWhenOff({argv: ['--autoupdate'], commandId: 'status', exitFn: exitStub})
    expect(exitStub.called).to.equal(false)
  })

  it('does NOT exit when commandId is undefined', () => {
    writeSetting(false)
    handleBlockAutoupdateWhenOff({argv: ['--autoupdate'], commandId: undefined, exitFn: exitStub})
    expect(exitStub.called).to.equal(false)
  })

  it('matches the flag even when it appears alongside other argv entries', () => {
    writeSetting(false)
    handleBlockAutoupdateWhenOff({argv: ['--verbose', '--autoupdate', '--foo'], commandId: 'update', exitFn: exitStub})
    expect(exitStub.calledOnce).to.equal(true)
  })
})
