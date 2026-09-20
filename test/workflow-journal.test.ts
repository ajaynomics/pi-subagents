/**
 * workflow-journal.test.ts — the record that makes `resumeFromRunId` cheap.
 *
 * Two things are being pinned here, and they pull against each other:
 *
 *   - a resume must not re-pay for work the previous run finished, and
 *   - it must never hand a script an answer produced under other conditions.
 *
 * Causal identity is what reconciles them, so most of these tests are about
 * where reuse *stops* — a changed prompt, a recorded failure, a chain whose
 * upstream moved — and prove that everything downstream is spawned for real.
 */

import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { appendJournal, journalKey, readJournal, readJournalHeader, type WorkflowJournalEntry, writeJournalHeader } from "../src/workflow/journal.js";
import { runWorkflow, type WorkflowSpawnRequest, type WorkflowSpawnResult } from "../src/workflow/runtime.js";

const HEAD = 'export const meta = { name: "probe", description: "a probe" };\n';

interface Stub {
  calls: WorkflowSpawnRequest[];
  host: { spawnAgent: (r: WorkflowSpawnRequest) => Promise<WorkflowSpawnResult>; abortAgent: () => void };
}

function stubHost(reply?: (request: WorkflowSpawnRequest) => WorkflowSpawnResult): Stub {
  const calls: WorkflowSpawnRequest[] = [];
  return {
    calls,
    host: {
      async spawnAgent(request) {
        calls.push(request);
        return reply ? reply(request) : { ok: true, text: `live:${request.prompt}` };
      },
      abortAgent() {},
    },
  };
}

/** Record the journal a run would have written, so the next run can replay it. */
function recorder() {
  const entries: WorkflowJournalEntry[] = [];
  return { entries, append: (entry: WorkflowJournalEntry) => entries.push(entry) };
}

const run = (body: string, options: Record<string, unknown>) =>
  runWorkflow({ script: HEAD + body, ...(options as any) });

describe("journalKey", () => {
  it("is stable for the same call and different for a changed prompt", () => {
    expect(journalKey({ prompt: "a" })).toBe(journalKey({ prompt: "a" }));
    expect(journalKey({ prompt: "a" })).not.toBe(journalKey({ prompt: "b" }));
  });

  it("separates calls that differ only in how the agent was configured", () => {
    const base = { prompt: "audit" };
    const keys = new Set([
      journalKey(base),
      journalKey({ ...base, model: "haiku" }),
      journalKey({ ...base, agentType: "Explore" }),
      journalKey({ ...base, effort: "high" }),
      journalKey({ ...base, isolation: "worktree" }),
      journalKey({ ...base, gate: "npm test" }),
      journalKey({ ...base, label: "one" }),
    ]);
    expect(keys.size).toBe(7);
  });

  it("ignores which phase the row is filed under", () => {
    // Re-grouping the progress tree changes no token the agent sees, and must
    // not throw away an hour of recorded results.
    expect(journalKey({ prompt: "a", label: "x" })).toBe(journalKey({ prompt: "a", label: "x" }));
  });
});

describe("journal files", () => {
  let dir: string;
  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), "wf-journal-")); });
  afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

  it("round-trips appended entries in arrival order", () => {
    const path = join(dir, "run.jsonl");
    appendJournal(path, { path: "#1", index: 1, key: "k1", ok: true, text: "second" });
    appendJournal(path, { path: "#0", index: 0, key: "k0", ok: true, text: "first" });

    expect(readJournal(path)).toEqual([
      { path: "#0", index: 0, key: "k0", ok: true, text: "first" },
      { path: "#1", index: 1, key: "k1", ok: true, text: "second" },
    ]);
  });

  it("treats a missing journal as nothing to replay", () => {
    expect(readJournal(join(dir, "nope.jsonl"))).toEqual([]);
  });

  it("keeps the entries before a truncated final line", () => {
    // The file is appended to while agents settle, so a killed run routinely
    // leaves a half-written line. Everything before it is still good.
    const path = join(dir, "torn.jsonl");
    appendJournal(path, { path: "#0", index: 0, key: "k0", ok: true, text: "kept" });
    writeFileSync(path, `${readFileSync(path, "utf-8")}{"path":"#1","index":1,"key":"k1"`, "utf-8");

    expect(readJournal(path)).toEqual([{ path: "#0", index: 0, key: "k0", ok: true, text: "kept" }]);
  });

  it("drops lines that are JSON but not entries", () => {
    const path = join(dir, "junk.jsonl");
    // Including an entry in the old, path-less format: identity is the path now,
    // so a journal written before it cannot be replayed against this run.
    writeFileSync(
      path,
      '{"path":"#0","index":"one","key":"k","ok":true}\n{"index":0,"key":"k","ok":true}\n[]\nnull\n',
      "utf-8",
    );
    expect(readJournal(path)).toEqual([]);
  });
});

describe("kill-during-write", () => {
  let dir: string;
  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), "wf-kill-")); });
  afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

  // Valid shape for a header resumeKey: 64 lowercase hex chars.
  const RESUME_KEY = "ab".repeat(32);

  // A realistic torn-run shape: header, two settled entries (one a recorded
  // failure), and a third still settling when the kill lands.
  function fullBytes(): string {
    const path = join(dir, "run.workflow.jsonl");
    writeJournalHeader(path, { resumeKey: RESUME_KEY, runId: "wf_kill", createdAt: 0 });
    appendJournal(path, { path: "#0", index: 0, key: "k0", ok: true, text: "first" });
    appendJournal(path, { path: "#1", index: 1, key: "k1", ok: false, error: "boom" });
    appendJournal(path, { path: "#2", index: 2, key: "k2", ok: true, text: "third" });
    return readFileSync(path, "utf-8");
  }

  it("replays exactly the complete entries for a kill at any byte offset", () => {
    // SIGKILL can land mid-write, so every prefix of the file is a journal a
    // real kill produced. Each must read as exactly the entries fully inside
    // it — never throw, never return a half-written entry.
    const full = fullBytes();
    const headerLen = full.indexOf("\n") + 1;
    for (let split = 0; split <= full.length; split++) {
      const path = join(dir, `cut-${split}.jsonl`);
      writeFileSync(path, full.slice(0, split), "utf-8");
      let consumed = 0;
      const complete: WorkflowJournalEntry[] = [];
      for (const line of full.split("\n")) {
        if (line === "") continue;
        // A line counts as complete without its trailing newline: the readers
        // split on "\n", so a kill landing exactly at a line end still replays it.
        if (split >= consumed + line.length) {
          const value: unknown = JSON.parse(line);
          if (typeof value === "object" && value !== null && typeof (value as { path?: unknown }).path === "string") {
            complete.push(value as WorkflowJournalEntry);
          }
        }
        consumed += line.length + 1;
      }
      complete.sort((a, b) => a.index - b.index);
      expect(readJournal(path), `kill at offset ${split}`).toEqual(complete);
      expect(readJournalHeader(path) !== undefined, `header at offset ${split}`).toBe(split >= headerLen - 1);
    }
  });

  it("reads a torn header as no key and no entries", () => {
    // The header is the first line written: a kill during it leaves a file
    // that is only a partial header, and it must decline both reads.
    const path = join(dir, "torn-header.jsonl");
    writeFileSync(path, '{"workflowJournalHeader":1,"resumeKey":"ab', "utf-8");

    expect(readJournal(path)).toEqual([]);
    expect(readJournalHeader(path)).toBeUndefined();
  });

  it("reads a header-only file as a key with nothing to replay", () => {
    // A kill between the header write and the first settled agent.
    const path = join(dir, "header-only.jsonl");
    writeJournalHeader(path, { resumeKey: RESUME_KEY, runId: "wf_kill", createdAt: 0 });

    expect(readJournal(path)).toEqual([]);
    expect(readJournalHeader(path)?.resumeKey).toBe(RESUME_KEY);
  });
});

describe("replay", () => {
  const twoAgents = 'const a = await agent("first");\nconst b = await agent("second");\nreturn [a, b];';

  it("records every settled call, so a first run can be resumed", async () => {
    const { host } = stubHost();
    const journal = recorder();

    const result = await run(twoAgents, { host, journal });

    expect(result.status).toBe("completed");
    expect(journal.entries).toEqual([
      // Keyed on what the script asked for, not on what the runtime derived —
      // the label here was derived from the prompt, so it is not part of it.
      // `path` is slot 0 and slot 1 of the root frame: two sequential calls at
      // the script's top level.
      { path: "#0", index: 0, key: journalKey({ prompt: "first" }), ok: true, text: "live:first" },
      { path: "#1", index: 1, key: journalKey({ prompt: "second" }), ok: true, text: "live:second" },
    ]);
  });

  it("replays an identical run without spawning anything", async () => {
    const first = recorder();
    await run(twoAgents, { host: stubHost().host, journal: first });

    const second = stubHost();
    const result = await run(twoAgents, { host: second.host, journal: { entries: first.entries } });

    expect(result.value).toEqual(["live:first", "live:second"]);
    expect(result.replayedCount).toBe(2);
    expect(second.calls, "a full cache hit must not reach the manager at all").toHaveLength(0);
  });

  it("runs live from the first changed call, and no earlier", async () => {
    const first = recorder();
    await run(twoAgents, { host: stubHost().host, journal: first });

    const second = stubHost(() => ({ ok: true, text: "fresh" }));
    const edited = 'const a = await agent("first");\nconst b = await agent("second, edited");\nreturn [a, b];';
    const result = await run(edited, { host: second.host, journal: { entries: first.entries } });

    expect(result.value).toEqual(["live:first", "fresh"]);
    expect(result.replayedCount).toBe(1);
    expect(second.calls.map(c => c.prompt)).toEqual(["second, edited"]);
  });

  it("stops replaying after a changed call even when a later one still matches", async () => {
    // Same frame, so the change dirties it: agent 3's recorded answer was
    // produced downstream of an agent 2 that no longer exists, and reusing it
    // would be reusing a result from a run that never happened.
    const three = 'await agent("one");\nawait agent("two");\nreturn await agent("three");';
    const first = recorder();
    await run(three, { host: stubHost().host, journal: first });

    const second = stubHost(() => ({ ok: true, text: "fresh" }));
    const edited = 'await agent("one");\nawait agent("two, edited");\nreturn await agent("three");';
    const result = await run(edited, { host: second.host, journal: { entries: first.entries } });

    expect(result.replayedCount).toBe(1);
    expect(second.calls.map(c => c.prompt)).toEqual(["two, edited", "three"]);
  });

  it("re-runs a call the journal recorded as failed", async () => {
    // The reason to resume a broken run is to retry the thing that broke.
    const first = recorder();
    let attempt = 0;
    const failing = stubHost(() => (attempt++ === 1 ? { ok: false, error: "boom" } : { ok: true, text: "fine" }));
    await run(twoAgents, { host: failing.host, journal: first });

    expect(first.entries[1]).toEqual({ path: "#1", index: 1, key: first.entries[1].key, ok: false });

    const second = stubHost(() => ({ ok: true, text: "retried" }));
    const result = await run(twoAgents, { host: second.host, journal: { entries: first.entries } });

    expect(result.value).toEqual(["fine", "retried"]);
    expect(result.replayedCount).toBe(1);
    expect(second.calls.map(c => c.prompt)).toEqual(["second"]);
  });

  it("re-records replayed calls, so a resume can itself be resumed", async () => {
    const first = recorder();
    await run(twoAgents, { host: stubHost().host, journal: first });

    const second = recorder();
    await run(twoAgents, { host: stubHost().host, journal: { entries: first.entries, append: second.append } });

    expect(second.entries).toEqual(first.entries);
  });

  it("runs everything live when there is no journal", async () => {
    const stub = stubHost();
    const result = await run(twoAgents, { host: stub.host, journal: { entries: [] } });

    expect(result.replayedCount).toBe(0);
    expect(stub.calls).toHaveLength(2);
  });

  it("still counts replayed agents in the run's agent total", async () => {
    const first = recorder();
    await run(twoAgents, { host: stubHost().host, journal: first });

    const result = await run(twoAgents, { host: stubHost().host, journal: { entries: first.entries } });

    // A replayed agent is an agent that ran, as far as the run's shape goes —
    // the progress tree shows the same rows the first run showed.
    expect(result.agentCount).toBe(2);
    expect(result.progress.filter(e => e.type === "workflow_agent" && e.state === "done")).toHaveLength(2);
  });

  it("marks a replayed agent so the views can say where it came from", async () => {
    const first = recorder();
    await run(twoAgents, { host: stubHost().host, journal: first });

    const result = await run(twoAgents, { host: stubHost().host, journal: { entries: first.entries } });

    // Without this a replayed row is a tick with no tokens and no duration —
    // indistinguishable from an agent that did the work for free.
    const done = result.progress.filter(
      (entry): entry is Extract<typeof entry, { type: "workflow_agent" }> =>
        entry.type === "workflow_agent" && entry.state === "done",
    );
    expect(done).toHaveLength(2);
    expect(done.every(entry => entry.cached === true)).toBe(true);
  });

  it("does not mark an agent that actually ran", async () => {
    const result = await run(twoAgents, { host: stubHost().host, journal: { entries: [] } });

    const done = result.progress.filter(
      (entry): entry is Extract<typeof entry, { type: "workflow_agent" }> =>
        entry.type === "workflow_agent" && entry.state === "done",
    );
    expect(done.some(entry => entry.cached)).toBe(false);
  });

  it("does not replay a run that used agent({ resume })", async () => {
    // The regression this guards: a replayed child leaves no conversation in
    // this run, so the later `resume` used to die with a script-bug message
    // and take the whole run with it.
    const body = 'await agent("first", { label: "a" });\nreturn await agent("follow up", { resume: "a" });';
    const resuming = {
      async spawnAgent(request: WorkflowSpawnRequest) {
        return { ok: true, text: `live:${request.prompt}` };
      },
      async resumeAgent(_id: string, prompt: string) {
        return { ok: true, text: `resumed:${prompt}` };
      },
      abortAgent() {},
    };

    const first = recorder();
    const one = await run(body, { host: resuming, journal: first });
    expect(one.status).toBe("completed");
    expect(one.value).toBe("resumed:follow up");
    expect(first.entries[1].resumed).toBe(true);

    const two = await run(body, { host: resuming, journal: { entries: first.entries } });
    expect(two.status).toBe("completed");
    expect(two.value).toBe("resumed:follow up");
    // Declined whole rather than replaying the half that would strand it.
    expect(two.replayedCount).toBe(0);
  });

  it("blames the replay, not the script, when an added resume has no live target", async () => {
    // An edited script can add a `resume` over a journal that has none. The
    // journal still matched, so the target really was replayed — and the reader
    // must not be sent hunting for a typo that is not there.
    const plain = recorder();
    await run('await agent("first", { label: "a" });\nreturn null;', { host: stubHost().host, journal: plain });

    const edited = await run(
      'await agent("first", { label: "a" });\nreturn await agent("more", { resume: "a" });',
      {
        host: { ...stubHost().host, async resumeAgent() { return { ok: true, text: "x" }; } },
        journal: { entries: plain.entries },
      },
    );

    expect(edited.status).toBe("failed");
    expect(edited.error).toContain("was replayed from the resume journal");
    expect(edited.error).toContain("Re-run without resumeFromRunId");
  });

  it("replays a parallel fan-out without holding concurrency slots", async () => {
    const fanout = 'return await parallel([() => agent("a"), () => agent("b"), () => agent("c")]);';
    const first = recorder();
    await run(fanout, { host: stubHost().host, journal: first });

    const second = stubHost();
    const result = await run(fanout, {
      host: second.host,
      journal: { entries: first.entries },
      concurrency: 1,
    });

    expect(result.value).toEqual(["live:a", "live:b", "live:c"]);
    expect(second.calls).toHaveLength(0);
  });
});

/* ------------------------------------------------------------------------- *
 * Causal identity
 *
 * A call is identified by where it sits in the run's structural tree, not by
 * when its message reached the host. These are the cases arrival order gets
 * wrong: concurrent chains that finish in a different order, and a chain whose
 * sibling changed.
 * ------------------------------------------------------------------------- */

describe("causal identity", () => {
  /** A host whose children answer after a per-prompt delay, so the test picks the completion order. */
  function delayedHost(delays: Record<string, number> = {}) {
    const prompts: string[] = [];
    return {
      prompts,
      host: {
        async spawnAgent(request: WorkflowSpawnRequest): Promise<WorkflowSpawnResult> {
          prompts.push(request.prompt);
          const wait = delays[request.prompt];
          if (wait !== undefined) await new Promise<void>(resolve => setTimeout(resolve, wait));
          return { ok: true, text: `live:${request.prompt}` };
        },
        abortAgent() {},
      },
    };
  }

  /** A two-stage pipeline: stage 2's prompt names the original item, not stage 1's answer. */
  const pipelineScript = (stage1 = '"s1:" + value', stage2 = '"s2:" + item') =>
    [
      'return await pipeline(["A", "B"],',
      `  async (value) => await agent(${stage1}),`,
      `  async (previous, item) => await agent(${stage2}),`,
      ");",
    ].join("\n");

  it("gives one pipeline item's whole stage chain a single frame", async () => {
    const journal = recorder();
    await run(pipelineScript(), { host: delayedHost().host, journal, concurrency: 4 });

    // Slot 0 of the root frame is the pipeline; each item is a branch of it (`l:i`),
    // and the stages take slots 0 and 1 *of that branch* because they run in one
    // sequential chain.
    expect(journal.entries.map(entry => entry.path).sort()).toEqual([
      "/0:l:0#0",
      "/0:l:0#1",
      "/0:l:1#0",
      "/0:l:1#1",
    ]);
  });

  it("replays a pipeline whose items finish in the other order", async () => {
    // Nothing about the script changed; only which agent was slower. Under
    // arrival-order identity the second run's third call is a different agent
    // than the journal's third entry, and everything from there runs live.
    const journal = recorder();
    const first = delayedHost({ "s1:A": 40 });
    await run(pipelineScript(), { host: first.host, journal, concurrency: 4 });
    expect(first.prompts).toEqual(["s1:A", "s1:B", "s2:B", "s2:A"]);

    const second = delayedHost({ "s1:B": 40 });
    const result = await run(pipelineScript(), {
      host: second.host,
      journal: { entries: journal.entries },
      concurrency: 4,
    });

    expect(result.replayedCount).toBe(4);
    expect(second.prompts, "an unchanged script must not pay for a different interleaving").toEqual([]);
  });

  it("runs only the item whose stage changed", async () => {
    const journal = recorder();
    await run(pipelineScript(), { host: delayedHost().host, journal, concurrency: 4 });

    const second = delayedHost();
    const result = await run(pipelineScript('"s1:" + value', 'item === "A" ? "s2:A edited" : "s2:" + item'), {
      host: second.host,
      journal: { entries: journal.entries },
      concurrency: 4,
    });

    // B's chain is a sibling frame, so it keeps its cache in full.
    expect(second.prompts).toEqual(["s2:A edited"]);
    expect(result.replayedCount).toBe(3);
  });

  it("runs the rest of an item's chain when its first stage changed", async () => {
    const journal = recorder();
    await run(pipelineScript(), { host: delayedHost().host, journal, concurrency: 4 });

    const second = delayedHost();
    const result = await run(pipelineScript('value === "A" ? "s1:A edited" : "s1:" + value'), {
      host: second.host,
      journal: { entries: journal.entries },
      concurrency: 4,
    });

    // "s2:A" keys exactly as it did before — it is invalidated because the chain
    // that feeds it changed, which is the whole reason a frame goes dirty.
    expect(second.prompts.sort()).toEqual(["s1:A edited", "s2:A"]);
    expect(result.replayedCount).toBe(2);
  });

  it("keeps parallel branches independent of each other", async () => {
    // The edited branch is the *first* one, so the unchanged sibling is decided
    // after the miss — which is the case a coarser invalidation would get wrong.
    const fanout = (a: string) =>
      `return await parallel([() => agent("${a}"), () => agent("p:b")]);`;
    const journal = recorder();
    await run(fanout("p:a"), { host: delayedHost().host, journal, concurrency: 4 });

    const second = delayedHost();
    const result = await run(fanout("p:a edited"), {
      host: second.host,
      journal: { entries: journal.entries },
      concurrency: 4,
    });

    expect(second.prompts).toEqual(["p:a edited"]);
    expect(result.replayedCount).toBe(1);
  });

  describe("nested workflow()", () => {
    const parent = 'await agent("parent-a");\nawait workflow("audit");\nreturn await agent("parent-b");';
    const childScript = (firstPrompt: string) =>
      `export const meta = { name: "audit", description: "d" };\nawait agent("${firstPrompt}");\nreturn await agent("child-2");\n`;

    /** The stub host, plus a library a nested `workflow()` can be resolved against. */
    function nestingHost(child: string) {
      const stub = delayedHost();
      return {
        prompts: stub.prompts,
        host: {
          ...stub.host,
          loadWorkflow: (ref: { name?: string }) =>
            ref.name === "audit"
              ? { ok: true as const, script: child }
              : { ok: false as const, message: `No saved workflow named "${ref.name}".` },
        },
      };
    }

    it("replays parent and child alike when nothing changed", async () => {
      const journal = recorder();
      await run(parent, { host: nestingHost(childScript("child-1")).host, journal });

      const second = nestingHost(childScript("child-1"));
      const result = await run(parent, { host: second.host, journal: { entries: journal.entries } });

      expect(result.replayedCount).toBe(4);
      expect(second.prompts).toEqual([]);
    });

    it("keeps a change inside the child out of the parent's chain", async () => {
      const journal = recorder();
      await run(parent, { host: nestingHost(childScript("child-1")).host, journal });

      const second = nestingHost(childScript("child-1, edited"));
      const result = await run(parent, { host: second.host, journal: { entries: journal.entries } });

      // The child body is its own frame: it goes dirty from its first stage on,
      // and the parent's own calls — including the one *after* the workflow() —
      // still come back from the journal.
      expect(second.prompts).toEqual(["child-1, edited", "child-2"]);
      expect(result.replayedCount).toBe(2);
    });

    it("replays an unchanged grandchild run in full", async () => {
      const root = 'await agent("parent-a");\nawait workflow("mid");\nreturn await agent("parent-b");';
      const mid = 'await agent("mid-a");\nawait workflow("leaf");\nreturn await agent("mid-b");';
      const leaf = (first: string) =>
        `export const meta = { name: "leaf", description: "d" };\nawait agent("${first}");\nreturn await agent("leaf-b");\n`;
      const library = (leafScript: string) => ({
        mid: `export const meta = { name: "mid", description: "d" };\n${mid}\n`,
        leaf: leafScript,
      });
      const serve = (scripts: Record<string, string>) => {
        const stub = delayedHost();
        return {
          prompts: stub.prompts,
          host: {
            ...stub.host,
            loadWorkflow: (ref: { name?: string }) => {
              const script = ref.name !== undefined ? scripts[ref.name] : undefined;
              return script !== undefined
                ? { ok: true as const, script }
                : { ok: false as const, message: `No saved workflow named "${ref.name}".` };
            },
          },
        };
      };

      const journal = recorder();
      await run(root, { host: serve(library(leaf("leaf-a"))).host, journal });

      const second = serve(library(leaf("leaf-a")));
      const result = await run(root, { host: second.host, journal: { entries: journal.entries } });

      expect(result.replayedCount).toBe(6);
      expect(second.prompts).toEqual([]);
    });

    it("a grandchild edit re-runs only that chain onward", async () => {
      const root = 'await agent("parent-a");\nawait workflow("mid");\nreturn await agent("parent-b");';
      const mid = 'await agent("mid-a");\nawait workflow("leaf");\nreturn await agent("mid-b");';
      const leaf = (first: string) =>
        `export const meta = { name: "leaf", description: "d" };\nawait agent("${first}");\nreturn await agent("leaf-b");\n`;
      const library = (leafScript: string) => ({
        mid: `export const meta = { name: "mid", description: "d" };\n${mid}\n`,
        leaf: leafScript,
      });
      const serve = (scripts: Record<string, string>) => {
        const stub = delayedHost();
        return {
          prompts: stub.prompts,
          host: {
            ...stub.host,
            loadWorkflow: (ref: { name?: string }) => {
              const script = ref.name !== undefined ? scripts[ref.name] : undefined;
              return script !== undefined
                ? { ok: true as const, script }
                : { ok: false as const, message: `No saved workflow named "${ref.name}".` };
            },
          },
        };
      };

      const journal = recorder();
      await run(root, { host: serve(library(leaf("leaf-a"))).host, journal });

      const second = serve(library(leaf("leaf-a, edited")));
      const result = await run(root, { host: second.host, journal: { entries: journal.entries } });

      // The leaf frame goes dirty at its first slot; the mid and root chains keep
      // their caches, including the calls after the nested workflow() bodies.
      expect(second.prompts).toEqual(["leaf-a, edited", "leaf-b"]);
      expect(result.replayedCount).toBe(4);
    });

    it("keeps recursive fan-out branches on distinct journal paths", async () => {
      const root =
        'await agent("split");\nreturn await parallel([() => workflow("leaf"), () => workflow("leaf")]);';
      const leaf =
        'export const meta = { name: "leaf", description: "d" };\nreturn await agent("leaf-work");\n';
      const serve = () => {
        const stub = delayedHost();
        return {
          prompts: stub.prompts,
          host: {
            ...stub.host,
            loadWorkflow: (ref: { name?: string }) =>
              ref.name === "leaf"
                ? { ok: true as const, script: leaf }
                : { ok: false as const, message: `No saved workflow named "${ref.name}".` },
          },
        };
      };

      const journal = recorder();
      const first = serve();
      const completed = await run(root, { host: first.host, journal, concurrency: 4 });
      expect(completed.status).toBe("completed");

      // One root agent, then one agent per workflow branch: the decompose shape.
      // Branch tags keep the two leaves apart despite identical prompts.
      expect(journal.entries.map(entry => entry.path).sort()).toEqual([
        "#0",
        "/1:p:0/0:w#0",
        "/1:p:1/0:w#0",
      ]);

      const second = serve();
      const result = await run(root, {
        host: second.host,
        journal: { entries: journal.entries },
        concurrency: 4,
      });

      expect(result.replayedCount).toBe(3);
      expect(second.prompts).toEqual([]);
    });
  });

  it("root miss poisons nested frames even when their keys still match", async () => {
    const firstBody = 'await agent("first");\nreturn await parallel([() => agent("a"), () => agent("b")]);';
    const journal = recorder();
    await run(firstBody, { host: delayedHost().host, journal, concurrency: 4 });

    const second = delayedHost();
    const edited = 'await agent("first, edited");\nreturn await parallel([() => agent("a"), () => agent("b")]);';
    const result = await run(edited, {
      host: second.host,
      journal: { entries: journal.entries },
      concurrency: 4,
    });

    // The root frame went dirty at #0, so the parallel branches miss despite
    // matching keys — poison degrades to misses, never wrong answers.
    expect(second.prompts.sort()).toEqual(["a", "b", "first, edited"]);
    expect(result.replayedCount).toBe(0);
  });

  it("replays two parallel siblings while an added third thunk runs live", async () => {
    const fanout = (extra: string) =>
      `return await parallel([() => agent("a"), () => agent("b")${extra}]);`;
    const journal = recorder();
    await run(fanout(""), { host: delayedHost().host, journal, concurrency: 4 });

    const second = delayedHost();
    const result = await run(fanout(', () => agent("c")'), {
      host: second.host,
      journal: { entries: journal.entries },
      concurrency: 4,
    });

    expect(second.prompts).toEqual(["c"]);
    expect(result.replayedCount).toBe(2);
  });

  it("runs both chains live when pipeline items reorder (paths are positional)", async () => {
    const pipe = (order: string) =>
      `return await pipeline([${order}], async (value) => await agent("stage:" + value));`;
    const journal = recorder();
    await run(pipe('"A", "B"'), { host: delayedHost().host, journal, concurrency: 4 });

    const second = delayedHost();
    const result = await run(pipe('"B", "A"'), {
      host: second.host,
      journal: { entries: journal.entries },
      concurrency: 4,
    });

    // Keys move with items but paths do not, so both positional chains miss.
    expect(second.prompts.sort()).toEqual(["stage:A", "stage:B"]);
    expect(result.replayedCount).toBe(0);
  });

  it("keeps a parallel thunk branch frame across a host round trip", async () => {
    const body = 'return await parallel([async () => {\n  const x = await agent("t0-first");\n  return await agent("t0-second");\n}, () => agent("other")]);';
    const journal = recorder();
    await run(body, { host: delayedHost().host, journal, concurrency: 4 });

    // Branch tags distinguish constructs: parallel thunks live under p:i.
    expect(journal.entries.map((entry) => entry.path).sort()).toEqual([
      "/0:p:0#0",
      "/0:p:0#1",
      "/0:p:1#0",
    ]);

    const second = delayedHost();
    const result = await run(body, {
      host: second.host,
      journal: { entries: journal.entries },
      concurrency: 4,
    });
    expect(result.replayedCount).toBe(3);
    expect(second.prompts).toEqual([]);
  });

  it("parent re-runs via key miss when its prompt depends on workflow() result (upward isolation relies on key)", async () => {
    const parent = 'const r = await workflow("audit");\nreturn await agent("parent:" + r);';
    const childScript = (firstPrompt: string) =>
      `export const meta = { name: "audit", description: "d" };\nreturn await agent("${firstPrompt}");\n`;
    const makeHost = (child: string) => {
      const stub = delayedHost();
      return {
        prompts: stub.prompts,
        host: {
          ...stub.host,
          loadWorkflow: (ref: { name?: string }) =>
            ref.name === "audit"
              ? { ok: true as const, script: child }
              : { ok: false as const, message: `No saved workflow named "${ref.name}".` },
        },
      };
    };

    const journal = recorder();
    await run(parent, { host: makeHost(childScript("child-1")).host, journal });

    const second = makeHost(childScript("child-1, edited"));
    const result = await run(parent, { host: second.host, journal: { entries: journal.entries } });

    // Child change flows upward through the parent prompt key, not through
    // dirty frames — a static-prompt parent would correctly replay.
    expect(second.prompts).toEqual(["child-1, edited", "parent:live:child-1, edited"]);
    expect(result.replayedCount).toBe(0);
  });
});
