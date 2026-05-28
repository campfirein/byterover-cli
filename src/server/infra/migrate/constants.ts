/**
 * Constants for the markdown→HTML context-tree migrator.
 *
 * Mirrors `scripts/migrate-context-tree-py/migrate_context_tree.py`
 * lines 79-211. Every value here must stay in sync with the Python
 * oracle until the oracle is retired.
 */

export const BRV_DIR = '.brv'
export const CONTEXT_TREE_DIR = 'context-tree'
export const MIGRATIONS_DIR = '_migrations'
export const ARCHIVE_FOLDER_PREFIX = 'context-tree-md-'

export const ARCHIVE_DIR = '_archived'
export const SUMMARY_INDEX_FILE = '_index.md'
export const ABSTRACT_EXTENSION = '.abstract.md'
export const OVERVIEW_EXTENSION = '.overview.md'
export const MANIFEST_FILE = '_manifest.json'

// Manifest written into the archive root listing relative .md paths
// whose .html siblings already existed BEFORE migration started. The
// rollback path reads this list so it doesn't delete .html files that
// predated the migration (which would be destructive data loss on
// mixed trees).
export const PRE_EXISTING_HTML_MANIFEST = '_pre_existing_html_siblings.json'

// Canonical body sections produced by the markdown writer; everything
// else is treated as an orphan section and routed through the heading-
// name heuristic map below.
export const KNOWN_SECTION_HEADINGS: ReadonlySet<string> = new Set([
  'Facts',
  'Narrative',
  'Raw Concept',
  'Reason',
  'Relations',
])

// Case-folded view for filters that need to match a heading regardless
// of casing — keeps the orphan-section walker (which is case-blind)
// consistent with the canonical-heading loops that use case-insensitive
// matching.
export const KNOWN_SECTION_HEADINGS_LOWER: ReadonlySet<string> = new Set(
  [...KNOWN_SECTION_HEADINGS].map((h) => h.toLowerCase()),
)

// Diagram type enum — keep in sync with the canonical Zod enum at
// src/server/infra/render/elements/bv-diagram/schema.ts (BvDiagramAttributesSchema.type).
// If a new diagram type lands there, add it here so the migrator's
// `normalizeDiagramType` doesn't collapse it to 'other'.
export const DIAGRAM_TYPES: ReadonlySet<string> = new Set([
  'ascii',
  'dot',
  'graphviz',
  'mermaid',
  'other',
  'plantuml',
])

// Fact category enum — keep in sync with the canonical Zod enum at
// src/server/infra/render/elements/bv-fact/schema.ts (BvFactAttributesSchema.category).
// If a new category lands there, add it here so the migrator's
// `normalizeFactCategory` doesn't collapse it to 'other'.
export const FACT_CATEGORIES: ReadonlySet<string> = new Set([
  'convention',
  'environment',
  'other',
  'personal',
  'preference',
  'project',
  'team',
])

// Frontmatter keys the migrator maps to <bv-topic> attributes. Anything
// else is either a runtime-signal (allow-listed below, dropped silently)
// or unknown content metadata (warned + dropped).
export const KNOWN_FRONTMATTER_KEYS_CONTENT: ReadonlySet<string> = new Set([
  'createdAt',
  'keywords',
  'related',
  'relateds',
  'short_description',
  'summary',
  'tags',
  'title',
  'updatedAt',
])

// Runtime signals live in the sidecar store per the runtime-signals
// migration. They're frontmatter today but intentionally dropped at
// migration time — no warning emitted.
export const RUNTIME_SIGNAL_FRONTMATTER_KEYS: ReadonlySet<string> = new Set([
  'accessCount',
  'importance',
  'maturity',
  'recency',
  'updateCount',
])

/**
 * Heading-name heuristic — orphan `## X` sections route to bv-*
 * elements when the canonical counterpart is empty. Keys are lowercase;
 * values describe the routing strategy used by `processOrphanSections`.
 */
export type OrphanH2Strategy =
  | 'decisions_multiple'
  | 'dependencies_if_empty'
  | 'examples_if_empty'
  | 'facts_parse'
  | 'highlights_if_empty'
  | 'patterns_multiple'
  | 'reason_if_empty'
  | 'rules_split'
  | 'structure_if_empty'
  | 'summary_attr_if_empty'

export const ORPHAN_H2_HEURISTIC: ReadonlyMap<string, OrphanH2Strategy> =
  new Map<string, OrphanH2Strategy>([
    ['abstract', 'summary_attr_if_empty'],
    ['architecture', 'structure_if_empty'],
    ['decisions', 'decisions_multiple'],
    ['dependencies', 'dependencies_if_empty'],
    ['evidence', 'facts_parse'],
    ['examples', 'examples_if_empty'],
    ['features', 'highlights_if_empty'],
    ['highlights', 'highlights_if_empty'],
    ['overview', 'reason_if_empty'],
    ['patterns', 'patterns_multiple'],
    ['purpose', 'reason_if_empty'],
    ['rules', 'rules_split'],
    ['scope', 'structure_if_empty'],
    ['structure', 'structure_if_empty'],
    ['summary', 'summary_attr_if_empty'],
  ])

/**
 * Heuristic for unknown `### X` subsections under `## Narrative`.
 * Same value semantics as `ORPHAN_H2_HEURISTIC`.
 */
export type NarrativeSubsectionStrategy =
  | 'decisions_multiple'
  | 'patterns_multiple'
  | 'structure_if_empty'

export const NARRATIVE_SUBSECTION_HEURISTIC: ReadonlyMap<
  string,
  NarrativeSubsectionStrategy
> = new Map<string, NarrativeSubsectionStrategy>([
  ['decisions', 'decisions_multiple'],
  ['overview', 'structure_if_empty'],
  ['patterns', 'patterns_multiple'],
])

/**
 * `## Raw Concept` recognized labels under bold-heading form
 * `**Label:**`. Plural-tolerant — both singular and plural forms route
 * to the same bv-* element.
 */
export type RawConceptKey =
  | 'author'
  | 'changes'
  | 'files'
  | 'flow'
  | 'patterns'
  | 'task'
  | 'timestamp'

export const RAW_CONCEPT_LABEL_MAP: ReadonlyMap<string, RawConceptKey> =
  new Map<string, RawConceptKey>([
    ['author', 'author'],
    ['authors', 'author'],
    ['change', 'changes'],
    ['changes', 'changes'],
    ['file', 'files'],
    ['files', 'files'],
    ['flow', 'flow'],
    ['flows', 'flow'],
    ['pattern', 'patterns'],
    ['patterns', 'patterns'],
    ['task', 'task'],
    ['tasks', 'task'],
    ['timestamp', 'timestamp'],
    ['timestamps', 'timestamp'],
  ])
