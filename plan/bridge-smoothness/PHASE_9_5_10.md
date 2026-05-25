# Phase 9.5.10 — Channel meta reconstruction: fix kimi-flagged corruption vectors

**Status:** GREEN — codex round-3 green-for-TDD (turnId `SeZXehzrBoBKhk2U1P6GS`) after wording cleanup
**Predecessor:** Phase 9.5.9 (`a9c4762b6` + `0b1a02b69`) — shipped 6 of 7 fixes; reconstruction held.
**Kimi review of 9.5.9 reconstruction:** turnId `7h-RAyyU6GEy0mRdjI9ay`.

**Codex r1 findings folded in:** 3 blockers + 9 improvements addressed below.

---

## Why this slice exists

Phase 9.5.9 introduced `reconstructMissingMetas` in
`src/server/utils/channel-meta-reconstruction.ts` as a defensive recovery
for the "channel meta vanishes" class of incident. Kimi's second-eyes
review flagged **two data-corruption vectors** plus this plan adds a
**third bug** found while reading the code carefully:

1. **TOCTOU race** between `fs.access(metaPath)` and `fs.rename(tmp, metaPath)`.
   If a legitimate turn fires between the access check and the rename,
   our rename silently overwrites a real meta.json with the empty-members
   stub.

2. **`members: []` is a lie.** Channels that had members before the meta
   vanished get a stub with zero members. Downstream sees a "legitimately
   empty" channel and may make decisions on that basis (skip warming,
   skip doctor checks, etc).

3. **Wrong `_recordType` literal** (found while drafting this plan, not in
   kimi's review). The reconstruction code reads
   `record._recordType === 'snapshot'` but the snapshot writer
   (`src/server/infra/channel/storage/snapshot-writer.ts:98`) writes
   `_recordType: 'turn_snapshot'`. The test happens to use `'snapshot'`
   too, so unit tests pass but **the function would never enrich
   `createdAt` from a real turn history.** The reconstruction stub would
   always carry `createdAt = now`, even when history shows the channel
   was months old.

The slice fixes all three, re-wires reconstruction into
`runChannelProjectStartup`, and un-skips the daemon-startup test.

---

## Fixes

### Fix A — Per-channel meta-lock + atomic exclusive publish

**File:** `src/server/utils/channel-meta-reconstruction.ts`,
`src/server/infra/channel/channel-store.ts` (new method).

**Current** (race window between line 50 access and line 95 rename):

```ts
try {
  await fs.access(metaPath)
  return // meta exists; nothing to reconstruct
} catch { /* proceed */ }
// ... read history, build minimal ...
await fs.writeFile(tmp, JSON.stringify(minimal, null, 2), 'utf8')
await fs.rename(tmp, metaPath)  // overwrites if a real writer beat us
```

**Race surface (per codex r1 #3):**

`createChannel` in `channel-store.ts:162` uses
`writeSerializer.withLock(metaLockKey(channelId))` then a tryReadMeta
+ writeAtomically inside the lock. If reconstruction writes outside
that lock, two failure modes:

- **Reconstruction wins, real createChannel loses:** createChannel sees
  the stub, throws "Channel X already exists". Bad UX but no data loss.
- **Real createChannel wins, reconstruction loses:** with our rename,
  we overwrite the real meta. Data loss. This is the kimi-flagged vector.

**Fix — two-layer defense:**

**Layer 1 (closes the race):** new `channelStore.reconstructIfMissing(meta, projectRoot)`
method that runs inside `writeSerializer.withLock(metaLockKey(meta.channelId))`:

```ts
async reconstructIfMissing(args: {
  readonly meta: ChannelMeta
  readonly projectRoot: string
}): Promise<'wrote' | 'already-exists'> {
  const {meta, projectRoot} = args
  return this.writeSerializer.withLock(metaLockKey(meta.channelId), async () => {
    const target = channelPaths.metaFile(projectRoot, meta.channelId)
    const existing = await tryReadMeta(target)
    if (existing !== undefined) return 'already-exists'  // someone wrote first
    await writeAtomically(target, JSON.stringify(meta, undefined, 2))
    return 'wrote'
  })
}
```

This reuses the same lock + write path as `createChannel`. Precise
phrasing (per codex r2 #2/#10): **the lock closes the overwrite /
data-loss race kimi flagged.** The remaining create-vs-reconstruct
race is intentionally resolved in favor of reconstruction — see Fix D.

**Cross-process exclusive publish is out of scope.** The daemon is
single-instance per data dir, enforced by `daemon.json` advisory lock.
The lock-protected `tryReadMeta` inside `reconstructIfMissing` is
sufficient for the single-daemon case; no link-or-fail layer is
needed.

**Reconstruction call site:**

```ts
// in reconstructOne — after building minimal:
const result = await channelStore.reconstructIfMissing({meta: minimal, projectRoot})
if (result === 'wrote') {
  args.log(`[channel-meta-reconstruction] reconstruct: wrote minimal meta.json ...`)
}
// 'already-exists' is silent no-op
```

**Signature change:** `reconstructMissingMetas` now requires
`channelStore: ChannelStore` (already passed to the migration step in
9.5.9; just thread it).

**Tests added:**

- "loses the race: existing meta.json is preserved when reconstructOne
  is called against a channel whose meta was created between scan and
  publish" — pre-write meta.json with sentinel; call
  `reconstructMissingMetas`; assert meta.json content unchanged AND
  `result === 'already-exists'`.
- "wins the race: writes meta when none exists" — basic happy path.
- "concurrent reconstruct calls produce exactly one write" — fire two
  `reconstructIfMissing` calls in `Promise.all`; assert one returns
  `wrote` and one returns `already-exists` AND meta content is sane.

---

### Fix B — Honest reconstruction marker + inferred handles + recordType scan

**Codex r1 #1+#2:** Bug 3 fix needs to scan ALL lines of each NDJSON
(real files have many events before the terminal `turn_snapshot`) and
collect ALL `turn.startedAt` values to pick the **earliest** (turn
IDs/filenames are not chronologically sorted).

**File:** `src/server/utils/channel-meta-reconstruction.ts`,
`src/shared/types/channel.ts` (schema extension),
`src/server/infra/channel/doctor-service.ts` (surface).

**Problem:** `members: []` lies about channels that had members. We
**cannot** safely reconstruct full member records from turn history
because we don't know `memberKind`, `peerId`, `multiaddr`, etc. for each
participant — only `author.handle` and `mentions[]` are recorded in
snapshots.

**Fix:** keep `members: []` (no fake schema-violating placeholders) but
add **two new fields** to the meta:

```ts
{
  channelId,
  createdAt,            // best-effort from oldest turn_snapshot
  members: [],
  reconstructionStatus: 'reconstructed-from-history',
  inferredHandles: ['@you', '@alice', '@bob'],  // dedupe of author + mentions
  updatedAt: now,
  reconstructedAt: now,
}
```

Why this shape:

- `members: []` stays empty rather than fake. The schema's
  discriminated union on `memberKind` would reject placeholders with
  unknown kind. Lying with `memberKind: 'remote-peer'` is what kimi
  flagged.
- `inferredHandles` is a flat string array — no schema invariants to
  violate. Downstream (doctor, TUI hints) reads it as a hint, not as
  authoritative membership.
- `reconstructionStatus` is the discriminator. Downstream code can
  branch on this without parsing other fields.

**Schema update** (`src/shared/types/channel.ts`):

Add to `ChannelMetaSchema` (or wherever channel meta is validated):

```ts
reconstructionStatus: z.literal('reconstructed-from-history').optional(),
inferredHandles: z.array(z.string()).optional(),
```

Both optional so existing healthy metas continue to parse.

**Doctor surface** (`src/server/infra/channel/doctor-service.ts`):

When loading a channel, if `meta.reconstructionStatus === 'reconstructed-from-history'`:

```ts
issues.push({
  channelId,
  code: 'DOCTOR_RECONSTRUCTED_FROM_HISTORY',
  message:
    `Channel ${channelId} was rebuilt from turn history after meta.json went missing. ` +
    `Inferred participants: ${inferredHandles.join(', ')}. ` +
    `Run \`brv channel invite <handle> --profile <name>\` to restore each member with full addressability.`,
  severity: 'warning',
})
```

Add `DOCTOR_RECONSTRUCTED_FROM_HISTORY` to whatever code constant set
DOCTOR_INBOUND_ONLY lives in (likely co-located in doctor-service.ts).

**`_recordType` correction** (Bug 3): change the reconstruction read
from `'snapshot'` to `'turn_snapshot'` to match the writer:

```ts
- if (record._recordType === 'snapshot' && ...
+ if (record._recordType === 'turn_snapshot' && ...
```

Update the existing reconstruction test's NDJSON fixture from
`'snapshot'` to `'turn_snapshot'`. The fact that the bug went
undetected demonstrates the test was lying alongside the impl.

**NDJSON scanning (Bug 3 corrected per codex r1 #1+#2):** for each
`<channelId>/turns/*.ndjson` file:

- Iterate ALL non-empty lines (not just the first).
- JSON.parse each; on parse error, skip silently (corrupt lines must
  not abort reconstruction).
- For each line where `_recordType === 'turn_snapshot'`:
  - Collect `record.turn.startedAt` (push to a `startedAt[]` array).
  - Collect `record.turn.author?.handle` (string).
  - Collect each handle in `record.turn.mentions[]` (array of strings).
- For each line where `_recordType === 'delivery_snapshot'` (codex r1
  #8 — additional source):
  - Collect `record.delivery?.memberHandle`.

After scanning all files:

- `createdAt = min(startedAt[])` if any, else `now`.
- `inferredHandles = Array.from(new Set([...authors, ...mentions, ...deliveryHandles])).filter(h => /^@/.test(h)).sort()`.
  - The `/^@/` filter (codex r1 #7) drops `'you'`-style local-user
    placeholders and stray non-handle strings; doctor's recovery hint
    can then safely say "re-invite the listed handles".
  - Sort for deterministic output (easier test assertions, stable
    doctor output across runs).

**Tests added (codex r1 #11 folded in):**

- "uses real `turn_snapshot` recordType (not the old 'snapshot' string)"
  — NDJSON has event lines BEFORE the terminal `turn_snapshot`; assert
  scanner finds it. Catches Bug 3.
- "picks the earliest `turn.startedAt` across turns, ignoring filename
  order" — write turn-zzz.ndjson with startedAt 2026-01-01, then
  turn-aaa.ndjson with 2026-06-01; assert createdAt = 2026-01-01.
- "extracts inferredHandles from author + mentions across all turns" —
  multi-turn history with varied participants; assert sorted handle set.
- "extracts handles from `delivery_snapshot.memberHandle` as well" —
  NDJSON with delivery_snapshot lines; assert those handles appear in
  inferredHandles.
- "filters out non-@-prefixed handles (e.g. 'you', '')" — author with
  handle 'you'; assert it does NOT appear in inferredHandles.
- "dedupes inferred handles" — same handle appears in author + mentions
  + delivery_snapshot; assert single entry.
- "ignores corrupt JSON lines without aborting" — NDJSON with one
  valid turn_snapshot and one un-parseable line; assert reconstruction
  still produces a meta + populates createdAt/inferredHandles from the
  valid line.
- "sets reconstructionStatus = 'reconstructed-from-history'" — basic.
- "schema round-trip: meta carrying reconstructionStatus +
  inferredHandles parses through ChannelMetaSchema and survives
  channelStore.updateChannelMeta without losing fields" — covers codex
  r1 #9 (zod stripping risk).
- "doctor surfaces DOCTOR_RECONSTRUCTED_FROM_HISTORY when meta is
  flagged, including the inferredHandles list" — read a flagged meta;
  assert diagnostic includes both the code and the handles list.

---

### Fix C — Re-wire reconstruction into channel-project-startup

**File:** `src/server/infra/daemon/channel-project-startup.ts`

**Current** (9.5.9 unwired): reconstruction NOT called at startup.

**Fix:** re-add the import + call **before** the inbound-only migration.
Order is load-bearing — migration walks the meta files; reconstruction
must produce them first. Threads `channelStore` (now required by Fix A).

```ts
import {reconstructMissingMetas} from '../../utils/channel-meta-reconstruction.js'
// ...
// Step 0: reconstruct any meta.json files missing from channel-history.
try {
  await reconstructMissingMetas({channelStore, log, projectRoot})
} catch (error) {
  log(`[channel-project-startup] reconstructMissingMetas error (continuing): ...`)
}

// Step 1: opportunistic migration (unchanged)
// Step 2: BrvDirWatcher.start() (unchanged)
```

Best-effort: any throw is logged and swallowed (matches Step 1
semantics — daemon startup must not be gated on reconstruction).

**Test un-skip:** `test/unit/server/infra/daemon/channel-project-startup.test.ts`
line 81 — change `it.skip(...)` back to `it(...)`, pass the test's
`fakeChannelStore` through to the new call signature, and update the
expectation to also assert `reconstructionStatus === 'reconstructed-from-history'`
(matches Fix B).

### Fix D — Stub-wins-by-design (codex r2 #2/#10)

**Race not closed by the lock:** if reconstruction acquires the meta
lock first and writes the stub, a concurrent legitimate `createChannel`
sees the stub and throws "Channel X already exists" — losing the full
member metadata the user intended.

**Practical reality:** this requires (1) channel has prior history,
(2) meta.json vanished, (3) daemon restart starts reconstruction, AND
(4) operator runs `brv channel new <same-id>` during the seconds-long
startup window. We accept this as the documented intentional behavior:

- **Reconstruction wins.** The stub is published.
- **`createChannel` fails fast** with the existing "already exists"
  error. No data loss because there was no prior real meta to lose
  — the user's intended createChannel input is in their terminal,
  retryable.
- **Operator recovery:** doctor surfaces `DOCTOR_RECONSTRUCTED_FROM_HISTORY`
  with the inferred handles list and explicit recovery hint to either
  (a) `brv channel invite <handle> --profile <name>` per inferredHandle
  to repair members, OR (b) delete the channel entirely and re-create.

**Why not gate channel events until startup completes:**

- Adds a per-project promise that channel-handler.ts would have to
  await on every event. Cross-cutting wiring change with non-trivial
  blast radius.
- Startup is already best-effort; gating creates a "startup failed →
  channel events blocked forever" failure mode that's worse than the
  rare stub-wins race.
- The kimi-flagged corruption (silent overwrite of real meta with
  empty stub) IS closed by the lock. The remaining race surfaces a
  loud error to the user, which is acceptable.

**Test added (codex r2 #9):** "stub-wins-by-design: reconstruction holds
the lock first, concurrent createChannel against same id fails fast
with 'already exists' and operator can recover via doctor → invite."

---

## TDD order

1. **Fix Bug 3 fixture + assertion first.** In
   `test/unit/server/utils/channel-meta-reconstruction.test.ts`, change
   the fixture's `_recordType: 'snapshot'` → `'turn_snapshot'` AND add
   an event line BEFORE the terminal turn_snapshot. Run. Expect: the
   existing createdAt-enrichment assertion now fails (impl still reads
   the old literal and only checks the first non-empty line). **RED.**
2. Add Fix B's new tests (recordType scan, earliest startedAt, multi-turn
   handle extraction, delivery_snapshot inclusion, `@`-prefix filter,
   dedupe, corrupt-line tolerance, reconstructionStatus, schema
   round-trip, doctor surface). Run. **RED.**
3. Add Fix A's tests (lose-race, win-race, concurrent reconstruct
   producing single write). Run. **RED.**
4. Implement Fix A (`reconstructIfMissing` on ChannelStore) + Fix B
   (NDJSON scan + recordType correction + filter + status + handles).
   Implement schema extension. Implement doctor surface. Run.
   **GREEN.**
5. Un-skip the daemon-startup test in
   `test/unit/server/infra/daemon/channel-project-startup.test.ts`.
   Implement Fix C (re-wire `reconstructMissingMetas` as Step 0,
   threading `channelStore`). Run. **GREEN.**
6. Full test suite. Confirm 8797 + 1 unskipped + ~11 new tests = green.

---

## Out of scope (defer further)

- **Reconstruct full member records.** Genuinely unsafe without a
  separate authoritative source (e.g. signed peer-handshake log).
  Operator runs `brv channel invite` to repair — surfaced by the doctor
  finding.
- **Periodic background reconstruction scan.** Startup-only is fine for
  the observed failure mode; periodic scan adds race surface.
- **Reconstruct full member records from `delivery_snapshot`.** Fix B
  already extracts `memberHandle` from delivery_snapshot lines into
  `inferredHandles`; building full `ChannelMember` records from them
  remains out of scope (no addressability info).
- **Root cause for "context-tree/channel/ vanishes."** Still unknown.
  Phase 9.5.9 §2.6 BrvDirWatcher gives observability; this slice is
  recovery, not prevention.

---

## Deliverables

| Path | Change |
|---|---|
| `src/server/utils/channel-meta-reconstruction.ts` | NDJSON full-scan + recordType fix + inferredHandles + reconstructionStatus; threads `channelStore` |
| `src/server/infra/channel/channel-store.ts` | NEW `reconstructIfMissing()` method using the same `writeSerializer.withLock(metaLockKey)` as `createChannel` |
| `src/shared/types/channel.ts` | Add optional `reconstructionStatus` + `inferredHandles` to channel meta schema |
| `src/server/infra/channel/doctor-service.ts` | `DOCTOR_RECONSTRUCTED_FROM_HISTORY` surface |
| `src/server/infra/daemon/channel-project-startup.ts` | Re-wire `reconstructMissingMetas` as Step 0 (passes `channelStore`) |
| `test/unit/server/utils/channel-meta-reconstruction.test.ts` | Fix fixture, add ~10 new tests |
| `test/unit/server/infra/daemon/channel-project-startup.test.ts` | Un-skip the reconstruction test |
| `test/unit/server/infra/channel/channel-store-reconstruct-if-missing.test.ts` (NEW) | Lock-protected reconstructIfMissing + stub-wins-by-design |
| `test/unit/server/infra/channel/doctor-service-reconstructed-flag.test.ts` (NEW) | Doctor surface coverage |

---

## Risks + mitigations

| Risk | Mitigation |
|---|---|
| Schema change breaks consumers that strict-validate channel meta | Both new fields are `.optional()`; existing healthy metas unaffected; schema round-trip test in suite |
| `reconstructIfMissing` locked via the same key as `createChannel` could deadlock if reconstruction is called from inside another holder of that lock | Only call site is `runChannelProjectStartup` (Step 0), which holds no other lock when it fires |
| Existing reconstructed metas in the wild from 9.5.9-pre have no `reconstructionStatus` field | None exist — 9.5.9 unwired the call before ship. Clean slate. |
| Re-wired reconstruction triggers on every restart, even when meta is healthy | Work per healthy channel = one `readdir` of `channel-history/`. The lock-protected `tryReadMeta` finds existing meta and returns `already-exists` immediately; no NDJSON parse for healthy channels because `reconstructOne` checks meta-presence FIRST via a cheap stat before scanning turns. Acceptable. |
| Cross-process race (two daemons sharing data dir) | Out of scope — single daemon per data dir is already enforced by `daemon.json` advisory lock. Documented in code comment. |

---

## Sign-off chain

- [ ] Codex plan-review (round 1, expecting ≥1 round of corrections)
- [ ] TDD impl + impl-review by codex
- [ ] Kimi second-eyes on impl
- [ ] Commit + push
