/**
 * Language-preservation clause for curate prompts.
 *
 * Single source of truth for the clause text. Every downstream injection
 * surface — `buildGeneratePrompt`, `buildCorrectionPrompt`, and the MCP
 * `brv-curate` tool description — imports `buildLanguageClause` and
 * emits the same string. A wording revision is a one-file change.
 *
 * Schema-key invariant: the clause must mention that tag names, attribute
 * names, attribute enum values, and `path` stay English. The element-
 * registry Zod schemas enforce this structurally at the writer boundary —
 * the clause mentions it so the calling agent's LLM doesn't burn a
 * correction round-trip authoring `<bv-решение>` or `path="безопасность/..."`
 * that would fail validation downstream.
 */

import type {BrvConfigLanguage} from '../entities/brv-config.js'

export {LANGUAGE_NAMES} from '../../../../shared/language/language-names.js'

import {LANGUAGE_NAMES as LANGUAGE_NAMES_LOCAL} from '../../../../shared/language/language-names.js'

const AUTO_CLAUSE =
  "Match the user's input language for human-readable content: body text of `<bv-*>` elements, list items, and the `title` / `summary` attributes on `<bv-topic>`. Keep tag names, attribute names, enum values, and the `path` attribute in English for tooling consistency. Code snippets and identifiers stay verbatim."

function buildFixedClause(languageName: string): string {
  return `Write all human-readable content (body text of \`<bv-*>\` elements, list items, \`title\` / \`summary\` attrs) in ${languageName}. Keep tag names, attribute names, enum values, and \`path\` in English. Code snippets and identifiers stay verbatim.`
}

/**
 * Return the language-preservation clause text for a config's language
 * preference.
 *
 * - `undefined` or `{mode: 'auto'}` → the auto clause: "match the user's
 *   input language".
 * - `{mode: 'fixed', code}` where `code` is in `LANGUAGE_NAMES` → the
 *   fixed clause referencing the mapped English name (e.g. "Russian").
 * - `{mode: 'fixed', code}` where `code` is unknown → the fixed clause
 *   with the raw code in double quotes (e.g. `in "xx"`). Degrades
 *   gracefully so a future ISO code we haven't mapped yet still produces
 *   a usable clause.
 *
 * `{mode: 'fixed'}` without `code` is rejected by `isBrvConfigJson` at
 * load time and cannot reach here under normal operation; the function
 * still defends against it by returning the auto clause rather than
 * throwing — a malformed config should degrade, not crash a write path.
 */
export function buildLanguageClause(language?: BrvConfigLanguage): string {
  if (language === undefined || language.mode === 'auto') {
    return AUTO_CLAUSE
  }

  if (language.code === undefined) {
    return AUTO_CLAUSE
  }

  const name = LANGUAGE_NAMES_LOCAL[language.code] ?? `"${language.code}"`
  return buildFixedClause(name)
}
