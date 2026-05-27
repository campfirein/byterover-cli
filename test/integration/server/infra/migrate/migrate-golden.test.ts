/**
 * Golden-baseline integration test for the TS migrator.
 *
 * Asserts byte-equal HTML + warnings list against the captured Python
 * oracle output for every fixture below. Fixtures are inlined — no
 * separate fixture files on disk.
 */

import {expect} from 'chai'

import {convertMarkdownTopicToHtml} from '../../../../../src/server/infra/migrate/convert.js'

// 2023-11-14T22:13:20.000Z — pinned mtime so the missing-timestamps
// fallback warning is deterministic across runs.
const FIXED_MTIME_MS = 1_700_000_000_000

type Fixture = {
  expectedHtml: string
  expectedWarnings: string[]
  input: string
  name: string
  relPath: string
}

const FIXTURES: Fixture[] = [
  {
    "expectedHtml": "<bv-topic path=\"docs/h1-fallback\" title=\"H1 Body Title\" tags=\"docs\" createdat=\"2023-11-14T22:13:20.000Z\" updatedat=\"2023-11-14T22:13:20.000Z\">\n  <bv-reason>Anchor topic.</bv-reason>\n</bv-topic>",
    "expectedWarnings": [
      "missing-timestamps: using stat.mtime fallback (2023-11-14T22:13:20.000Z)"
    ],
    "input": "---\ntags: [docs]\n---\n\n# H1 Body Title\n\n## Reason\nAnchor topic.\n",
    "name": "case-01-h1-title-fallback",
    "relPath": "docs/h1-fallback.md"
  },
  {
    "expectedHtml": "<bv-topic path=\"intro/overview\" title=\"Overview demo\" createdat=\"2023-11-14T22:13:20.000Z\" updatedat=\"2023-11-14T22:13:20.000Z\">\n  <bv-reason>This overview explains the intent of the topic.</bv-reason>\n  <bv-fact>system has 3 components</bv-fact>\n</bv-topic>",
    "expectedWarnings": [
      "missing-timestamps: using stat.mtime fallback (2023-11-14T22:13:20.000Z)"
    ],
    "input": "---\ntitle: Overview demo\n---\n\n## Overview\nThis overview explains the intent of the topic.\n\n## Facts\n- system has 3 components\n",
    "name": "case-02-orphan-overview-to-reason",
    "relPath": "intro/overview.md"
  },
  {
    "expectedHtml": "<bv-topic path=\"ops/keys\" title=\"Unknown key\" createdat=\"2023-11-14T22:13:20.000Z\" updatedat=\"2023-11-14T22:13:20.000Z\">\n  <bv-reason>Anchor.</bv-reason>\n</bv-topic>",
    "expectedWarnings": [
      "dropped-frontmatter-key:weird_key",
      "missing-timestamps: using stat.mtime fallback (2023-11-14T22:13:20.000Z)"
    ],
    "input": "---\ntitle: Unknown key\nweird_key: some value\nimportance: 0.5\n---\n\n## Reason\nAnchor.\n",
    "name": "case-03-unknown-frontmatter-key",
    "relPath": "ops/keys.md"
  },
  {
    "expectedHtml": "<bv-topic path=\"intro/lede\" title=\"Lede demo\" summary=\"This lede paragraph should land in the summary attribute.\" createdat=\"2023-11-14T22:13:20.000Z\" updatedat=\"2023-11-14T22:13:20.000Z\">\n  <bv-reason>Anchor.</bv-reason>\n</bv-topic>",
    "expectedWarnings": [
      "missing-timestamps: using stat.mtime fallback (2023-11-14T22:13:20.000Z)"
    ],
    "input": "---\ntitle: Lede demo\n---\n\n# Lede Demo\n\nThis lede paragraph should land in the summary attribute.\n\nIt can have multiple sentences in the first paragraph.\n\n## Reason\nAnchor.\n",
    "name": "case-04-lede-paragraph-hoist",
    "relPath": "intro/lede.md"
  },
  {
    "expectedHtml": "<bv-topic path=\"ops/rule-prefix\" title=\"Rule N splitter\" createdat=\"2023-11-14T22:13:20.000Z\" updatedat=\"2023-11-14T22:13:20.000Z\">\n  <bv-rule severity=\"must\" id=\"r-validate-input-before-persisting\">MUST validate input before persisting.</bv-rule>\n  <bv-rule severity=\"should\" id=\"r-avoid-silent-failures\">SHOULD avoid silent failures.</bv-rule>\n</bv-topic>",
    "expectedWarnings": [
      "missing-timestamps: using stat.mtime fallback (2023-11-14T22:13:20.000Z)"
    ],
    "input": "---\ntitle: Rule N splitter\n---\n\n## Narrative\n### Rules\nRule 1: MUST validate input before persisting.\nRule 2: SHOULD avoid silent failures.\n",
    "name": "case-05-rule-n-prefix-splitter",
    "relPath": "ops/rule-prefix.md"
  },
  {
    "expectedHtml": "<bv-topic path=\"diagrams/all-fences\" title=\"Fence promotion\" createdat=\"2023-11-14T22:13:20.000Z\" updatedat=\"2023-11-14T22:13:20.000Z\">\n  <bv-reason>Anchor.\n\n**Sample**\n```python\nprint(&quot;hi&quot;)\n```</bv-reason>\n  <bv-diagram type=\"mermaid\" title=\"Architecture\"><pre><code>graph LR; A --&gt; B</code></pre></bv-diagram>\n  <bv-diagram type=\"other\" title=\"Sample\"><pre><code>print(&quot;hi&quot;)</code></pre></bv-diagram>\n  <bv-diagram type=\"mermaid\" title=\"Architecture\"><pre><code>graph LR; A --&gt; B</code></pre></bv-diagram>\n</bv-topic>",
    "expectedWarnings": [
      "missing-timestamps: using stat.mtime fallback (2023-11-14T22:13:20.000Z)"
    ],
    "input": "---\ntitle: Fence promotion\n---\n\n## Reason\nAnchor.\n\n**Sample**\n```python\nprint(\"hi\")\n```\n\n## Narrative\n### Diagrams\n\n**Architecture**\n```mermaid\ngraph LR; A --> B\n```\n",
    "name": "case-06-fenced-blocks-promote-to-diagram",
    "relPath": "diagrams/all-fences.md"
  },
  {
    "expectedHtml": "<bv-topic path=\"tasks/plurals\" title=\"Plural labels\" createdat=\"2023-11-14T22:13:20.000Z\" updatedat=\"2023-11-14T22:13:20.000Z\">\n  <bv-task>Implement plural support across the parser.</bv-task>\n  <bv-files><li>src/a.ts</li><li>src/b.ts</li></bv-files>\n  <bv-pattern flags=\"i\" description=\"matches foo\">^foo$</bv-pattern>\n</bv-topic>",
    "expectedWarnings": [
      "missing-timestamps: using stat.mtime fallback (2023-11-14T22:13:20.000Z)"
    ],
    "input": "---\ntitle: Plural labels\n---\n\n## Raw Concept\n**Tasks:**\nImplement plural support across the parser.\n\n**Files:**\n- src/a.ts\n- src/b.ts\n\n**Patterns:**\n- `^foo$` (flags: i) - matches foo\n",
    "name": "case-07-plural-raw-concept-labels",
    "relPath": "tasks/plurals.md"
  },
  {
    "expectedHtml": "<bv-topic path=\"patterns/narrative-extras\" title=\"Narrative extras\" createdat=\"2023-11-14T22:13:20.000Z\" updatedat=\"2023-11-14T22:13:20.000Z\">\n  <bv-pattern>one</bv-pattern>\n  <bv-pattern>two</bv-pattern>\n  <bv-pattern>three</bv-pattern>\n</bv-topic>",
    "expectedWarnings": [
      "missing-timestamps: using stat.mtime fallback (2023-11-14T22:13:20.000Z)",
      "dropped-narrative-subsection:Mystery (42 chars)"
    ],
    "input": "---\ntitle: Narrative extras\n---\n\n## Narrative\n### Patterns\n- one\n- two\n- three\n\n### Decisions\n- chose X over Y because Z\n\n### Mystery\n- this subsection has no heuristic mapping\n",
    "name": "case-08-narrative-subsection-heuristic",
    "relPath": "patterns/narrative-extras.md"
  },
  {
    "expectedHtml": "<bv-topic path=\"facts/loose-bullets\" title=\"Loose bullets\" createdat=\"2023-11-14T22:13:20.000Z\" updatedat=\"2023-11-14T22:13:20.000Z\">\n  <bv-fact>dash fact</bv-fact>\n  <bv-fact>asterisk fact</bv-fact>\n  <bv-fact>plus fact</bv-fact>\n  <bv-fact>numbered fact</bv-fact>\n  <bv-fact>another numbered fact</bv-fact>\n</bv-topic>",
    "expectedWarnings": [
      "missing-timestamps: using stat.mtime fallback (2023-11-14T22:13:20.000Z)"
    ],
    "input": "---\ntitle: Loose bullets\n---\n\n## Facts\n- dash fact\n* asterisk fact\n+ plus fact\n1. numbered fact\n2. another numbered fact\n",
    "name": "case-09-loose-bullets-in-facts",
    "relPath": "facts/loose-bullets.md"
  },
  {
    "expectedHtml": "<bv-topic path=\"ops/rule-dedup\" title=\"Rule dedup\" createdat=\"2023-11-14T22:13:20.000Z\" updatedat=\"2023-11-14T22:13:20.000Z\">\n  <bv-rule severity=\"must\" id=\"r-validate-input-before-persisting\">MUST validate input before persisting</bv-rule>\n  <bv-rule severity=\"must\" id=\"r-validate-input-before-persisting-2\">MUST validate input before persisting</bv-rule>\n  <bv-rule severity=\"should\" id=\"r-log-every-failure\">SHOULD log every failure</bv-rule>\n</bv-topic>",
    "expectedWarnings": [
      "missing-timestamps: using stat.mtime fallback (2023-11-14T22:13:20.000Z)"
    ],
    "input": "---\ntitle: Rule dedup\n---\n\n## Narrative\n### Rules\n- MUST validate input before persisting\n\n## Rules\n- MUST validate input before persisting\n- SHOULD log every failure\n",
    "name": "case-10-rule-id-dedup-across-canonical-orphan",
    "relPath": "ops/rule-dedup.md"
  },
  {
    "expectedHtml": "<bv-topic path=\"frontmatter/hash-hazard\" title=\"hash hazard demo\" summary=\"a value\" createdat=\"2023-11-14T22:13:20.000Z\" updatedat=\"2023-11-14T22:13:20.000Z\">\n  <bv-reason>Anchor.</bv-reason>\n</bv-topic>",
    "expectedWarnings": [
      "yaml-comment-truncation:title value contains ' #' — PyYAML treats as inline comment, likely silently truncating",
      "yaml-comment-truncation:summary value contains ' #' — PyYAML treats as inline comment, likely silently truncating",
      "missing-timestamps: using stat.mtime fallback (2023-11-14T22:13:20.000Z)"
    ],
    "input": "---\ntitle: hash hazard demo # demo\nsummary: a value # everything after this is gone\n---\n\n## Reason\nAnchor.\n",
    "name": "case-11-yaml-hash-truncation-hazard",
    "relPath": "frontmatter/hash-hazard.md"
  },
  {
    "expectedHtml": "<bv-topic path=\"frontmatter/typed\" title=\"H1 Title For Fallback\" tags=\"good,also good\" createdat=\"2023-11-14T22:13:20.000Z\" updatedat=\"2023-11-14T22:13:20.000Z\">\n  <bv-reason>Anchor.</bv-reason>\n</bv-topic>",
    "expectedWarnings": [
      "frontmatter-type-mismatch:title expected string, got int",
      "frontmatter-type-mismatch:summary expected string, got list",
      "frontmatter-type-mismatch:tags contained 1 non-string element(s) — dropped",
      "frontmatter-type-mismatch:related expected string or list, got int",
      "missing-timestamps: using stat.mtime fallback (2023-11-14T22:13:20.000Z)"
    ],
    "input": "---\ntitle: 42\nsummary:\n  - this\n  - is\n  - a list\ntags:\n  - good\n  - 99\n  - also good\nrelated: 7\n---\n\n# H1 Title For Fallback\n\n## Reason\nAnchor.\n",
    "name": "case-13-type-checked-frontmatter",
    "relPath": "frontmatter/typed.md"
  },
  {
    "expectedHtml": "<bv-topic path=\"syn/empty\" title=\"Empty body\" summary=\"An entirely-empty body produces a minimal bv-topic.\" createdat=\"2023-11-14T22:13:20.000Z\" updatedat=\"2023-11-14T22:13:20.000Z\"></bv-topic>",
    "expectedWarnings": [
      "missing-timestamps: using stat.mtime fallback (2023-11-14T22:13:20.000Z)"
    ],
    "input": "---\ntitle: Empty body\nsummary: An entirely-empty body produces a minimal bv-topic.\n---\n",
    "name": "syn-14-frontmatter-only-empty-body",
    "relPath": "syn/empty.md"
  },
  {
    "expectedHtml": "<bv-topic path=\"syn/whitespace\" title=\"Whitespace only\" createdat=\"2023-11-14T22:13:20.000Z\" updatedat=\"2023-11-14T22:13:20.000Z\"></bv-topic>",
    "expectedWarnings": [
      "missing-timestamps: using stat.mtime fallback (2023-11-14T22:13:20.000Z)"
    ],
    "input": "---\ntitle: Whitespace only\n---\n\n\n\n\n",
    "name": "syn-15-whitespace-body",
    "relPath": "syn/whitespace.md"
  },
  {
    "expectedHtml": "<bv-topic path=\"syn/fenced-rules\" title=\"Fenced inside rules\" summary=\"Rule 2: also fake\n```\nRule 2: MUST do thing two.\" createdat=\"2023-11-14T22:13:20.000Z\" updatedat=\"2023-11-14T22:13:20.000Z\">\n  <bv-rule severity=\"must\" id=\"r-do-thing-one\">MUST do thing one.</bv-rule>\n  <bv-rule severity=\"must\" id=\"r-do-thing-two\">MUST do thing two.</bv-rule>\n  <bv-diagram type=\"other\"><pre><code>## not a section\n# also not a rule\nRule 2: also fake</code></pre></bv-diagram>\n</bv-topic>",
    "expectedWarnings": [
      "missing-timestamps: using stat.mtime fallback (2023-11-14T22:13:20.000Z)"
    ],
    "input": "---\ntitle: Fenced inside rules\n---\n\n## Narrative\n### Rules\nRule 1: MUST do thing one.\n```python\n## not a section\n# also not a rule\nRule 2: also fake\n```\nRule 2: MUST do thing two.\n",
    "name": "syn-16-fenced-inside-rules",
    "relPath": "syn/fenced-rules.md"
  },
  {
    "expectedHtml": "<bv-topic path=\"syn/mixed-bullets\" title=\"Mixed bullets\" createdat=\"2023-11-14T22:13:20.000Z\" updatedat=\"2023-11-14T22:13:20.000Z\">\n  <bv-changes><li>dash change</li><li>asterisk change</li><li>plus change</li><li>numbered change</li></bv-changes>\n</bv-topic>",
    "expectedWarnings": [
      "missing-timestamps: using stat.mtime fallback (2023-11-14T22:13:20.000Z)"
    ],
    "input": "---\ntitle: Mixed bullets\n---\n\n## Raw Concept\n**Changes:**\n- dash change\n* asterisk change\n+ plus change\n1. numbered change\n",
    "name": "syn-17-mixed-bullets-changes",
    "relPath": "syn/mixed-bullets.md"
  },
  {
    "expectedHtml": "<bv-topic path=\"syn/lowercase-canonical\" title=\"Lowercase canonical\" createdat=\"2023-11-14T22:13:20.000Z\" updatedat=\"2023-11-14T22:13:20.000Z\">\n  <bv-reason>foo</bv-reason>\n</bv-topic>",
    "expectedWarnings": [
      "missing-timestamps: using stat.mtime fallback (2023-11-14T22:13:20.000Z)",
      "dropped-snippets: 1 legacy '---'-separated snippets discarded (no <bv-snippet> element)"
    ],
    "input": "---\ntitle: Lowercase canonical\n---\n\n## reason\nfoo\n\n---\n\nlegacy snippet content that should be dropped with a warning.\n",
    "name": "syn-18-lowercase-canonical-with-snippet",
    "relPath": "syn/lowercase-canonical.md"
  },
  {
    "expectedHtml": "<bv-topic path=\"syn/unterminated\" title=\"unterminated\" createdat=\"2023-11-14T22:13:20.000Z\" updatedat=\"2023-11-14T22:13:20.000Z\">\n  <bv-reason>Anchor.</bv-reason>\n</bv-topic>",
    "expectedWarnings": [
      "malformed-frontmatter: unterminated-frontmatter-delimiter",
      "missing-timestamps: using stat.mtime fallback (2023-11-14T22:13:20.000Z)"
    ],
    "input": "---\ntitle: Unterminated\nsummary: no closing delim follows\n\n## Reason\nAnchor.\n",
    "name": "syn-19-unterminated-frontmatter",
    "relPath": "syn/unterminated.md"
  },
  {
    "expectedHtml": "<bv-topic path=\"node.js/intro\" title=\"Multi-dot file\" createdat=\"2023-11-14T22:13:20.000Z\" updatedat=\"2023-11-14T22:13:20.000Z\">\n  <bv-reason>Anchor.</bv-reason>\n</bv-topic>",
    "expectedWarnings": [
      "missing-timestamps: using stat.mtime fallback (2023-11-14T22:13:20.000Z)"
    ],
    "input": "---\ntitle: Multi-dot file\n---\n\n## Reason\nAnchor.\n",
    "name": "syn-20-multi-dot-filename",
    "relPath": "node.js/intro.md"
  }
]

// Exact case roster — locked so accidental fixture loss / dedup / rename
// is caught up front instead of silently passing the loop.
const EXPECTED_CASE_NAMES = [
  'case-01-h1-title-fallback',
  'case-02-orphan-overview-to-reason',
  'case-03-unknown-frontmatter-key',
  'case-04-lede-paragraph-hoist',
  'case-05-rule-n-prefix-splitter',
  'case-06-fenced-blocks-promote-to-diagram',
  'case-07-plural-raw-concept-labels',
  'case-08-narrative-subsection-heuristic',
  'case-09-loose-bullets-in-facts',
  'case-10-rule-id-dedup-across-canonical-orphan',
  'case-11-yaml-hash-truncation-hazard',
  'case-13-type-checked-frontmatter',
  'syn-14-frontmatter-only-empty-body',
  'syn-15-whitespace-body',
  'syn-16-fenced-inside-rules',
  'syn-17-mixed-bullets-changes',
  'syn-18-lowercase-canonical-with-snippet',
  'syn-19-unterminated-frontmatter',
  'syn-20-multi-dot-filename',
]

describe('migrate/convert — golden baseline against Python oracle', () => {
  it('has the exact expected fixture roster', () => {
    expect(FIXTURES.map((f) => f.name)).to.deep.equal(EXPECTED_CASE_NAMES)
  })

  for (const f of FIXTURES) {
    describe(f.name, () => {
      const actual = convertMarkdownTopicToHtml({
        markdown: f.input,
        mtimeMs: FIXED_MTIME_MS,
        relPath: f.relPath,
      })

      it('HTML matches oracle byte-for-byte', () => {
        expect(actual.html).to.equal(f.expectedHtml)
      })

      it('warnings match oracle', () => {
        expect(actual.warnings).to.deep.equal(f.expectedWarnings)
      })
    })
  }
})
