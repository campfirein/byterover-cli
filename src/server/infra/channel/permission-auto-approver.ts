import {realpathSync} from 'node:fs'
import {dirname, isAbsolute, relative, resolve} from 'node:path'

import type {PermissionOption} from '../../../shared/types/channel.js'

// Phase 10 Tier B2 (V6 run-2/run-3 §3b) — auto-approve "empty-oldText Edit"
// permission requests when the target file is inside the project sandbox.
//
// Why: when codex (and other drivers) re-write a file they own with the
// Edit tool, the diff carries an EMPTY `oldText` and the full file as
// `newText`. That's semantically a Write, but the permission boundary
// treats it as an Edit and gates it behind a human decision. Across
// V6 run-2 + run-3 this cost ~15 minutes of orchestrator wall-clock
// per build for an operation that's structurally identical to the
// initial Write the agent already had permission to perform.
//
// Safety constraints (must ALL hold to auto-approve):
//   1. toolCall.kind === 'edit'
//   2. EVERY content entry has `type === 'diff'` (codex F2 — don't widen
//      to arbitrary object-shaped content)
//   3. every diff has empty `oldText`
//      (a partial-replacement edit still gates as usual)
//   4. every target path RESOLVES + REALPATH-ESCAPES land within the
//      project sandbox (codex F3 + F4 — anchor relative paths to
//      projectRoot, not daemon cwd; follow symlinks to defeat
//      symlink-escape attacks)
//   5. the request options include an `allow_once` choice. We
//      DELIBERATELY refuse `allow_always` even when it's the only allow
//      flavour offered (codex F1 — auto-selecting `allow_always` would
//      permanently broaden permissions for that toolCall class without
//      consent)
//
// If any check fails → return undefined → orchestrator falls through to
// the human-decision path. The detector is intentionally conservative:
// false negatives are fine (extra gate is annoying but safe); false
// positives could bypass an intentional Edit-protected file.

export type AutoApproveDecision = {
  readonly optionId: string
  readonly reason: string
}

type DiffPayload = {
  readonly diff?: {
    readonly newText?: unknown
    readonly oldText?: unknown
    readonly path?: unknown
  }
  readonly newText?: unknown
  readonly oldText?: unknown
  readonly path?: unknown
  readonly type?: unknown
}

export type AutoApprovalArgs = {
  readonly options: ReadonlyArray<PermissionOption>
  readonly projectRoot: string
  readonly toolCall: unknown
}

// eslint-disable-next-line complexity
export function decideAutoApprovalForEditAsWrite(args: AutoApprovalArgs): AutoApproveDecision | undefined {
  const {options, projectRoot, toolCall} = args
  if (typeof toolCall !== 'object' || toolCall === null) return undefined
  const tc = toolCall as {content?: unknown; kind?: unknown; locations?: unknown}
  if (tc.kind !== 'edit') return undefined

  // Codex F2 — accept ONLY entries explicitly typed `diff`. Without this
  // any object-shaped content (text blocks, image refs, etc.) that
  // happened to carry oldText/newText/path keys would pass through.
  const content = Array.isArray(tc.content) ? tc.content : []
  if (content.length === 0) return undefined

  const diffs: DiffPayload[] = content.filter((c): c is DiffPayload =>
    typeof c === 'object' && c !== null && (c as {type?: unknown}).type === 'diff',
  )
  if (diffs.length === 0) return undefined
  // All-or-nothing: if ANY content entry is non-diff, decline entirely.
  if (diffs.length !== content.length) return undefined

  for (const entry of diffs) {
    const oldText = entry.diff?.oldText ?? entry.oldText
    if (typeof oldText !== 'string' || oldText.length > 0) {
      // Any non-empty-oldText entry disqualifies the whole request.
      return undefined
    }

    const newText = entry.diff?.newText ?? entry.newText
    if (typeof newText !== 'string' || newText.length === 0) {
      // Edit with both old and new empty isn't a Write-equivalent.
      return undefined
    }

    const rawPath = entry.diff?.path ?? entry.path
    if (typeof rawPath !== 'string' || rawPath.length === 0) {
      return undefined
    }

    if (!isWithinProjectRoot(rawPath, projectRoot)) {
      return undefined
    }
  }

  // Codex F1 — only `allow_once`. Refusing `allow_always` keeps the
  // auto-approval scoped to THIS request; an `allow_always` choice
  // would permanently broaden the permission policy without consent.
  const allowOnce = options.find(o => o.kind === 'allow_once')
  if (allowOnce === undefined) return undefined

  return {
    optionId: allowOnce.optionId,
    reason: `empty-oldText Edit on sandboxed project file(s); auto-approved as Write-equivalent`,
  }
}

// Two layers of check, both must accept:
//
//   1. Lexical containment — resolve(projectRoot, targetPath) (codex F3:
//      anchor relative paths to the SANDBOX, not daemon cwd) must NOT
//      `..`-escape projectRoot. This is necessary for synthetic paths
//      whose ancestors don't exist (test cases, brand-new files).
//   2. Symlink-resolved containment — the deepest EXISTING ancestor of
//      the target must realpath INTO the realpath of projectRoot
//      (codex F4: a symlink inside projectRoot pointing outside must
//      NOT pass). When the projectRoot itself doesn't exist (tests),
//      this layer is vacuously satisfied.
//
// Both layers run; both must accept. The previous single-layer
// "canonicalise then relative" check could be tricked when realpath
// fallback ascended to a shared existing ancestor between root and
// target (caught by codex review F4 follow-on).
function isWithinProjectRoot(targetPath: string, projectRoot: string): boolean {
  // Layer 1 — lexical containment.
  const lexicalRoot = resolve(projectRoot)
  const anchored = isAbsolute(targetPath) ? targetPath : resolve(projectRoot, targetPath)
  const lexicalTarget = resolve(anchored)
  const lexRel = relative(lexicalRoot, lexicalTarget)
  if (lexRel !== '' && (lexRel.startsWith('..') || isAbsolute(lexRel))) return false

  // Layer 2 — symlink-resolved containment. Skip if projectRoot doesn't
  // exist on this filesystem (test-only scenario).
  const realRoot = tryRealpath(lexicalRoot)
  if (realRoot === undefined) return true
  const realTarget = deepestRealpath(lexicalTarget)
  if (realTarget === undefined) return true
  const realRel = relative(realRoot, realTarget)
  if (realRel === '') return true
  return !realRel.startsWith('..') && !isAbsolute(realRel)
}

function tryRealpath(p: string): string | undefined {
  try {
    return realpathSync(p)
  } catch {
    return undefined
  }
}

// `realpathSync` follows every component of an EXISTING path. For paths
// that don't yet exist (brand-new file write), it throws ENOENT; we fall
// back to canonicalising the deepest existing ancestor so symlinks in
// the ancestor chain are still resolved.
function deepestRealpath(p: string): string | undefined {
  let current = p
  // Bounded ascent — prevent infinite loop on root-only paths.
  for (let depth = 0; depth < 64; depth++) {
    const resolved = tryRealpath(current)
    if (resolved !== undefined) return resolved
    const parent = dirname(current)
    if (parent === current) return undefined  // hit filesystem root with no existing ancestor
    current = parent
  }

  return undefined
}
