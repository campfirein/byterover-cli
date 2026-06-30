/**
 * Tests for `tokenizeWithCjk` — the BM25 tokenizer that fixes MiniSearch's
 * CJK blind spot.
 *
 * Whitespace-separated scripts (Latin, Cyrillic, Vietnamese, …) must
 * tokenize byte-identical to the MiniSearch default; CJK runs must emit
 * overlapping bigrams; mixed Latin+CJK tokens must split at the script
 * boundary so the Latin portion stays a real word token. The integration
 * block at the end exercises the wired-up MiniSearch contract — the CJK
 * gate — and confirms English scoring is preserved.
 */

import {expect} from 'chai'
import MiniSearch from 'minisearch'

import {tokenizeWithCjk} from '../../../../../../src/agent/infra/tools/implementations/cjk-tokenizer.js'

function buildMiniSearchIndex(docs: Array<{id: number; t: string}>): MiniSearch {
  const ms = new MiniSearch({
    fields: ['t'],
    idField: 'id',
    tokenize: tokenizeWithCjk,
  })
  ms.addAll(docs)
  return ms
}

describe('cjk-tokenizer', () => {
  describe('tokenizeWithCjk — non-CJK scripts behave like the MiniSearch default', () => {
    it('English: splits on whitespace, preserves word tokens verbatim', () => {
      expect(tokenizeWithCjk('Hello world JWT auth')).to.deep.equal([
        'Hello', 'world', 'JWT', 'auth',
      ])
    })

    it('Russian (Cyrillic): preserves whitespace tokenization, no CJK side effects', () => {
      expect(tokenizeWithCjk('Привет мир программирования')).to.deep.equal([
        'Привет', 'мир', 'программирования',
      ])
    })

    it('Vietnamese (Latin-non-English): diacritics survive intact', () => {
      // The proof point that LLM-in-call detection beats a Unicode-block
      // heuristic — Vietnamese is Latin script and tokenizes via whitespace
      // just like English. Diacritics are part of the word, not separators.
      expect(tokenizeWithCjk('Cách triển khai xác thực')).to.deep.equal([
        'Cách', 'triển', 'khai', 'xác', 'thực',
      ])
    })

    it('punctuation acts as a separator (matches MiniSearch default)', () => {
      // Default MiniSearch splits on `\p{Z}\p{P}+`; commas, periods, parens
      // all become token boundaries.
      expect(tokenizeWithCjk('one, two; three.')).to.deep.equal(['one', 'two', 'three'])
    })
  })

  describe('tokenizeWithCjk — CJK scripts emit overlapping bigrams', () => {
    it('Chinese: 4-character run → 3 overlapping bigrams', () => {
      expect(tokenizeWithCjk('认证系统')).to.deep.equal(['认证', '证系', '系统'])
    })

    it('Chinese: 2-character run → single bigram (the whole token)', () => {
      expect(tokenizeWithCjk('认证')).to.deep.equal(['认证'])
    })

    it('Japanese: kanji + katakana both segmented as CJK', () => {
      // `認証システム` contains both kanji (`認証`) and katakana
      // (`システム`). The tokenizer treats them as a single CJK run since
      // both ranges are CJK-classified, producing overlapping bigrams
      // across the whole string.
      const tokens = tokenizeWithCjk('認証システム')
      expect(tokens).to.deep.include('認証')
      expect(tokens).to.deep.include('証シ')
      expect(tokens).to.deep.include('シス')
      expect(tokens).to.deep.include('ステ')
      expect(tokens).to.deep.include('テム')
    })

    it('Korean (Hangul Syllables): segmented into bigrams', () => {
      // Whitespace-separated Korean tokens still bigram within each token.
      // `'인증 시스템'` → `'인증'` (single bigram == whole token) plus
      // bigrams of `'시스템'` (`'시스'`, `'스템'`).
      const tokens = tokenizeWithCjk('인증 시스템')
      expect(tokens).to.deep.include('인증')
      expect(tokens).to.deep.include('시스')
      expect(tokens).to.deep.include('스템')
    })

    it('single-character CJK input falls back to unigram', () => {
      // Edge case for BM25 — a lone character has no bigram, but should
      // still be searchable as itself. The unigram fallback prevents the
      // tokenizer from emitting an empty array (which MiniSearch would
      // interpret as "this document has no content for this field").
      expect(tokenizeWithCjk('认')).to.deep.equal(['认'])
    })
  })

  describe('tokenizeWithCjk — mixed Latin + CJK tokens split at the script boundary', () => {
    it('whitespace-separated Latin and CJK tokens stay independent', () => {
      // `'JWT 令牌'` is already two whitespace-separated tokens. Latin
      // stays Latin, the 2-char CJK run emits one bigram (the whole thing).
      expect(tokenizeWithCjk('JWT 令牌')).to.deep.equal(['JWT', '令牌'])
    })

    it('no-whitespace mixed token splits at the script boundary', () => {
      // `'JWT令牌'` has no whitespace — but the script boundary between
      // 'T' (Latin) and '令' (CJK) is still a token boundary. Otherwise
      // the Latin portion would get lost in a CJK bigram smear.
      expect(tokenizeWithCjk('JWT令牌')).to.deep.equal(['JWT', '令牌'])
    })

    it('multiple boundaries in one token: alternating Latin/CJK runs', () => {
      // `'API请求JSON响应'` → Latin/CJK/Latin/CJK boundaries.
      // Each non-CJK run stays as one token; each CJK run emits bigrams.
      expect(tokenizeWithCjk('API请求JSON响应')).to.deep.equal([
        'API',
        '请求',
        'JSON',
        '响应',
      ])
    })
  })

  describe('MiniSearch integration — the CJK gate', () => {
    // The unit tests above lock the tokenizer's input/output contract.
    // These integration tests prove the contract holds when the tokenizer
    // is wired into a real MiniSearch instance — what
    // `search-knowledge-service.ts:MINISEARCH_OPTIONS` does in production.

    it('Chinese query matches Chinese content (was broken before this fix)', () => {
      // The motivating test. Pre-fix: empirical run returned [] because
      // `'认证系统使用JWT令牌'` tokenized as a single token under the
      // MiniSearch default. With the bigram tokenizer, the query `'认证'`
      // tokenizes to ['认证'] and finds doc 1's `'认证'` bigram.
      const ms = buildMiniSearchIndex([
        {id: 1, t: '认证系统使用JWT令牌'},
        {id: 2, t: 'JWT auth tokens'},
      ])
      const results = ms.search('认证')
      expect(results.length, 'Chinese query returns at least one match').to.be.greaterThan(0)
      expect(results[0].id).to.equal(1)
    })

    it('Japanese query matches Japanese content', () => {
      const ms = buildMiniSearchIndex([{id: 1, t: '認証システムはJWTトークンを使用'}])
      const results = ms.search('認証')
      expect(results.length).to.be.greaterThan(0)
    })

    it('Korean query matches Korean content', () => {
      const ms = buildMiniSearchIndex([{id: 1, t: '인증 시스템은 JWT 토큰을 사용합니다'}])
      const results = ms.search('인증')
      expect(results.length).to.be.greaterThan(0)
    })

    it('Russian query matches Russian content (regression, was working pre-fix)', () => {
      // Cyrillic is whitespace-separated → the default tokenizer already
      // handled it. Locking the regression so a future tokenizer rewrite
      // doesn't accidentally break a script that used to work.
      const ms = buildMiniSearchIndex([{id: 1, t: 'Привет мир программирования'}])
      const results = ms.search('программирования')
      expect(results.length).to.be.greaterThan(0)
    })

    it('English query against English content returns the expected match', () => {
      // Sanity check: the Latin path is byte-identical to the default
      // MiniSearch behavior, so the existing BM25 ranking story is
      // preserved end-to-end.
      const ms = buildMiniSearchIndex([
        {id: 1, t: 'JWT authentication tokens'},
        {id: 2, t: 'session cookies and CSRF'},
      ])
      const results = ms.search('JWT')
      expect(results.length).to.equal(1)
      expect(results[0].id).to.equal(1)
    })

    it('English query does NOT match unrelated CJK content', () => {
      // Cross-script isolation: a CJK doc shouldn't drag into English
      // queries (and vice versa). The bigram tokenization is opaque to
      // Latin queries; no false positives leak across scripts.
      const ms = buildMiniSearchIndex([
        {id: 1, t: '认证系统'},
        {id: 2, t: 'JWT authentication'},
      ])
      const englishResults = ms.search('JWT')
      expect(englishResults.length).to.equal(1)
      expect(englishResults[0].id).to.equal(2)
    })
  })
})
