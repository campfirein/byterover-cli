/**
 * Tests for the pure-function dispatcher inside `brv config set`. The oclif
 * wrapper handles arg parsing + filesystem I/O; this suite asserts the
 * validation + transformation contract that backs every call.
 */

import {expect} from 'chai'

import {applyConfigSet} from '../../../../../src/oclif/commands/config/set.js'
import {BrvConfig} from '../../../../../src/server/core/domain/entities/brv-config.js'

const validParams = {
  createdAt: '2026-05-26T00:00:00.000Z',
  cwd: '/tmp/project',
  version: '0.0.1',
}

describe('config set — applyConfigSet', () => {
  describe('language.mode', () => {
    it("accepts 'auto' and clears the code-defaulted shape", () => {
      const config = new BrvConfig(validParams)
      const result = applyConfigSet(config, 'language.mode', 'auto')
      expect(result.kind).to.equal('ok')
      if (result.kind === 'ok') {
        expect(result.config.language).to.deep.equal({mode: 'auto'})
      }
    })

    it("accepts 'auto' and preserves an existing code", () => {
      // Switching from fixed back to auto keeps the code on disk (it's
      // vestigial in auto mode but harmless, and makes a future switch
      // back to fixed a one-command re-activation).
      const config = new BrvConfig({...validParams, language: {code: 'ru', mode: 'fixed'}})
      const result = applyConfigSet(config, 'language.mode', 'auto')
      expect(result.kind).to.equal('ok')
      if (result.kind === 'ok') {
        expect(result.config.language).to.deep.equal({code: 'ru', mode: 'auto'})
      }
    })

    it("accepts 'fixed' when code is already set", () => {
      const config = new BrvConfig({...validParams, language: {code: 'ru', mode: 'auto'}})
      const result = applyConfigSet(config, 'language.mode', 'fixed')
      expect(result.kind).to.equal('ok')
      if (result.kind === 'ok') {
        expect(result.config.language).to.deep.equal({code: 'ru', mode: 'fixed'})
      }
    })

    it("rejects 'fixed' when no code is set, with a redirect message", () => {
      // The on-disk config `{language: {mode: 'fixed'}}` would be rejected
      // by `isBrvConfigJson` on next load. Reject here so we never write it.
      const config = new BrvConfig(validParams)
      const result = applyConfigSet(config, 'language.mode', 'fixed')
      expect(result.kind).to.equal('error')
      if (result.kind === 'error') {
        expect(result.code).to.equal('missing-language-code')
        expect(result.message).to.include('brv config set language.code')
      }
    })

    it("rejects unknown mode values", () => {
      const config = new BrvConfig(validParams)
      const result = applyConfigSet(config, 'language.mode', 'always-english')
      expect(result.kind).to.equal('error')
      if (result.kind === 'error') {
        expect(result.code).to.equal('invalid-value')
        expect(result.message).to.include("must be 'auto' or 'fixed'")
      }
    })
  })

  describe('language.code', () => {
    it('accepts a known ISO code; defaults mode to auto when language was unset', () => {
      const config = new BrvConfig(validParams)
      const result = applyConfigSet(config, 'language.code', 'ru')
      expect(result.kind).to.equal('ok')
      if (result.kind === 'ok') {
        expect(result.config.language).to.deep.equal({code: 'ru', mode: 'auto'})
      }
    })

    it('preserves an existing fixed mode when updating code', () => {
      // Switching the active fixed language is a one-line operation:
      // `brv config set language.code zh`. Mode stays fixed.
      const config = new BrvConfig({...validParams, language: {code: 'ru', mode: 'fixed'}})
      const result = applyConfigSet(config, 'language.code', 'zh')
      expect(result.kind).to.equal('ok')
      if (result.kind === 'ok') {
        expect(result.config.language).to.deep.equal({code: 'zh', mode: 'fixed'})
      }
    })

    it('rejects unknown ISO codes with a sorted supported-list message', () => {
      const config = new BrvConfig(validParams)
      const result = applyConfigSet(config, 'language.code', 'xx')
      expect(result.kind).to.equal('error')
      if (result.kind === 'error') {
        expect(result.code).to.equal('unknown-iso-code')
        expect(result.message).to.include("'xx'")
        expect(result.message).to.include('Supported codes:')
        // Sanity: a few representative codes appear in the suggestion list.
        expect(result.message).to.include('en')
        expect(result.message).to.include('ru')
        expect(result.message).to.include('zh')
      }
    })

    it('accepts English so the restoration recipe works', () => {
      // The release-notes recipe instructs users to set `code: en` for
      // forced-English mode. The CLI must accept it.
      const config = new BrvConfig(validParams)
      const result = applyConfigSet(config, 'language.code', 'en')
      expect(result.kind).to.equal('ok')
      if (result.kind === 'ok') {
        expect(result.config.language).to.deep.equal({code: 'en', mode: 'auto'})
      }
    })
  })

  describe('unknown key', () => {
    it('rejects an unsupported key with a sorted supported-list message', () => {
      const config = new BrvConfig(validParams)
      const result = applyConfigSet(config, 'language.unknown', 'whatever')
      expect(result.kind).to.equal('error')
      if (result.kind === 'error') {
        expect(result.code).to.equal('unknown-key')
        expect(result.message).to.include('language.code')
        expect(result.message).to.include('language.mode')
      }
    })

    it('rejects a totally unrelated key', () => {
      const config = new BrvConfig(validParams)
      const result = applyConfigSet(config, 'cipherAgent.context', 'whatever')
      expect(result.kind).to.equal('error')
      if (result.kind === 'error') {
        expect(result.code).to.equal('unknown-key')
      }
    })
  })

  describe('restoration recipe — forced English', () => {
    it('two-step set produces {mode: fixed, code: en}', () => {
      // Mirrors what release notes recommend for users who want the old
      // implicit-English behavior. Set code first, then flip mode.
      const initial = new BrvConfig(validParams)
      const afterCode = applyConfigSet(initial, 'language.code', 'en')
      expect(afterCode.kind).to.equal('ok')
      if (afterCode.kind !== 'ok') return
      const afterMode = applyConfigSet(afterCode.config, 'language.mode', 'fixed')
      expect(afterMode.kind).to.equal('ok')
      if (afterMode.kind === 'ok') {
        expect(afterMode.config.language).to.deep.equal({code: 'en', mode: 'fixed'})
      }
    })
  })
})
