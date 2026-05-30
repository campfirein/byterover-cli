import {defaultTreeAdapter, type DefaultTreeAdapterMap, html as htmlNs, parseFragment, serialize} from 'parse5'

import type {DocumentNode, ElementNode, ParsedNode} from '../../../core/domain/render/element-types.js'

/**
 * HTML parser wrapper around parse5.
 *
 * Produces a normalised AST (`DocumentNode` / `ElementNode` /
 * `TextNode`) independent of parse5's internal types so consumers
 * (query reader, writer round-trip validation, future indexers) can
 * iterate without coupling to a specific HTML library.
 *
 * Why parse5 — it's the W3C-spec parser used by jsdom; widely vetted;
 * forgiving on malformed input by design (a feature for migration
 * tooling, neutral for the light-validation regime).
 *
 * Parses everything as a fragment (no `<html>`/`<head>`/`<body>`
 * wrapper required). Document-level parsing can be added if topic
 * files grow document-shaped headers; this wrapper leaves room.
 */

type Parse5DocumentFragment = DefaultTreeAdapterMap['documentFragment']
type Parse5Node = DefaultTreeAdapterMap['node']
type Parse5Element = DefaultTreeAdapterMap['element']
type Parse5TextNode = DefaultTreeAdapterMap['textNode']

/**
 * Strip a single ` ```<lang>? … ``` ` code-fence wrapper from the input.
 *
 * Sonnet 4.5 (and other models) wrap their HTML response in a code fence
 * even when the prompt explicitly forbids it — observed at ~90% during
 * the authoring fluency check. The fence is cosmetic; the inner HTML
 * still parses and validates. Defensive sanitisation in the response
 * parser generalises better than chasing the model's quirk via prompt
 * iteration.
 *
 * Behaviour:
 *   - Input wrapped in ` ```<any-lang>? \n … \n ``` ` → returns inner content.
 *   - Input not fence-wrapped → returns input unchanged.
 *   - Trailing/leading whitespace around the wrapper is tolerated.
 *
 * Only strips ONE outer fence. Inner fences (e.g., `<pre><code>` blocks
 * inside `<bv-diagram>`) survive intact.
 */
export function stripCodeFenceWrapper(html: string): string {
  const trimmed = html.trim()
  const match = trimmed.match(/^```\w*\s*\n([\s\S]*?)\n```\s*$/)
  return match ? match[1] : html
}

/**
 * Parse an HTML string into a normalized `DocumentNode`. parse5's
 * forgiving mode means malformed input returns a best-effort tree
 * rather than throwing.
 */
export function parseHtml(html: string): DocumentNode {
  const fragment: Parse5DocumentFragment = parseFragment(html)
  const children = fragment.childNodes
    .map((c) => convertNode(c))
    .filter((n): n is ParsedNode => n !== undefined)
  return {children, type: 'document'}
}

/**
 * Walk a parsed tree depth-first, returning every element node in
 * document order. Used by element-axis indexing and by validators that
 * need to find typed elements anywhere in the tree.
 */
export function walkElements(root: ParsedNode): ElementNode[] {
  const out: ElementNode[] = []
  walk(root, out)
  return out
}

function walk(node: ParsedNode, out: ElementNode[]): void {
  if (node.type === 'element') out.push(node)
  if (node.type === 'element' || node.type === 'document') {
    for (const child of node.children) walk(child, out)
  }
}

/**
 * Concatenate all text-node descendants of an element into a single
 * string. Used to extract BM25-ready text content from typed elements.
 * HTML entities are already decoded by parse5, so the output is usable
 * verbatim by the tokenizer.
 *
 * Inserts a space between sibling element-children so adjacent block
 * boundaries don't merge tokens (e.g., compact `<p>foo.</p><p>bar.</p>`
 * yields `foo. bar.` rather than `foo.bar.`). Whitespace runs are
 * collapsed and the result is trimmed so existing whitespace in the
 * source isn't doubled.
 */
export function getInnerText(node: ParsedNode): string {
  return collapseWhitespace(getInnerTextRaw(node))
}

function getInnerTextRaw(node: ParsedNode): string {
  if (node.type === 'text') return node.text
  if (node.type === 'element' || node.type === 'document') {
    // Insert a space at every child boundary; the outer collapseWhitespace
    // step then normalises any resulting double spaces.
    return node.children.map((c) => getInnerTextRaw(c)).join(' ')
  }

  return ''
}

function collapseWhitespace(text: string): string {
  return text.replaceAll(/\s+/g, ' ').trim()
}

/**
 * Serialise a normalised tree back to HTML. Used for round-trip
 * validation in tests and for the writer's emit path.
 *
 * Note: serialisation is semantically equivalent, not byte-equivalent.
 * Whitespace, attribute quoting, and self-closing tag style may
 * normalise.
 */
export function serializeHtml(root: DocumentNode): string {
  // Convert our normalized tree back to parse5's shape, then call serialize.
  const fragment = toParse5Fragment(root)
  return serialize(fragment)
}

// ----- internal: parse5 → normalized -----

/**
 * Convert a parse5 node into our normalised AST.
 *
 * Known limitation — `<template>` element content is not extracted. parse5
 * places template children in a separate `.content` DocumentFragment per
 * the HTML5 spec rather than under `childNodes`; the curate vocabulary
 * does not currently use `<template>`, so the converter ignores that
 * branch. If the vocabulary ever adopts `<template>`, the converter must
 * read `defaultTreeAdapter.getTemplateContent(node)`.
 */
function convertNode(node: Parse5Node): ParsedNode | undefined {
  if (isTextNode(node)) {
    return {text: node.value, type: 'text'}
  }

  if (isElementNode(node)) {
    const attributes: Record<string, string> = {}
    for (const attr of node.attrs) {
      attributes[attr.name] = attr.value
    }

    const children = node.childNodes
      .map((c) => convertNode(c))
      .filter((c): c is ParsedNode => c !== undefined)

    return {
      attributes,
      children,
      tagName: node.tagName.toLowerCase(),
      type: 'element',
    }
  }

  // Skip comments, doctype, processing instructions, etc.
  return undefined
}

function isTextNode(node: Parse5Node): node is Parse5TextNode {
  return node.nodeName === '#text'
}

function isElementNode(node: Parse5Node): node is Parse5Element {
  return 'tagName' in node && 'attrs' in node && 'childNodes' in node
}

// ----- internal: normalized → parse5 (for serialize) -----

/**
 * Build a parse5 DocumentFragment from our normalized tree using
 * `defaultTreeAdapter`. The adapter's factories return the exact node
 * shapes parse5's serializer expects, so no structural casting is needed.
 */
function toParse5Fragment(doc: DocumentNode): Parse5DocumentFragment {
  const fragment = defaultTreeAdapter.createDocumentFragment()
  appendChildren(fragment, doc.children)
  return fragment
}

function appendChildren(
  parent: DefaultTreeAdapterMap['parentNode'],
  children: readonly ParsedNode[],
): void {
  for (const child of children) {
    if (child.type === 'text') {
      const textNode = defaultTreeAdapter.createTextNode(child.text)
      defaultTreeAdapter.appendChild(parent, textNode)
    } else if (child.type === 'element') {
      const attrs = Object.entries(child.attributes).map(([name, value]) => ({name, value}))
      const element = defaultTreeAdapter.createElement(child.tagName, htmlNs.NS.HTML, attrs)
      appendChildren(element, child.children)
      defaultTreeAdapter.appendChild(parent, element)
    }
    // 'document' nodes shouldn't appear inside a tree (it's the root only).
  }
}
