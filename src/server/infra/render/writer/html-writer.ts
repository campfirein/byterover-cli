import {existsSync, readFileSync} from 'node:fs'
import path from 'node:path'

import type {ElementName, ValidationError} from '../../../core/domain/render/element-types.js'

import {DirectoryManager} from '../../../core/domain/knowledge/directory-manager.js'
import {ELEMENT_NAMES} from '../../../core/domain/render/element-types.js'
import {ELEMENT_REGISTRY} from '../elements/registry.js'
import {parseHtml, stripCodeFenceWrapper, walkElements} from '../reader/html-parser.js'
import {computeRelatedWarnings} from './related-ref-warner.js'

/**
 * HTML writer for the curate context-tree.
 *
 * Consumes the LLM's text response (the curate agent's final output),
 * validates it against the element registry, and atomically writes the
 * topic file to disk. `stripCodeFenceWrapper` handles the model's
 * stubborn habit of wrapping responses in code fences (~70% of the time
 * on Sonnet 4.5 per the authoring fluency check).
 *
 * Sequence on every write:
 *   1. Strip a single outer ` ```<lang>? … ``` ` wrapper if present.
 *   2. Parse with parse5 (forgiving — never throws).
 *   3. Walk the parsed tree; require exactly one `<bv-topic>` root and
 *      a `path` attribute. Validate every typed `<bv-*>` element through
 *      its registered validator. Reject on any failure.
 *   4. Resolve the on-disk path via the topic's `path` attribute (relative
 *      to a project's context-tree root) and atomically write the cleaned
 *      HTML via the existing `tmp-rename` pattern.
 *
 * On validation failure: returns a structured result for the executor
 * to log + surface as a curate-status. No file is written; the writer
 * fails clean. (Salvage mode for partial recovery is future work.)
 */

export type HtmlWriteSuccess = {
  /** Absolute path of the file that was written. */
  filePath: string
  ok: true
  /**
   * Advisory warnings raised AFTER the write succeeded. Today these
   * come from the `related` ref resolver (broken refs); the channel is
   * open to future read-only post-write checks. Always an array —
   * empty means a clean write. Wire formats may omit the field when
   * empty (see `agent-process.ts` curate-tool-mode case).
   */
  warnings: readonly string[]
  /** The cleaned HTML actually persisted (after fence-stripping). */
  written: string
}

export type HtmlWriteFailure = {
  errors: readonly HtmlWriteError[]
  ok: false
}

export type HtmlWriteResult = HtmlWriteFailure | HtmlWriteSuccess

export type HtmlWriteError =
  /**
   * Existing topic at the resolved path blocked the write because
   * `confirmOverwrite` was not set. `existingContent` carries the prior
   * file's bytes when readable; it is `undefined` when the file exists
   * but cannot be read (perms change, concurrent unlink, dangling
   * symlink). Consumers MUST NOT assume `existingContent === undefined`
   * means "topic is empty" — it means "couldn't read prior content,
   * merge requires re-fetching".
   */
  | {existingContent: string | undefined; kind: 'path-exists'; message: string; topicPath: string}
  | {field: string; kind: 'attribute-validation'; message: string; tag: ElementName}
  | {kind: 'missing-bv-topic'; message: string}
  | {kind: 'missing-path-attribute'; message: string}
  | {kind: 'multiple-bv-topic'; message: string}
  | {kind: 'unknown-bv-element'; message: string; tag: string}
  | {kind: 'unsafe-path'; message: string}

export type HtmlWriteOptions = {
  /**
   * Opt-in to clobber an existing topic at the resolved path. Default
   * `false`: the writer refuses to overwrite and returns a structured
   * `path-exists` error carrying the existing file's content so the
   * caller can merge. Set `true` only when the caller has consciously
   * decided to replace prior content (e.g. via a `--overwrite` flag
   * from the calling agent).
   */
  confirmOverwrite?: boolean
  /**
   * Project root directory. The topic file is written to
   * `<contextTreeRoot>/<topic.path>.html` relative to this root.
   */
  contextTreeRoot: string
  /** Raw LLM response text. May be wrapped in a code fence. */
  rawHtml: string
}

/**
 * Validate and atomically write a curate output as an HTML topic file.
 *
 * Before writing, system-managed timestamps (`createdat`, `updatedat`)
 * are injected onto `<bv-topic>`:
 *   - `updatedat` is always set to the current ISO instant.
 *   - `createdat` is preserved from the existing file on disk if one
 *     exists; otherwise it is set to the current ISO instant.
 * Any value the LLM authored for these attributes is overridden — the
 * agent is not allowed to choose its own timestamps.
 */
export async function writeHtmlTopic(options: HtmlWriteOptions): Promise<HtmlWriteResult> {
  const {confirmOverwrite = false, contextTreeRoot, rawHtml} = options
  const cleaned = stripCodeFenceWrapper(rawHtml)

  const validation = validateHtmlTopic(cleaned)
  if (!validation.ok) {
    return {errors: validation.errors, ok: false}
  }

  const filePath = topicPathToFilePath(contextTreeRoot, validation.topicPath)

  // Overwrite guard. The default policy is "refuse to clobber" — surface
  // a structured `path-exists` error carrying the existing file's content
  // so the caller (today: tool-mode orchestrator) can route the calling
  // agent to merge instead of silently losing prior facts. An explicit
  // `confirmOverwrite: true` from the caller is the only way through.
  //
  // NOTE on TOCTOU: a small race exists between `existsSync` here and
  // `writeFileAtomic` below. In practice tool-mode curate is serialised
  // by the daemon's per-project task pipeline and the per-session
  // orchestrator state machine (only one continuation in flight per
  // session). A concurrent writer on a different session targeting the
  // same path is the only window; with `tmp+rename` atomic semantics
  // the worst case is a single write losing on the rename, never a
  // partial file.
  if (!confirmOverwrite && existsSync(filePath)) {
    // existingContent may be undefined if the file exists but is
    // unreadable (perms change, concurrent unlink, broken symlink). We
    // pass that through verbatim — the prompt builder skips the inline
    // block when undefined so the agent does not see an empty
    // <existing-topic> and conclude the prior topic was empty (which
    // would lead to a different silent-clobber path).
    const existingContent = readExistingFileSafe(filePath)
    return {
      errors: [
        {
          existingContent,
          kind: 'path-exists',
          message: existingContent === undefined
            ? `A topic already exists at "${validation.topicPath}" but its content could not be read. `
              + 'Pass --overwrite to replace it (will clobber), or investigate the file before retrying.'
            : `A topic already exists at "${validation.topicPath}". Pass --overwrite to replace it, `
              + 'or merge the new content into the existing topic and re-emit.',
          topicPath: validation.topicPath,
        },
      ],
      ok: false,
    }
  }

  const now = new Date().toISOString()
  const createdAt = readExistingTopicAttribute(filePath, 'createdat') ?? now
  const stamped = setBvTopicAttributes(cleaned, {createdat: createdAt, updatedat: now})

  await DirectoryManager.writeFileAtomic(filePath, stamped)

  const warnings = computeRelatedWarnings({contextTreeRoot, relatedAttr: validation.relatedAttr})

  return {filePath, ok: true, warnings, written: stamped}
}

type ValidatedTopic =
  | {errors: readonly HtmlWriteError[]; ok: false}
  | {ok: true; relatedAttr: string | undefined; topicPath: string}

/**
 * Pure validation pass — does not touch disk. Exposed so the executor
 * can verify a response before deciding to write (e.g., for status
 * pre-checks) without paying the I/O cost twice.
 */
export function validateHtmlTopic(html: string): ValidatedTopic {
  const errors: HtmlWriteError[] = []

  const elements = walkElements(parseHtml(html))
  const topics = elements.filter((e) => e.tagName === 'bv-topic')

  if (topics.length === 0) {
    errors.push({
      kind: 'missing-bv-topic',
      message: 'Curate output must contain exactly one <bv-topic> root element. Found 0.',
    })
    return {errors, ok: false}
  }

  if (topics.length > 1) {
    errors.push({
      kind: 'multiple-bv-topic',
      message: `Curate output must contain exactly one <bv-topic> root. Found ${topics.length}.`,
    })
    return {errors, ok: false}
  }

  const topic = topics[0]
  const topicPath = topic.attributes.path
  if (!topicPath || topicPath.trim().length === 0) {
    errors.push({
      kind: 'missing-path-attribute',
      message: '<bv-topic> must declare a non-empty `path` attribute.',
    })
  } else {
    // Path-segment safety: the `path` becomes a filesystem location; reject
    // traversal segments before any caller treats `topicPath` as safe.
    // `topicPathToFilePath` keeps `path.resolve` defence-in-depth, but
    // surfacing as a structured validation error means standalone callers
    // (preview, dry-run) don't need to repeat the check.
    const normalized = topicPath.replaceAll('\\', '/').replace(/^\/+/, '')
    const segments = normalized.split('/').filter((s) => s.length > 0)
    for (const segment of segments) {
      if (segment === '..' || segment === '.') {
        errors.push({
          kind: 'unsafe-path',
          message: `bv-topic path may not contain "${segment}" segment: ${topicPath}`,
        })
        break
      }
    }
  }

  for (const el of elements) {
    if (!el.tagName.startsWith('bv-')) continue

    if (!isRegisteredElementName(el.tagName)) {
      errors.push({
        kind: 'unknown-bv-element',
        message: `<${el.tagName}> is not in the element registry. Vocabulary is closed.`,
        tag: el.tagName,
      })
      continue
    }

    const result = ELEMENT_REGISTRY[el.tagName].validator(el)
    if (!result.valid) {
      for (const e of result.errors) {
        errors.push(toAttributeError(el.tagName, e))
      }
    }
  }

  if (errors.length > 0) {
    return {errors, ok: false}
  }

  return {ok: true, relatedAttr: topic.attributes.related, topicPath: topicPath as string}
}

function isRegisteredElementName(tag: string): tag is ElementName {
  return (ELEMENT_NAMES as readonly string[]).includes(tag)
}

function toAttributeError(tag: ElementName, error: ValidationError): HtmlWriteError {
  return {field: error.field, kind: 'attribute-validation', message: error.message, tag}
}

/**
 * Resolve a `<bv-topic path="...">` attribute to an absolute on-disk
 * path inside the project's context-tree directory. The topic path is
 * sanitised: backslashes normalised to forward slashes, leading slashes
 * stripped, `..` segments rejected. A trailing `.html` is stripped
 * before re-appending so `path="x/y"` and `path="x/y.html"` both
 * resolve to `x/y.html` — the dream→curate handoff emits the suffixed
 * form, the convention elsewhere is the bare form, and both must
 * collide on the path-exists guard to keep the merge workflow from
 * silently producing a doubled-extension stale survivor. The current
 * storage layout is `.brv/context-tree/`; this resolver is the single
 * point that encodes that convention.
 */
function topicPathToFilePath(contextTreeRoot: string, topicPath: string): string {
  const normalized = topicPath.replaceAll('\\', '/').replace(/^\/+/, '').replace(/\.html$/i, '')
  const segments = normalized.split('/').filter((s) => s.length > 0)

  for (const segment of segments) {
    if (segment === '..' || segment === '.') {
      throw new Error(`bv-topic path may not contain "${segment}" segment: ${topicPath}`)
    }
  }

  const relative = segments.join('/') + '.html'
  const resolved = path.resolve(contextTreeRoot, relative)

  // Defence in depth: ensure the resolved path stays under contextTreeRoot.
  const rootResolved = path.resolve(contextTreeRoot)
  if (!resolved.startsWith(rootResolved + path.sep) && resolved !== rootResolved) {
    throw new Error(`bv-topic path escapes the context-tree root: ${topicPath}`)
  }

  return resolved
}

/**
 * Insert or replace attributes on the document's first `<bv-topic>`
 * opening tag. Surgical regex edit (no parse → re-serialize round-trip)
 * so the LLM's formatting (whitespace, attribute order, quoting style)
 * survives intact.
 *
 * Used by the writer to set system-managed `createdat` / `updatedat`
 * after the LLM emits its content. If the LLM happens to author either
 * attribute, the system value wins (last-attribute-with-same-name in
 * HTML5 attr-list semantics; here we replace in place rather than
 * append).
 */
function setBvTopicAttributes(html: string, attrs: Record<string, string>): string {
  let result = html
  for (const [name, value] of Object.entries(attrs)) {
    result = setBvTopicAttribute(result, name, value)
  }

  return result
}

function setBvTopicAttribute(html: string, name: string, value: string): string {
  const tagPattern = /<bv-topic\b[^>]*>/
  const tagMatch = html.match(tagPattern)
  if (!tagMatch || tagMatch.index === undefined) return html

  const tag = tagMatch[0]
  const escaped = escapeHtmlAttributeValue(value)
  const attrPattern = new RegExp(`\\s${name}="[^"]*"`, 'i')

  const newTag = attrPattern.test(tag)
    ? tag.replace(attrPattern, ` ${name}="${escaped}"`)
    : tag.endsWith('/>')
      ? tag.slice(0, -2) + ` ${name}="${escaped}"/>`
      : tag.slice(0, -1) + ` ${name}="${escaped}">`

  return html.slice(0, tagMatch.index) + newTag + html.slice(tagMatch.index + tag.length)
}

// Full HTML attribute escape. Ordering matters: `&` first, otherwise the
// `&lt;`/`&gt;`/`&quot;` entities we introduce below would get re-escaped
// to `&amp;lt;` etc. Today's only callers are ISO-8601 timestamps which
// contain none of these characters, but the helper is general-purpose by
// shape and a future caller passing user-influenced content would
// otherwise silently corrupt the tag.
export function escapeHtmlAttributeValue(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
}

/**
 * Read a single `<bv-topic>` attribute value from an existing file on
 * disk without parsing the whole document. Returns `null` if the file
 * is missing, unreadable, or the attribute isn't present. Used to
 * preserve `createdat` across re-writes.
 */
function readExistingTopicAttribute(filePath: string, attrName: string): null | string {
  if (!existsSync(filePath)) return null

  try {
    const content = readFileSync(filePath, 'utf8')
    const tagMatch = content.match(/<bv-topic\b[^>]*>/)
    if (!tagMatch) return null

    const attrPattern = new RegExp(`\\s${attrName}="([^"]*)"`, 'i')
    const attrMatch = tagMatch[0].match(attrPattern)
    return attrMatch ? attrMatch[1] : null
  } catch {
    return null
  }
}

/**
 * Read a file's full contents, returning `undefined` on any I/O error.
 * Used by the overwrite guard to surface the prior file content into a
 * `path-exists` error envelope. Errors here are swallowed deliberately:
 * the guard's purpose is to prevent silent clobber, and surfacing
 * partial / unreadable content as an empty string is acceptable
 * (the caller still sees the structural `path-exists` signal).
 */
function readExistingFileSafe(filePath: string): string | undefined {
  try {
    return readFileSync(filePath, 'utf8')
  } catch {
    return undefined
  }
}
