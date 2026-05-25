import type {ElementName} from '../../../core/domain/render/element-types.js'
import type {ElementAxisEntry} from './html-reader.js'

/**
 * In-memory index from element-shape lookups to topic file paths.
 *
 * Two query keys:
 *   - tag       — every path containing at least one element of that tag.
 *   - tag.attr=value — every path containing an element of that tag whose
 *                       attribute holds the given value.
 *
 * The structural-selector grammar consumes this for pre-filtering
 * before BM25 ranking (e.g., "give me topics with `<bv-rule
 * severity=must>`"). Today the search service accepts an optional
 * `elementHint` and uses this index to prune the candidate set; without
 * a hint, the index is dormant and the ranker walks the full corpus.
 *
 * The index is in-memory and lazy-built on first query for a project
 * (the search service materialises it from the same file walk that
 * builds the BM25 index). Invalidated whole-topic on every write —
 * mtime-based cache invalidation upstream catches this; T4 doesn't
 * need a finer-grained signal because a single curate run rewrites
 * exactly one topic file at a time.
 *
 * Persistence is deferred — rebuild on first-query-after-restart is
 * cheap (sub-100ms for the corpus sizes the bench produces).
 *
 * Storage uses nested Maps (`tag → attr → value → Set<path>`) rather
 * than a stringly-keyed `${tag}.${attr}=${value}` table. HTML attribute
 * names and values can legally contain `.` and `=`; nesting eliminates
 * the entire collision class without a delimiter discipline.
 */
export class ElementAxisIndex {
  /** `tag → attr → value → Set<filePath>`. Three-level nest avoids string-key collisions. */
  private readonly attrIndex: Map<ElementName, Map<string, Map<string, Set<string>>>> = new Map()
  /**
   * Reverse map from `filePath` to the set of `(tag, attr, value)` triples
   * (and bare tag memberships) it contributed to. Lets us drop a file
   * from every membership in O(memberships) on invalidation without
   * scanning the full index.
   *
   * Each entry is one of:
   *   - `{kind: 'tag', tag}`
   *   - `{kind: 'attr', tag, attr, value}`
   */
  private readonly pathToMemberships: Map<string, Membership[]> = new Map()
  /** `tag → Set<filePath>`. */
  private readonly tagIndex: Map<ElementName, Set<string>> = new Map()

  /** How many paths the index currently knows about. Mainly for tests. */
  public get size(): number {
    return this.pathToMemberships.size
  }

  /**
   * Register every element in `entries` against `filePath`. Idempotent —
   * calling `add` twice for the same path stacks duplicates harmlessly
   * (Set semantics dedupes), but callers should `remove` first to keep
   * the path-to-memberships reverse map accurate when re-indexing.
   */
  public add(filePath: string, entries: readonly ElementAxisEntry[]): void {
    let memberships = this.pathToMemberships.get(filePath)
    if (!memberships) {
      memberships = []
      this.pathToMemberships.set(filePath, memberships)
    }

    for (const entry of entries) {
      this.addToTagIndex(entry.tag, filePath, memberships)

      for (const [attr, value] of Object.entries(entry.attributes)) {
        this.addToAttrIndex(entry.tag, attr, value, filePath, memberships)
      }
    }
  }

  /**
   * Drop every entry. Used on full corpus rebuild (after a project
   * switch or on first-query-after-restart).
   */
  public clear(): void {
    this.tagIndex.clear()
    this.attrIndex.clear()
    this.pathToMemberships.clear()
  }

  /**
   * Paths containing an element of `tag` whose `attribute` holds the
   * exact `value`. Comparison is case-sensitive on values (HTML5
   * attribute names are lowercased at parse time, but values are
   * verbatim).
   */
  public findByAttribute(tag: ElementName, attribute: string, value: string): readonly string[] {
    const set = this.attrIndex.get(tag)?.get(attribute)?.get(value)
    return set ? [...set] : []
  }

  /**
   * Paths containing at least one element of `tag`. Empty array if no
   * matches (rather than `undefined`) so callers can treat the result
   * as a candidate set without null-checks.
   */
  public findByTag(tag: ElementName): readonly string[] {
    const set = this.tagIndex.get(tag)
    return set ? [...set] : []
  }

  /**
   * Drop every membership tied to `filePath`. Called before re-indexing
   * a touched topic, and when a topic file is deleted.
   */
  public remove(filePath: string): void {
    const memberships = this.pathToMemberships.get(filePath)
    if (!memberships) return

    for (const m of memberships) {
      if (m.kind === 'tag') {
        const set = this.tagIndex.get(m.tag)
        if (!set) continue

        set.delete(filePath)
        if (set.size === 0) {
          this.tagIndex.delete(m.tag)
        }
      } else {
        const tagBucket = this.attrIndex.get(m.tag)
        const attrBucket = tagBucket?.get(m.attr)
        const set = attrBucket?.get(m.value)
        if (!set || !tagBucket || !attrBucket) continue

        set.delete(filePath)
        if (set.size === 0) {
          attrBucket.delete(m.value)
          if (attrBucket.size === 0) {
            tagBucket.delete(m.attr)
            if (tagBucket.size === 0) {
              this.attrIndex.delete(m.tag)
            }
          }
        }
      }
    }

    this.pathToMemberships.delete(filePath)
  }

  private addToAttrIndex(
    tag: ElementName,
    attr: string,
    value: string,
    filePath: string,
    memberships: Membership[],
  ): void {
    let tagBucket = this.attrIndex.get(tag)
    if (!tagBucket) {
      tagBucket = new Map()
      this.attrIndex.set(tag, tagBucket)
    }

    let attrBucket = tagBucket.get(attr)
    if (!attrBucket) {
      attrBucket = new Map()
      tagBucket.set(attr, attrBucket)
    }

    let set = attrBucket.get(value)
    if (!set) {
      set = new Set()
      attrBucket.set(value, set)
    }

    set.add(filePath)
    memberships.push({attr, kind: 'attr', tag, value})
  }

  private addToTagIndex(tag: ElementName, filePath: string, memberships: Membership[]): void {
    let set = this.tagIndex.get(tag)
    if (!set) {
      set = new Set()
      this.tagIndex.set(tag, set)
    }

    set.add(filePath)
    memberships.push({kind: 'tag', tag})
  }
}

type Membership =
  | {attr: string; kind: 'attr'; tag: ElementName; value: string}
  | {kind: 'tag'; tag: ElementName}
