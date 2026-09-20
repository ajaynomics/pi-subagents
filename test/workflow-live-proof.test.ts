/**
 * workflow-live-proof.test.ts — task-7 live runs as committed fixtures.
 *
 * The journals, transcripts, scripts and stdout captures under
 * test/fixtures/live-proof/ were produced by real headless runs (local
 * SuperQwen, paid Anthropic haiku, paid Anthropic Sonnet) and committed so
 * the proof re-verifies without spending a model call. The Sonnet run is
 * the designated criterion-7b closed-list run; haiku stands as supporting
 * cross-model determinism evidence (same script, args, and resume key).
 * Every property below is asserted from the files with the production
 * journal parser and key function — corrupt a fixture and its test goes
 * red.
 */

import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  readJournal,
  readJournalHeader,
  type WorkflowJournalEntry,
  workflowResumeKey,
} from "../src/workflow/journal.js";

const PROOF_DIR = fileURLToPath(new URL("./fixtures/live-proof", import.meta.url));

const fixture = (name: string): string => join(PROOF_DIR, name);

function journalEntries(name: string): WorkflowJournalEntry[] {
  return readJournal(fixture(name));
}

function journalHeader(name: string): { resumeKey: string; runId: string } {
  const header = readJournalHeader(fixture(name));
  expect(header, `${name} must carry a valid header`).toBeTruthy();
  return header!;
}

function journalRunId(name: string): string {
  return name.replace(/\.workflow\.jsonl$/, "");
}

function textsOf(entries: WorkflowJournalEntry[]): string[] {
  return entries.map(entry => entry.text ?? "");
}

function gcTokens(texts: string[]): Set<string> {
  const found = new Set<string>();
  for (const text of texts) {
    for (const match of text.match(/GC_[A-Za-z0-9_]+/g) ?? []) found.add(match);
  }
  return found;
}

function workflowDepth(entries: WorkflowJournalEntry[]): number {
  if (entries.length === 0) return 0;
  return Math.max(...entries.map(entry => entry.path.split(":w").length - 1));
}

function outputFiles(): string[] {
  return readdirSync(PROOF_DIR).filter(file => file.endsWith(".output"));
}

function sharesTokensEachWay(files: string[], tokens: Set<string>): void {
  for (const file of files) {
    const text = readFileSync(join(PROOF_DIR, file), "utf-8");
    expect(
      Array.from(tokens).some(token => text.includes(token)),
      `${file} shares a journal token`,
    ).toBe(true);
  }
  for (const token of Array.from(tokens)) {
    const hit = files.some(file => readFileSync(join(PROOF_DIR, file), "utf-8").includes(token));
    expect(hit, `journal token ${token} appears in a transcript`).toBe(true);
  }
}

function transcriptTotalTokens(file: string): number {
  // Sums provider-reported per-call usage.totalTokens lines in one committed
  // grandchild transcript (exactly one exists per file). Presence and shape
  // asserted, not the number — the aggregate is the delegated subset, never
  // the full run (direct agent calls report no committed usage).
  const totals: number[] = [];
  for (const line of readFileSync(join(PROOF_DIR, file), "utf-8").split("\n")) {
    const trimmed = line.trim();
    if (trimmed === "") continue;
    const usage = (JSON.parse(trimmed) as { message?: { usage?: { totalTokens?: unknown } } }).message?.usage;
    if (usage !== undefined) {
      const value: unknown = usage.totalTokens;
      expect(typeof value, `${file} usage.totalTokens is numeric`).toBe("number");
      if (typeof value === "number") totals.push(value);
    }
  }
  expect(totals.length, `${file} carries exactly one provider-reported usage line`).toBe(1);
  return totals.reduce((sum, value) => sum + value, 0);
}

describe("live proof: composed run (recursion + worklist + delegation)", () => {
  it("journals 18 agents at depth 3, all ok", () => {
    const entries = journalEntries("wf_00d1931ce699.workflow.jsonl");
    expect(entries).toHaveLength(18);
    expect(entries.every(entry => entry.ok)).toBe(true);
    expect(workflowDepth(entries)).toBe(3);
  });

  it("keys the journal deterministically from the committed script", () => {
    const script = readFileSync(fixture("big-deleg.js"), "utf-8");
    const header = journalHeader("wf_00d1931ce699.workflow.jsonl");
    expect(header.resumeKey).toBe(workflowResumeKey(script, undefined));
    expect(header.runId).toBe(journalRunId("wf_00d1931ce699.workflow.jsonl"));
  });

  it("links all 8 delegations to transcripts bidirectionally", () => {
    const entries = journalEntries("wf_00d1931ce699.workflow.jsonl");
    const journalGc = gcTokens(textsOf(entries));
    expect(journalGc.size).toBe(8);
    const composed = outputFiles().filter(
      file =>
        !file.startsWith("wf_") &&
        readFileSync(join(PROOF_DIR, file), "utf-8").includes("GC_root_"),
    );
    expect(composed).toHaveLength(8);
    sharesTokensEachWay(composed, journalGc);
  });

  it("stdout reports the run's Task ID and Resume key", () => {
    const out = readFileSync(fixture("delegated.stdout.txt"), "utf-8");
    expect(out).toContain("Task ID: wf_00d1931ce699");
    expect(out).toContain("Resume key:");
  });
});

describe("live proof: kill + id-resume replays the killed prefix", () => {
  it("replays 8 killed calls identical and runs 10 live", () => {
    const killed = journalEntries("wf_74f36ab43ceb.workflow.jsonl");
    expect(killed).toHaveLength(8);
    const resumed = journalEntries("wf_d069526db115.workflow.jsonl");
    expect(resumed).toHaveLength(18);
    const oldSet = new Map(killed.map(entry => [`${entry.path}\n${entry.key}`, entry.text]));
    const replayed = resumed.filter(entry => oldSet.has(`${entry.path}\n${entry.key}`));
    const live = resumed.filter(entry => !oldSet.has(`${entry.path}\n${entry.key}`));
    expect(replayed).toHaveLength(8);
    expect(live).toHaveLength(10);
    for (const entry of replayed) {
      expect(entry.text).toBe(oldSet.get(`${entry.path}\n${entry.key}`));
    }
    expect(live.every(entry => entry.ok)).toBe(true);
    expect(workflowDepth(resumed)).toBe(3);
  });

  it("keys deterministically from the committed kill script", () => {
    const script = readFileSync(fixture("big-kill.js"), "utf-8");
    expect(journalHeader("wf_74f36ab43ceb.workflow.jsonl").resumeKey).toBe(
      workflowResumeKey(script, { stopAfter: 0 }),
    );
    expect(journalHeader("wf_d069526db115.workflow.jsonl").resumeKey).toBe(
      workflowResumeKey(script, undefined),
    );
  });
});

describe("live proof: paid full run", () => {
  it("journals 18 agents at depth 3, all ok", () => {
    const entries = journalEntries("wf_d975d29936f2.workflow.jsonl");
    expect(entries).toHaveLength(18);
    expect(entries.every(entry => entry.ok)).toBe(true);
    expect(workflowDepth(entries)).toBe(3);
  });

  it("keys deterministically and stdout reports its Task ID", () => {
    const script = readFileSync(fixture("big-paid.js"), "utf-8");
    const header = journalHeader("wf_d975d29936f2.workflow.jsonl");
    expect(header.resumeKey).toBe(workflowResumeKey(script, undefined));
    expect(header.runId).toBe(journalRunId("wf_d975d29936f2.workflow.jsonl"));
    expect(readFileSync(fixture("paid.stdout.txt"), "utf-8")).toContain("Task ID: wf_d975d29936f2");
  });
});

describe("live proof: delegation links journal and transcript", () => {
  it("records the grandchild answer in both places", () => {
    const entries = journalEntries("wf_9300889399fe.workflow.jsonl");
    expect(entries).toHaveLength(2);
    expect(entries.every(entry => entry.ok)).toBe(true);
    expect(textsOf(entries)).toEqual(["DEL_A", "DEL_B:DEL_CHILD"]);
    const linked = outputFiles().filter(
      file =>
        readFileSync(join(PROOF_DIR, file), "utf-8").includes("DEL_CHILD") &&
        !readFileSync(join(PROOF_DIR, file), "utf-8").includes("GC_root_"),
    );
    expect(linked).toHaveLength(1);
  });
});

describe("live proof: flag harness journals", () => {
  it("journals 18 agents at depth 3 under the required harness", () => {
    const entries = journalEntries("wf_a5f865a64c96.workflow.jsonl");
    expect(entries).toHaveLength(18);
    expect(entries.every(entry => entry.ok)).toBe(true);
    expect(workflowDepth(entries)).toBe(3);
  });

  it("keys deterministically and stdout reports its Task ID", () => {
    const script = readFileSync(fixture("big.js"), "utf-8");
    const header = journalHeader("wf_a5f865a64c96.workflow.jsonl");
    expect(header.resumeKey).toBe(workflowResumeKey(script, undefined));
    expect(header.runId).toBe(journalRunId("wf_a5f865a64c96.workflow.jsonl"));
    expect(readFileSync(fixture("flag.stdout.txt"), "utf-8")).toContain("Task ID: wf_a5f865a64c96");
  });
});

describe("live proof: scripts", () => {
  it("commits every executed script byte-identical with its meta block", () => {
    for (const name of ["big-deleg.js", "big.js", "big-kill.js", "delegate.js", "big-paid.js", "big-full.js"]) {
      const path = fixture(name);
      expect(existsSync(path), `${name} committed`).toBe(true);
      expect(readFileSync(path, "utf-8")).toContain("export const meta");
    }
  });
});

describe("live proof: closed-list composed run (backbone + real decompose leg)", () => {
  it("journals 21 agents at depth 3, all ok", () => {
    // 18 backbone (15 fixed-fanout tree + 3 worklist) + 3 decompose leg
    // (1 schema split + 2 subtask leaves) for this run.
    const entries = journalEntries("wf_8c71607c0df2.workflow.jsonl");
    expect(entries).toHaveLength(21);
    expect(entries.every(entry => entry.ok)).toBe(true);
    expect(workflowDepth(entries)).toBe(3);
  });

  it("keys deterministically from the committed script", () => {
    const script = readFileSync(fixture("big-full.js"), "utf-8");
    const header = journalHeader("wf_8c71607c0df2.workflow.jsonl");
    expect(header.resumeKey).toBe(workflowResumeKey(script, undefined));
    expect(header.runId).toBe(journalRunId("wf_8c71607c0df2.workflow.jsonl"));
  });

  it("carries the backbone tokens and a real decompose branch", () => {
    const entries = journalEntries("wf_8c71607c0df2.workflow.jsonl");
    const texts = textsOf(entries);
    expect(texts.some(text => text.includes("SURV_root"))).toBe(true);
    expect(texts.some(text => text.includes("WL_w1b"))).toBe(true);
    expect(texts.filter(text => text.includes("LEAF_"))).toHaveLength(8);
    // Slot-independent: the decompose leg is the only nested-workflow branch
    // whose texts carry none of the backbone echo markers.
    const groups = new Map<string, WorkflowJournalEntry[]>();
    for (const entry of entries) {
      const frame = entry.path
        .split("/")
        .find(segment => /^\d+:w/.test(segment))
        ?.split("#")[0];
      if (frame === undefined || /(SURV_|LEAF_|WL_)/.test(entry.text ?? "")) continue;
      const list = groups.get(frame) ?? [];
      list.push(entry);
      groups.set(frame, list);
    }
    const sizes = [...groups.values()].map(list => list.length);
    expect(sizes).toEqual([3]);
  });

  it("links its 8 transcripts by delegation token", () => {
    const files = readdirSync(PROOF_DIR).filter(
      file => file.startsWith("wf_8c71607c0df2-") && file.endsWith(".output"),
    );
    expect(files).toHaveLength(8);
    for (const file of files) {
      expect(readFileSync(join(PROOF_DIR, file), "utf-8").length).toBeGreaterThan(500);
    }
    const entries = journalEntries("wf_8c71607c0df2.workflow.jsonl");
    sharesTokensEachWay(files, gcTokens(textsOf(entries)));
  });

  it("stdout reports the run's Task ID (no model summary was emitted)", () => {
    // Haiku wrote no completion summary for this run (model variance, not a
    // harness gap — the prior paid run's "Tokens: 52.6K" proves totals are
    // reported when the model summarizes). Scale is pinned by the 21
    // journaled calls + 8 non-trivial transcripts above, not by a token line.
    const out = readFileSync(fixture("full-paid.stdout.txt"), "utf-8");
    expect(out).toContain("Task ID: wf_8c71607c0df2");
    expect(out).toContain("Resume key:");
  });
});

describe("live proof: kill + resume runtime report", () => {
  it("commits the kill Task ID and the runtime Resuming line", () => {
    expect(readFileSync(fixture("kill.stdout.txt"), "utf-8")).toContain("Task ID: wf_74f36ab43ceb");
    const resume = readFileSync(fixture("resume.stdout.txt"), "utf-8");
    expect(resume).toContain("Task ID: wf_d069526db115");
    expect(resume).toContain("Resuming wf_74f36ab43ceb: 8 recorded call(s) available to replay.");
  });
});

describe("live proof: Sonnet closed-list composed run (designated 7b run)", () => {
  const JOURNAL = "wf_135fcfd5ebcc.workflow.jsonl";
  const STDOUT = "sonnet-paid.stdout.txt";
  const PREFIX = "wf_135fcfd5ebcc-";

  it("journals 21 agents at depth 3, all ok", () => {
    const entries = journalEntries(JOURNAL);
    expect(entries).toHaveLength(21);
    expect(entries.every(entry => entry.ok)).toBe(true);
    expect(workflowDepth(entries)).toBe(3);
  });

  it("keys deterministically from the committed script; stdout reports Task ID and Resume key", () => {
    const script = readFileSync(fixture("big-full.js"), "utf-8");
    const header = journalHeader(JOURNAL);
    expect(header.resumeKey).toBe(workflowResumeKey(script, undefined));
    expect(header.runId).toBe(journalRunId(JOURNAL));
    const out = readFileSync(fixture(STDOUT), "utf-8");
    expect(out).toContain("Task ID: wf_135fcfd5ebcc");
    expect(out).toContain("Resume key:");
  });

  it("carries the backbone tokens and a real decompose branch", () => {
    const entries = journalEntries(JOURNAL);
    const texts = textsOf(entries);
    expect(texts.some(text => text.includes("SURV_root"))).toBe(true);
    expect(texts.some(text => text.includes("WL_w1b"))).toBe(true);
    expect(texts.filter(text => text.includes("LEAF_root_"))).toHaveLength(8);
    // The /3:w branch is the schema-split leg: split JSON plus 2 leaves.
    // (One leaf's prose mentions the LEAF_/GC_ convention without adding a
    // token — the journal GC set stays exactly the 8 backbone tokens.)
    const branch = entries.filter(entry => entry.path.split("/")[1]?.startsWith("3:w") ?? false);
    expect(branch).toHaveLength(3);
    const split = branch.find(entry => entry.path === "/3:w#0");
    expect(split?.ok).toBe(true);
    const subtasks: unknown = (JSON.parse(split?.text ?? "") as { subtasks?: unknown }).subtasks;
    if (!Array.isArray(subtasks)) throw new Error("decompose split lacks a subtasks array");
    expect(subtasks.length).toBe(2);
    const leaves = branch.filter(entry => entry.path !== "/3:w#0");
    expect(leaves).toHaveLength(2);
    for (const leaf of leaves) {
      expect(leaf.ok).toBe(true);
      expect(leaf.text?.length ?? 0).toBeGreaterThan(200);
    }
  });

  it("links its 8 transcripts by delegation token", () => {
    const files = readdirSync(PROOF_DIR).filter(file => file.startsWith(PREFIX) && file.endsWith(".output"));
    expect(files).toHaveLength(8);
    for (const file of files) {
      expect(readFileSync(join(PROOF_DIR, file), "utf-8").length).toBeGreaterThan(500);
    }
    const journalGc = gcTokens(textsOf(journalEntries(JOURNAL)));
    expect(journalGc.size, "journal GC set is exactly the 8 backbone tokens").toBe(8);
    sharesTokensEachWay(files, journalGc);
  });

  it("aggregates the delegated-subset token total from transcripts", () => {
    const files = readdirSync(PROOF_DIR).filter(file => file.startsWith(PREFIX) && file.endsWith(".output"));
    expect(files).toHaveLength(8);
    const sum = files.map(transcriptTotalTokens).reduce((a, b) => a + b, 0);
    expect(Number.isInteger(sum)).toBe(true);
    expect(sum).toBeGreaterThan(0);
  });
});
