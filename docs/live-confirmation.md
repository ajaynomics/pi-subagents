# Task-7 live confirmation evidence, v5 (closed-list record)

Supersedes v4. Records exactly the revised criterion-7 closed lists — one
composed run, one kill+resume, committed artifacts, asserted values. Every
number below is pasted raw output or re-asserted by
`test/workflow-live-proof.test.ts` (23 passed). No human anywhere.

## 7b: the closed-list composed run (designated: Sonnet)

`pi -p --no-extensions --extension <worktree>/src/index.ts --provider anthropic
--model claude-sonnet-4-5
--subagents-workflow-file=/tmp/wf-live-full/big-full.js` (required flag
harness, one-shot awaited mode), EXIT=0. Raw stdout head, verbatim:

```
[pi-subagents] Running workflow live-proof-full…
[pi-subagents] Task ID: wf_135fcfd5ebcc
[pi-subagents] Resume key: f3ef379924484bad683cb98d42e9418e7a2d530ffe528a52b5d01ec8f9a0241c — same script plus args with resumeFromKey replays this run from any session.
```

Raw journal parse (`wf_135fcfd5ebcc.workflow.jsonl`), verbatim:

```
runId: wf_135fcfd5ebcc | key: f3ef37992448
entries: 21 ok: 21
max :w depth: 3
SURV_root: True | WL_w1b: True | LEAF_root_: 8
decompose-leg entries: 3
transcripts: 8
```

Composition, all in this one run: 18 backbone (15 fixed-fanout tree + 3
worklist incl. dynamically added `w1b`) at `:w` depth 3 with 8 depth-0
leaves delegating via the Agent tool (texts `LEAF_*:GC_*`, 8 grandchild
transcripts bidirectionally linked), PLUS a real saved-workflow leg
`workflow("decompose", {task, depth: 1, fanout: 2})` whose schema split
returned model-generated subtasks (`/3:w#0 →
{"subtasks":["Implement core audit proof helper functions and
utilities","Add tests and documentation …`) with 2 subtask leaves
journaled under the same branch. One leaf's prose documents the
`SURV_/LEAF_/GC_/WL_` prefix convention without adding a token — the
journal GC set stays exactly the 8 backbone tokens. Resume key
`f3ef37992448` is byte-identical across two SuperQwen dry-runs, the haiku
run, and this Sonnet run (same script, no args) — cross-model key
determinism, computed live by the fixture test from the committed script.

Run-level token evidence (revised 7b): the transcript-aggregated
delegated-subset total — sum of provider-reported per-call
`usage.totalTokens` across the run's 8 committed grandchild transcripts —
is 62,291 totalTokens ($0.120749; input 80, output 926, cacheRead 35710,
cacheWrite 25575), labeled as the delegated subset, plus journal-derived
scale (21 journaled agents, max `:w` depth 3, 8 transcripts). The fixture
test pins presence and shape (8 numeric per-call totals, positive integer
aggregate), not the number.

Free dry-runs (setup validation, fulfilled): first died silently at the
decompose call (project root resolved to the worktree, no
`.pi/workflows/` there — relaunched from the project dir); second proved
the leg resolves with a real split, then hung on SuperQwen inline work
(300s silence — killed; SuperQwen behavior, not product evidence).

## Tweak history (why 7b changed)

The prior 7b demanded a provider-reported full-run total in the run's
stdout. Four completion audits rejected on that line: haiku completed the
composed run 21/21 yet printed headers only. A second paid run on Sonnet
(user-authorized) also completed 21/21 with headers only — two models,
same outcome, so the gap is harness behavior (the flag runner prints
Task-ID/Resume-key and the journal stores no usage), not model variance.
Re-rolling paid further could not produce what no run records. The user
tweak accepts the transcript-aggregated delegated-subset total plus
journal-derived scale as the run-level token evidence, and the Sonnet run
— stronger model, same script/args/key — is designated the closed-list
run; the haiku run stands as supporting cross-model determinism evidence.

## 7c: kill + id-resume

Kill journal `wf_74f36ab43ceb` (8 entries, controlled `-9`) → same-session
`resumeFromRunId` journal `wf_d069526db115` (18 entries): replayed 8
byte-identical, live 10, all 18 ok, depth 3 (fixture test). Runtime report,
committed verbatim in `resume.stdout.txt`:

```
Task ID: wf_d069526db115
Resuming wf_74f36ab43ceb: 8 recorded call(s) available to replay.
```

Replay is proven by the runtime's Resuming report plus subset structure.
Deterministic prompts make replayed content identical to fresh content by
design — content difference is not required (criterion says so explicitly).
Header keys differ (`stopAfter` args vs none): id-resume is args-agnostic.

## Supporting runs (fixtures, one line each)

- SuperQwen composed `wf_00d1931ce699`: 18/18 ok, depth 3, 8 delegations,
  bidirectional transcript linkage (fixed-fanout backbone proof).
- Paid big.js `wf_d975d29936f2`: 18/18 ok, depth 3, completion text
  `Tokens: 52.6K` — the mechanism proof that totals are reported when the
  model summarizes.
- Haiku composed `wf_8c71607c0df2`: 21/21 ok, depth 3, real decompose
  branch, 8 transcripts — superseded as designated run by Sonnet, kept as
  same-key cross-model determinism proof.
- Delegation `wf_9300889399fe`: 2 entries + 1 transcript sharing
  `DEL_B:DEL_CHILD`.
- Flag SuperQwen `wf_a5f865a64c96`: 18/18 ok, depth 3 (flag harness journals).
- Kill/resume journals above.

## Committed artifacts

`test/fixtures/live-proof/` (46 files): 6 scripts, 8 journals, 25
transcripts, 7 stdout captures (4 full-run + kill + resume + flag).
`test/workflow-live-proof.test.ts` (23 tests) pins: counts, all-ok, depth,
key determinism recomputed from committed scripts, filename-derived runIds,
backbone tokens, 3-entry decompose branch (split JSON + 2 leaves),
per-file bidirectional transcript linkage, Task-ID/Resume-key lines, the
Resuming line, and the aggregated delegated-subset token total
(presence/shape).
`docs/reviews.md`: per-milestone + post-hoc finding resolutions with the
full mutation-probe log.

## Honest gaps, final

- Per-agent token tables: the runtime reports per-turn usage and run totals
  only. Not claimed.
- Headless progress file: none exists by design (card is live-rendered);
  sessions mined for `workflow-result`: zero hits. Covered by in-process
  render assertions + journal entries + completion texts.
- UI surfaces: in-process only, per 7d.
- RPC mega-logs are ephemeral transport; the kill/resume Task-ID and
  Resuming lines are committed as extracts and re-asserted by test.

## Infra notes (paid for, kept)

RPC keepalive needs a persistent fifo writer; transient writers EOF and pi
exits cleanly mid-run. Never `pkill -f` with a pattern in your own command
line (kills your shell — twice bitten); exact-PID kills only, and
`pgrep -x pi` plus cmdline-match protects other sessions on a shared box.
Python `json.dumps` needs `separators=(",", ":")` to match Node
`JSON.stringify` for sha checks (and Node writes journals spaceless —
`"runId":"…"`, which one probe initially missed). Saved `.workflow.js`
files are ground truth for what ran. Launch flag runs from the project dir
so `.pi/workflows` and `.pi/agents` resolve where the run executes.
Mutation probes edit fixture bytes in place with backup/restore — `sed`
without `/g` misses same-line duplicate tokens (bitten once on P4).
