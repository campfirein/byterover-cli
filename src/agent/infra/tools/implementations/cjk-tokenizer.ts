/**
 * BM25 tokenizer with CJK bigram segmentation.
 *
 * MiniSearch 7.2.0's default tokenizer splits on `\p{Z}\p{P}` (Unicode
 * whitespace + punctuation). Latin / Cyrillic / Vietnamese / European
 * scripts use whitespace between words and tokenize correctly. CJK scripts
 * do not — a sentence like `认证系统使用JWT令牌` becomes a single token,
 * so a query for `认证` against indexed CJK content returns zero matches.
 *
 * Empirical confirmation before this fix (MiniSearch 7.2.0):
 *
 *   const ms = new MiniSearch({fields: ['t'], idField: 'id'})
 *   ms.addAll([{id: 1, t: '认证系统使用JWT令牌'}])
 *   ms.search('认证')           // → [] — broken
 *   ms.search('Привет мир')   // → matches as expected
 *
 * This tokenizer preserves the default behavior for whitespace-separated
 * scripts and adds overlapping-bigram segmentation for CJK runs. Mixed
 * Latin+CJK tokens (e.g. `JWT令牌`) split at the script boundary so the
 * Latin portion stays a real word token.
 *
 * Wired via the top-level `tokenize` option on MiniSearch — per the
 * library docs and source (`MiniSearch.js:1564-1566`), that single option
 * applies at both index and query time unless `searchOptions.tokenize`
 * is set, which we leave unset.
 */

/**
 * Unicode ranges treated as CJK for the purposes of bigram segmentation.
 * Anything outside these ranges is "non-CJK" and tokenizes by whitespace
 * boundaries only.
 *
 * - `0x4E00–0x9FFF`: CJK Unified Ideographs (Chinese, Japanese kanji)
 * - `0x3040–0x309F`: Hiragana
 * - `0x30A0–0x30FF`: Katakana
 * - `0xAC00–0xD7AF`: Hangul Syllables (Korean)
 *
 * CJK Extension A/B/C/… are deliberately excluded — they appear in academic
 * / historical text but rarely in user content. If a user's corpus needs
 * them, extend this list and bump `INDEX_SCHEMA_VERSION` in
 * `search-knowledge-service.ts` so cached indexes invalidate.
 */
const CJK_RANGES: ReadonlyArray<readonly [number, number]> = [
  [0x4E_00, 0x9F_FF],
  [0x30_40, 0x30_9F],
  [0x30_A0, 0x30_FF],
  [0xAC_00, 0xD7_AF],
]

function isCjkCodePoint(cp: number): boolean {
  for (const [lo, hi] of CJK_RANGES) {
    if (cp >= lo && cp <= hi) return true
  }

  return false
}

/**
 * Whitespace + punctuation split, matching MiniSearch's default
 * `SPACE_OR_PUNCTUATION` regex. Kept verbatim so a future upstream tweak
 * is easy to spot via diff.
 */
const SPACE_OR_PUNCTUATION = /[\p{Z}\p{P}]+/u

/**
 * Split a token at boundaries between CJK and non-CJK runs.
 *
 * - `'JWT令牌'`  → `['JWT', '令牌']` (script boundary at index 3)
 * - `'认证'`     → `['认证']`        (single CJK run)
 * - `'JWT'`      → `['JWT']`          (single non-CJK run)
 */
function splitAtCjkBoundary(token: string): string[] {
  const segments: string[] = []
  let current = ''
  let currentIsCjk: boolean | undefined

  // Iterate by code point so any future range extension into the
  // supplementary plane handles surrogate pairs correctly. The current
  // four ranges are all BMP, so `for...of` is equivalent to char-by-char
  // here — but cheap to be correct.
  for (const ch of token) {
    const cp = ch.codePointAt(0)
    if (cp === undefined) continue
    const charIsCjk = isCjkCodePoint(cp)

    if (currentIsCjk === undefined) {
      current = ch
      currentIsCjk = charIsCjk
    } else if (charIsCjk === currentIsCjk) {
      current += ch
    } else {
      segments.push(current)
      current = ch
      currentIsCjk = charIsCjk
    }
  }

  if (current.length > 0) segments.push(current)

  return segments
}

/**
 * Emit overlapping bigrams for a CJK run.
 *
 * - `'认证系统'` (4 chars) → `['认证', '证系', '系统']`
 * - `'认证'`     (2 chars) → `['认证']`
 * - `'认'`       (1 char)  → `['认']` (unigram fallback so single-char tokens are searchable)
 *
 * Bigrams are the standard CJK IR compromise: unigrams are too noisy
 * (common chars like `的` dominate scoring), trigrams are too sparse
 * (miss 2-character compound matches).
 */
function cjkBigrams(run: string): string[] {
  const chars = [...run]
  if (chars.length <= 1) return chars

  const grams: string[] = []
  for (let i = 0; i < chars.length - 1; i++) {
    grams.push(chars[i] + chars[i + 1])
  }

  return grams
}

/**
 * Tokenize text for BM25 indexing and querying.
 *
 * Algorithm:
 *   1. Split on Unicode whitespace + punctuation (matches MiniSearch default).
 *   2. For each resulting token, split at CJK ↔ non-CJK script boundaries.
 *   3. For non-CJK segments, emit the segment as-is.
 *   4. For CJK segments, emit overlapping bigrams.
 *
 * The result is the union — Latin / Cyrillic / Vietnamese behave exactly
 * as the MiniSearch default, while CJK runs become searchable.
 */
export function tokenizeWithCjk(text: string): string[] {
  const out: string[] = []

  for (const wsToken of text.split(SPACE_OR_PUNCTUATION)) {
    if (wsToken.length === 0) continue

    for (const segment of splitAtCjkBoundary(wsToken)) {
      if (segment.length === 0) continue

      // `splitAtCjkBoundary` returns single-script segments, so the
      // first code point's classification applies to the whole segment.
      const firstCp = segment.codePointAt(0)
      if (firstCp !== undefined && isCjkCodePoint(firstCp)) {
        out.push(...cjkBigrams(segment))
      } else {
        out.push(segment)
      }
    }
  }

  return out
}
