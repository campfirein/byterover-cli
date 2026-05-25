import {expect} from 'chai'
import {mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync} from 'node:fs'
import {tmpdir} from 'node:os'
import {join} from 'node:path'

import type {PermissionOption} from '../../../../../src/shared/types/channel.js'

import {decideAutoApprovalForEditAsWrite} from '../../../../../src/server/infra/channel/permission-auto-approver.js'

const allowOnce: PermissionOption = {kind: 'allow_once', name: 'Yes', optionId: 'approved'}
const rejectOnce: PermissionOption = {kind: 'reject_once', name: 'No', optionId: 'abort'}
const PROJECT_ROOT = '/Users/me/proj'

// Helper: build a codex-style toolCall payload with the inline diff shape
// observed in V6 (`{type: 'diff', path, oldText, newText}` at the content
// entry's top level).
function inlineDiffToolCall(diffs: Array<{newText: string; oldText: string; path: string}>): unknown {
  return {
    content: diffs.map(d => ({...d, type: 'diff'})),
    kind: 'edit',
    locations: diffs.map(d => ({path: d.path})),
    status: 'pending',
    title: `Edit ${diffs[0]!.path}`,
    toolCallId: 'call-1',
  }
}

// Helper: nested `.diff` shape some drivers emit.
function nestedDiffToolCall(diffs: Array<{newText: string; oldText: string; path: string}>): unknown {
  return {
    content: diffs.map(d => ({diff: d, type: 'diff'})),
    kind: 'edit',
    toolCallId: 'call-1',
  }
}

describe('decideAutoApprovalForEditAsWrite (B2)', () => {
  describe('approves', () => {
    it('inline diff with empty oldText + non-empty newText within projectRoot', () => {
      const tc = inlineDiffToolCall([{newText: 'console.log("hi")\n', oldText: '', path: `${PROJECT_ROOT}/src/main.js`}])
      const result = decideAutoApprovalForEditAsWrite({
        options: [allowOnce, rejectOnce],
        projectRoot: PROJECT_ROOT,
        toolCall: tc,
      })
      expect(result?.optionId).to.equal('approved')
      expect(result?.reason).to.match(/empty-oldText Edit/i)
    })

    it('nested .diff shape with empty oldText', () => {
      const tc = nestedDiffToolCall([{newText: 'x', oldText: '', path: `${PROJECT_ROOT}/x.js`}])
      const result = decideAutoApprovalForEditAsWrite({
        options: [allowOnce],
        projectRoot: PROJECT_ROOT,
        toolCall: tc,
      })
      expect(result?.optionId).to.equal('approved')
    })

    it('multi-file edit where every diff has empty oldText', () => {
      const tc = inlineDiffToolCall([
        {newText: 'a', oldText: '', path: `${PROJECT_ROOT}/a.js`},
        {newText: 'b', oldText: '', path: `${PROJECT_ROOT}/sub/b.js`},
      ])
      const result = decideAutoApprovalForEditAsWrite({
        options: [allowOnce, rejectOnce],
        projectRoot: PROJECT_ROOT,
        toolCall: tc,
      })
      expect(result?.optionId).to.equal('approved')
    })

    it('codex F1: REFUSES allow_always — only allow_once auto-approves', () => {
      // Auto-selecting `allow_always` would permanently broaden the
      // permission policy for that toolCall class without consent.
      const tc = inlineDiffToolCall([{newText: 'x', oldText: '', path: `${PROJECT_ROOT}/x.js`}])
      const allowAlways: PermissionOption = {kind: 'allow_always', name: 'Always', optionId: 'always-yes'}
      const result = decideAutoApprovalForEditAsWrite({
        options: [allowAlways, rejectOnce],
        projectRoot: PROJECT_ROOT,
        toolCall: tc,
      })
      expect(result, 'allow_always alone must NOT trigger auto-approve').to.equal(undefined)
    })

    it('codex F1: picks allow_once even when allow_always is also offered', () => {
      const tc = inlineDiffToolCall([{newText: 'x', oldText: '', path: `${PROJECT_ROOT}/x.js`}])
      const allowAlways: PermissionOption = {kind: 'allow_always', name: 'Always', optionId: 'always-yes'}
      const result = decideAutoApprovalForEditAsWrite({
        options: [allowAlways, allowOnce, rejectOnce],
        projectRoot: PROJECT_ROOT,
        toolCall: tc,
      })
      expect(result?.optionId).to.equal('approved')
    })
  })

  describe('declines', () => {
    it('toolCall.kind !== "edit"', () => {
      const tc = {...inlineDiffToolCall([{newText: 'x', oldText: '', path: `${PROJECT_ROOT}/x.js`}]) as object, kind: 'write'}
      const result = decideAutoApprovalForEditAsWrite({
        options: [allowOnce],
        projectRoot: PROJECT_ROOT,
        toolCall: tc,
      })
      expect(result).to.equal(undefined)
    })

    it('toolCall is not an object', () => {
      for (const tc of [null, undefined, 'edit', 42]) {
        expect(decideAutoApprovalForEditAsWrite({
          options: [allowOnce],
          projectRoot: PROJECT_ROOT,
          toolCall: tc,
        })).to.equal(undefined)
      }
    })

    it('any diff has non-empty oldText (partial replacement)', () => {
      const tc = inlineDiffToolCall([{newText: 'after', oldText: 'before', path: `${PROJECT_ROOT}/x.js`}])
      const result = decideAutoApprovalForEditAsWrite({
        options: [allowOnce],
        projectRoot: PROJECT_ROOT,
        toolCall: tc,
      })
      expect(result).to.equal(undefined)
    })

    it('multi-file where ONE diff has non-empty oldText (all-or-nothing safety)', () => {
      const tc = inlineDiffToolCall([
        {newText: 'a', oldText: '', path: `${PROJECT_ROOT}/a.js`},
        {newText: 'b', oldText: 'old', path: `${PROJECT_ROOT}/b.js`},
      ])
      const result = decideAutoApprovalForEditAsWrite({
        options: [allowOnce],
        projectRoot: PROJECT_ROOT,
        toolCall: tc,
      })
      expect(result, 'partial replacement in ANY file disqualifies the whole request').to.equal(undefined)
    })

    it('target path is OUTSIDE projectRoot', () => {
      const tc = inlineDiffToolCall([{newText: 'x', oldText: '', path: '/etc/passwd'}])
      const result = decideAutoApprovalForEditAsWrite({
        options: [allowOnce],
        projectRoot: PROJECT_ROOT,
        toolCall: tc,
      })
      expect(result).to.equal(undefined)
    })

    it('target path uses .. to escape projectRoot', () => {
      const tc = inlineDiffToolCall([{newText: 'x', oldText: '', path: `${PROJECT_ROOT}/../outside.js`}])
      const result = decideAutoApprovalForEditAsWrite({
        options: [allowOnce],
        projectRoot: PROJECT_ROOT,
        toolCall: tc,
      })
      expect(result).to.equal(undefined)
    })

    it('newText is empty (no-op or pure deletion)', () => {
      const tc = inlineDiffToolCall([{newText: '', oldText: '', path: `${PROJECT_ROOT}/x.js`}])
      const result = decideAutoApprovalForEditAsWrite({
        options: [allowOnce],
        projectRoot: PROJECT_ROOT,
        toolCall: tc,
      })
      expect(result).to.equal(undefined)
    })

    it('options offer NO allow flavour (only reject_once / reject_always)', () => {
      const tc = inlineDiffToolCall([{newText: 'x', oldText: '', path: `${PROJECT_ROOT}/x.js`}])
      const result = decideAutoApprovalForEditAsWrite({
        options: [rejectOnce, {kind: 'reject_always', name: 'Never', optionId: 'never'}],
        projectRoot: PROJECT_ROOT,
        toolCall: tc,
      })
      expect(result).to.equal(undefined)
    })

    it('no content entries at all', () => {
      const tc = {content: [], kind: 'edit'}
      const result = decideAutoApprovalForEditAsWrite({
        options: [allowOnce],
        projectRoot: PROJECT_ROOT,
        toolCall: tc,
      })
      expect(result).to.equal(undefined)
    })

    it('content entries are non-diff (e.g. text-only)', () => {
      const tc = {content: ['some text'], kind: 'edit'}
      const result = decideAutoApprovalForEditAsWrite({
        options: [allowOnce],
        projectRoot: PROJECT_ROOT,
        toolCall: tc,
      })
      expect(result).to.equal(undefined)
    })

    it('codex F2: object-shaped content without type: "diff" must not pass', () => {
      // The shape happens to carry oldText/newText/path but isn't typed
      // as a diff — could be an embedded markdown block or an unrelated
      // tool descriptor. Refuse to auto-approve.
      const tc = {
        content: [{newText: 'x', oldText: '', path: `${PROJECT_ROOT}/x.js`}],
        kind: 'edit',
      }
      const result = decideAutoApprovalForEditAsWrite({
        options: [allowOnce],
        projectRoot: PROJECT_ROOT,
        toolCall: tc,
      })
      expect(result, 'untyped object content must not auto-approve').to.equal(undefined)
    })

    it('codex F2: mixed content with one non-diff entry disqualifies the whole request', () => {
      const tc = {
        content: [
          {newText: 'x', oldText: '', path: `${PROJECT_ROOT}/x.js`, type: 'diff'},
          {message: 'context', type: 'text'},
        ],
        kind: 'edit',
      }
      const result = decideAutoApprovalForEditAsWrite({
        options: [allowOnce],
        projectRoot: PROJECT_ROOT,
        toolCall: tc,
      })
      expect(result, 'all-or-nothing on content typing').to.equal(undefined)
    })

    it('diff path is missing', () => {
      const tc = {content: [{newText: 'x', oldText: '', type: 'diff'}], kind: 'edit'}
      const result = decideAutoApprovalForEditAsWrite({
        options: [allowOnce],
        projectRoot: PROJECT_ROOT,
        toolCall: tc,
      })
      expect(result).to.equal(undefined)
    })
  })

  describe('codex F3: path anchoring', () => {
    it('relative target path resolves AGAINST projectRoot, not daemon cwd', () => {
      // Relative path 'src/main.js' must anchor to projectRoot so the
      // check works regardless of where the daemon process started.
      const tc = inlineDiffToolCall([{newText: 'x', oldText: '', path: 'src/main.js'}])
      const result = decideAutoApprovalForEditAsWrite({
        options: [allowOnce],
        projectRoot: PROJECT_ROOT,
        toolCall: tc,
      })
      expect(result?.optionId, 'relative paths must anchor to projectRoot').to.equal('approved')
    })
  })

  describe('codex F4: symlink escape detection (real FS)', () => {
    let realRoot: string

    beforeEach(() => {
      realRoot = mkdtempSync(join(tmpdir(), 'b2-symlink-'))
    })

    afterEach(() => {
      rmSync(realRoot, {force: true, recursive: true})
    })

    it('declines when a symlink inside projectRoot points OUTSIDE', () => {
      // Layout:
      //   <realRoot>/
      //     escape-link  ->  <outsideDir>
      //
      // Auto-approve target: <realRoot>/escape-link/new-file.js
      // Lexical check passes (`escape-link/new-file.js` is inside realRoot).
      // Symlink-resolved check fails (`<outsideDir>/new-file.js` is outside).
      const outsideDir = mkdtempSync(join(tmpdir(), 'b2-outside-'))
      try {
        symlinkSync(outsideDir, join(realRoot, 'escape-link'))
        const tc = {
          content: [{newText: 'leak', oldText: '', path: join(realRoot, 'escape-link', 'new-file.js'), type: 'diff'}],
          kind: 'edit',
        }
        const result = decideAutoApprovalForEditAsWrite({
          options: [allowOnce],
          projectRoot: realRoot,
          toolCall: tc,
        })
        expect(result, 'symlink escape must NOT auto-approve').to.equal(undefined)
      } finally {
        rmSync(outsideDir, {force: true, recursive: true})
      }
    })

    it('approves when a symlink inside projectRoot points to ANOTHER path inside projectRoot', () => {
      // Symlink to sibling dir within the same sandbox is fine.
      const insideTarget = join(realRoot, 'real-sub')
      mkdirSync(insideTarget)
      symlinkSync(insideTarget, join(realRoot, 'link-sub'))
      const tc = {
        content: [{newText: 'ok', oldText: '', path: join(realRoot, 'link-sub', 'new.js'), type: 'diff'}],
        kind: 'edit',
      }
      const result = decideAutoApprovalForEditAsWrite({
        options: [allowOnce],
        projectRoot: realRoot,
        toolCall: tc,
      })
      expect(result?.optionId).to.equal('approved')
    })

    it('approves when the target path is a brand-new file directly under projectRoot (no symlinks)', () => {
      const tc = {
        content: [{newText: 'fresh', oldText: '', path: join(realRoot, 'new.js'), type: 'diff'}],
        kind: 'edit',
      }
      // Touch a sibling to ensure realRoot is recognised as existing.
      writeFileSync(join(realRoot, 'sentinel'), '')
      const result = decideAutoApprovalForEditAsWrite({
        options: [allowOnce],
        projectRoot: realRoot,
        toolCall: tc,
      })
      expect(result?.optionId).to.equal('approved')
    })
  })

  describe('V6 verbatim scenario', () => {
    it('reproduces the codex run-2/run-3 §3b request — full-file rewrite of own engine.js', () => {
      // From EVALUATION.md run-3 §3b: codex emits Edit with oldText: ""
      // and the full 4892-byte file as newText.
      const enginePath = `${PROJECT_ROOT}/engine.js`
      const tc = {
        content: [{newText: '/* 4892 bytes of engine code */\n', oldText: '', path: enginePath, type: 'diff'}],
        kind: 'edit',
        locations: [{path: enginePath}],
        rawInput: {changes: {[enginePath]: {content: '/* ... */', type: 'add'}}},
        status: 'pending',
        title: `Edit ${enginePath}`,
        toolCallId: 'call_codex',
      }
      const result = decideAutoApprovalForEditAsWrite({
        options: [allowOnce, rejectOnce],
        projectRoot: PROJECT_ROOT,
        toolCall: tc,
      })
      expect(result?.optionId).to.equal('approved')
    })
  })
})
