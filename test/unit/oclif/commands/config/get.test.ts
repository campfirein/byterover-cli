/**
 * Tests for the pure-function dispatcher inside `brv config get`. Mirrors
 * the set-side test pattern.
 */

import {expect} from 'chai'

import {applyConfigGet} from '../../../../../src/oclif/commands/config/get.js'
import {BrvConfig} from '../../../../../src/server/core/domain/entities/brv-config.js'

const validParams = {
  createdAt: '2026-05-26T00:00:00.000Z',
  cwd: '/tmp/project',
  version: '0.0.1',
}

describe('config get — applyConfigGet', () => {
  it("returns undefined when 'language.mode' is unset", () => {
    const config = new BrvConfig(validParams)
    const result = applyConfigGet(config, 'language.mode')
    expect(result.kind).to.equal('ok')
    if (result.kind === 'ok') {
      expect(result.value).to.be.undefined
    }
  })

  it("returns 'auto' when language.mode = auto", () => {
    const config = new BrvConfig({...validParams, language: {mode: 'auto'}})
    const result = applyConfigGet(config, 'language.mode')
    expect(result.kind).to.equal('ok')
    if (result.kind === 'ok') {
      expect(result.value).to.equal('auto')
    }
  })

  it("returns 'fixed' and the code when language is fully configured", () => {
    const config = new BrvConfig({...validParams, language: {code: 'ru', mode: 'fixed'}})
    expect((applyConfigGet(config, 'language.mode') as {value: string}).value).to.equal('fixed')
    expect((applyConfigGet(config, 'language.code') as {value: string}).value).to.equal('ru')
  })

  it("returns undefined for 'language.code' when language has only mode", () => {
    const config = new BrvConfig({...validParams, language: {mode: 'auto'}})
    const result = applyConfigGet(config, 'language.code')
    expect(result.kind).to.equal('ok')
    if (result.kind === 'ok') {
      expect(result.value).to.be.undefined
    }
  })

  it('rejects an unsupported key with a sorted supported-list', () => {
    const config = new BrvConfig(validParams)
    const result = applyConfigGet(config, 'unsupported.key')
    expect(result.kind).to.equal('error')
    if (result.kind === 'error') {
      expect(result.code).to.equal('unknown-key')
      expect(result.message).to.include('language.code')
      expect(result.message).to.include('language.mode')
    }
  })
})
