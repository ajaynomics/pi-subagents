# Verification records: independent review per milestone + machine outputs + probe log

Method (unchanged all goal): each milestone implemented by a T3 Theo persona
agent (pragmatic, idiomatic TS, no over-abstraction), reviewed by a separate
Sandi Metz persona agent (small objects, clear responsibilities, tests as
spec), findings resolved or explicitly accepted with reasoning before commit.
I read every diff myself and re-ran targeted vitest + `npm run check` in my
own shell — agent reports were claims, never evidence. Every new assertion
mutation-checked once (break source → red → restore → green).

## Task-1 — causal journal (commit `1209467`)

Theo implemented; Sandi verdict **ship with fixes** (4 should-fix, 3 nits).
1. should-fix: `currentFrame()` fell back to shared `ROOT_FRAME` on ALS loss
   → poison frame (misses, never wrong answers). Fixed, worker-source.
2. should-fix: `parallel`/`pipeline` branches shared `/slot:index` →
   tagged `p:`/`l:`/`w` branches. Fixed + tests updated.
3. should-fix: dirtiness parent→child only → documented upward isolation
   relies on the key + data-dependent-parent test.
4. should-fix: slot consumed before validation → validate before `next++`
   in all four functions.
5. nit: `journalByPath` last-wins → first-wins. Fixed.
6. nit: `childFrame` `#`/`/` invariant comment → added. Fixed.
7. nit: `isEntry` path-grammar validation → EXPLICITLY NOT DONE (a malformed
   path can only miss; validation adds surface for zero correctness gain).
My verification: diff read; `workflow-journal`+`workflow-runtime` 110→115
passed; `npm run check` 106 files 2142 passed/7 skipped.
Mutations, each red then restored: pipeline `als.run(child)`→`als.run(frame)`
(4 red); `replayAt` drop `chainDirty` (2 red); `dirtyFrames.add(frame)`→`""`
(4 red); `workflowIn` childFrame→frame (1 red); `isEntry` drop path check
(1 red).

## Task-2 — recursive `workflow()` nesting (commit `fc6a439`)

Theo implemented; Sandi verdict **ship with fixes** (4 should-fix, 3 nits).
1. should-fix: `MAX_DEPTH` fallback duplicated default → no fallback
   (`ITEM_CAP` pattern: host always sends it).
2. should-fix: depth throw plain-Error vs `nestedCap` fatal → KEPT catchable
   (docs promise try/catch; existing test catches) + parallel-absorption
   test + loud `decompose.js` failure. Decided, not defaulted.
3. should-fix: `decompose.js` dual shape + silent filter → single shape
   always `{task,subtasks,results}` + loud null-child throw; test updated.
4. should-fix: examples-test `loadWorkflow` fallback for ANY name →
   whitelist to the self-reference only.
5-7. nits: ref/depth ordering comment+tests; boundary/depth precedence
   comment+test; root-depth-0 docs clause.
Setting deviation, accepted with reasoning: `maxWorkflowDepth` lives on
`RunWorkflowOptions` — grep proved no workflow caps exist in settings
plumbing, so runtime options IS the existing pattern.
My verification: diff read; 4 files 160→165 passed; `npm run check` 2156→2161/7.
Mutations, each red then restored — base 5 (depth guard, scope.prefix,
default, chainDirty split, depth-1) + fix-round 5 (absorption, leaf shape,
ref check, boundary order, branch tag).

## Task-3 — `worklist(seeds, fn)` (commit `9aacabd`)

Theo implemented; Sandi verdict **ship with fixes** (1 blocker + 4
should-fix + 1 nit).
1. BLOCKER: over-cap `add()` folded to null → `workflowFatal` like
   `nestedCap` + test.
2. `add()` scopes to calling frame (kept — causally precise, stabilizes
   concurrent adds) + words fixed + nested-path test.
3. `runEntry` fire-and-forget trailing lines → launch-site `.catch`.
4. pump reentrancy on sync `fn` → `pumping` guard + sync test.
5. lexicographic sort breaks past 9 seeds → segment-wise numeric sort +
   12-seed test.
6. nit: tool-description `` `q:i` `` → `` `/k:q:i` ``.
Theo divergence, documented: fatal test uses `nestedCap: 0` (past-limit
`workflow()` folds to null per existing test — it is not fatal).
My verification: diff read; 4 files 182 passed; `npm run check` 2178/7.
Mutations, each red then restored: 7 base (sort, drain message, null fold,
cap×2, branch tag, isFatal, example) + 5 fix-round (waits set, abort,
recordJournal, `??=`, pumping).

## Task-4 — first-class nested agents (commit `93b1dc8`)

Theo implemented; Sandi verdict **do not ship** (2 blockers + 4 should-fix
+ 2 nits). All fixed in a second round:
1. BLOCKER: background spawn deadlocks at saturated cap → acquire deferred
   to the await path + deadlock test (pre-fix: 5s timeout proof).
2. BLOCKER: breach lets child finish → `manager.abort` mid-run + abort test.
3. fatal path skips journal → record `ok:false` + resume-retries test.
4. breach message last-wins → first-wins (`??=`) + test.
5. late settle after run done → emit no-op + test.
6. per-child `nestedBases` sharding → run-global map.
7-8. nits: explicit `nestParentIndex` from host; early-settle-wins comment.
Deliberate non-doings (reasoned): no README change (manager pools
untouched); background-then-await edge noted; no journaling of nested
agents (agent-native activity, not script calls).
My verification: diff read; new file 11→16 passed; neighbours 475/475
(8 files); `npm run check` 2189→2194/7.
Mutations, each red then restored: 7 base (stamp, cap message, fatal flag,
handoff removal→timeout hang, parentIndex, nestingDepth, recordId) + 5 fix
(stale waits, abort neutralize, recordJournal removal, `??=`→`=`, pumping
finally emptied→timeout).

## Task-5 — UI parity + cross-session resume (commit `162e3a6`)

Agent implemented; Sandi verdict **ship with fixes** (4 should-fix + 3 nits);
the fix round was refused by the agent harness, so I implemented every
finding myself (diff-read first, as always):
1. newest-mtime ≠ most complete → most-entries-wins + test.
2. sanitize collisions overwrite → `-2`/`-3` suffix + tests.
3. valid-id + malformed-key dropped → fail-fast + test.
4. unserializable args → key fn throws; caller catches and runs headerless + test.
5. nit: `getuid` fallback — verified shared expression, no change.
6. nit: duplicated precedence comment — removed.
7. nit: `.js` strip added.
Fidelity deviations, Sandi-endorsed: separate `resumeFromKey` param (strict
patterns both sides, explicit precedence — better than loosening the run-id
pattern); overview-`s` repurposed to save (skip stays one level down,
overwrite announced, pinned by test).
My verification: diff read; surfaces 20→26 passed; `npm run check`
2214→2220/7. Mutations, each red then restored: implementor 9/9 + mine 7
(most-complete→mtime, collision→overwrite, keyProbe→undefined,
throw→`if(false)`, strip removal, drop-args, hex-check).

## Task-6 — quality gate (commit `5ca4664`)

No behavior change: docs-consistency sweep found one stale README depth
statement ("one level deep" → `maxWorkflowDepth` 6); other hits verified
unrelated/historical. No Sandi review (nothing behavioral to review).
Verified by grep sweep + `npm run check`.

## Task-8 — final review fixes (commit `3db3f39`)

Sandi end-to-end verdict **ship with fixes** (6 should-fix + 3 nits);
cross-milestone checks verified clean (nested rows never touch frames;
caps orthogonal; launch paths undrifted). Fixed by me:
1. stale "newest match wins" doc → most-complete wording.
2. failed journals outranking complete → ok-only ranking + decisive test.
3. malformed-vs-unknown asymmetry → ACCEPTED with documented reasoning
   (malformed can never match → fail fast; well-formed-unknown may be
   swept → ignore when unused; both behaviors pinned by existing tests).
4. full scan even when id wins → cheap shape-check + scan-only-when-needed
   (`isResumeKeyShape` shared with the resolver).
5. double-read per candidate → shared `parseJournalEntries` /
   `parseJournalHeaderLine` with `readJournal`.
6. symlinked save root → refuse + test; unreadable file → refuse, don't
   suffix + test.
7. case-sensitive `.js` strip → ACCEPTED with documented reasoning
   (exact-name resolution round-trips only then).
8. `isEntry` error-field validation + test.
My verification: diff read; 5 files 265 passed; `npm run check` 2224/7.
Mutations, each red then restored (6): ok-count→total, symlink→false,
error-check removal, read-throw→suffix, shape-check→false, parser bypass.

## Flag-path journaling (commit `a901a26`, auditor 7b fix)

Sandi verdict **ship with fixes** — persistence mirror verified field by
field (no resumability drift), `undefined`-args keying correct, no orphan
paths, omissions intentional. Resolved: unified Resume-key suffix with the
tool; corrected fallback comment; documented tool/flag divergence
(suppress-vs-report) and no-saved-copy note. Test T-F1 (header round-trip
+ reporting, anchored regex + suffix pin).
Mutations, each red then restored (3): resumeKey forced undefined, Task ID
report dropped, suffix reverted — T-F1 red every time.

## Machine outputs (pasted, real)

`npm run check` (branch tip, then `local-patches` @ `d01621e`):
```
Test Files  108 passed (108)
Tests  2224 passed | 7 skipped (2231)
```
(final tip @ `332fa9c`: 108 files, 2225 passed / 7 skipped — +1 is T-F1.)
`npm run test:e2e` (faux): `Test Files 15 passed (15) / Tests 68 passed | 7 skipped (75)`.
`PI_E2E_LIVE=1 PI_PROVIDER=anthropic PI_MODEL=claude-haiku-4-5 npm run test:e2e`:
`Test Files 14 passed | 1 skipped (15) / Tests 65 passed | 10 skipped (75)`, EXIT=0.
`npm run build`: clean, exit 0.
Fixture suite `test/workflow-live-proof.test.ts`: 12 passed (first run green;
one corruption probe red, restored, green).

## Post-hoc Sandi review — task-5 fixes, task-6, evidence layer (criterion 8 closure)

Sandi verdict **ship with fixes** (4 should-fix on the fixture test, 2 doc nits, 1 accept-as-is). This closes the process gap the auditor flagged (task-5 fix round maintainer-implemented after harness refusal; task-6 docs-only unreviewed) — independent eyes on the shipped work, findings resolved below:
1. should-fix: `workflowDepth()` `-Infinity` on empty journal → empty-guard added.
2. should-fix: `header.runId` restated fixture bytes → derived from journal filename (key-determinism assertion remains the real anti-forgery).
3. should-fix: transcript linkage by size + global set equality → per-file bidirectional check (each file shares ≥1 journal token and vice versa).
4. should-fix: decompose branch hardcoded `/3:` slot → slot-independent grouping (non-backbone `:w` branch, sizes `[3]`).
5. nit (accepted, no change): content-filtered file sets partly overfit — acceptable for a fixture pin.
6. nit: evidence note '26 agents' vs '18 entries' → clarified as 18 journaled + 8 transcripts.
7. nit: this note's item 4 wording → 'key fn throws; caller catches and runs headerless.'
Verified clean (no finding): task-5 ok-count ranking, shared parsers, fail-fast key shape, headerless-skip, case-sensitive strip doc, collision suffix + unreadable-refuse; task-6 README depth statement accurate.
Explicitly not covered by the review (known-uncovered, not findings): concurrent-journal kill interleaving; non-journal `.workflow.jsonl` garbage in session dirs; `/workflows` verbatim-args path beyond surface tests.
My verification: diff read; fixture test 18→18 green; `npm run check` green.

## Finish-off probes — new fixture assertions (criterion 7 closure)

Q1 (filename-derived runId): forged header runId on the composed journal → exactly 'keys the journal deterministically' red (1 failed/17 passed) → restored → 18 green.
Q2 (per-file linkage): dropped all 4 GC_ tokens in one run-prefixed transcript → exactly 'links its 8 transcripts' red → restored → green.
Q3 (slot-free branch): injected a SURV_ marker into the split entry → branch sizes [2]≠[3], exactly 'carries the backbone tokens' red → restored → green.
Earlier (original 12 assertions): P1 dropped a journal line → count test red; P2-strong replaced all GC_ in one transcript → linkage red (a single-occurrence replace was insufficient — the token repeats in prompt+answer); both restored → green.
Probe sweep after each restore: grep for FORGED/XX_/SURV_subtasks clean; git status shows only intended files.

## Post-hoc Sandi review — Sonnet designated run (revised 7b closure)

Sandi verdict **no blockers** (3 suggestions, all fixed). Post-hoc independent review of the shipped diff (5-test Sonnet describe + `transcriptTotalTokens` helper + 10 Sonnet fixtures + v5 note + CHANGELOG bullet), satisfying criterion 8 for maintainer-implemented finish-off work:
1. suggestion (fixed): v5 'verbatim' stdout block typed `live-profit-full` — a real typo I introduced; corrected to `live-proof-full`.
2. suggestion (fixed): linkage comment claimed 'exactly the 8 backbone tokens' but no assertion pinned the set size — added `expect(journalGc.size).toBe(8)`.
3. suggestion (fixed in substance): usage-line assertion was `>0`, not `===1` — hardened to exactly one per file. Direct `JSON.parse` kept deliberately: non-JSON corruption throws red, stricter than skip-and-count.
My verification: diff read; fixture test 23/23 green; `npm run check` 109 files, 2248 passed / 7 skipped.
Probes, each red then restored (7): P1 journal ok→false → counts red; P2 forged stdout Task ID → stdout red; P3 split to 1 subtask → branch red; P4 global GC rename → linkage red (single-file rename insufficient — the token occurs 4× with 2 sharing a line); P5 dropped usage line → aggregated red; S 9th GC token in journal+transcript → only the size assertion red (linkage held); U duplicated usage line → only the aggregated test red. All restores byte-verified against backups; 23 green after each restore.
Machine outputs: `npx vitest run test/workflow-live-proof.test.ts` → 23 passed (23). `npm run check` → Test Files 109 passed (109) / Tests 2248 passed | 7 skipped (2255).

## Post-hoc independent review — leftover hardening (criterion: independent eyes)

Sandi verdict **ship** (no blockers; docs-only + test-pinning, no source changes). Reviewed `3ca591e..HEAD` (stale-doc reword, kill-offset property, garbage/torn ranking, verbatim-args cases, CHANGELOG bullets):
1. Kill-offset property loop correctly oracles the split-on-newline readers (complete-without-newline boundaries); torn-header and header-only cases match decline/accept.
2. Garbage + torn-ranking pins verified against the scan; `utimesSync` (plural) confirmed as the real `node:fs` API and the correct deterministic-ordering fix for recency-tie false-passes.
3. Nit (verified non-issue, no change): claimed 4sp over-indent — the block indents `it` at 4sp throughout and biome is green.
Not covered (accepted with reasoning): multi-byte split mid-codepoint — fixtures are ASCII and utf-8 decode never throws (replacement char parses as skippable), so the property holds by construction.
My verification: diff read; `npm run check` green (2255 passed | 7 skipped).
Probes, each red then restored: K1 (push non-entries), K2 (header marker never matches); G1 (drop resume-key check — rerun deterministic after `utimesSync` ordering), G2 (complete torn partial into a 2nd ok entry); V1 (wrap parsed args), V2 (dangling catch transform error). The kill property also caught an off-by-one in my own test math (complete-without-newline), fixed before commit.
