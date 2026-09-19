/**
 * journal.ts — the record a workflow run leaves so a later run can skip work.
 *
 * ## What resume actually buys
 *
 * The documented iteration loop is "edit the persisted script and re-run it".
 * Without a journal that re-pays every agent from scratch, which for a 40-agent
 * audit is the entire cost of the run — to change one line of the last stage.
 * With one, the unchanged work comes back from disk and only the edit runs.
 *
 * ## Identity: where a call sits, not when it arrived
 *
 * Each entry is keyed by two things: a *path* — the call's position in the run's
 * structural tree — and a hash of everything that decides what that agent does.
 * A call replays when the journal has that exact path, the hash still matches,
 * and the recorded call succeeded.
 *
 * The path is causal, not chronological. A run is a tree of *frames*, where a
 * frame is one sequential chain of script execution: the top level is one, each
 * `parallel()` thunk is one, each `pipeline()` item's whole stage chain is one,
 * each nested `workflow()` body is one. Within a frame the script's own code
 * fixes the order, so a per-frame counter is deterministic; concurrency only
 * happens between frames. Paths name that tree: `#k` is slot `k` of a frame,
 * `/k:p:i` is parallel thunk `i` at slot `k`, `/k:l:i` is pipeline item `i` at
 * slot `k`, and `/k:w` is the nested `workflow()` body at slot `k`. Numbering
 * calls by arrival instead would make the identity of a pipeline's agents depend
 * on which sibling item finished first, so an unchanged script re-run would lose
 * most of its cache to nothing more than a different interleaving.
 *
 * ## Why a match is not enough on its own
 *
 * A recorded answer was produced downstream of whatever ran before it in its
 * own chain, so reusing it after that chain changed would be reusing a result
 * from a run that never happened. On the first miss the runtime marks that
 * frame dirty, and every later call in it — or in a frame nested inside it —
 * runs live however well it matches. Sibling frames are untouched: editing one
 * pipeline item's prompt re-runs that item, not the other thirty-nine. Upward
 * isolation relies on the key: a parent whose prompt is data-dependent on a
 * child's result re-runs via key miss, while a parent with a static prompt is
 * genuinely independent so replay stays correct.
 *
 * The dirty mark is per frame and not per causal edge, which over-invalidates in
 * one shape: a script that starts a `parallel()` without awaiting it, runs an
 * `agent()` that misses, then awaits the parallel will see those children
 * invalidated although nothing they depend on changed. It costs cache hits, not
 * correctness.
 *
 * A failed agent is journaled as a failure and never replayed as one. Resuming
 * a run that died at agent 5 exists to retry agent 5, so that call misses and
 * its chain runs live — the alternative would make a failure permanent.
 *
 * ## Runs that use `agent({ resume })`
 *
 * Those are not replayed at all. A replayed agent is text from a file, not a
 * live child, so there is no conversation in this run for a later `resume` to
 * continue — and the id map that would find one belongs to the run that did
 * the spawning. Rather than replay a journal that strands the first `resume`
 * call, a journal carrying one declines the whole cache and the run pays in
 * full. Coarse on purpose: the alternative is tracking which label each entry
 * ran under and declining every chain that feeds one, which is a second key
 * concept for a case that costs one run.
 *
 * ## What the file is
 *
 * The file is JSON Lines, appended as each agent settles, so a run that is
 * killed mid-flight still leaves everything it had finished.
 */

import { createHash } from "node:crypto";
import { appendFileSync, readFileSync } from "node:fs";

/** One settled agent call, as replayed. */
export interface WorkflowJournalEntry {
  /**
   * Where the call sits in the run's structural tree — its identity on replay.
   *
   * `#k` is slot `k` of a frame; `/k:p:i` is parallel thunk `i` at slot `k`,
   * `/k:l:i` is pipeline item `i` at slot `k`, and `/k:w` is the nested
   * `workflow()` body at slot `k`. Opaque: compared for equality, and for
   */
  path: string;
  /**
   * Arrival order — the same counter that names `wf-agent-N`.
   *
   * Informational. It orders the file for a reader (the tool description sends
   * the model here to see what each agent actually returned) and nothing on the
   * replay path reads it.
   */
  index: number;
  /** Hash of the call's payload; a mismatch makes the call, and its chain, run live. */
  key: string;
  /** Whether the agent succeeded. A failure is never replayed. */
  ok: boolean;
  /** The agent's answer, when it had one. */
  text?: string;
  /**
   * Whether the call continued an earlier child (`agent({ resume })`).
   *
   * A replayed agent leaves no session behind in the run that replays it — the
   * conversation belongs to the run that actually spawned it, and the host's
   * id map is per-run — so a later `resume` would have nothing to continue.
   * Recording it lets the next run decline to replay at all rather than fail
   * partway through, which is why the flag is on the journal and not derived.
   */
  resumed?: true;
}

/**
 * The fields that decide what an agent does.
 *
 * Deliberately not the whole payload: `phaseIndex` and `phaseTitle` move the
 * row around in the progress tree without changing a single token the agent
 * sees, so re-grouping phases should not throw away an hour of results.
 */
export interface JournalKeyInput {
  prompt: string;
  label?: string;
  model?: string;
  agentType?: string;
  effort?: string;
  isolation?: string;
  gate?: string;
  resume?: string;
  /** Serialized `agent({ schema })`, when the call asked for one. */
  schema?: string;
}

/** Stable hash of a call's payload. Field order is fixed here, not by the caller. */
export function journalKey(input: JournalKeyInput): string {
  const canonical = JSON.stringify([
    input.prompt,
    input.label ?? null,
    input.model ?? null,
    input.agentType ?? null,
    input.effort ?? null,
    input.isolation ?? null,
    input.gate ?? null,
    input.resume ?? null,
    // Appended only when present, which looks like a hack and is not: adding a
    // ninth slot unconditionally would change the canonical form of every entry
    // and invalidate every journal already on disk. Conditional, a schema-less
    // call keys exactly as it always did, and adding or changing a schema still
    // produces a different key.
    ...(input.schema !== undefined ? [input.schema] : []),
  ]);
  return createHash("sha256").update(canonical).digest("hex").slice(0, 32);
}

/**
 * Read a journal file into arrival order.
 *
 * Never throws: a missing, truncated or hand-mangled journal means "nothing to
 * replay", which costs tokens. Refusing to run would cost the whole run.
 * A partial last line is normal — the file is appended to while agents settle.
 */
export function readJournal(path: string): WorkflowJournalEntry[] {
  let raw: string;
  try {
    raw = readFileSync(path, "utf-8");
  } catch {
    return [];
  }

  const entries: WorkflowJournalEntry[] = [];
  for (const line of raw.split("\n")) {
    if (line.trim() === "") continue;
    try {
      const parsed = JSON.parse(line) as unknown;
      if (!isEntry(parsed)) continue;
      entries.push(parsed);
    } catch {
      // A half-written final line, or someone editing the file. Skipping it
      // keeps every other entry replayable.
    }
  }
  entries.sort((a, b) => a.index - b.index);
  return entries;
}

/** Append one settled call. Failure to write is not failure to run. */
export function appendJournal(path: string, entry: WorkflowJournalEntry): void {
  try {
    appendFileSync(path, `${JSON.stringify(entry)}\n`, "utf-8");
  } catch {
    // A journal that cannot be written costs a future resume, nothing more.
  }
}

function isEntry(value: unknown): value is WorkflowJournalEntry {
  if (typeof value !== "object" || value === null) return false;
  const entry = value as Record<string, unknown>;
  return (
    typeof entry.path === "string" &&
    Number.isInteger(entry.index) &&
    (entry.index as number) >= 0 &&
    typeof entry.key === "string" &&
    typeof entry.ok === "boolean" &&
    (entry.text === undefined || typeof entry.text === "string") &&
    (entry.resumed === undefined || entry.resumed === true)
  );
}
