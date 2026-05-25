/**
 * Element type definitions for the HTML render layer.
 *
 * This file is the type-only contract between:
 *  - the HTML parser (produces `ParsedNode` trees)
 *  - per-element validators (consume `ElementNode`s)
 *  - the element registry (catalogs `ElementSchema`s by `ElementName`)
 *  - downstream consumers (curate writer, query reader)
 *
 * The vocabulary is closed but additive: adding an element is one entry
 * in `ELEMENT_NAMES` plus a `<name>/{schema,validator}.ts` pair under
 * `elements/`. Consumers walk the registry generically; no consumer
 * needs touching when the vocabulary grows.
 */

/**
 * The element names in the closed `<bv-*>` vocabulary. The HTML curate
 * format must round-trip through the markdown writer without
 * information loss; the vocabulary covers everything the writer renders
 * into the `.md` file:
 *
 *   bv-topic        — root container; carries frontmatter as attributes.
 *   bv-reason       — `## Reason` body section.
 *   bv-task,        — `## Raw Concept` sub-fields:
 *   bv-changes,       Task / Changes / Files / Flow / Timestamp /
 *   bv-files,         Author / Patterns. (One sibling per emitted
 *   bv-flow,          bullet-label; multiple <bv-pattern> permitted.)
 *   bv-timestamp,
 *   bv-author,
 *   bv-pattern
 *   bv-structure,   — `## Narrative` sub-fields:
 *   bv-dependencies,  Structure / Dependencies / Highlights /
 *   bv-highlights,    Rules / Examples / Diagrams.
 *   bv-rule,
 *   bv-examples,
 *   bv-diagram
 *   bv-fact         — `## Facts` list entry (subject/category/value attrs).
 *   bv-decision     — decision record (no MD analog yet).
 *   bv-bug, bv-fix  — paired bug + fix runbook entries (no MD analog yet).
 *
 * Adding to this list must be an additive operation; downstream
 * consumers iterate the registry generically.
 */
export const ELEMENT_NAMES = [
  'bv-topic',
  'bv-reason',
  'bv-task',
  'bv-changes',
  'bv-files',
  'bv-flow',
  'bv-timestamp',
  'bv-author',
  'bv-pattern',
  'bv-structure',
  'bv-dependencies',
  'bv-highlights',
  'bv-rule',
  'bv-examples',
  'bv-diagram',
  'bv-fact',
  'bv-decision',
  'bv-bug',
  'bv-fix',
] as const

export type ElementName = typeof ELEMENT_NAMES[number]

/**
 * Normalized AST node produced by the HTML parser. Independent of any
 * specific parser library so we can swap implementations without
 * touching consumers.
 */
export type ParsedNode = DocumentNode | ElementNode | TextNode

export type ElementNode = {
  /**
   * Attribute map. Values are always strings (HTML attribute semantics).
   *
   * NOTE on key case: per the HTML5 parsing spec, attribute names are
   * lowercased during parsing — `updatedAt` in the source becomes
   * `updatedat` in this map. Downstream consumers (writer, reader)
   * MUST emit and look up attributes in lowercase. Schemas declared in
   * per-element `schema.ts` files use lowercase to match.
   */
  attributes: Readonly<Record<string, string>>
  children: readonly ParsedNode[]
  /** Tag name, lowercased. May or may not be a registered `ElementName`. */
  tagName: string
  type: 'element'
}

export type TextNode = {
  text: string
  type: 'text'
}

export type DocumentNode = {
  children: readonly ParsedNode[]
  type: 'document'
}

/** A single validation issue. Field is informational (often the attribute name). */
export type ValidationError = {
  field: string
  message: string
}

/**
 * Validation outcome from a per-element validator. Discriminated union so
 * consumers can branch without optional-undefined gymnastics.
 */
export type ValidationResult =
  | {errors: readonly ValidationError[]; valid: false;}
  | {valid: true}

/**
 * Allowed-children semantic hint. Informational — the validator carries
 * the enforcement; this is documentation for the curate prompt template
 * generator and the structural-axis index.
 */
export type AllowedChildren = 'any' | 'block' | 'inline' | 'none'

/**
 * Per-element registry entry. The validator is the load-bearing field;
 * everything else is metadata for the prompt template generator and
 * the structural-axis index.
 */
export type ElementSchema = {
  /** Allowed-children semantic hint. Informational. */
  allowedChildren: AllowedChildren
  /** Human-readable description for the curate prompt template generator. */
  description: string
  name: ElementName
  /** Optional attribute names. Informational; the validator enforces. */
  optionalAttributes: readonly string[]
  /** Required attribute names. Informational; the validator enforces. */
  requiredAttributes: readonly string[]
  /** Validate an `ElementNode`'s tag name + attributes. Light validation today (per-attribute Zod schema); strict validation per ADR-007 §13 is future work. */
  validator: (node: ElementNode) => ValidationResult
}

/** The full element registry — exactly one `ElementSchema` per `ElementName`. */
export type ElementRegistry = Readonly<Record<ElementName, ElementSchema>>
