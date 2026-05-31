import {readFile} from 'node:fs/promises'

import type {ElementName} from '../../../core/domain/render/element-types.js'

import {ELEMENT_NAMES} from '../../../core/domain/render/element-types.js'
import {getInnerText, parseHtml, walkElements} from './html-parser.js'

/**
 * Topic-file reader for the HTML render layer.
 *
 * Parses an HTML topic via parse5, extracts BM25-ready text content,
 * and produces a flat list of every typed `<bv-*>` element with its
 * tag and attributes. The element list is consumed by the
 * element-axis index for structural lookups; the inner text is fed
 * into the BM25 index alongside markdown bodies.
 *
 * Inner text is already entity-decoded by parse5 (the parser handles
 * `&amp;` → `&`, `&lt;` → `<`, etc. at parse time), so the tokenizer
 * sees plain text and ranking parity with markdown is straightforward.
 */

/**
 * One typed `<bv-*>` element discovered in a topic. Attributes are a
 * snapshot of the parsed attribute map (lowercase keys per HTML5
 * normalization). Used by the element-axis index for `tag → [paths]`
 * and `tag.attribute=value → [paths]` lookups.
 */
export type ElementAxisEntry = {
  attributes: Readonly<Record<string, string>>
  tag: ElementName
}

/**
 * Topic-level frontmatter attributes lifted off `<bv-topic>` for
 * convenience. Consumers that need the full attribute set walk the
 * elements list directly.
 */
export type TopicAttributes = Readonly<Record<string, string>>

export type HtmlTopicRead = {
  /** Tokenizer-ready text content. Whitespace collapsed; entities decoded. */
  bodyText: string
  /** Flat list of every typed `<bv-*>` element, in document order. */
  elements: readonly ElementAxisEntry[]
  /**
   * Searchable text aggregated from every `<img>` in the topic — `alt`
   * attribute and `src` URL, space-joined in document order. Concatenated
   * into the BM25 input by the indexer so queries for image alt phrases
   * or URL tokens (host, path segments, filename) surface the topic.
   * `<img>` is a void element with no text-node children, so the default
   * `getInnerText` extraction returns nothing for it — this field is the
   * indexer's view of image content.
   */
  imageContent: string
  /** Attributes on the bv-topic root, or empty if no bv-topic was present. */
  topicAttributes: TopicAttributes
}

/**
 * Parse an HTML string into the structured shape the search/index
 * pipeline consumes. The reader is forgiving — malformed HTML returns
 * a best-effort result rather than throwing (parse5 is forgiving by
 * design; we mirror that for the reader's contract).
 */
export function readHtmlTopicSync(html: string): HtmlTopicRead {
  const document = parseHtml(html)
  const allElements = walkElements(document)

  const bodyText = getInnerText(document)
  const imageContent = extractImageContent(allElements)

  const elements: ElementAxisEntry[] = []
  let topicAttributes: TopicAttributes = {}
  let topicSeen = false

  for (const el of allElements) {
    // Lift attributes off the FIRST `bv-topic` encountered, regardless
    // of whether its attribute map is empty. The schema requires
    // `path` + `title`, but malformed input (zero-attribute `<bv-topic>`
    // followed by a populated sibling) used to silently lift the
    // sibling — the contract says "root", and the implementation now
    // matches that.
    if (el.tagName === 'bv-topic' && !topicSeen) {
      topicAttributes = el.attributes
      topicSeen = true
    }

    if (!isRegisteredElementName(el.tagName)) continue

    elements.push({
      attributes: el.attributes,
      tag: el.tagName,
    })
  }

  return {bodyText, elements, imageContent, topicAttributes}
}

/**
 * Aggregate every `<img>`'s `alt` and `src` into a single space-joined
 * string. Public so the BM25 indexer can include image content in its
 * input without re-walking the parsed tree.
 *
 * The full URL goes in verbatim — the BM25 tokenizer splits on `/`, `:`,
 * `.`, `?`, etc. (already CJK-aware after ENG-2689), which decomposes
 * URLs into useful tokens (`https`, `example`, `com`, `arch`, `png`).
 * No explicit host extraction needed.
 *
 * Returns the empty string when the topic has no `<img>` elements, so
 * the indexer's `[bodyText, summary, …, imageContent].filter(…)` step
 * cleanly drops the entry instead of carrying an empty token.
 */
export function extractImageContent(elements: readonly {attributes: Readonly<Record<string, string>>; tagName: string}[]): string {
  const parts: string[] = []
  for (const el of elements) {
    if (el.tagName !== 'img') continue
    const alt = (el.attributes.alt ?? '').trim()
    const src = (el.attributes.src ?? '').trim()
    if (alt.length > 0) parts.push(alt)
    if (src.length > 0) parts.push(src)
  }

  return parts.join(' ')
}

/**
 * I/O wrapper: reads `filePath` from disk and returns the parsed shape.
 * Used by the search service when indexing HTML topic files.
 */
export async function readHtmlTopic(filePath: string): Promise<HtmlTopicRead> {
  const html = await readFile(filePath, 'utf8')
  return readHtmlTopicSync(html)
}

function isRegisteredElementName(tag: string): tag is ElementName {
  return (ELEMENT_NAMES as readonly string[]).includes(tag)
}
