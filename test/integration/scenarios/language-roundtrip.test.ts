/**
 * Full-pipeline integration test for the language-selection feature.
 *
 * Walks `.brv/config.json` on disk → `ProjectConfigStore.read()` →
 * `BrvConfig.language` → `kickoffSession()` → the kickoff prompt envelope
 * the calling agent's LLM consumes. Proves the threading hasn't broken
 * at any layer for the four target non-English scripts (Russian /
 * Vietnamese / Chinese / Japanese) plus the default auto-mode.
 *
 * Unit tests cover each layer in isolation:
 *   - `language-clause.test.ts` — clause text emission
 *   - `brv-config.test.ts` — schema round-trip
 *   - `curate-prompt-builder.test.ts` — clause appears in the prompt
 *   - `curate-session.test.ts` — orchestrator threading
 *
 * This file proves the layers compose end-to-end against a real config
 * file on disk — the legacy per-project fallback tier of
 * `resolveLanguagePreference`. The canonical write surface is now
 * `brv settings set language.code <iso>`; this test still exercises the
 * `.brv/config.json` fallback used by mid-migration users.
 *
 * Out of scope: actual LLM-honoring of the clause. That requires a real
 * calling agent (Claude Code, Cursor) and is validated manually pre-release.
 * The on-the-wire prompt content is what we can test deterministically here.
 */

import {expect} from 'chai'
import {existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync} from 'node:fs'
import {tmpdir} from 'node:os'
import {join} from 'node:path'

import {kickoffSession} from '../../../src/oclif/lib/curate-session.js'
import {BRV_CONFIG_VERSION, BRV_DIR, PROJECT_CONFIG_FILE} from '../../../src/server/constants.js'
import {ProjectConfigStore} from '../../../src/server/infra/config/file-config-store.js'

describe('language-roundtrip — config file → BrvConfig → kickoff prompt', () => {
  let projectRoot: string

  beforeEach(() => {
    projectRoot = mkdtempSync(join(tmpdir(), 'lang-roundtrip-'))
    mkdirSync(join(projectRoot, BRV_DIR), {recursive: true})
  })

  afterEach(() => {
    if (existsSync(projectRoot)) rmSync(projectRoot, {force: true, recursive: true})
  })

  function writeProjectConfig(language?: {code?: string; mode: 'auto' | 'fixed'}): void {
    const config = {
      createdAt: '2026-05-26T00:00:00.000Z',
      cwd: projectRoot,
      ...(language !== undefined && {language}),
      version: BRV_CONFIG_VERSION,
    }
    writeFileSync(join(projectRoot, BRV_DIR, PROJECT_CONFIG_FILE), JSON.stringify(config, undefined, 2), 'utf8')
  }

  async function kickoffWithProjectConfig(): ReturnType<typeof kickoffSession> {
    const config = await new ProjectConfigStore().read(projectRoot)
    return kickoffSession({content: 'remember X', language: config?.language, projectRoot})
  }

  describe('auto mode (default)', () => {
    it('default config without a language field emits the auto clause', async () => {
      writeProjectConfig()
      const envelope = await kickoffWithProjectConfig()
      // Match the user's input language — the auto wording from language-clause.ts.
      // This is the modal path: every existing `.brv/config.json` predates the
      // feature, so the default must be a no-op for English users and a graceful
      // pass-through for non-English users.
      expect(envelope.prompt).to.include("Match the user's input language")
    })

    it('explicit `mode: auto` config emits the auto clause', async () => {
      writeProjectConfig({mode: 'auto'})
      const envelope = await kickoffWithProjectConfig()
      expect(envelope.prompt).to.include("Match the user's input language")
    })
  })

  describe('fixed mode — clause names the user-configured language', () => {
    it('Russian (Cyrillic) — `code: ru` emits "in Russian"', async () => {
      // The #616 reporter is a Russian user. This is the load-bearing path
      // for closing the issue end-to-end: a real config on disk, read via
      // the real loader, threaded through the real orchestrator, lands in
      // the prompt the calling agent's LLM sees.
      writeProjectConfig({code: 'ru', mode: 'fixed'})
      const envelope = await kickoffWithProjectConfig()
      expect(envelope.prompt).to.include('in Russian')
      expect(envelope.prompt).to.not.include("Match the user's input language")
    })

    it('Vietnamese (Latin-non-English) — `code: vi` emits "in Vietnamese"', async () => {
      // The proof point for LLM-in-call detection beating a Unicode-block
      // heuristic. Vietnamese is Latin script with diacritics, indistinguishable
      // from English by code-range alone.
      writeProjectConfig({code: 'vi', mode: 'fixed'})
      const envelope = await kickoffWithProjectConfig()
      expect(envelope.prompt).to.include('in Vietnamese')
    })

    it('Chinese (CJK kanji) — `code: zh` emits "in Chinese"', async () => {
      // CJK kanji — ENG-2689's tokenizer fix makes the search side searchable
      // for content authored under this clause. This test is the curate-side
      // equivalent: the calling agent's prompt explicitly names Chinese.
      writeProjectConfig({code: 'zh', mode: 'fixed'})
      const envelope = await kickoffWithProjectConfig()
      expect(envelope.prompt).to.include('in Chinese')
    })

    it('Japanese (CJK kanji + kana) — `code: ja` emits "in Japanese"', async () => {
      // Second CJK script. Hiragana / Katakana / Kanji all share the same
      // bigram tokenization rules from ENG-2689 and the same clause naming here.
      writeProjectConfig({code: 'ja', mode: 'fixed'})
      const envelope = await kickoffWithProjectConfig()
      expect(envelope.prompt).to.include('in Japanese')
    })
  })

  describe('schema rejection at load time', () => {
    it('fixed mode without code is rejected by fromJson — the load throws', async () => {
      // `mode: 'fixed'` without `code` would silently fall back to English at
      // prompt time. `isBrvConfigJson` rejects it at load so the failure mode
      // is structurally impossible. Confirm the loader still throws end-to-end
      // (not just at the unit-test level).
      writeProjectConfig({mode: 'fixed'})
      let threwAtLoadTime = false
      try {
        await new ProjectConfigStore().read(projectRoot)
      } catch {
        threwAtLoadTime = true
      }

      expect(threwAtLoadTime, 'ProjectConfigStore.read rejects fixed-without-code').to.equal(true)
    })
  })

  describe('unknown ISO code degrades gracefully', () => {
    it('unmapped code (`xx`) emits the fixed clause with the raw code in quotes', async () => {
      // Forward-compat path. A future ISO code we haven't mapped yet must
      // still produce a usable clause (`in "xx"`) rather than blowing up.
      // This is the runtime-side counterpart to the loader's strict-validation
      // contract.
      writeProjectConfig({code: 'xx', mode: 'fixed'})
      const envelope = await kickoffWithProjectConfig()
      expect(envelope.prompt).to.include('in "xx"')
    })
  })
})
