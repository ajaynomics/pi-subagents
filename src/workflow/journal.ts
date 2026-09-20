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
 * each `worklist()` seed or added item's run of `fn` is one,
 * each nested `workflow()` body is one. Within a frame the script's own code
 * fixes the order, so a per-frame counter is deterministic; concurrency only
 * happens between frames. Paths name that tree: `#k` is slot `k` of a frame,
 * `/k:p:i` is parallel thunk `i` at slot `k`, `/k:l:i` is pipeline item `i` at
 * slot `k`, `/k:q:i` is worklist seed `i` at slot `k`, `/a:j` extends the
 * calling frame with the j-th `add()` from it, and `/k:w` is the nested
 * `workflow()` body at slot `k`. Numbering
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
 * killed mid-flight still leaves everything it had finished. The first line
 * may instead be a header carrying the run's resume key (see
 * {@link workflowResumeKey}) — it is not an agent entry, so a reader that
 * only accepts entries skips it untouched.
 *
 * ## Cross-session resume
 *
 * A run id only resolves inside the session that ran it, and journals live
 * under a per-session directory. A new session finds an old journal by the
 * resume key instead: the sha256 of the script plus its args, stored in the
 * header and matched by {@link findJournalByResumeKey} across every session
 * directory for the project. Newest match wins.
 */

import { createHash } from "node:crypto";
import { appendFileSync, readdirSync, readFileSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { encodeCwd } from "../output-file.js";

/** One settled agent call, as replayed. */
export interface WorkflowJournalEntry {
  /**
   * Where the call sits in the run's structural tree — its identity on replay.
   *
   * `#k` is slot `k` of a frame; `/k:p:i` is parallel thunk `i` at slot `k`,
   * `/k:l:i` is pipeline item `i` at slot `k`, `/k:q:i` is worklist seed `i`
   * at slot `k`, `/a:j` is the j-th `add()` from the calling frame, and `/k:w`
   * is the nested `workflow()` body at slot `k`. Opaque: compared for
   * equality, and for
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
  /** The failure that settled the call, when it had one. Informational: failures never replay. */
  error?: string;
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

/**
 * Key that identifies a whole run's journal across sessions.
 *
 * `sha256(JSON.stringify([script, argsJson]))` as 64 lowercase hex chars,
 * where `argsJson` is `"null"` for no args and `JSON.stringify(args)`
 * otherwise. JSON key order matters: the same args in a different key order
 * are a different key, and so replay nothing. Throws when `args` are not
 * JSON-serializable — callers that cannot key a run skip the header and keep
 * the same-session resume they already had.
 */
export function workflowResumeKey(script: string, args: unknown): string {
  const argsJson: string | undefined = args === undefined ? "null" : JSON.stringify(args);
  if (argsJson === undefined) {
    throw new Error("workflowResumeKey: args are not JSON-serializable, so the run cannot be keyed for cross-session resume.");
  }
  return createHash("sha256").update(JSON.stringify([script, argsJson])).digest("hex");
}

/** First line of a journal file, when the run recorded one. */
export interface WorkflowJournalHeader {
  /** {@link workflowResumeKey} of the run that wrote the file. */
  resumeKey: string;
  /** The run id that wrote it, for the result line that says what replayed. */
  runId: string;
  /** `Date.now()` when the run started. Informational. */
  createdAt: number;
}

/** Marker field a header line carries; agent entries never have it. */
const JOURNAL_HEADER_MARKER = "workflowJournalHeader";

/** Write the header line. Best-effort like every other journal write. */
export function writeJournalHeader(path: string, header: WorkflowJournalHeader): void {
  try {
    appendFileSync(path, `${JSON.stringify({ [JOURNAL_HEADER_MARKER]: 1, ...header })}\n`, "utf-8");
  } catch {
    // Same trade as appendJournal: no header costs a cross-session resume.
  }
}

/**
 * Read the header line back. Never throws: a journal from before headers
 * existed, or one whose first line is an agent entry, simply has none.
 */
export function readJournalHeader(path: string): WorkflowJournalHeader | undefined {
  let first: string | undefined;
  try {
    const raw = readFileSync(path, "utf-8");
    for (const line of raw.split("\n")) {
      if (line.trim() === "") continue;
      first = line;
      break;
    }
  } catch {
    return undefined;
  }
  if (first === undefined) return undefined;
  try {
    const parsed: unknown = JSON.parse(first);
    if (typeof parsed !== "object" || parsed === null) return undefined;
    const record = parsed as Record<string, unknown>;
    if (record[JOURNAL_HEADER_MARKER] !== 1) return undefined;
    if (typeof record.resumeKey !== "string" || typeof record.runId !== "string") return undefined;
    if (!/^[0-9a-f]{64}$/.test(record.resumeKey)) return undefined;
    return {
      resumeKey: record.resumeKey,
      runId: record.runId,
      createdAt: typeof record.createdAt === "number" ? record.createdAt : 0,
    };
  } catch {
    return undefined;
  }
}

/**
 * Find a journal written for `resumeKey` under the same project.
 *
 * Journals live at `<tmp>/pi-subagents-<uid>/<encoded-cwd>/<session>/tasks/,
 * so a new session is a new directory: the scan covers every session directory
 * for this cwd and returns the match with the most journaled agent calls
 * (file mtime breaks ties), which is the most complete run of that script
 * plus args. Never throws: nothing found is undefined.
 */
export function findJournalByResumeKey(cwd: string, resumeKey: string): string | undefined {
  let base: string;
  try {
    base = join(tmpdir(), `pi-subagents-${process.getuid?.() ?? 0}`, encodeCwd(cwd));
  } catch {
    return undefined;
  }
  let sessions: string[];
  try {
    sessions = readdirSync(base);
  } catch {
    return undefined;
  }
  let best: string | undefined;
  let bestCount = -1;
  let bestMtime = -1;
  for (const session of sessions) {
    const dir = join(base, session, "tasks");
    let files: string[];
    try {
      files = readdirSync(dir);
    } catch {
      continue;
    }
    for (const file of files) {
      if (!file.endsWith(".workflow.jsonl")) continue;
      const path = join(dir, file);
      const header = readJournalHeader(path);
      if (header?.resumeKey !== resumeKey) continue;
      const count = readJournal(path).length;
      let mtime = 0;
      try {
        mtime = statSync(path).mtimeMs;
      } catch {
        continue;
      }
      if (count > bestCount || (count === bestCount && mtime > bestMtime)) {
        bestCount = count;
        bestMtime = mtime;
        best = path;
      }
    }
  }
  return best;
}
