import type {ElementRegistry} from '../../../core/domain/render/element-types.js'

import {validateBvAuthor} from './bv-author/validator.js'
import {validateBvBug} from './bv-bug/validator.js'
import {validateBvChanges} from './bv-changes/validator.js'
import {validateBvDecision} from './bv-decision/validator.js'
import {validateBvDependencies} from './bv-dependencies/validator.js'
import {validateBvDiagram} from './bv-diagram/validator.js'
import {validateBvExamples} from './bv-examples/validator.js'
import {validateBvFact} from './bv-fact/validator.js'
import {validateBvFiles} from './bv-files/validator.js'
import {validateBvFix} from './bv-fix/validator.js'
import {validateBvFlow} from './bv-flow/validator.js'
import {validateBvHighlights} from './bv-highlights/validator.js'
import {validateBvPattern} from './bv-pattern/validator.js'
import {validateBvReason} from './bv-reason/validator.js'
import {validateBvRule} from './bv-rule/validator.js'
import {validateBvStructure} from './bv-structure/validator.js'
import {validateBvTask} from './bv-task/validator.js'
import {validateBvTimestamp} from './bv-timestamp/validator.js'
import {validateBvTopic} from './bv-topic/validator.js'

/**
 * Element registry — single source of truth for the closed `<bv-*>`
 * vocabulary. The vocabulary covers every section of the rendered .md
 * file (frontmatter + Reason + Raw Concept + Narrative + Facts) plus
 * three runbook elements (decision, bug, fix) that have no MD analog.
 * Vocabulary expansion is **purely additive**: add an entry here and
 * a `<name>/{schema,validator}.ts` pair under `elements/`. No consumer
 * (writer, reader, indexer, prompt template generator) needs touching
 * — they all walk this registry generically.
 *
 * The data-driven shape is a guardrail. If you find yourself writing
 * `switch (elementName)` anywhere in the render layer, push back: that
 * pattern doesn't scale to vocabulary growth.
 *
 * Notably absent: `importance`, `maturity`, `recency`, `updatedat`,
 * `createdAt`. Per the runtime-signals migration, ranking signals live
 * in the sidecar store keyed by relpath — not in topic file content.
 */
export const ELEMENT_REGISTRY: ElementRegistry = {
  'bv-author': {
    allowedChildren: 'inline',
    description:
      'Renders as `**Author:**` inside the `## Raw Concept` section — the ' +
      'person or system identifier responsible for the concept.',
    name: 'bv-author',
    optionalAttributes: [],
    requiredAttributes: [],
    validator: validateBvAuthor,
  },
  'bv-bug': {
    allowedChildren: 'block',
    description:
      'A bug runbook entry (symptom, root cause). Optional `id` and `severity` ' +
      '(low|medium|high|critical). Typically paired with a sibling `<bv-fix>`.',
    name: 'bv-bug',
    optionalAttributes: ['id', 'severity'],
    requiredAttributes: [],
    validator: validateBvBug,
  },
  'bv-changes': {
    allowedChildren: 'block',
    description:
      'Renders as `**Changes:**` inside the `## Raw Concept` section. ' +
      'Children should be `<li>` items.',
    name: 'bv-changes',
    optionalAttributes: [],
    requiredAttributes: [],
    validator: validateBvChanges,
  },
  'bv-decision': {
    allowedChildren: 'block',
    description:
      'A decision record (with rationale and evidence). Optional `id` for ' +
      'cross-referencing.',
    name: 'bv-decision',
    optionalAttributes: ['id'],
    requiredAttributes: [],
    validator: validateBvDecision,
  },
  'bv-dependencies': {
    allowedChildren: 'block',
    description:
      'Renders as the `### Dependencies` subsection inside `## Narrative` — ' +
      'dependencies, prerequisites, blockers.',
    name: 'bv-dependencies',
    optionalAttributes: [],
    requiredAttributes: [],
    validator: validateBvDependencies,
  },
  'bv-diagram': {
    allowedChildren: 'block',
    description:
      'Preserves a diagram (mermaid / plantuml / ascii / dot) verbatim. ' +
      'Optional `type` selects the fenced-code-block language tag; optional ' +
      '`title` becomes the diagram caption.',
    name: 'bv-diagram',
    optionalAttributes: ['type', 'title'],
    requiredAttributes: [],
    validator: validateBvDiagram,
  },
  'bv-examples': {
    allowedChildren: 'block',
    description:
      'Renders as the `### Examples` subsection inside `## Narrative` — ' +
      'worked examples, sample code, scenario walkthroughs.',
    name: 'bv-examples',
    optionalAttributes: [],
    requiredAttributes: [],
    validator: validateBvExamples,
  },
  'bv-fact': {
    allowedChildren: 'inline',
    description:
      'A structured fact rendered into the `## Facts` list. Text content is ' +
      'the canonical statement; optional attributes carry the structured ' +
      'extraction (subject, category in {personal|project|preference|' +
      'convention|team|environment|other}, value).',
    name: 'bv-fact',
    optionalAttributes: ['subject', 'category', 'value'],
    requiredAttributes: [],
    validator: validateBvFact,
  },
  'bv-files': {
    allowedChildren: 'block',
    description:
      'Renders as `**Files:**` inside the `## Raw Concept` section. ' +
      'Children should be `<li>` items.',
    name: 'bv-files',
    optionalAttributes: [],
    requiredAttributes: [],
    validator: validateBvFiles,
  },
  'bv-fix': {
    allowedChildren: 'block',
    description:
      'A fix runbook entry (steps to resolve a bug). Optional `id`. Typically ' +
      'the sibling of a `<bv-bug>`.',
    name: 'bv-fix',
    optionalAttributes: ['id'],
    requiredAttributes: [],
    validator: validateBvFix,
  },
  'bv-flow': {
    allowedChildren: 'inline',
    description:
      'Renders as `**Flow:**` inside the `## Raw Concept` section — ' +
      'process flow, workflow, or sequence of steps.',
    name: 'bv-flow',
    optionalAttributes: [],
    requiredAttributes: [],
    validator: validateBvFlow,
  },
  'bv-highlights': {
    allowedChildren: 'block',
    description:
      'Renders as the `### Highlights` subsection inside `## Narrative` — ' +
      'key highlights, capabilities, deliverables, notable outcomes.',
    name: 'bv-highlights',
    optionalAttributes: [],
    requiredAttributes: [],
    validator: validateBvHighlights,
  },
  'bv-pattern': {
    allowedChildren: 'inline',
    description:
      'Renders as a bullet entry under `**Patterns:**` in the `## Raw ' +
      'Concept` section. Element text content is the pattern itself ' +
      '(e.g., a regex). Optional `flags` and `description` attributes ' +
      'carry the structured fields. Multiple `<bv-pattern>` siblings ' +
      'inside `<bv-topic>` are collected into the bullet list.',
    name: 'bv-pattern',
    optionalAttributes: ['flags', 'description'],
    requiredAttributes: [],
    validator: validateBvPattern,
  },
  'bv-reason': {
    allowedChildren: 'block',
    description:
      'Renders as the `## Reason` body section — the curate operation\'s ' +
      '"why" stated for a human reviewer.',
    name: 'bv-reason',
    optionalAttributes: [],
    requiredAttributes: [],
    validator: validateBvReason,
  },
  'bv-rule': {
    allowedChildren: 'inline',
    description:
      'A rule statement the agent should follow. Optional `severity` ' +
      '(info|must|should) and `id` for cross-referencing.',
    name: 'bv-rule',
    optionalAttributes: ['severity', 'id'],
    requiredAttributes: [],
    validator: validateBvRule,
  },
  'bv-structure': {
    allowedChildren: 'block',
    description:
      'Renders as the `### Structure` subsection inside `## Narrative` — ' +
      'structural or organizational documentation (file layout, hierarchy).',
    name: 'bv-structure',
    optionalAttributes: [],
    requiredAttributes: [],
    validator: validateBvStructure,
  },
  'bv-task': {
    allowedChildren: 'inline',
    description:
      'Renders as `**Task:**` inside the `## Raw Concept` section — the ' +
      'task or subject this concept relates to.',
    name: 'bv-task',
    optionalAttributes: [],
    requiredAttributes: [],
    validator: validateBvTask,
  },
  'bv-timestamp': {
    allowedChildren: 'inline',
    description:
      'Renders as `**Timestamp:**` inside the `## Raw Concept` section — ' +
      'the date the concept\'s data represents (distinct from the file\'s ' +
      'createdAt/updatedAt frontmatter, which is system-set).',
    name: 'bv-timestamp',
    optionalAttributes: [],
    requiredAttributes: [],
    validator: validateBvTimestamp,
  },
  'bv-topic': {
    allowedChildren: 'any',
    description:
      'Root container per topic file. Carries frontmatter as attributes ' +
      '(title, summary, tags, keywords, related, path). Required: `path`, ' +
      '`title`. Note: attribute names MUST be lowercase — HTML5 normalizes ' +
      'them at parse time. Runtime signals (importance/maturity/recency) ' +
      'are sidecar state and are NOT carried as attributes.',
    name: 'bv-topic',
    optionalAttributes: ['summary', 'tags', 'keywords', 'related'],
    requiredAttributes: ['path', 'title'],
    validator: validateBvTopic,
  },
}
