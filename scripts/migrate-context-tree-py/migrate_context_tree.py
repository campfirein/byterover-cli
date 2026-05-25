#!/usr/bin/env python3
"""
ENG-2834 — Markdown-to-HTML context-tree migration script.

One-shot, offline, no-daemon migrator that converts a project's
`.brv/context-tree/` from Markdown topic files to `<bv-topic>` HTML
documents matching the format `proj/byterover-tool-mode`'s curate
flow writes today.

Scope (per the Linear ticket): walk `.brv/context-tree/`, route every
entry into one of four outcomes:
  - topic .md  -> emit `.html` + archive the source `.md`
  - derived    -> archive without emitting HTML (no HTML equivalent
                  for `_index.md`, `.abstract.md`, `.overview.md`,
                  `_manifest.json` in the current pipeline)
  - archived/  -> skip entirely (subtree out of migration scope; no
                  `<bv-archive-stub>` element in the vocabulary)
  - failed     -> archive the source `.md` and mark as failed

After one run the live `.brv/context-tree/` contains zero `.md` files
outside `_archived/`. Every markdown the migrator touches ends up in
either the HTML output (live tree) or the archive — never both, never
lingering in `.brv/context-tree/` as `.md`. The archive root is
`.brv/_migrations/context-tree-md-<YYYY-MM-DD>/`, flat-mirroring the
source tree structure. `--dry-run` runs classification + conversion
in memory only.

Output contract: the migrated HTML uses ONLY the closed `bv-*`
vocabulary defined in `src/server/infra/render/elements/registry.ts`
on `proj/byterover-tool-mode`. Non-bv-* elements are NOT emitted —
the render pipeline would silently skip them (see html-reader.ts:77,
html-renderer.ts:155), making any preservation in `<p>`/`<section>`
dead content from the brv pipeline's perspective. Content that has
no clean bv-* target is dropped with a per-file warning so the
operator can see exactly what was lost.

Heuristic recovery (cases 1, 2, 4, 7, 8): orphan section content
(`## Overview`, `## Architecture`, `## Evidence`, etc.) is mapped to
the nearest semantically-fitting bv-* element when the canonical
counterpart is empty. Conflict resolution: canonical wins, orphan
content is dropped + warned.

Usage:
    python migrate_context_tree.py --project-root /path/to/project
    python migrate_context_tree.py --dry-run --project-root .
    python migrate_context_tree.py --rollback --project-root .
"""

from __future__ import annotations

import argparse
import datetime
import json
import re
import shutil
import sys
from pathlib import Path
from typing import Optional, Tuple

import yaml


class FrontmatterLoader(yaml.SafeLoader):
    pass


FrontmatterLoader.yaml_implicit_resolvers = {
    key: list(value)
    for key, value in yaml.SafeLoader.yaml_implicit_resolvers.items()
}
for ch, resolvers in list(FrontmatterLoader.yaml_implicit_resolvers.items()):
    FrontmatterLoader.yaml_implicit_resolvers[ch] = [
        (tag, regexp)
        for tag, regexp in resolvers
        if tag != "tag:yaml.org,2002:timestamp"
    ]


# =============================================================================
# Constants — mirrored from byterover-cli's TypeScript constants.ts
# =============================================================================

BRV_DIR = ".brv"
CONTEXT_TREE_DIR = "context-tree"
MIGRATIONS_DIR = "_migrations"
ARCHIVE_FOLDER_PREFIX = "context-tree-md-"

ARCHIVE_DIR = "_archived"
SUMMARY_INDEX_FILE = "_index.md"
ABSTRACT_EXTENSION = ".abstract.md"
OVERVIEW_EXTENSION = ".overview.md"
MANIFEST_FILE = "_manifest.json"

# Manifest written into the archive root listing relative .md paths
# whose .html siblings already existed BEFORE migration started. The
# rollback path reads this list so it doesn't delete .html files that
# predated the migration (which would be destructive data loss on
# mixed trees).
PRE_EXISTING_HTML_MANIFEST = "_pre_existing_html_siblings.json"

# Canonical body sections produced by the markdown writer; everything
# else is treated as an orphan section and routed through the heading-
# name heuristic map below.
KNOWN_SECTION_HEADINGS = {"Reason", "Raw Concept", "Narrative", "Facts", "Relations"}

# Diagram type enum from `<bv-diagram type>` schema.
DIAGRAM_TYPES = {"mermaid", "plantuml", "ascii", "dot", "graphviz", "other"}

# Fact category enum from `<bv-fact category>` schema.
FACT_CATEGORIES = {
    "personal",
    "project",
    "preference",
    "convention",
    "team",
    "environment",
    "other",
}

# Frontmatter keys the migrator maps to <bv-topic> attributes. Anything
# else is either a runtime-signal (allow-listed below, dropped silently)
# or unknown content metadata (warned + dropped).
KNOWN_FRONTMATTER_KEYS_CONTENT = {
    "title",
    "summary",
    "tags",
    "keywords",
    "related",
    "relateds",
    "createdAt",
    "updatedAt",
    "short_description",
}

# Runtime signals live in the sidecar store per the runtime-signals
# migration. They're frontmatter today but intentionally dropped at
# migration time — no warning emitted.
RUNTIME_SIGNAL_FRONTMATTER_KEYS = {
    "importance",
    "recency",
    "maturity",
    "accessCount",
    "updateCount",
}

# Heading-name heuristic — orphan `## X` sections route to bv-*
# elements when the canonical counterpart is empty. Keys are lowercase;
# values describe the routing strategy used by _process_orphan_sections.
#
# Strategies:
#   reason_if_empty           — populate <bv-reason> if canonical is empty
#   structure_if_empty        — populate <bv-structure> if canonical empty
#   dependencies_if_empty     — populate <bv-dependencies> if empty
#   highlights_if_empty       — populate <bv-highlights> if empty
#   examples_if_empty         — populate <bv-examples> if empty
#   summary_attr_if_empty     — populate <bv-topic summary> attr if empty
#   rules_split               — split into multiple <bv-rule> siblings (append)
#   patterns_multiple         — bullets become <bv-pattern> siblings (append)
#   decisions_multiple        — bullets become <bv-decision> siblings (append)
#   facts_parse               — bullets parsed as <bv-fact> siblings (append)
ORPHAN_H2_HEURISTIC = {
    "abstract": "summary_attr_if_empty",
    "overview": "reason_if_empty",
    "summary": "summary_attr_if_empty",
    "purpose": "reason_if_empty",
    "architecture": "structure_if_empty",
    "structure": "structure_if_empty",
    "scope": "structure_if_empty",
    "dependencies": "dependencies_if_empty",
    "highlights": "highlights_if_empty",
    "features": "highlights_if_empty",
    "examples": "examples_if_empty",
    "rules": "rules_split",
    "patterns": "patterns_multiple",
    "decisions": "decisions_multiple",
    "evidence": "facts_parse",
}

# Heuristic for unknown `### X` subsections under `## Narrative` (case
# 8). Same value semantics as ORPHAN_H2_HEURISTIC.
NARRATIVE_SUBSECTION_HEURISTIC = {
    "patterns": "patterns_multiple",
    "decisions": "decisions_multiple",
    "overview": "structure_if_empty",
}

# `## Raw Concept` recognized labels under bold-heading form
# `**Label:**`. Plural-tolerant per case 7 — both singular and plural
# forms route to the same bv-* element.
RAW_CONCEPT_LABEL_MAP = {
    "task": "task",
    "tasks": "task",
    "change": "changes",
    "changes": "changes",
    "file": "files",
    "files": "files",
    "flow": "flow",
    "flows": "flow",
    "timestamp": "timestamp",
    "timestamps": "timestamp",
    "author": "author",
    "authors": "author",
    "pattern": "patterns",
    "patterns": "patterns",
}


# =============================================================================
# Heuristic-map — pure functions
# =============================================================================


def infer_rule_severity(text: str) -> Optional[str]:
    """Return RFC2119 severity ('must'|'should'|'info') or None when no
    keyword is present. Word boundaries are enforced so 'trust' doesn't
    match MUST. Precedence (must > should > info) handles sentences with
    multiple keywords.
    """
    if re.search(r"\b(MUST|SHALL)\b", text, re.IGNORECASE):
        return "must"
    if re.search(r"\bSHOULD\b", text, re.IGNORECASE):
        return "should"
    if re.search(r"\b(MAY|INFO)\b", text, re.IGNORECASE):
        return "info"
    return None


# Strip RFC2119 keywords from rule text when building an id so the
# slug reflects the rule's content rather than the keyword itself.
_RFC2119_STRIP = re.compile(r"\b(MUST|SHALL|SHOULD|MAY|INFO)\b", re.IGNORECASE)


def slugify_rule_id(text: str, prefix: str) -> str:
    """Generate a stable kebab-case id from rule text. Strips RFC2119
    keywords, normalises to ASCII alphanumerics + hyphens, takes the
    first ~6 words, and prefixes with the supplied marker.

    Returns '<prefix>-rule' for empty/all-stopword input so callers
    always have a non-empty id."""
    cleaned = _RFC2119_STRIP.sub(" ", text).lower()
    cleaned = re.sub(r"[^a-z0-9\s-]", " ", cleaned)
    words = [w for w in cleaned.split() if w]
    words = words[:6]
    if not words:
        return f"{prefix}-rule"
    slug = "-".join(words)
    slug = re.sub(r"-{2,}", "-", slug).strip("-")
    if len(slug) > 48:
        slug = slug[:48].rsplit("-", 1)[0] if "-" in slug[:48] else slug[:48]
    return f"{prefix}-{slug}"


# Case 5: detect "Rule N:" / "Rule N." prefix as a splitter pattern.
# Curator output frequently uses this form (a) on consecutive lines
# with no blank between (defeats the paragraph fallback), or (b) on
# the SAME line separated only by a sentence-ending period.
#
# Matches when the prefix appears at line start (`^`) or immediately
# after a sentence-ending punctuation + whitespace. The lookbehind
# avoids splitting on mid-sentence mentions like "similar to Rule 3:".
_RULE_PREFIX_LINE = re.compile(
    r"(?m)(?:^|(?<=[.!?])\s+)Rule\s*\d+\s*[:.\)]\s*",
    re.IGNORECASE,
)


def split_rules_block(rules_text: str) -> list[dict]:
    """Split a markdown `### Rules` block into individual rule entries.

    Detection priority (case 5 — new):
      1. dash/asterisk/plus bullets (`-`, `*`, `+`)
      2. numbered list (`1.`, `2.`)
      3. "Rule N:" / "Rule N." prefix on consecutive lines
      4. blank-line-separated paragraphs

    Each entry carries `text`, optional `severity`, and a unique `id`.
    """
    trimmed = rules_text.strip()
    if not trimmed:
        return []

    # Detect bullet style on the ORIGINAL (not flattened) text so
    # multi-line items with indented continuations are kept together
    # (codex finding — line-flat splitter drops continuations).
    has_bullets = bool(re.search(r"(?m)^[-*+]\s+\S", trimmed))
    has_numbered = bool(re.search(r"(?m)^\d+\.\s+\S", trimmed))

    items: list[str]
    if has_bullets or has_numbered:
        items = _collect_bullet_items_with_continuations(trimmed)
    elif _RULE_PREFIX_LINE.search(trimmed):
        # Case 5: split on "Rule N:" prefix occurrences. The first
        # element of `parts` is the text BEFORE the first prefix —
        # almost always an intro paragraph, not a rule. Drop it; if
        # the section is purely intro with no prefixes the paragraph
        # fallback would have handled it instead.
        parts = _RULE_PREFIX_LINE.split(trimmed)
        items = [p.strip() for p in parts[1:] if p.strip()]
    else:
        items = [p.strip() for p in re.split(r"\n\s*\n", trimmed) if p.strip()]

    seen_ids: set[str] = set()
    out: list[dict] = []
    for text in items:
        base_id = slugify_rule_id(text, "r")
        rule_id = base_id
        suffix = 2
        while rule_id in seen_ids:
            rule_id = f"{base_id}-{suffix}"
            suffix += 1
        seen_ids.add(rule_id)

        severity = infer_rule_severity(text)
        entry: dict = {"id": rule_id, "text": text}
        if severity is not None:
            entry["severity"] = severity
        out.append(entry)
    return out


def normalize_diagram_type(type_: str) -> str:
    """Collapse a diagram type label to the bv-diagram schema enum.
    Empty input defaults to 'ascii' (the MD writer's historical default
    for unlabelled fenced blocks). Unknown labels collapse to 'other'.
    """
    if not type_:
        return "ascii"
    lowered = type_.lower()
    return lowered if lowered in DIAGRAM_TYPES else "other"


def normalize_fact_category(category: Optional[str]) -> Optional[str]:
    """Collapse a fact category to the bv-fact schema enum, or None
    when input is None so the attribute can be omitted entirely."""
    if category is None:
        return None
    lowered = category.lower()
    return lowered if lowered in FACT_CATEGORIES else "other"


def escape_html_text(s: str) -> str:
    """Entity-encode the five HTML special characters. `&` is escaped
    first so subsequent encodings of `<`/`>`/quotes do not get
    double-encoded.
    """
    return (
        s.replace("&", "&amp;")
        .replace("<", "&lt;")
        .replace(">", "&gt;")
        .replace('"', "&quot;")
        .replace("'", "&#39;")
    )


def rel_path_to_topic_path(rel_path: str) -> str:
    """Convert `security/auth.md` -> `security/auth`. Normalises
    backslashes; rejects traversal segments so the migrated topic
    passes the HTML writer's path safety check."""
    normalized = rel_path.replace("\\", "/").lstrip("/")
    segments = [s for s in normalized.split("/") if s]
    for seg in segments:
        if seg in ("..", "."):
            raise ValueError(f"Topic path contains unsafe segment '{seg}': {rel_path}")
    joined = "/".join(segments)
    return joined[:-3] if joined.endswith(".md") else joined


_SECTION_REGEX = re.compile(r"^##\s+([^\n]+?)\s*$([\s\S]*?)(?=^##\s|\Z)", re.MULTILINE)

# Case 6: line-anchor the optional **Title** prefix so a `**bold**` mid-
# sentence preceding a fence doesn't become a spurious diagram title.
# The title line must start at column 0 (or right after a newline) and
# be immediately followed by the fence opener.
_FENCED_BLOCK_REGEX = re.compile(
    r"(?:(?:^|\n)\*\*(.+?)\*\*\s*\n)?```(\w*)\n([\s\S]*?)```"
)

# Case 5 (rules splitter) and case 5 (section regex) both need to ignore
# content inside fenced code blocks so that a literal `## ...` line or a
# `Rule N:` line inside a fence doesn't terminate / split anything.
# Mask fenced regions with same-length whitespace so byte spans stay
# aligned with the original text.
_FENCE_MASK_REGEX = re.compile(r"```[\s\S]*?```|~~~[\s\S]*?~~~")


def _mask_fenced_blocks(text: str) -> str:
    """Replace fenced code blocks with equal-length whitespace so
    structural regexes (`## heading`, `Rule N:` splitter, etc.) can
    walk the text without false-matching inside code samples. Caller
    must read original content via byte-span slicing into the source
    text — character positions are preserved by the masking."""
    return _FENCE_MASK_REGEX.sub(lambda m: " " * len(m.group()), text)


def _list_orphan_sections(body: str) -> list[dict]:
    """Walk a markdown body and return every `## X` section whose
    heading is not in the canonical set. Each entry: heading, content.

    Case 5 — runs the section regex against a fence-masked copy of
    the body so a literal `## ...` line inside a ` ``` ` block doesn't
    terminate the enclosing section. Content is sliced back out of the
    original body via the matched span so fenced code survives intact.
    """
    masked = _mask_fenced_blocks(body)
    out: list[dict] = []
    for m in _SECTION_REGEX.finditer(masked):
        heading = m.group(1).strip()
        if heading in KNOWN_SECTION_HEADINGS:
            continue
        content = body[m.start(2):m.end(2)].strip()
        if not content:
            continue
        out.append({"heading": heading, "content": content})
    return out


# =============================================================================
# Markdown body parsers — mirror MarkdownWriter.parseContent (TS)
# =============================================================================


def _parse_frontmatter(content: str) -> Tuple[Optional[dict], str, str, Optional[str]]:
    """Extract YAML frontmatter from the head of the file.

    Returns (frontmatter_dict, body, raw_yaml_block, parse_error).
    `parse_error` is None on success; a short string describing the
    failure when YAML parsing fails or the parsed value isn't a dict.
    Callers should surface non-None `parse_error` as an operator-
    visible warning so broken frontmatter is never silently dropped.

    When no frontmatter is found at all, returns (None, original, '', None)
    — that's a content-shape signal, not a parse failure."""
    if not (content.startswith("---\n") or content.startswith("---\r\n")):
        return None, content, "", None

    lf = content.find("\n---\n", 4)
    crlf = content.find("\r\n---\r\n", 5)
    is_crlf = lf == -1
    end = crlf if is_crlf else lf
    if end < 0:
        return None, content, "", "unterminated-frontmatter-delimiter"

    delim = 7 if is_crlf else 5
    yaml_block = content[5 if is_crlf else 4 : end]
    body = content[end + delim :]

    try:
        parsed = yaml.load(yaml_block, Loader=FrontmatterLoader)
    except yaml.YAMLError as e:
        return None, body, yaml_block, f"yaml-parse-error: {e}"
    if not isinstance(parsed, dict):
        return None, body, yaml_block, (
            f"frontmatter-not-a-mapping (got {type(parsed).__name__})"
        )
    return parsed, body, yaml_block, None


def _str_list(value) -> list[str]:
    if isinstance(value, str):
        return [part.strip() for part in value.split(",") if part.strip()]
    return [v for v in (value or []) if isinstance(v, str)]


def _opt_str(value) -> Optional[str]:
    return value if isinstance(value, str) else None


def _opt_str_typed(
    value, key: str, warnings: list[str]
) -> Optional[str]:
    """Like `_opt_str`, but emits a type-mismatch warning when the
    value is present but not a string (case 13). Missing values are
    silent — they fall back to the next resolution layer."""
    if value is None:
        return None
    if isinstance(value, str):
        return value
    warnings.append(
        f"frontmatter-type-mismatch:{key} expected string, got {type(value).__name__}"
    )
    return None


def _str_list_typed(value, key: str, warnings: list[str]) -> list[str]:
    """Like `_str_list`, but emits a type-mismatch warning when the
    value is present but neither a string nor a list-of-strings."""
    if value is None:
        return []
    if isinstance(value, str):
        return [part.strip() for part in value.split(",") if part.strip()]
    if isinstance(value, list):
        out: list[str] = []
        bad = 0
        for v in value:
            if isinstance(v, str):
                out.append(v)
            else:
                bad += 1
        if bad:
            warnings.append(
                f"frontmatter-type-mismatch:{key} contained {bad} non-string element(s) — dropped"
            )
        return out
    warnings.append(
        f"frontmatter-type-mismatch:{key} expected string or list, got {type(value).__name__}"
    )
    return []


def _html_related_paths(values: list[str]) -> list[str]:
    return [
        f"{value[:-3]}.html" if value.endswith(".md") else value
        for value in values
    ]


def _parse_section(body: str, heading: str) -> Optional[str]:
    """Extract the content body of a named `## Heading` section.

    Case 5 — same fence-masking as `_list_orphan_sections`. The regex
    walks the masked text to find boundaries, then content is sliced
    from the original body so fenced code survives."""
    pattern = re.compile(
        rf"##\s*{re.escape(heading)}\s*\n([\s\S]*?)(?=\n##\s|\n---\n|$)",
        re.IGNORECASE,
    )
    masked = _mask_fenced_blocks(body)
    m = pattern.search(masked)
    if not m:
        return None
    text = body[m.start(1):m.end(1)].strip()
    return text or None


def _parse_reason(body: str) -> Optional[str]:
    return _parse_section(body, "Reason")


# Case 9/10: loose-bullet regex used by Facts and Raw Concept list
# parsers. Matches `- `, `* `, `+ `, or `1. ` line-leading bullets.
_LOOSE_BULLET_PREFIX = re.compile(r"^\s*(?:[-*+]|\d+\.)\s+")


def _strip_bullet_prefix(line: str) -> Optional[str]:
    """Return the content of a bulleted line (any common style), or
    None if the line isn't a bullet."""
    m = _LOOSE_BULLET_PREFIX.match(line)
    if not m:
        return None
    return line[m.end():]


def _collect_bullet_items_with_continuations(text: str) -> list[str]:
    """Split a bulleted block into items, preserving indented
    continuation lines on the same item.

    Markdown allows multi-line list items where continuation text is
    indented under the bullet. The naive line-by-line splitter drops
    those continuations silently — that's the codex finding on the
    rules block. This helper folds indented (or pure-whitespace)
    follow-up lines back into the current item until the next bullet-
    leading line or a blank-line break.

    Returns the list of joined item strings (trimmed)."""
    items: list[str] = []
    current: Optional[list[str]] = None
    for line in text.splitlines():
        if _LOOSE_BULLET_PREFIX.match(line):
            if current is not None:
                joined = "\n".join(current).strip()
                if joined:
                    items.append(joined)
            stripped = _strip_bullet_prefix(line) or ""
            current = [stripped.rstrip()]
            continue
        if current is None:
            continue
        if not line.strip():
            # Blank line terminates the current item.
            joined = "\n".join(current).strip()
            if joined:
                items.append(joined)
            current = None
            continue
        # Indented continuation of the current item — strip leading
        # whitespace and append.
        if line.startswith((" ", "\t")):
            current.append(line.strip())
        else:
            # Un-indented non-bullet line — closes the current item.
            joined = "\n".join(current).strip()
            if joined:
                items.append(joined)
            current = None
    if current is not None:
        joined = "\n".join(current).strip()
        if joined:
            items.append(joined)
    return items


def _parse_raw_concept(body: str) -> Tuple[dict, list[str]]:
    """Parse `## Raw Concept`. Returns (raw_concept_dict, warnings).

    Case 7 — plural tolerance: `**Tasks:**`, `**Flows:**`, etc. route
    to the same target as their singular form. Labels still not in
    `RAW_CONCEPT_LABEL_MAP` are warned + dropped.

    Case 9/10 — bullet tolerance: Changes / Files lists accept `- `,
    `* `, `+ `, and `1. ` style bullets.
    """
    warnings: list[str] = []
    section = _parse_section(body, "Raw Concept")
    if not section:
        return {}, warnings

    rc: dict = {}

    # Walk every **Label:** bold-heading subsection.
    sub_iter = re.finditer(
        r"\*\*\s*([A-Za-z][\w \t]*?)\s*:\s*\*\*\s*\n?([\s\S]*?)(?=\n\*\*[A-Za-z]|\n##|$)",
        section,
    )
    for m in sub_iter:
        raw_label = m.group(1).strip()
        sub_body = m.group(2).strip()
        key = RAW_CONCEPT_LABEL_MAP.get(raw_label.lower())
        if key is None:
            if sub_body:
                warnings.append(
                    f"dropped-raw-concept-subsection:{raw_label} ({len(sub_body)} chars)"
                )
            continue

        if key == "task":
            if "task" not in rc:
                rc["task"] = sub_body
        elif key == "flow":
            if "flow" not in rc:
                rc["flow"] = sub_body
        elif key == "timestamp":
            if "timestamp" not in rc:
                # Timestamp is single-line; take the first non-empty line.
                first = next((l.strip() for l in sub_body.splitlines() if l.strip()), "")
                rc["timestamp"] = first or sub_body
        elif key == "author":
            if "author" not in rc:
                first = next((l.strip() for l in sub_body.splitlines() if l.strip()), "")
                rc["author"] = first or sub_body
        elif key == "changes":
            existing = rc.get("changes", [])
            existing.extend(_collect_bullet_items_with_continuations(sub_body))
            if existing:
                rc["changes"] = existing
        elif key == "files":
            existing = rc.get("files", [])
            existing.extend(_collect_bullet_items_with_continuations(sub_body))
            if existing:
                rc["files"] = existing
        elif key == "patterns":
            existing = rc.get("patterns", [])
            for line in sub_body.splitlines():
                stripped = line.strip()
                if not stripped.startswith("- `") and not stripped.startswith("* `"):
                    continue
                pm = re.match(r"[-*]\s+`(.+?)`(?:\s*\(flags:\s*(.+?)\))?\s*-\s*(.+)", stripped)
                if pm:
                    entry = {"pattern": pm.group(1), "description": pm.group(3).strip()}
                    if pm.group(2):
                        entry["flags"] = pm.group(2)
                    existing.append(entry)
            if existing:
                rc["patterns"] = existing

    return rc, warnings


def _parse_narrative(body: str) -> Tuple[dict, dict, list[str]]:
    """Parse `## Narrative`. Returns (canonical_dict, extras_dict,
    warnings).

    canonical: {structure, dependencies, highlights, rules, examples,
                diagrams[]}
    extras: {patterns: [...], decisions: [...]} from case-8 heuristic
            mapping of unknown `### X` subsections

    Case 8 — unknown ### subsections routed via NARRATIVE_SUBSECTION_
    HEURISTIC, others warned + dropped.
    """
    warnings: list[str] = []
    # Lookahead uses `(?m)^##\s[^#]` so a `## Narrative` followed
    # IMMEDIATELY by another H2 (no blank line) is still terminated
    # correctly. The previous `\n##\s[^#]` required a literal `\n`
    # before the next H2, which meant back-to-back `## A\n## B`
    # consumed the `\n` and never matched — Narrative swallowed the
    # whole rest of the document.
    pattern = re.compile(
        r"(?ms)##\s*Narrative\s*\n([\s\S]*?)(?=^##\s[^#]|\n---\n|\Z)",
        re.IGNORECASE,
    )
    m = pattern.search(body)
    if not m:
        return {}, {}, warnings
    section = m.group(1)
    narrative: dict = {}
    extras: dict = {}

    # Walk every `### X` subsection. Use \Z for end-of-string under
    # multiline mode — `$` would match end-of-line and produce empty
    # subsection bodies.
    sub_iter = re.finditer(
        r"(?m)^###\s+(.+?)\s*$\n([\s\S]*?)(?=^###\s|\n##\s|\Z)", section
    )
    for sm in sub_iter:
        label = sm.group(1).strip()
        lower = label.lower()
        sub_body = sm.group(2).strip()
        if not sub_body:
            continue

        # Canonical narrative subsections.
        if lower == "structure":
            if "structure" not in narrative:
                narrative["structure"] = sub_body
            continue
        if lower == "dependencies":
            if "dependencies" not in narrative:
                narrative["dependencies"] = sub_body
            continue
        if lower in ("highlights", "features"):
            if "highlights" not in narrative:
                narrative["highlights"] = sub_body
            continue
        if lower == "rules":
            if "rules" not in narrative:
                narrative["rules"] = sub_body
            continue
        if lower == "examples":
            if "examples" not in narrative:
                narrative["examples"] = sub_body
            continue
        if lower == "diagrams":
            diagrams: list[dict] = []
            for bm in _FENCED_BLOCK_REGEX.finditer(sub_body):
                entry: dict = {
                    "content": bm.group(3).rstrip(),
                    "type": bm.group(2) or "ascii",
                }
                if bm.group(1):
                    entry["title"] = bm.group(1)
                diagrams.append(entry)
            if diagrams:
                narrative["diagrams"] = diagrams
            continue

        # Case 8: heuristic route unknown ### subsections.
        strategy = NARRATIVE_SUBSECTION_HEURISTIC.get(lower)
        if strategy == "patterns_multiple":
            items = _parse_bullet_items(sub_body)
            if items:
                extras.setdefault("patterns", []).extend(items)
        elif strategy == "decisions_multiple":
            items = _parse_bullet_items(sub_body)
            if items:
                extras.setdefault("decisions", []).extend(items)
        elif strategy == "structure_if_empty":
            # Only fills canonical if empty.
            if "structure" not in narrative:
                narrative["structure"] = sub_body
            else:
                warnings.append(
                    f"dropped-narrative-subsection:{label} (canonical structure already populated, {len(sub_body)} chars)"
                )
        else:
            warnings.append(
                f"dropped-narrative-subsection:{label} ({len(sub_body)} chars)"
            )

    return narrative, extras, warnings


def _parse_bullet_items(section_body: str) -> list[str]:
    """Extract bulleted items (any common style) as a list of strings,
    preserving indented continuation lines as part of the same item.
    Strips the bullet prefix and returns the content text."""
    return _collect_bullet_items_with_continuations(section_body)


def _parse_fact_bullets(section_body: str) -> list[dict]:
    """Parse a bulleted section as bv-fact items. Used for both `##
    Facts` (canonical) and `## Evidence` (orphan-routed)."""
    facts: list[dict] = []
    for line in section_body.splitlines():
        content = _strip_bullet_prefix(line)
        if content is None:
            continue
        stripped = content.strip()
        if not stripped:
            continue
        structured = re.match(r"^\*\*(.+?)\*\*\s*:\s*(.+?)(?:\s*\[(\w+)\])?$", stripped)
        if structured:
            entry = {
                "statement": structured.group(2).strip(),
                "subject": structured.group(1).strip(),
            }
            if structured.group(3):
                entry["category"] = structured.group(3)
            facts.append(entry)
            continue
        plain = re.match(r"^(.+?)(?:\s*\[(\w+)\])?$", stripped)
        if plain:
            entry = {"statement": plain.group(1).strip()}
            if plain.group(2):
                entry["category"] = plain.group(2)
            facts.append(entry)
    return facts


def _parse_facts(body: str) -> list[dict]:
    """Parse `## Facts` section. Case 9/10: accepts dash, asterisk,
    and numbered bullets uniformly."""
    section = _parse_section(body, "Facts")
    if not section:
        return []
    return _parse_fact_bullets(section)


# =============================================================================
# New helpers for refactor + cases 1, 3, 4, 6, 11
# =============================================================================


def _extract_h1_title(body: str) -> Optional[str]:
    """Case 1: Find first `# X` body H1 (single-#, not ##). Returns
    the heading text or None."""
    for line in body.splitlines():
        m = re.match(r"^#\s+(.+?)\s*$", line)
        if m:
            return m.group(1).strip()
        # Stop at first `## X` — H1 must be before any ##.
        if line.lstrip().startswith("##"):
            return None
    return None


def _extract_lede_paragraph(body: str) -> Optional[str]:
    """Case 4: Extract prose between the body H1 and the first `##`
    section (or end-of-body). Returns the joined non-empty lines or
    None if no lede content exists."""
    after_h1 = False
    captured: list[str] = []
    for line in body.splitlines():
        if not after_h1:
            if re.match(r"^#\s+\S", line):
                after_h1 = True
            continue
        if line.lstrip().startswith("## "):
            break
        if line.startswith("---"):
            break
        captured.append(line)
    text = "\n".join(captured).strip()
    return text or None


def _check_yaml_hash_hazard(yaml_block: str) -> list[str]:
    """Case 11: Detect `<space>#` inside unquoted YAML scalar values
    that would silently truncate. Heuristic: scan key:value lines for
    ` #` outside of quoted strings."""
    warnings: list[str] = []
    for line in yaml_block.splitlines():
        m = re.match(r"^([A-Za-z_][\w-]*)\s*:\s*(.*)$", line)
        if not m:
            continue
        key = m.group(1)
        rest = m.group(2)
        # Quoted scalars are safe.
        if rest.startswith(("'", '"', "|", ">", "[", "{")):
            continue
        # Look for ` #` outside-of-quotes hazard.
        if " #" in rest:
            warnings.append(
                f"yaml-comment-truncation:{key} value contains ' #' — PyYAML treats as inline comment, likely silently truncating"
            )
    return warnings


def _check_unknown_frontmatter_keys(frontmatter: dict) -> list[str]:
    """Case 3: warn on frontmatter keys that aren't recognized content
    keys. Runtime signals are allow-listed (silently dropped per spec).
    """
    warnings: list[str] = []
    for key in frontmatter:
        if key in KNOWN_FRONTMATTER_KEYS_CONTENT:
            continue
        if key in RUNTIME_SIGNAL_FRONTMATTER_KEYS:
            continue
        warnings.append(f"dropped-frontmatter-key:{key}")
    return warnings


def _extract_all_fenced_blocks(body: str, exclude_spans: list[tuple[int, int]]) -> list[dict]:
    """Case 6: Promote every fenced code block in the body to a
    bv-diagram entry. Language tag drives the type (in-enum → that
    type; else 'other'). Blocks whose source span falls inside an
    excluded range (e.g., already-extracted `### Diagrams` blocks)
    are skipped to avoid double emission.
    """
    out: list[dict] = []
    for bm in _FENCED_BLOCK_REGEX.finditer(body):
        block_start = bm.start()
        skip = False
        for ex_start, ex_end in exclude_spans:
            if ex_start <= block_start < ex_end:
                skip = True
                break
        if skip:
            continue
        entry: dict = {
            "content": bm.group(3).rstrip(),
            "type": normalize_diagram_type(bm.group(2) or ""),
        }
        if bm.group(1):
            entry["title"] = bm.group(1)
        out.append(entry)
    return out


def _diagrams_section_span(body: str) -> Optional[tuple[int, int]]:
    """Return (start, end) span of the `## Narrative > ### Diagrams`
    subsection in `body`, for fenced-block dedup. Same `(?m)^##\\s[^#]`
    anchoring as `_parse_narrative` so back-to-back H2s terminate
    correctly."""
    nar = re.search(
        r"(?ms)##\s*Narrative\s*\n([\s\S]*?)(?=^##\s[^#]|\n---\n|\Z)",
        body,
        re.IGNORECASE,
    )
    if not nar:
        return None
    section_start = nar.start(1)
    section = nar.group(1)
    m_dia = re.search(
        r"###\s*Diagrams\s*\n([\s\S]*?)(?=\n###\s|\n##\s|$)", section, re.IGNORECASE
    )
    if not m_dia:
        return None
    return (section_start + m_dia.start(1), section_start + m_dia.end(1))


def _process_orphan_sections(
    *,
    body: str,
    canonical_reason: Optional[str],
    canonical_narrative: dict,
    canonical_summary_attr: str,
) -> Tuple[dict, list[str]]:
    """Case 2: Route orphan `## X` sections to bv-* targets via the
    heading-name heuristic. Conflict resolution: canonical wins; if
    the canonical target is already populated, the orphan content is
    dropped and a warning is emitted.

    Returns (extras_dict, warnings) where extras_dict has keys:
      summary_attr_override : optional str (case 4 fallback)
      reason                : optional str (only if canonical empty)
      structure             : optional str (only if canonical empty)
      dependencies          : optional str
      highlights            : optional str
      examples              : optional str
      rules                 : list[dict]   (multiple, appended)
      patterns              : list[str]    (multiple, appended)
      decisions             : list[str]    (multiple, appended)
      facts                 : list[dict]   (multiple, appended)
    """
    warnings: list[str] = []
    extras: dict = {}

    for orphan in _list_orphan_sections(body):
        heading = orphan["heading"]
        lower = heading.lower()
        content = orphan["content"]
        strategy = ORPHAN_H2_HEURISTIC.get(lower)

        if strategy is None:
            warnings.append(
                f"dropped-orphan-section:{heading} ({len(content)} chars — no bv-* target)"
            )
            continue

        if strategy == "summary_attr_if_empty":
            if not canonical_summary_attr and "summary_attr_override" not in extras:
                # Strip fenced/markdown decoration to one-paragraph form.
                first_para = re.split(r"\n\s*\n", content, maxsplit=1)[0].strip()
                extras["summary_attr_override"] = first_para
            else:
                warnings.append(
                    f"dropped-orphan-section:{heading} (canonical summary already populated)"
                )
            continue

        if strategy == "reason_if_empty":
            if canonical_reason is None and "reason" not in extras:
                extras["reason"] = content
            else:
                warnings.append(
                    f"dropped-orphan-section:{heading} (canonical <bv-reason> already populated)"
                )
            continue

        if strategy == "structure_if_empty":
            if "structure" not in canonical_narrative and "structure" not in extras:
                extras["structure"] = content
            else:
                warnings.append(
                    f"dropped-orphan-section:{heading} (canonical <bv-structure> already populated)"
                )
            continue

        if strategy == "dependencies_if_empty":
            if "dependencies" not in canonical_narrative and "dependencies" not in extras:
                extras["dependencies"] = content
            else:
                warnings.append(
                    f"dropped-orphan-section:{heading} (canonical <bv-dependencies> already populated)"
                )
            continue

        if strategy == "highlights_if_empty":
            if "highlights" not in canonical_narrative and "highlights" not in extras:
                extras["highlights"] = content
            else:
                warnings.append(
                    f"dropped-orphan-section:{heading} (canonical <bv-highlights> already populated)"
                )
            continue

        if strategy == "examples_if_empty":
            if "examples" not in canonical_narrative and "examples" not in extras:
                extras["examples"] = content
            else:
                warnings.append(
                    f"dropped-orphan-section:{heading} (canonical <bv-examples> already populated)"
                )
            continue

        if strategy == "rules_split":
            # Split rules — multiple <bv-rule> siblings are valid.
            items = split_rules_block(content)
            if items:
                extras.setdefault("rules", []).extend(items)
            continue

        if strategy == "patterns_multiple":
            items = _parse_bullet_items(content)
            if items:
                extras.setdefault("patterns", []).extend(items)
            continue

        if strategy == "decisions_multiple":
            items = _parse_bullet_items(content)
            if items:
                extras.setdefault("decisions", []).extend(items)
            continue

        if strategy == "facts_parse":
            items = _parse_fact_bullets(content)
            if items:
                extras.setdefault("facts", []).extend(items)
            else:
                warnings.append(
                    f"dropped-orphan-section:{heading} (no parseable fact bullets in {len(content)} chars)"
                )
            continue

    return extras, warnings


# =============================================================================
# Markdown -> HTML conversion
# =============================================================================


def _to_iso(dt: datetime.datetime) -> str:
    """Render a UTC datetime as RFC3339 with millisecond precision +
    trailing Z, matching the TS html-writer's timestamp format."""
    iso = dt.astimezone(datetime.timezone.utc).isoformat(timespec="milliseconds")
    return iso.replace("+00:00", "Z")


def convert_markdown_topic_to_html(
    *, markdown: str, mtime_ms: float, rel_path: str
) -> dict:
    """One-shot conversion of a markdown topic to its bv-topic HTML
    equivalent. Returns {'html': str, 'warnings': list[str]}.

    Pure function — does not touch disk. The orchestrator is
    responsible for atomic writes.

    Output uses ONLY closed bv-* vocabulary; orphan content is mapped
    to existing bv-* targets via the heading-name heuristic, or
    dropped + warned when no clean target exists.
    """
    warnings: list[str] = []
    topic_path = rel_path_to_topic_path(rel_path)

    normalized = markdown if markdown.endswith("\n") else markdown + "\n"
    frontmatter_raw, body, yaml_block, parse_error = _parse_frontmatter(normalized)
    frontmatter: dict = frontmatter_raw or {}

    # Case 3: surface malformed frontmatter so the operator knows
    # title/summary/tags/related were silently demoted to defaults.
    if parse_error is not None:
        warnings.append(f"malformed-frontmatter: {parse_error}")

    # Case 11: YAML hazard warnings.
    warnings.extend(_check_yaml_hash_hazard(yaml_block))

    # Case 3: unknown frontmatter key warnings.
    warnings.extend(_check_unknown_frontmatter_keys(frontmatter))

    # Title resolution: frontmatter -> body H1 (case 1) -> path slug.
    # Case 13: `_opt_str_typed` warns when the value is the wrong type
    # (e.g. `title: 42`) so silent coercion doesn't hide content loss.
    fm_title = _opt_str_typed(frontmatter.get("title"), "title", warnings)
    title = fm_title or _extract_h1_title(body) or topic_path.split("/")[-1] or topic_path

    # Summary resolution: frontmatter -> orphan ## Abstract / ##
    # Overview (handled via heuristic later) -> lede paragraph (case
    # 4) -> empty.
    fm_summary = (
        _opt_str_typed(frontmatter.get("summary"), "summary", warnings)
        or _opt_str_typed(
            frontmatter.get("short_description"), "short_description", warnings
        )
        or ""
    )
    summary = fm_summary  # may be overwritten below by orphan / lede

    tags = _str_list_typed(frontmatter.get("tags"), "tags", warnings)
    keywords = _str_list_typed(frontmatter.get("keywords"), "keywords", warnings)
    related = _html_related_paths(
        _str_list_typed(frontmatter.get("related"), "related", warnings)
        or _str_list_typed(frontmatter.get("relateds"), "relateds", warnings)
    )

    created_at = _opt_str_typed(frontmatter.get("createdAt"), "createdAt", warnings)
    updated_at = _opt_str_typed(frontmatter.get("updatedAt"), "updatedAt", warnings)
    fallback = _to_iso(
        datetime.datetime.fromtimestamp(mtime_ms / 1000, tz=datetime.timezone.utc)
    )
    if created_at is None or updated_at is None:
        warnings.append(f"missing-timestamps: using stat.mtime fallback ({fallback})")
        created_at = created_at or fallback
        updated_at = updated_at or fallback

    # Canonical parsing.
    raw_concept, rc_warnings = _parse_raw_concept(body)
    warnings.extend(rc_warnings)
    narrative, narrative_extras, narrative_warnings = _parse_narrative(body)
    warnings.extend(narrative_warnings)
    facts = _parse_facts(body)
    reason = _parse_reason(body)

    # Orphan section heuristic (case 2).
    orphan_extras, orphan_warnings = _process_orphan_sections(
        body=body,
        canonical_reason=reason,
        canonical_narrative=narrative,
        canonical_summary_attr=summary,
    )
    warnings.extend(orphan_warnings)

    # Merge canonical + orphan-discovered content. Canonical wins per
    # the conflict resolution rule.
    if reason is None and "reason" in orphan_extras:
        reason = orphan_extras["reason"]
    for key in ("structure", "dependencies", "highlights", "examples"):
        if key not in narrative and key in orphan_extras:
            narrative[key] = orphan_extras[key]
    extra_rules: list[dict] = list(narrative_extras.get("rules", []))
    extra_rules.extend(orphan_extras.get("rules", []))
    extra_patterns: list[str] = list(narrative_extras.get("patterns", []))
    extra_patterns.extend(orphan_extras.get("patterns", []))
    extra_decisions: list[str] = list(orphan_extras.get("decisions", []))
    extra_facts: list[dict] = list(orphan_extras.get("facts", []))

    # Case 4 final fallback: hoist lede paragraph if summary still empty
    # and orphan didn't fill it.
    if not summary:
        summary = orphan_extras.get("summary_attr_override", "") or ""
    if not summary:
        lede = _extract_lede_paragraph(body)
        if lede:
            summary = re.split(r"\n\s*\n", lede, maxsplit=1)[0].strip()

    # Case 6: every fenced block anywhere → bv-diagram. Dedup against
    # canonical `### Diagrams` extraction (those are already in
    # narrative['diagrams']).
    diagrams_span = _diagrams_section_span(body)
    exclude_spans = [diagrams_span] if diagrams_span else []
    extra_diagrams = _extract_all_fenced_blocks(body, exclude_spans)
    if extra_diagrams:
        narrative.setdefault("diagrams", []).extend(extra_diagrams)

    snippets = _extract_snippets_from_body(body)
    if snippets:
        warnings.append(
            f"dropped-snippets: {len(snippets)} legacy '---'-separated "
            "snippets discarded (no <bv-snippet> element)"
        )

    # Assemble the topic attributes string.
    attrs: list[str] = [
        f'path="{escape_html_text(topic_path)}"',
        f'title="{escape_html_text(title)}"',
    ]
    if summary:
        attrs.append(f'summary="{escape_html_text(summary)}"')
    if tags:
        attrs.append(f'tags="{escape_html_text(",".join(tags))}"')
    if keywords:
        attrs.append(f'keywords="{escape_html_text(",".join(keywords))}"')
    if related:
        attrs.append(f'related="{escape_html_text(",".join(related))}"')
    # NOTE on `createdat=` / `updatedat=` emission: the bv-topic schema
    # at src/server/infra/render/elements/bv-topic/schema.ts lists these
    # in `RESERVED_TOPIC_ATTRIBUTES` and rejects them on LLM input —
    # they're considered system-managed. The on-disk reader doesn't
    # enforce that, so they're safe to set here at migration time, and
    # we want to preserve source dates rather than synthesize from
    # mtime on every read. The hazard is downstream: if curate later
    # surfaces an existing migrated topic to the LLM as context and the
    # LLM copies these attributes back into its output, the writer's
    # validator will reject it with an attribute-validation error. The
    # curate prompt builder should scrub reserved attributes before
    # showing existing content — that's its responsibility, not ours.
    attrs.append(f'createdat="{escape_html_text(created_at)}"')
    attrs.append(f'updatedat="{escape_html_text(updated_at)}"')

    body_parts: list[str] = []
    rule_id_registry: set[str] = set()
    _append_reason(body_parts, reason)
    _append_raw_concept(body_parts, raw_concept)
    _append_narrative(body_parts, narrative, rule_id_registry)
    _append_facts(body_parts, facts + extra_facts)
    _append_extra_rules(body_parts, extra_rules, rule_id_registry)
    _append_extra_patterns(body_parts, extra_patterns)
    _append_extra_decisions(body_parts, extra_decisions)

    inner = ("\n  " + "\n  ".join(body_parts) + "\n") if body_parts else ""
    html = f"<bv-topic {' '.join(attrs)}>{inner}</bv-topic>"
    return {"html": html, "warnings": warnings}


def _append_reason(parts: list[str], reason: Optional[str]) -> None:
    if not reason:
        return
    parts.append(f"<bv-reason>{escape_html_text(reason)}</bv-reason>")


def _append_raw_concept(parts: list[str], rc: dict) -> None:
    if not rc:
        return
    if "task" in rc:
        parts.append(f"<bv-task>{escape_html_text(rc['task'])}</bv-task>")
    if rc.get("changes"):
        items = "".join(f"<li>{escape_html_text(c)}</li>" for c in rc["changes"])
        parts.append(f"<bv-changes>{items}</bv-changes>")
    if rc.get("files"):
        items = "".join(f"<li>{escape_html_text(f)}</li>" for f in rc["files"])
        parts.append(f"<bv-files>{items}</bv-files>")
    if "flow" in rc:
        parts.append(f"<bv-flow>{escape_html_text(rc['flow'])}</bv-flow>")
    if "timestamp" in rc:
        parts.append(f"<bv-timestamp>{escape_html_text(rc['timestamp'])}</bv-timestamp>")
    if "author" in rc:
        parts.append(f"<bv-author>{escape_html_text(rc['author'])}</bv-author>")
    for pat in rc.get("patterns", []):
        attrs = []
        if "flags" in pat:
            attrs.append(f' flags="{escape_html_text(pat["flags"])}"')
        if "description" in pat:
            attrs.append(f' description="{escape_html_text(pat["description"])}"')
        parts.append(
            f"<bv-pattern{''.join(attrs)}>{escape_html_text(pat['pattern'])}</bv-pattern>"
        )


def _append_narrative(
    parts: list[str], narr: dict, rule_ids: Optional[set[str]] = None
) -> None:
    """Emit canonical narrative subsections. `rule_ids` is a shared
    seen-set threaded through canonical + orphan rule emission so a
    rule that slugifies to the same id in both blocks gets a unique
    suffix on its second emission (case 10)."""
    if not narr:
        return
    if rule_ids is None:
        rule_ids = set()
    if "structure" in narr:
        parts.append(f"<bv-structure>{escape_html_text(narr['structure'])}</bv-structure>")
    if "dependencies" in narr:
        parts.append(
            f"<bv-dependencies>{escape_html_text(narr['dependencies'])}</bv-dependencies>"
        )
    if "highlights" in narr:
        parts.append(
            f"<bv-highlights>{escape_html_text(narr['highlights'])}</bv-highlights>"
        )
    if "rules" in narr:
        for rule in split_rules_block(narr["rules"]):
            rid = _uniquify_id(rule["id"], rule_ids)
            sev_attr = f' severity="{rule["severity"]}"' if "severity" in rule else ""
            parts.append(
                f'<bv-rule{sev_attr} id="{escape_html_text(rid)}">'
                f'{escape_html_text(rule["text"])}</bv-rule>'
            )
    if "examples" in narr:
        parts.append(f"<bv-examples>{escape_html_text(narr['examples'])}</bv-examples>")
    for d in narr.get("diagrams", []):
        type_ = normalize_diagram_type(d.get("type", ""))
        title_attr = f' title="{escape_html_text(d["title"])}"' if "title" in d else ""
        parts.append(
            f'<bv-diagram type="{type_}"{title_attr}><pre><code>'
            f'{escape_html_text(d["content"])}</code></pre></bv-diagram>'
        )


def _uniquify_id(rule_id: str, seen: set[str]) -> str:
    """Suffix `rule_id` with -2, -3, ... until it doesn't collide with
    any entry already in `seen`, then record it."""
    candidate = rule_id
    suffix = 2
    while candidate in seen:
        candidate = f"{rule_id}-{suffix}"
        suffix += 1
    seen.add(candidate)
    return candidate


def _append_facts(parts: list[str], facts: list[dict]) -> None:
    for fact in facts:
        category = normalize_fact_category(fact.get("category"))
        attrs = []
        if "subject" in fact:
            attrs.append(f'subject="{escape_html_text(fact["subject"])}"')
        if category:
            attrs.append(f'category="{category}"')
        if "value" in fact:
            attrs.append(f'value="{escape_html_text(fact["value"])}"')
        attr_part = (" " + " ".join(attrs)) if attrs else ""
        parts.append(
            f"<bv-fact{attr_part}>{escape_html_text(fact['statement'])}</bv-fact>"
        )


def _append_extra_rules(
    parts: list[str], rules: list[dict], rule_ids: Optional[set[str]] = None
) -> None:
    """Emit orphan-routed rules. Shares the `rule_ids` seen-set with
    `_append_narrative` so canonical + orphan rules get unique ids
    across the whole topic (case 10)."""
    if rule_ids is None:
        rule_ids = set()
    for rule in rules:
        base_id = rule.get("id", slugify_rule_id(rule.get("text", ""), "r"))
        rid = _uniquify_id(base_id, rule_ids)
        sev_attr = f' severity="{rule["severity"]}"' if "severity" in rule else ""
        parts.append(
            f'<bv-rule{sev_attr} id="{escape_html_text(rid)}">'
            f'{escape_html_text(rule["text"])}</bv-rule>'
        )


def _append_extra_patterns(parts: list[str], patterns: list[str]) -> None:
    for pat_text in patterns:
        parts.append(f"<bv-pattern>{escape_html_text(pat_text)}</bv-pattern>")


def _append_extra_decisions(parts: list[str], decisions: list[str]) -> None:
    for dec_text in decisions:
        parts.append(f"<bv-decision>{escape_html_text(dec_text)}</bv-decision>")


def _extract_snippets_from_body(body: str) -> list[str]:
    """Detect legacy `---`-separated snippets in the body. A "snippet"
    only exists when the body contains an explicit `\\n---\\n` ruler
    AFTER frontmatter has been stripped — orphan `## X` content with
    no horizontal rule isn't a snippet, it's section content (and is
    handled by the orphan heuristic).

    Returns the list of non-empty pieces between rulers. An empty
    return means there were no snippets to drop.
    """
    if "\n---\n" not in body:
        return []
    s = body
    for heading in ("Relations", "Reason", "Raw Concept", "Narrative", "Facts"):
        pattern = re.compile(
            rf"##\s*{re.escape(heading)}[\s\S]*?(?=\n##\s|\n---\n|$)", re.IGNORECASE
        )
        s = pattern.sub("", s).strip()
    # Strip orphan `## X` sections too — those are routed via the
    # heuristic elsewhere and must not be re-counted as snippets here.
    s = _SECTION_REGEX.sub("", s).strip()
    snippets = [
        snippet.strip()
        for snippet in re.split(r"(?:^|\n)---\n", s)
        if snippet.strip() and snippet.strip() != "No context available."
    ]
    return snippets


# =============================================================================
# Migrator orchestrator
# =============================================================================


def _today_utc() -> str:
    return datetime.datetime.now(datetime.timezone.utc).strftime("%Y-%m-%d")


def _classify_entry(rel: str, tree_files: set[str]) -> str:
    """Returns 'manifest', 'derived', or 'topic'. Called for files
    NOT in _archived/ (filtered upstream).

    `.abstract.md` / `.overview.md` sidecars are classified as derived
    ONLY when the base `<name>.md` sibling exists in the same dir. A
    standalone `<name>.abstract.md` with no corresponding `<name>.md`
    is treated as a regular topic — the suffix is then an unfortunate
    naming coincidence, not a derived-sidecar marker."""
    basename = rel.rsplit("/", 1)[-1] if "/" in rel else rel
    if basename == MANIFEST_FILE:
        return "manifest"
    if basename == SUMMARY_INDEX_FILE:
        return "derived"
    sidecar_match = re.match(r"^(.+?)\.(?:abstract|overview)\.md$", basename)
    if sidecar_match:
        prefix = rel[: -len(basename)] if "/" in rel else ""
        sibling_base = f"{prefix}{sidecar_match.group(1)}.md"
        if sibling_base in tree_files:
            return "derived"
        # else: standalone topic that happens to end in .abstract.md /
        # .overview.md — treat as a regular topic.
    return "topic"


def _list_tree_files(tree_root: Path) -> list[str]:
    """List every regular file relative to tree_root, skipping
    _archived/ and any hidden directory (e.g. .git/). Returns
    forward-slash-normalised relative paths sorted alphabetically.

    Hidden-dir skip: prevents the cogit `.git/` (and any other
    dot-prefixed dir) from polluting reports with hundreds of
    skipped binary entries. Hidden files at the root of the tree
    (e.g. `.snapshot.json`, `.gitignore`) still pass through and
    get classified as `unsupported-extension`.
    """
    out: list[str] = []
    if not tree_root.exists():
        return out
    for path in sorted(tree_root.rglob("*")):
        if not path.is_file():
            continue
        parts = path.relative_to(tree_root).parts
        # Skip anything inside an _archived/ or hidden subdir
        if any(p == ARCHIVE_DIR or p.startswith(".") for p in parts[:-1]):
            continue
        out.append("/".join(parts))
    return out


def _html_sibling_path(tree_root: Path, rel_md: str) -> Path:
    """Map `foo/bar.md` -> `tree_root/foo/bar.html`.

    Uses string concatenation rather than `Path.with_suffix(".html")`
    because `with_suffix` only replaces the LAST dot-suffix — so a
    legitimate topic filename like `node.js.md` would otherwise map to
    `node.html` (losing the `.js` segment) and mismatch the
    `<bv-topic path>` attribute the writer produces."""
    return tree_root / (rel_md[:-3] + ".html")


def _html_sibling_exists(tree_root: Path, rel_md: str) -> bool:
    if not rel_md.endswith(".md"):
        return False
    return _html_sibling_path(tree_root, rel_md).exists()


def _move(source: Path, target: Path) -> None:
    target.parent.mkdir(parents=True, exist_ok=True)
    shutil.move(str(source), str(target))


def _write_atomic(target: Path, content: str) -> None:
    # `newline="\n"` disables Python's default CRLF translation on
    # Windows so the on-disk bytes match macOS/Linux byte-for-byte.
    # The HTML pipeline accepts CRLF, but consistent LF keeps git
    # diffs reproducible across operators on different machines.
    target.parent.mkdir(parents=True, exist_ok=True)
    tmp = target.with_suffix(target.suffix + ".tmp")
    tmp.write_text(content, encoding="utf-8", newline="\n")
    tmp.replace(target)


def _process_file(
    *,
    archive_root: Path,
    basename: str,
    tree_root: Path,
    dry_run: bool,
    rel: str,
    tree_files: set[str],
) -> dict:
    if not basename.endswith(".md") and basename != MANIFEST_FILE:
        return {"outcome": "skipped", "reason": "unsupported-extension", "source_rel_path": rel}

    kind = _classify_entry(rel, tree_files)
    source_abs = tree_root / rel
    archive_abs = archive_root / rel

    if kind in ("manifest", "derived"):
        if not dry_run:
            _move(source_abs, archive_abs)
        return {
            "outcome": "archived",
            "reason": kind,
            "source_rel_path": rel,
            "archive_path": str(archive_abs),
        }

    # kind == 'topic'
    if _html_sibling_exists(tree_root, rel):
        if not dry_run:
            _move(source_abs, archive_abs)
        return {
            "outcome": "archived",
            "reason": "html-sibling-exists",
            "source_rel_path": rel,
            "archive_path": str(archive_abs),
        }

    try:
        markdown = source_abs.read_text(encoding="utf-8")
    except OSError as e:
        return _archive_failed(source_abs, archive_abs, rel, f"read-error: {e}", dry_run)

    if not markdown.strip():
        # Empty file. If the basename matches a sidecar pattern
        # (`.abstract.md` / `.overview.md`), treat as derived even
        # though the sibling base check (case 12) classified it as
        # topic — empty sidecars are usually pre-allocated stubs
        # from the curate pipeline, not user-authored content.
        # Non-sidecar empty files surface as `failed` so the
        # operator notices unexpected emptiness.
        if basename.endswith(ABSTRACT_EXTENSION) or basename.endswith(OVERVIEW_EXTENSION):
            if not dry_run:
                _move(source_abs, archive_abs)
            return {
                "outcome": "archived",
                "reason": "empty-sidecar",
                "source_rel_path": rel,
                "archive_path": str(archive_abs),
            }
        return _archive_failed(source_abs, archive_abs, rel, "empty-file", dry_run)

    mtime_ms = source_abs.stat().st_mtime * 1000.0
    try:
        result = convert_markdown_topic_to_html(
            markdown=markdown, mtime_ms=mtime_ms, rel_path=rel
        )
    except (ValueError, RuntimeError) as e:
        return _archive_failed(
            source_abs, archive_abs, rel, f"convert-error: {e}", dry_run
        )

    html_abs = _html_sibling_path(tree_root, rel)
    if dry_run:
        entry: dict = {
            "outcome": "migrated",
            "source_rel_path": rel,
            "html_path": str(html_abs),
        }
        if result["warnings"]:
            entry["warnings"] = result["warnings"]
        return entry

    try:
        _write_atomic(html_abs, result["html"])
        _move(source_abs, archive_abs)
    except OSError as e:
        return _archive_failed(
            source_abs, archive_abs, rel, f"write-error: {e}", dry_run
        )

    entry = {
        "outcome": "migrated",
        "source_rel_path": rel,
        "html_path": str(html_abs),
        "archive_path": str(archive_abs),
    }
    if result["warnings"]:
        entry["warnings"] = result["warnings"]
    return entry


def _archive_failed(
    source_abs: Path, archive_abs: Path, rel: str, reason: str, dry_run: bool
) -> dict:
    """Move a failed `.md` to the archive so the live tree stays
    .md-free, then report 'failed' with the reason. If the move
    itself errors, the file may remain in the live tree — the entry
    records both failures so the operator can investigate."""
    entry: dict = {"outcome": "failed", "reason": reason, "source_rel_path": rel}
    if dry_run:
        return entry
    try:
        _move(source_abs, archive_abs)
        entry["archive_path"] = str(archive_abs)
    except OSError as move_err:
        entry["reason"] = f"{reason}; archive-move-error: {move_err}"
    return entry


def run_migration(*, project_root: str, dry_run: bool = False) -> dict:
    started_at = datetime.datetime.now(datetime.timezone.utc).isoformat()
    project_path = Path(project_root)
    tree_root = project_path / BRV_DIR / CONTEXT_TREE_DIR

    report: dict = {
        "project_root": str(project_path),
        "started_at": started_at,
        "completed_at": "",
        "dry_run": dry_run,
        "archive_root": None,
        "files": [],
        "summary": {"migrated": 0, "archived": 0, "skipped": 0, "failed": 0},
    }

    if not tree_root.exists():
        report["completed_at"] = datetime.datetime.now(datetime.timezone.utc).isoformat()
        return report

    archive_root = (
        project_path
        / BRV_DIR
        / MIGRATIONS_DIR
        / f"{ARCHIVE_FOLDER_PREFIX}{_today_utc()}"
    )
    report["archive_root"] = str(archive_root)

    tree_files_list = _list_tree_files(tree_root)
    tree_files_set = set(tree_files_list)
    for rel in tree_files_list:
        basename = rel.rsplit("/", 1)[-1] if "/" in rel else rel
        entry = _process_file(
            archive_root=archive_root,
            basename=basename,
            tree_root=tree_root,
            dry_run=dry_run,
            rel=rel,
            tree_files=tree_files_set,
        )
        report["files"].append(entry)
        report["summary"][entry["outcome"]] += 1

    # Persist the pre-existing-HTML preserve list so rollback can avoid
    # deleting .html files that predated the migration. Written under
    # the archive root so it travels with the migration artifact.
    if not dry_run:
        preserve = sorted(
            f["source_rel_path"]
            for f in report["files"]
            if f.get("reason") == "html-sibling-exists"
        )
        if preserve:
            manifest_path = archive_root / PRE_EXISTING_HTML_MANIFEST
            manifest_path.parent.mkdir(parents=True, exist_ok=True)
            manifest_path.write_text(
                json.dumps({"preserve_html_siblings": preserve}, indent=2),
                encoding="utf-8",
            )

    report["completed_at"] = datetime.datetime.now(datetime.timezone.utc).isoformat()
    return report


def rollback(*, project_root: str, dry_run: bool = False) -> dict:
    """Restore the most recent migration: move every file from the
    latest archive back into the live tree, delete matching `.html`
    siblings (except those that predated the migration — tracked via
    `_pre_existing_html_siblings.json` in the archive root), then
    remove the archive folder.

    Honors `dry_run`: classifies what would be restored / deleted /
    preserved without touching disk."""
    started_at = datetime.datetime.now(datetime.timezone.utc).isoformat()
    project_path = Path(project_root)
    migrations_dir = project_path / BRV_DIR / MIGRATIONS_DIR
    tree_root = project_path / BRV_DIR / CONTEXT_TREE_DIR

    archives = sorted(
        [
            p
            for p in (migrations_dir.iterdir() if migrations_dir.exists() else [])
            if p.is_dir() and p.name.startswith(ARCHIVE_FOLDER_PREFIX)
        ]
    )
    if not archives:
        raise RuntimeError(
            "No archive to roll back. Run `python migrate_context_tree.py "
            "--project-root <path>` first."
        )

    archive_root = archives[-1]

    # Load the pre-existing-HTML preserve list. Migrations before this
    # field was added won't have the manifest; treat as empty.
    preserve_html_siblings: set[str] = set()
    manifest_path = archive_root / PRE_EXISTING_HTML_MANIFEST
    if manifest_path.exists():
        try:
            data = json.loads(manifest_path.read_text(encoding="utf-8"))
            preserve_html_siblings = set(data.get("preserve_html_siblings", []))
        except (json.JSONDecodeError, OSError):
            pass

    restored: list[str] = []
    deleted_html: list[str] = []
    preserved_html: list[str] = []
    for archived_file in sorted(archive_root.rglob("*")):
        if not archived_file.is_file():
            continue
        rel = archived_file.relative_to(archive_root).as_posix()
        # Skip our own preserve-list manifest — it lives in the
        # archive root, not in the source tree.
        if rel == PRE_EXISTING_HTML_MANIFEST:
            continue
        target = tree_root / rel
        if not dry_run:
            target.parent.mkdir(parents=True, exist_ok=True)
            shutil.move(str(archived_file), str(target))
        restored.append(rel)

        if rel.endswith(".md"):
            html_sibling = _html_sibling_path(tree_root, rel)
            if rel in preserve_html_siblings:
                preserved_html.append(rel)
                continue
            if html_sibling.exists():
                if not dry_run:
                    html_sibling.unlink()
                deleted_html.append(str(html_sibling))

    if not dry_run:
        shutil.rmtree(archive_root)

    return {
        "project_root": str(project_path),
        "started_at": started_at,
        "completed_at": datetime.datetime.now(datetime.timezone.utc).isoformat(),
        "archive_root": str(archive_root),
        "dry_run": dry_run,
        "restored": len(restored),
        "deleted_html": deleted_html,
        "preserved_html": preserved_html,
    }


def summarize_report(report: dict) -> str:
    s = report["summary"]
    mode = "dry-run" if report["dry_run"] else "applied"
    return (
        f"[{mode}] migrated={s['migrated']} archived={s['archived']} "
        f"skipped={s['skipped']} failed={s['failed']}"
    )


# =============================================================================
# CLI
# =============================================================================


def _build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        prog="migrate_context_tree",
        description=(
            "Migrate a .brv/context-tree from Markdown to bv-topic HTML. "
            "Run from any project root that has .brv/."
        ),
    )
    parser.add_argument(
        "--project-root",
        default=".",
        help="Project root containing .brv/. Defaults to the current directory.",
    )
    parser.add_argument(
        "--dry-run",
        action="store_true",
        help="Classify and convert in memory; write nothing to disk.",
    )
    parser.add_argument(
        "--rollback",
        action="store_true",
        help="Roll back the most recent migration: restore archived "
        ".md files and remove generated .html files. Pre-existing .html "
        "siblings recorded in the archive manifest are preserved.",
    )
    parser.add_argument(
        "--yes",
        action="store_true",
        help="Skip the interactive confirmation prompt for --rollback. "
        "Required for non-interactive use; ignored for forward migration.",
    )
    return parser


def main(argv: Optional[list[str]] = None) -> int:
    parser = _build_parser()
    args = parser.parse_args(argv)

    if args.rollback:
        if args.dry_run:
            preview = rollback(project_root=args.project_root, dry_run=True)
            print(
                f"[dry-run] would restore {preview['restored']} file(s) "
                f"from {preview['archive_root']}\n"
                f"[dry-run] would delete {len(preview['deleted_html'])} .html "
                f"sibling(s); preserve {len(preview['preserved_html'])} pre-existing"
            )
            return 0

        # Destructive operation — require explicit confirmation unless
        # --yes was passed or stdin isn't a TTY (assume non-interactive
        # caller already accepted the risk).
        if not args.yes and sys.stdin.isatty():
            preview = rollback(project_root=args.project_root, dry_run=True)
            print(
                f"About to roll back migration at {preview['archive_root']}:\n"
                f"  restore {preview['restored']} file(s) into the live tree\n"
                f"  delete {len(preview['deleted_html'])} generated .html sibling(s)\n"
                f"  preserve {len(preview['preserved_html'])} pre-existing .html sibling(s)",
                file=sys.stderr,
            )
            try:
                resp = input("Proceed? Type 'yes' to confirm: ").strip().lower()
            except EOFError:
                resp = ""
            if resp != "yes":
                print("Aborted.", file=sys.stderr)
                return 1

        result = rollback(project_root=args.project_root)
        print(
            f"Rolled back from {result['archive_root']}: "
            f"restored {result['restored']} file(s)."
        )
        return 0

    report = run_migration(project_root=args.project_root, dry_run=args.dry_run)
    print(summarize_report(report))
    if report["summary"]["failed"] > 0:
        print(
            f"\n{report['summary']['failed']} file(s) failed — sources moved "
            f"to the archive at {report['archive_root']}",
            file=sys.stderr,
        )
        for f in report["files"]:
            if f["outcome"] == "failed":
                print(f"  - {f['source_rel_path']}: {f['reason']}", file=sys.stderr)

    return 0 if report["summary"]["failed"] == 0 else 2


if __name__ == "__main__":
    sys.exit(main())
