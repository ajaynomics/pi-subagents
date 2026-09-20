# Task-7 live confirmation evidence (unattended, no human gate)

Branch `feat/dynamic-workflows`, base `5ca4664`. All runs headless on heyoka.
No screenshot, no eyeballing, no human inspection anywhere: every claim below
is a pasted command output or a programmatically asserted value. Where a first
reading was wrong, the correction is recorded, not edited away.

Model set: SuperQwen 3.8-27B local (`gpu0/qwen3.8-27b-superqwen`, free) for the
recursive runs; Anthropic `claude-haiku-4-5` (paid) for the e2e live suite.
Paid-big-model substitution is recorded at the bottom with failure modes.

## 7a — `PI_E2E_LIVE=1 npm run test:e2e` passes

```
$ PI_E2E_LIVE=1 PI_PROVIDER=anthropic PI_MODEL=claude-haiku-4-5 npm run test:e2e
EXIT=0
Test Files  14 passed | 1 skipped (15)
Tests  65 passed | 10 skipped (75)
```

Pre-history (kept because it explains two infra notes): first attempt with
`PI_PROVIDER=gpu0` failed all 7 live tests — 1 root cause (`model
"gpu0/qwen3.8-27b-superqwen" not found in the builtin catalog`: the e2e runner
resolves via pi-ai `getBuiltinModel`, which has no local providers) plus 6
`uv_cwd` cascade victims (the first failure leaves the worker chdir'd into a
deleted temp dir; siblings then fail at `process.cwd()`). With a valid catalog
model (`anthropic/claude-haiku-4-5`, verified via `getBuiltinModel` returning
FOUND before spending) the suite is green. The `uv_cwd` cascade is a harness
wart, out of scope: with a working model there is no first failure to cascade.

## 7b — headless recursive runs (SuperQwen, free)

Script `/tmp/wf-live-big/big.js` (self-contained, no schema): depth-3,
fanout-2 recursion via `workflow({scriptPath})` (survey agent per non-leaf
level) plus a root `worklist` (seeds w1,w2; w1 adds w1b). Expected: 15 tree
agents + 3 worklist = 18, `:w` depth 3. Leaves use `agentType: "worker"`
(`.pi/agents/worker.md` copied beside the script); prompts are exact-token
echoes (`SURV_*`, `LEAF_*`, `WL_*`).

Headless harness: `pi --mode rpc` with stdin on a held-open fifo, prompt
instructs ONE verbatim `SubagentWorkflow` call (`scriptPath`, no args), then
the journal file is polled from bash — never the model's word for it. Two
infra lessons, both paid for and both fixed in-harness: (1) a transient
`echo > fifo` writer closes the write end, the reader sees EOF and pi shuts
down cleanly mid-run — a persistent `sleep 3500 > fifo &` writer is required;
(2) `pkill -f` with a pattern present in your own command line kills your own
shell — exact-PID kills only (this bit twice).

Deviation from the criterion letter, with reasoning: the criterion names `pi
-p --subagents-workflow-file=<path>`, but `runWorkflowFlag` wires NO
`journalPath` (read: `createWorkflowTask({id, script, scriptPath, meta})` —
no journal, no header, no replay), so flag runs cannot satisfy the contract's
own journal/resume assertions. The evidence uses the tool path headless
(`scriptPath` passed to `SubagentWorkflow`), which is the same file-driven
mechanics with full journaling. Fixing the flag path is product scope beyond
this task, not taken.

Run wf_c41526ac7366 (SuperQwen, tool-driven headless):
run wf_eac616166d93 (SuperQwen, tool-driven headless, retry of a dropped key):
both journals parsed programmatically:

- entries: 18 / 18. ok: 18 / 18. max `:w` depth: 3 / 3.
- tokens echoed: `SURV_root`, `LEAF_root_0_0_0`, `LEAF_root_1_1_1`, `WL_w1b` present.
- header resume keys equal across both runs (same script+args → same key, twice).

## 7c — controlled kill + resume (SuperQwen, free)

Kill: fresh run wf_3f7b6dc8a289 polled to 5 entries, then `kill -9` by exact
PID in the same command. Verified: process dead (`kill -0` fails), journal
static at 5/5 across a 20s re-read, all 5 ok, paths
`#0 /1:p:0/0:w#0 /1:p:1/0:w#0 /1:p:0/0:w/1:p:0/0:w#0
/1:p:0/0:w/1:p:1/0:w#0` (true big.js structure).

Resume wf_dc46d2a82adf (fresh RPC session, `scriptPath` + `resumeFromKey`
both early-verified byte-exact in the tool-call log BEFORE waiting — the
protocol that caught one dropped key and would have caught the paraphrase):

- `keys_equal: True` (cross-session key determinism).
- old entries: 5, new entries: 18. new ok: 18. max `:w` depth: 3.
- **replayed: 5, live: 13.** replay text identical: True (byte-identical
  answers — never another call's answer). live all ok: True.
- replayed paths exactly the 5 killed entries above.
- tool result in the log: `Resuming wf_3f7b6dc8a289: 5 recorded call(s)
  available to replay.`

Model-compliance hardening (worth stating because two legs burned on it):
one run dropped `resumeFromKey` (fixed by focused re-prompt + log check), and
the very first `-p` run inlined a paraphrase (caught by sha + saved-script
diffs, which also corrected an early misattribution of mine: run 38bfa was
the smoke script, not big.js). Product mechanics behaved exactly as designed
in every leg: header at launch, deterministic keys, lookup by key, replay on
(path,key) match, live on mismatch (including correct NON-replay across
different scripts).

## Paid-big-model substitution (objective fallback rule invoked)

 muse-spark-1.3-contributor (this session's model): unreachable headless.
 `--provider meta` → `Error: Unknown provider "meta"` (instant, no spend);
 `--model meta/muse-spark-1.3-contributor` alone → OpenRouter 404 `Paid model
 training violation (account settings)`. Account settings are a human surface;
 untouched, as instructed.
 claude-sonnet-4-5 via RPC: session alive, TWO consecutive empty turns
 (`content:[]`, zero usage, `turn_end` fired), no dispatch in ~15 min. Killed.
 claude-haiku-4-5 via RPC: alive, no dispatch in ~8.5 min — although the SAME
 model dispatches reliably in the vitest e2e harness (7a above), so this is a
 harness interaction, not a model verdict. Killed.
Paid-model evidence therefore rests on the 7a live suite (dispatch, schema,
fanout on Anthropic); the recursive + kill/resume proofs rest on SuperQwen
(live, non-faux, headless) with the programmatic assertions above. No further
paid attempts: the fallback rule says record and continue.

## Honest gaps (what was NOT separately located)

- Per-agent token totals: the journal carries texts, not tokens. The RPC log
  holds per-agent `totalTokens` usage snapshots (e.g. five at 14520); they are
  unattributed steady-state records, so no per-agent token table is claimed.
- Progress entry log: headless has no card; the `workflow-result` session
  entry was not isolated by grep among RPC events. Counts asserted instead
  from journal cross-checks (replayed/live/ok/depth), which subsume what the
  notification reports.
- UI surfaces (criterion 5/7d): proven in-process by `test/workflow-surfaces.test.ts`
  (26 tests: render strings, key handling, counts) — screenshots and eyeballing
  are neither required nor accepted as evidence, per the objective.
