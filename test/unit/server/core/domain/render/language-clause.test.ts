/**
 * Tests for buildLanguageClause and the LANGUAGE_NAMES map.
 *
 * The clause is load-bearing for the language-selection feature — every
 * downstream injection surface (kickoff prompt, correction prompt, MCP
 * tool description) emits this exact string. The "schema-key invariant"
 * test below is the contract the clause must hold so that LLM authoring
 * doesn't drift into translating tag names / enum values, which would
 * fail Zod validation at the writer boundary.
 */

import {expect} from 'chai'

import {buildLanguageClause, LANGUAGE_NAMES} from '../../../../../../src/server/core/domain/render/language-clause.js'

describe('language-clause', () => {
  describe('LANGUAGE_NAMES', () => {
    it('includes Russian (the #616 reporter language)', () => {
      expect(LANGUAGE_NAMES.ru).to.equal('Russian')
    })

    it('includes the four scripts covered by the validation matrix', () => {
      expect(LANGUAGE_NAMES.vi).to.equal('Vietnamese')
      expect(LANGUAGE_NAMES.zh).to.equal('Chinese')
      expect(LANGUAGE_NAMES.ja).to.equal('Japanese')
    })

    it('includes English so the CLI accepts the restoration code', () => {
      // Release notes recommend `language: { mode: 'fixed', code: 'en' }`
      // as the opt-out path for users who want forced English. The CLI
      // (commit 05) rejects codes not in this map, so `en` must be here.
      expect(LANGUAGE_NAMES.en).to.equal('English')
    })
  })

  describe('buildLanguageClause', () => {
    it('returns the auto clause when language is undefined', () => {
      const clause = buildLanguageClause()
      expect(clause).to.include("Match the user's input language")
    })

    it('returns the auto clause when mode is auto', () => {
      const clause = buildLanguageClause({mode: 'auto'})
      expect(clause).to.include("Match the user's input language")
    })

    it('returns the fixed clause with mapped English name for a known code', () => {
      const clause = buildLanguageClause({code: 'ru', mode: 'fixed'})
      expect(clause).to.include('in Russian')
    })

    it('returns the fixed clause for Chinese (CJK)', () => {
      const clause = buildLanguageClause({code: 'zh', mode: 'fixed'})
      expect(clause).to.include('in Chinese')
    })

    it('returns the fixed clause for Vietnamese (Latin-non-English)', () => {
      const clause = buildLanguageClause({code: 'vi', mode: 'fixed'})
      expect(clause).to.include('in Vietnamese')
    })

    it('falls back to the raw code in quotes for an unknown ISO code', () => {
      // Forward-compat: a future code we haven't mapped yet still
      // produces a usable clause. Degrades to `in "xx"` rather than
      // failing the entire prompt build.
      const clause = buildLanguageClause({code: 'xx', mode: 'fixed'})
      expect(clause).to.include('in "xx"')
    })

    it('degrades to auto when fixed-mode arrives without a code', () => {
      // `isBrvConfigJson` rejects this shape at load time; the function
      // defends against the case anyway so a malformed config degrades
      // rather than crashing a write path.
      const clause = buildLanguageClause({mode: 'fixed'})
      expect(clause).to.include("Match the user's input language")
    })

    it('every clause variant mentions the schema-key invariant', () => {
      // Load-bearing — if the clause is loose enough that this assertion
      // fails, the LLM may translate tag names like `<bv-decision>` to a
      // localized form, which fails Zod validation downstream.
      const auto = buildLanguageClause()
      const fixedKnown = buildLanguageClause({code: 'ru', mode: 'fixed'})
      const fixedUnknown = buildLanguageClause({code: 'xx', mode: 'fixed'})

      for (const clause of [auto, fixedKnown, fixedUnknown]) {
        expect(clause).to.include('tag names')
        expect(clause).to.include('attribute names')
        expect(clause).to.include('enum values')
        expect(clause).to.include('`path`')
      }
    })

    it('all clauses preserve code snippets verbatim', () => {
      const auto = buildLanguageClause()
      const fixed = buildLanguageClause({code: 'ru', mode: 'fixed'})

      expect(auto).to.include('Code snippets and identifiers stay verbatim')
      expect(fixed).to.include('Code snippets and identifiers stay verbatim')
    })
  })
})
