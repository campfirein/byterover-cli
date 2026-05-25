import type {ElementNode, ParsedNode} from '../../../core/domain/render/element-types.js'

import {getInnerText, parseHtml} from './html-parser.js'

/**
 * Render a parsed `<bv-topic>` document into a markdown-like string for
 * downstream LLM consumption (Tier 2 direct response, Tier 4 agent
 * tool reads). Strips raw markup and reduces every typed `<bv-*>`
 * element to its semantic role plus inner text.
 *
 * Why this exists: shipping raw `<bv-topic ...><bv-rule severity="must">x</bv-rule>...`
 * to the model burns tokens on tags and attribute syntax it doesn't
 * need to reconstruct meaning. Stripping every tag (bodyText only) is
 * the other extreme — it loses the severity / id / subject signals
 * the typed vocabulary exists to carry. This renderer preserves
 * element semantics in a compact, human-and-LLM-readable form.
 *
 * Behaviour:
 *   - `<bv-topic>` attributes (title, summary, tags, keywords) lift to
 *     a header block.
 *   - Top-level children are rendered with a per-tag semantic prefix
 *     (e.g. `- **Rule** [must]: ...`).
 *   - Unknown / unregistered tags fall back to a generic bullet so we
 *     don't drop content when the vocabulary grows.
 *   - Empty inner text is skipped (no zero-content bullets).
 *
 * Forgiving on malformed input: missing `<bv-topic>` root → renders
 * what's parseable; throws nothing.
 */
export function renderHtmlTopicForLlm(html: string): string {
  const document = parseHtml(html)
  const bvTopic = findFirstElement(document, 'bv-topic')

  const lines: string[] = []
  const headerLines: string[] = []
  const topicAttributes = bvTopic?.attributes ?? {}

  if (topicAttributes.title) headerLines.push(`# ${topicAttributes.title}`)
  if (topicAttributes.summary) headerLines.push(`> ${topicAttributes.summary}`)
  if (topicAttributes.tags) headerLines.push(`Tags: ${topicAttributes.tags}`)
  if (topicAttributes.keywords) headerLines.push(`Keywords: ${topicAttributes.keywords}`)
  if (topicAttributes.related) headerLines.push(`Related: ${topicAttributes.related}`)

  if (headerLines.length > 0) {
    lines.push(headerLines.join('\n'))
  }

  const children: readonly ParsedNode[] = bvTopic?.children ?? document.children

  for (const child of children) {
    if (child.type !== 'element') continue
    const rendered = renderChild(child)
    if (rendered) lines.push(rendered)
  }

  return lines.join('\n\n')
}

function renderChild(element: ElementNode): string {
  const text = getInnerText(element).trim()
  if (text.length === 0) return ''

  const {attributes, tagName} = element

  switch (tagName) {
    case 'bv-author': {
      return `**Author:** ${text}`
    }

    case 'bv-bug': {
      const id = attributes.id ? ` (${attributes.id})` : ''
      return `- **Bug**${id}: ${text}`
    }

    case 'bv-changes': {
      return `**Changes:** ${text}`
    }

    case 'bv-decision': {
      const id = attributes.id ? ` (${attributes.id})` : ''
      return `- **Decision**${id}: ${text}`
    }

    case 'bv-dependencies': {
      return `**Dependencies:** ${text}`
    }

    case 'bv-diagram': {
      return `**Diagram:**\n${text}`
    }

    case 'bv-examples': {
      return `**Examples:** ${text}`
    }

    case 'bv-fact': {
      const parts: string[] = []
      if (attributes.subject) parts.push(`subject=${attributes.subject}`)
      if (attributes.category) parts.push(`category=${attributes.category}`)
      if (attributes.value) parts.push(`value=${attributes.value}`)
      const meta = parts.length > 0 ? ` (${parts.join(', ')})` : ''
      return `- **Fact**${meta}: ${text}`
    }

    case 'bv-files': {
      return `**Files:** ${text}`
    }

    case 'bv-fix': {
      const id = attributes.id ? ` (${attributes.id})` : ''
      return `- **Fix**${id}: ${text}`
    }

    case 'bv-flow': {
      return `**Flow:** ${text}`
    }

    case 'bv-highlights': {
      return `**Highlights:** ${text}`
    }

    case 'bv-pattern': {
      return `- **Pattern:** ${text}`
    }

    case 'bv-reason': {
      return `**Reason:** ${text}`
    }

    case 'bv-rule': {
      const severity = attributes.severity ? `[${attributes.severity}]` : ''
      const id = attributes.id ? ` (${attributes.id})` : ''
      const head = severity ? `**Rule** ${severity}${id}` : `**Rule**${id}`
      return `- ${head}: ${text}`
    }

    case 'bv-structure': {
      return `**Structure:** ${text}`
    }

    case 'bv-task': {
      return `**Task:** ${text}`
    }

    case 'bv-timestamp': {
      return `**Timestamp:** ${text}`
    }

    default: {
      // Unknown / future bv-* element. Preserve content as a generic
      // bullet so growing the vocabulary doesn't silently drop data
      // from rendered output. Non-bv-* elements are skipped (would
      // typically be raw HTML the curate prompt forbids; if they
      // sneak in, we don't want them in the LLM-facing render).
      if (tagName.startsWith('bv-')) {
        return `- ${text}`
      }

      return ''
    }
  }
}

function findFirstElement(root: ParsedNode, tagName: string): ElementNode | undefined {
  if (root.type === 'element' && root.tagName === tagName) return root
  if (root.type === 'element' || root.type === 'document') {
    for (const child of root.children) {
      const found = findFirstElement(child, tagName)
      if (found) return found
    }
  }

  return undefined
}
