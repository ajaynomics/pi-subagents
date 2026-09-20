/**
 * workflow-surfaces.test.ts — task-5: UI parity surfaces plus cross-session resume.
 *
 * Four surfaces, each in its own describe:
 *
 * - `/workflows` lists saved workflows from the three roots (project wins over
 *   global) and launches the pick with args passed through verbatim.
 * - The inspector's `s` saves the run's script at the overview level, where it
 *   does not steal the subview's skip binding.
 * - Fleet rows count nested agents (entries with `parentIndex`) like any other.
 * - A journal is resumable from a new session via its resume key — the sha256
 *   of the script plus its args — with a live run id winning when both exist.
 *
 * In-process assertions only: booted extensions, stub hosts and temp dirs.
 */

import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import subagentsExtension from "../src/index.js";
import { encodeCwd } from "../src/output-file.js";
import { taskToFleetWorkflow } from "../src/ui/fleet-list.js";
import {
  handleWorkflowDialogKey,
  initialWorkflowDialogState,
  layoutWorkflowDialog,
  plainWorkflowDialogLines,
  resolveWorkflowDialog,
} from "../src/ui/workflow-dialog.js";
import { saveWorkflowRunScript, showWorkflowDialog } from "../src/ui/workflow-menu.js";
import {
  appendJournal,
  findJournalByResumeKey,
  readJournal,
  readJournalHeader,
  workflowResumeKey,
  writeJournalHeader,
} from "../src/workflow/journal.js";
import type { WorkflowAgentEntry, WorkflowEntry } from "../src/workflow/progress.js";
import { runWorkflow, type WorkflowHost, type WorkflowSpawnRequest } from "../src/workflow/runtime.js";
import { sanitizeWorkflowSaveName } from "../src/workflow/saved.js";
import { createWorkflowTask, formatWorkflowNotification, resolveKeyResumeTarget, updateWorkflowProgressBatch } from "../src/workflow/task.js";
import { ctx, type Hermetic, hermeticDir, makePi, textOf } from "./helpers/boot-extension.js";

/* ------------------------------------------------------------------------- *
 * `/workflows`
 * ------------------------------------------------------------------------- */

describe("/workflows", () => {
  let hermetic: Hermetic;

  beforeEach(() => {
    hermetic = hermeticDir({ settings: { workflowsEnabled: true } });
  });
  afterEach(() => {
    hermetic.restore();
  });

  const workflowFile = (name: string, description: string, body: string) =>
    `export const meta = { name: "${name}", description: "${description}" };\n${body}\n`;

  /** Seed the three roots; the caller picks which names go where. */
  function seedRoots(files: { root: "project" | "shared" | "global"; name: string; content: string }[]) {
    const roots = {
      project: join(hermetic.dir, ".pi", "workflows"),
      shared: join(hermetic.dir, ".agents", "workflows"),
      global: join(process.env.PI_CODING_AGENT_DIR ?? "", "workflows"),
    };
    for (const file of files) {
      mkdirSync(roots[file.root], { recursive: true });
      writeFileSync(join(roots[file.root], `${file.name}.js`), file.content, "utf-8");
    }
    return roots;
  }

  function bootWorkflows() {
    const booted = makePi();
    subagentsExtension(booted.pi);
    const command = booted.commands.get("workflows");
    if (!command) throw new Error("the extension did not register /workflows");
    return { ...booted, command };
  }

  /** A command ctx whose picker and arg entry are scripted; notifications kept. */
  function commandCtx(options: { pick?: (options: string[]) => string | undefined; argsInput?: string } = {}) {
    const notes: { text: string; level?: string }[] = [];
    const seen: { title: string; options: string[] }[] = [];
    const context = ctx({
      cwd: hermetic.dir,
      ui: {
        notify: vi.fn((text: string, level?: string) => notes.push({ text, level })),
        select: vi.fn(async (title: string, selectOptions: string[]) => {
          seen.push({ title, options: selectOptions });
          return options.pick?.(selectOptions);
        }),
        input: vi.fn(async () => options.argsInput),
        custom: vi.fn(),
      },
    });
    return { context, notes, seen };
  }

  /** Wait for the completion notification a background run sends for `taskId`. */
  async function awaitNotification(booted: ReturnType<typeof makePi>, taskId: string) {
    await vi.waitFor(
      () =>
        expect(
          booted.pi.sendMessage.mock.calls.some((call: unknown[]) =>
            String((call[0] as { content?: unknown })?.content).includes(taskId),
          ),
        ).toBe(true),
      { timeout: 10_000 },
    );
    return booted.pi.sendMessage.mock.calls.find((call: unknown[]) =>
      String((call[0] as { content?: unknown })?.content).includes(taskId),
    )!;
  }

  it("lists saved workflows from all three roots with project shadowing global", async () => {
    seedRoots([
      { root: "project", name: "alpha", content: workflowFile("alpha", "Alpha workflow", "return args?.tag ?? 0;") },
      { root: "shared", name: "beta", content: workflowFile("beta", "Beta workflow", "return 1;") },
      { root: "global", name: "gamma", content: workflowFile("gamma", "Global gamma", "return 2;") },
      { root: "project", name: "gamma", content: workflowFile("gamma", "Project gamma", "return 3;") },
      { root: "project", name: "notes", content: "not a workflow at all\n" },
    ]);
    const { command } = bootWorkflows();
    const ui = commandCtx();

    await command.handler("", ui.context);

    expect(ui.seen).toHaveLength(1);
    const [offered] = ui.seen[0].options;
    expect(ui.seen[0].options).toHaveLength(3);
    expect(offered).toContain("alpha");
    const rows = ui.seen[0].options.join("\n");
    expect(rows).toContain("Alpha workflow");
    expect(rows).toContain("Beta workflow");
    expect(rows).toContain("Project gamma");
    expect(rows).not.toContain("Global gamma");
    expect(rows).not.toContain("notes");
    expect(rows).toContain(".pi/workflows");
    expect(rows).toContain("takes args");
    expect(rows).toContain("no args");
  });

  it("launches the pick with args passed through verbatim", async () => {
    seedRoots([
      { root: "project", name: "alpha", content: workflowFile("alpha", "Alpha workflow", "return args?.tag ?? 0;") },
    ]);
    const booted = bootWorkflows();
    const ui = commandCtx({
      pick: options => options.find(option => option.includes("alpha")),
      argsInput: '{"tag":"T7"}',
    });

    await booted.command.handler("", ui.context);

    const started = ui.notes.find(note => note.text.includes("started in the background"));
    expect(started?.text).toContain("Task ID: ");
    // The command's one-liner ends the id with a period, which is not part of it.
    const taskId = /Task ID: ([A-Za-z0-9_-]+)/.exec(started?.text ?? "")?.[1];
    expect(taskId).toBeTruthy();
    const sent = await awaitNotification(booted, taskId!);
    expect(String((sent[0] as { content?: unknown })?.content)).toContain("<result>T7</result>");
  });

  it("passes nested, array, unicode, empty and absent args through verbatim", async () => {
    seedRoots([
      { root: "project", name: "echo", content: workflowFile("echo", "Echo workflow", "return JSON.stringify(args ?? null);") },
    ]);
    const cases: { label: string; input: string | undefined; expected: unknown }[] = [
      { label: "nested", input: '{"a":{"b":[1,{"c":null}]}}', expected: { a: { b: [1, { c: null }] } } },
      { label: "unicode", input: '{"emoji":"héllo wörld 🎉","esc":"a\\"b"}', expected: { emoji: "héllo wörld 🎉", esc: 'a"b' } },
      { label: "empty", input: "{}", expected: {} },
      { label: "absent", input: "", expected: null },
    ];
    for (const c of cases) {
      const booted = bootWorkflows();
      const ui = commandCtx({ pick: options => options.find(option => option.includes("echo")), argsInput: c.input });
      await booted.command.handler("", ui.context);
      const started = ui.notes.find(note => note.text.includes("started in the background"));
      const taskId = /Task ID: ([A-Za-z0-9_-]+)/.exec(started?.text ?? "")?.[1];
      expect(taskId, `${c.label} launches`).toBeTruthy();
      const sent = await awaitNotification(booted, taskId!);
      const result = /<result>([\s\S]*)<\/result>/.exec(String((sent[0] as { content?: unknown })?.content))?.[1];
      expect(JSON.parse(result ?? ""), `${c.label} args verbatim`).toEqual(c.expected);
    }
  });

  it("refuses invalid JSON args without launching", async () => {
    seedRoots([
      { root: "project", name: "echo", content: workflowFile("echo", "Echo workflow", "return 1;") },
    ]);
    const booted = bootWorkflows();
    const ui = commandCtx({ pick: options => options.find(option => option.includes("echo")), argsInput: "{oops" });

    await booted.command.handler("", ui.context);

    expect(ui.notes.some(note => note.text.includes("not valid JSON"))).toBe(true);
    expect(ui.notes.some(note => note.text.includes("started in the background"))).toBe(false);
  });

  it("treats Esc on the args prompt as a cancel, not a launch with no args", async () => {
    seedRoots([
      { root: "project", name: "echo", content: workflowFile("echo", "Echo workflow", "return 1;") },
    ]);
    const booted = bootWorkflows();
    const ui = commandCtx({ pick: options => options.find(option => option.includes("echo")), argsInput: undefined });

    await booted.command.handler("", ui.context);

    expect(ui.notes.some(note => note.text.includes("started in the background"))).toBe(false);
  });

  describe("workflow completion notification", () => {
    function finishedTask(value: unknown, journalPath?: string) {
      const task = createWorkflowTask({ id: "wf_note", script: "return 1;" });
      task.status = "completed";
      task.value = value;
      if (journalPath !== undefined) task.journalPath = journalPath;
      return task;
    }

    it("names the journal file alongside a truncated result", () => {
      const note = formatWorkflowNotification(finishedTask("x".repeat(5000), "/tmp/j/run.workflow.jsonl"));

      expect(note).toContain("...(truncated)");
      expect(note).toContain("<journal>/tmp/j/run.workflow.jsonl</journal>");
    });

    it("omits the journal line when the run journaled nowhere", () => {
      const note = formatWorkflowNotification(finishedTask("short"));

      expect(note).not.toContain("<journal>");
      expect(note).toContain("<result>short</result>");
    });
    it("states failures in the summary instead of leaving them to the denominator", () => {
      const task = createWorkflowTask({ id: "wf_failed", script: "return 1;" });
      task.status = "completed";
      task.value = "done";
      task.workflowProgress = [
        { type: "workflow_agent", index: 0, label: "a", state: "done" },
        { type: "workflow_agent", index: 1, label: "b", state: "error" },
      ];

      expect(formatWorkflowNotification(task)).toContain("1/2 agents, 1 failed");
    });

    it("does not report a user-skipped agent as failed in the summary", () => {
      const task = createWorkflowTask({ id: "wf_skipped", script: "return 1;" });
      task.status = "completed";
      task.value = "done";
      task.workflowProgress = [
        { type: "workflow_agent", index: 0, label: "a", state: "done" },
        { type: "workflow_agent", index: 1, label: "b", state: "error", skipped: true },
      ];

      const note = formatWorkflowNotification(task);
      expect(note).toContain("1/2 agents");
      expect(note).not.toContain("failed");
    });
  });

  it("refuses when workflows are off, without offering a picker", async () => {
    hermetic.restore();
    hermetic = hermeticDir({ settings: { workflowsEnabled: false } });
    const { command } = bootWorkflows();
    const ui = commandCtx({ pick: () => "anything" });

    await command.handler("", ui.context);

    expect(ui.seen).toHaveLength(0);
    expect(ui.notes.map(note => note.text).join("\n")).toMatch(/Workflows are off/);
  });

  it("says so when nothing is saved", async () => {
    const { command } = bootWorkflows();
    const ui = commandCtx();

    await command.handler("", ui.context);

    expect(ui.notes.map(note => note.text).join("\n")).toMatch(/No saved workflows/);
  });

  it("rejects args that are not JSON instead of launching", async () => {
    seedRoots([
      { root: "project", name: "alpha", content: workflowFile("alpha", "Alpha workflow", "return 1;") },
    ]);
    const booted = bootWorkflows();
    const ui = commandCtx({
      pick: options => options.find(option => option.includes("alpha")),
      argsInput: "{oops",
    });

    await booted.command.handler("", ui.context);

    expect(ui.notes.map(note => note.text).join("\n")).toMatch(/not valid JSON/);
    expect(ui.notes.some(note => note.text.includes("started in the background"))).toBe(false);
  });
});

/* ------------------------------------------------------------------------- *
 * Inspector `s`: save the run's script
 * ------------------------------------------------------------------------- */

describe("inspector s saves the run", () => {
  const doneEntry = (index: number, extra: Partial<WorkflowAgentEntry> = {}): WorkflowAgentEntry => ({
    type: "workflow_agent",
    index,
    label: `a${index}`,
    state: "done",
    ...extra,
  });

  it("saves at the overview, where s is free", () => {
    const progress: WorkflowEntry[] = [doneEntry(0), doneEntry(1)];
    const full = {
      progress,
      task: { status: "completed" as const, workflowName: "wf", startTime: 1_000_000 },
      state: initialWorkflowDialogState(),
    };
    const view = resolveWorkflowDialog(full);
    expect(view.selectedEntry).toBeDefined();
    expect(handleWorkflowDialogKey("s", full.state, view)?.action).toEqual({ kind: "save" });
  });

  it("keeps skipping a running agent in the subview", () => {
    const progress: WorkflowEntry[] = [
      { type: "workflow_agent", index: 0, label: "live", state: "progress", queuedAt: 1, startedAt: 2 },
    ];
    const full = {
      progress,
      task: { status: "running" as const, workflowName: "wf", startTime: 1_000_000 },
      state: { ...initialWorkflowDialogState(), level: "agent" as const },
    };
    const view = resolveWorkflowDialog(full);
    expect(handleWorkflowDialogKey("s", full.state, view)?.action).toEqual({ kind: "skip", index: 0 });
  });

  it("advertises s save in the overview footer", () => {
    const lines = plainWorkflowDialogLines(
      layoutWorkflowDialog({
        progress: [doneEntry(0)],
        task: { status: "completed" as const, workflowName: "wf", startTime: 1_000_000 },
        meta: undefined,
        agentCount: 1,
        state: initialWorkflowDialogState(),
        width: 120,
        now: 1_001_000,
      }),
    );
    expect(lines.at(-1)).toContain("s save");
  });

  it("sanitizes the meta name, falling back to the run id", () => {
    expect(sanitizeWorkflowSaveName("audit-src", "wf_abc")).toBe("audit-src");
    expect(sanitizeWorkflowSaveName("  spaced out!! ", "wf_abc")).toBe("spaced-out");
    expect(sanitizeWorkflowSaveName(undefined, "wf_abc")).toBe("wf_abc");
    expect(sanitizeWorkflowSaveName("", "wf_abc")).toBe("wf_abc");
    expect(sanitizeWorkflowSaveName("../../etc", "wf_abc")).toBe("wf_abc");
  });

  it("strips a single trailing .js from the meta name", () => {
    expect(sanitizeWorkflowSaveName("foo.js", "wf_abc")).toBe("foo");
    expect(sanitizeWorkflowSaveName(".js", "wf_abc")).toBe("wf_abc");
    expect(sanitizeWorkflowSaveName("foo.JS", "wf_abc")).toBe("foo.JS");
  });

  it("writes the script byte-identical and reports overwrites", () => {
    const cwd = mkdtempSync(join(tmpdir(), "wf-save-"));
    try {
      const script = 'export const meta = { name: "audit", description: "d" };\nreturn 1;\n';
      const first = saveWorkflowRunScript(cwd, {
        id: "wf_abc",
        script,
        meta: { name: "audit", description: "d" },
      });
      expect(first).toEqual({ path: join(cwd, ".pi", "workflows", "audit.js"), name: "audit", overwritten: false });
      expect(readFileSync(first.path, "utf-8")).toBe(script);

      const second = saveWorkflowRunScript(cwd, { id: "wf_abc", script, meta: { name: "audit", description: "d" } });
      expect(second.overwritten).toBe(true);
      expect(readFileSync(second.path, "utf-8")).toBe(script);

      const fallback = saveWorkflowRunScript(cwd, { id: "wf_xyz", script, meta: undefined });
      expect(fallback.name).toBe("wf_xyz");
      expect(readFileSync(fallback.path, "utf-8")).toBe(script);
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });

  it("refuses an unreadable target instead of suffixing blindly", () => {
    const cwd = mkdtempSync(join(tmpdir(), "wf-save-unreadable-"));
    try {
      const script = 'export const meta = { name: "audit", description: "d" };\nreturn 1;\n';
      mkdirSync(join(cwd, ".pi", "workflows", "audit.js"), { recursive: true });
      expect(() =>
        saveWorkflowRunScript(cwd, { id: "wf_abc", script, meta: { name: "audit", description: "d" } }),
      ).toThrow(/refusing to overwrite blindly/);
      expect(existsSync(join(cwd, ".pi", "workflows", "audit-2.js"))).toBe(false);
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });

  it("suffixes a colliding name instead of overwriting different bytes", () => {
    const cwd = mkdtempSync(join(tmpdir(), "wf-save-collide-"));
    try {
      const first = saveWorkflowRunScript(cwd, {
        id: "wf_one",
        script: 'export const meta = { name: "audit", description: "d" };\nreturn 1;\n',
        meta: { name: "audit", description: "d" },
      });
      expect(first).toEqual({ path: join(cwd, ".pi", "workflows", "audit.js"), name: "audit", overwritten: false });

      const second = saveWorkflowRunScript(cwd, {
        id: "wf_two",
        script: 'export const meta = { name: "audit", description: "d" };\nreturn 2;\n',
        meta: { name: "audit", description: "d" },
      });
      expect(second).toEqual({
        path: join(cwd, ".pi", "workflows", "audit-2.js"),
        name: "audit-2",
        overwritten: false,
      });
      expect(readFileSync(join(cwd, ".pi", "workflows", "audit.js"), "utf-8")).toContain("return 1;");
      expect(readFileSync(second.path, "utf-8")).toContain("return 2;");
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });

  it("refuses a symlinked .pi/workflows root without writing through it", () => {
    const cwd = mkdtempSync(join(tmpdir(), "wf-save-link-"));
    try {
      const target = join(cwd, "real-target");
      mkdirSync(target, { recursive: true });
      mkdirSync(join(cwd, ".pi"), { recursive: true });
      symlinkSync(target, join(cwd, ".pi", "workflows"));
      const script = 'export const meta = { name: "audit", description: "d" };\nreturn 1;\n';
      expect(() =>
        saveWorkflowRunScript(cwd, { id: "wf_abc", script, meta: { name: "audit", description: "d" } }),
      ).toThrow(/symlinked directory/);
      expect(existsSync(join(target, "audit.js"))).toBe(false);
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });

  it("saves from the live dialog with a one-line confirmation", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "wf-save-dialog-"));
    try {
      const script = 'export const meta = { name: "audit", description: "d" };\nreturn 1;\n';
      const task = createWorkflowTask({
        id: "wf_dialog",
        script,
        meta: { name: "audit", description: "d" },
      });
      const notes: string[] = [];
      let instance: { handleInput(data: string): void } | undefined;
      const context = ctx({
        cwd,
        ui: {
          notify: vi.fn((text: string) => notes.push(text)),
          custom: vi.fn(async (factory: (...args: never[]) => unknown) => {
            instance = factory(
              { requestRender: () => {} },
              { fg: (_c: string, text: string) => text, bold: (text: string) => text },
              {},
              () => {},
            ) as { handleInput(data: string): void };
            return undefined;
          }),
        },
      });
      await showWorkflowDialog(context, task, {
        tasks: new Map([[task.id, task]]),
        getRecord: () => undefined,
        viewAgentConversation: async () => {},
        getCtx: () => undefined,
      });

      instance?.handleInput("s");

      const path = join(cwd, ".pi", "workflows", "audit.js");
      expect(existsSync(path)).toBe(true);
      expect(readFileSync(path, "utf-8")).toBe(script);
      expect(notes).toHaveLength(1);
      expect(notes[0]).toContain("audit.js");
      expect(notes[0]).not.toContain("overwrote");

      instance?.handleInput("s");
      expect(notes).toHaveLength(2);
      expect(notes[1]).toContain("overwrote");
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });
});

/* ------------------------------------------------------------------------- *
 * Fleet rows count nested agents
 * ------------------------------------------------------------------------- */

describe("fleet rows count nested agents", () => {
  const top = (index: number, state: WorkflowAgentEntry["state"]): WorkflowAgentEntry => ({
    type: "workflow_agent",
    index,
    label: `top-${index}`,
    state,
    ...(state === "progress" ? { startedAt: 1_000_000 } : {}),
  });
  const nested = (index: number, parentIndex: number, state: WorkflowAgentEntry["state"]): WorkflowAgentEntry => ({
    type: "workflow_agent",
    index,
    label: `nested-${index}`,
    state,
    parentIndex,
    ...(state === "progress" ? { startedAt: 1_000_000 } : {}),
  });

  it("counts 2 top-level plus 3 nested as 5 in the row and the total", () => {
    const progress: WorkflowEntry[] = [top(0, "done"), top(1, "done"), nested(2, 0, "done"), nested(3, 0, "done"), nested(4, 1, "done")];
    const task = createWorkflowTask({ id: "wf_fleet", script: "x" });
    updateWorkflowProgressBatch(task, progress);

    const row = taskToFleetWorkflow(task);

    expect(row.doneCount).toBe(5);
    expect(row.totalCount).toBe(5);
  });

  it("counts running nested agents toward the total but not the done count", () => {
    const progress: WorkflowEntry[] = [
      top(0, "done"),
      top(1, "done"),
      nested(2, 0, "done"),
      nested(3, 0, "progress"),
      nested(4, 1, "progress"),
    ];
    const task = createWorkflowTask({ id: "wf_fleet_live", script: "x" });
    updateWorkflowProgressBatch(task, progress);

    const row = taskToFleetWorkflow(task);

    expect(row.doneCount).toBe(3);
    expect(row.totalCount).toBe(5);
  });
});

/* ------------------------------------------------------------------------- *
 * Cross-session resume by hash key
 * ------------------------------------------------------------------------- */

describe("cross-session resume", () => {
  const script =
    'export const meta = { name: "xfer", description: "cross-session probe" };\n' +
    // biome-ignore lint/suspicious/noTemplateCurlyInString: the `${a}` runs inside the worker, not here
    'const a = await agent("first");\nconst b = await agent("second");\nreturn `${a}|${b}`;\n';
  const argsA = { tag: "A" };

  function stubHost() {
    const calls: WorkflowSpawnRequest[] = [];
    const host: WorkflowHost = {
      async spawnAgent(request) {
        calls.push(request);
        return { ok: true, text: `ok:${request.prompt}` };
      },
      abortAgent() {},
    };
    return { host, calls };
  }

  it("keys journals by script plus args", () => {
    const key = workflowResumeKey(script, argsA);
    expect(key).toMatch(/^[0-9a-f]{64}$/);
    expect(workflowResumeKey(script, argsA)).toBe(key);
    expect(workflowResumeKey(script, { tag: "B" })).not.toBe(key);
    expect(workflowResumeKey(`${script}\n`, argsA)).not.toBe(key);
    expect(workflowResumeKey(script, undefined)).not.toBe(key);
  });

  it("keys arg key order separately and rejects unserializable args", () => {
    expect(workflowResumeKey(script, { a: 1, b: 2 })).not.toBe(workflowResumeKey(script, { b: 2, a: 1 }));
    expect(() => workflowResumeKey(script, () => 0)).toThrow(/JSON-serializable/);
    expect(() => workflowResumeKey(script, Symbol("s"))).toThrow(/JSON-serializable/);
  });

  it("round-trips the header past old readers", () => {
    const dir = mkdtempSync(join(tmpdir(), "wf-journal-"));
    try {
      const path = join(dir, "wf_x.workflow.jsonl");
      const key = workflowResumeKey(script, argsA);
      writeJournalHeader(path, { resumeKey: key, runId: "wf_x", createdAt: 1_234_567 });
      appendJournal(path, { path: "#0", index: 0, key: "k0", ok: true, text: "first answer" });

      expect(readJournalHeader(path)).toEqual({ resumeKey: key, runId: "wf_x", createdAt: 1_234_567 });
      // The header is not an agent entry, so existing readers skip it untouched.
      const entries = readJournal(path);
      expect(entries).toHaveLength(1);
      expect(entries[0]).toMatchObject({ path: "#0", text: "first answer" });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("reads no header from a journal written before headers existed", () => {
    const dir = mkdtempSync(join(tmpdir(), "wf-journal-legacy-"));
    try {
      const path = join(dir, "wf_old.workflow.jsonl");
      appendJournal(path, { path: "#0", index: 0, key: "k0", ok: true, text: "old answer" });
      expect(readJournalHeader(path)).toBeUndefined();
      expect(readJournal(path)).toHaveLength(1);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("rejects a header line with a malformed resume key", () => {
    const dir = mkdtempSync(join(tmpdir(), "wf-journal-badhex-"));
    try {
      const path = join(dir, "wf_bad.workflow.jsonl");
      writeFileSync(path, '{"workflowJournalHeader":1,"resumeKey":"zzz","runId":"wf_bad"}\n', "utf-8");
      expect(readJournalHeader(path)).toBeUndefined();
      expect(readJournal(path)).toHaveLength(0);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("drops an entry line with a non-string error field", () => {
    const dir = mkdtempSync(join(tmpdir(), "wf-journal-baderror-"));
    try {
      const path = join(dir, "wf_err.workflow.jsonl");
      writeFileSync(
        path,
        '{"path":"#0","index":0,"key":"k0","ok":true,"text":"kept"}\n' +
          '{"path":"#1","index":1,"key":"k1","ok":false,"error":123}\n',
        "utf-8",
      );
      expect(readJournal(path)).toEqual([{ path: "#0", index: 0, key: "k0", ok: true, text: "kept" }]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("resolves a key against nothing, garbage and absence", () => {
    const cwd = mkdtempSync(join(tmpdir(), "wf-key-empty-"));
    try {
      expect(resolveKeyResumeTarget(undefined, cwd)).toBeUndefined();
      expect(resolveKeyResumeTarget("  ", cwd)).toBeUndefined();
      const malformed = resolveKeyResumeTarget("not-a-key", cwd);
      expect(malformed?.ok).toBe(false);
      const unknown = resolveKeyResumeTarget("0".repeat(64), cwd);
      expect(unknown?.ok).toBe(false);
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });

  describe("across two runtime sessions sharing storage", () => {
    let cwd: string;
    let encoded: string;

    beforeEach(() => {
      cwd = mkdtempSync(join(tmpdir(), "wf-xfer-"));
      encoded = encodeCwd(cwd);
    });
    afterEach(() => {
      rmSync(join(tmpdir(), `pi-subagents-${process.getuid?.() ?? 0}`, encoded), { recursive: true, force: true });
      rmSync(cwd, { recursive: true, force: true });
    });

    /** A journal path in the real per-session layout, under a named session. */
    function sessionJournal(sessionId: string, runId: string): string {
      const dir = join(tmpdir(), `pi-subagents-${process.getuid?.() ?? 0}`, encoded, sessionId, "tasks");
      mkdirSync(dir, { recursive: true });
      return join(dir, `${runId}.workflow.jsonl`);
    }

    it("finds the newest journal for a key across session dirs", async () => {
      const key = workflowResumeKey(script, argsA);
      const first = sessionJournal("sess-a", "wf_first");
      writeJournalHeader(first, { resumeKey: key, runId: "wf_first", createdAt: 1 });
      appendJournal(first, { path: "#0", index: 0, key: "k", ok: true, text: "a" });
      await new Promise(resolve => setTimeout(resolve, 25));
      const second = sessionJournal("sess-b", "wf_second");
      writeJournalHeader(second, { resumeKey: key, runId: "wf_second", createdAt: 2 });
      appendJournal(second, { path: "#0", index: 0, key: "k", ok: true, text: "b" });

      expect(findJournalByResumeKey(cwd, key)).toBe(second);
      expect(findJournalByResumeKey(cwd, "f".repeat(64))).toBeUndefined();
    });

    it("prefers the most complete journal over the newest", async () => {
      const key = workflowResumeKey(script, argsA);
      const complete = sessionJournal("sess-old", "wf_complete");
      writeJournalHeader(complete, { resumeKey: key, runId: "wf_complete", createdAt: 1 });
      appendJournal(complete, { path: "#0", index: 0, key: "k0", ok: true, text: "a" });
      appendJournal(complete, { path: "#1", index: 1, key: "k1", ok: true, text: "b" });
      appendJournal(complete, { path: "#2", index: 2, key: "k2", ok: true, text: "c" });
      await new Promise(resolve => setTimeout(resolve, 25));
      const killed = sessionJournal("sess-new", "wf_killed");
      writeJournalHeader(killed, { resumeKey: key, runId: "wf_killed", createdAt: 2 });
      appendJournal(killed, { path: "#0", index: 0, key: "k0", ok: true, text: "a" });

      expect(findJournalByResumeKey(cwd, key)).toBe(complete);
    });

    it("prefers successful entries over failed ones at equal totals", async () => {
      const key = workflowResumeKey(script, argsA);
      const complete = sessionJournal("sess-ok", "wf_done");
      writeJournalHeader(complete, { resumeKey: key, runId: "wf_done", createdAt: 1 });
      appendJournal(complete, { path: "#0", index: 0, key: "k0", ok: true, text: "a" });
      appendJournal(complete, { path: "#1", index: 1, key: "k1", ok: true, text: "b" });
      appendJournal(complete, { path: "#2", index: 2, key: "k2", ok: true, text: "c" });
      await new Promise(resolve => setTimeout(resolve, 25));
      const failed = sessionJournal("sess-bad", "wf_broke");
      writeJournalHeader(failed, { resumeKey: key, runId: "wf_broke", createdAt: 2 });
      appendJournal(failed, { path: "#0", index: 0, key: "k0", ok: true, text: "a" });
      appendJournal(failed, { path: "#1", index: 1, key: "k1", ok: true, text: "b" });
      appendJournal(failed, { path: "#2", index: 2, key: "k2", ok: false });

      // Equal totals (3 vs 3): total-count would tie-break to the newer failed
      // journal, but failures never replay — the complete one must win.
      expect(findJournalByResumeKey(cwd, key)).toBe(complete);
    });

    it("ignores garbage files while ranking real journals", () => {
      // Session dirs accumulate whatever lands in them: foreign files, torn
      // writes, pre-header journals. None of it may break the scan or
      // outrank a real journal.
      const key = workflowResumeKey(script, argsA);
      const good = sessionJournal("sess-good", "wf_good");
      writeJournalHeader(good, { resumeKey: key, runId: "wf_good", createdAt: 1 });
      appendJournal(good, { path: "#0", index: 0, key: "k0", ok: true, text: "a" });

      const junkTasks = join(tmpdir(), `pi-subagents-${process.getuid?.() ?? 0}`, encoded, "sess-junk", "tasks");
      mkdirSync(junkTasks, { recursive: true });
      writeFileSync(join(junkTasks, "notes.txt"), "hello", "utf-8");
      writeFileSync(join(junkTasks, "junk.workflow.jsonl"), "not json at all\n", "utf-8");
      writeFileSync(join(junkTasks, "old.workflow.jsonl"), '{"path":"#0","index":0,"key":"k","ok":true}\n', "utf-8");
      const other = join(junkTasks, "other.workflow.jsonl");
      writeJournalHeader(other, { resumeKey: "0".repeat(64), runId: "wf_other", createdAt: 1 });
      appendJournal(other, { path: "#0", index: 0, key: "k0", ok: true, text: "x" });
      mkdirSync(join(junkTasks, "dir.workflow.jsonl"), { recursive: true });
      writeFileSync(join(junkTasks, "empty.workflow.jsonl"), "", "utf-8");
      const torn = join(junkTasks, "torn.workflow.jsonl");
      writeJournalHeader(torn, { resumeKey: key, runId: "wf_torn", createdAt: 2 });
      writeFileSync(torn, `${readFileSync(torn, "utf-8")}{"path":"#0","index":0,`, "utf-8");

      // Force the good journal oldest: on coarse filesystem timestamps the
      // junk could otherwise tie it, and a dropped key/header check would win
      // by recency instead of going red.
      utimesSync(good, 1000000, 1000000);

      // A session directory without a tasks/ subdir at all.
      mkdirSync(join(tmpdir(), `pi-subagents-${process.getuid?.() ?? 0}`, encoded, "sess-notasks"), { recursive: true });

      expect(findJournalByResumeKey(cwd, key)).toBe(good);
    });

    it("counts only complete entries in a torn candidate", () => {
      // B's partial second line must not count: A (2 ok) beats B (1 ok plus
      // a torn line) even though B is newer — if the partial counted, the tie
      // would break to the newer file.
      const key = workflowResumeKey(script, argsA);
      const a = sessionJournal("sess-a", "wf_a");
      writeJournalHeader(a, { resumeKey: key, runId: "wf_a", createdAt: 1 });
      appendJournal(a, { path: "#0", index: 0, key: "k0", ok: true, text: "a" });
      appendJournal(a, { path: "#1", index: 1, key: "k1", ok: true, text: "b" });
      const b = sessionJournal("sess-b", "wf_b");
      writeJournalHeader(b, { resumeKey: key, runId: "wf_b", createdAt: 2 });
      appendJournal(b, { path: "#0", index: 0, key: "k0", ok: true, text: "a" });
      writeFileSync(b, `${readFileSync(b, "utf-8")}{"path":"#1","index":1,"key":"k1","ok":true,`, "utf-8");
      // Force A oldest so B is unambiguously newer without sleeping on the clock.
      utimesSync(a, 1000000, 1000000);

      expect(findJournalByResumeKey(cwd, key)).toBe(a);
    });

    it("replays session A in session B with zero live spawns; changed args replay nothing", async () => {
      const keyA = workflowResumeKey(script, argsA);
      const journalPath = sessionJournal("sess-a", "wf_session_a");
      writeJournalHeader(journalPath, { resumeKey: keyA, runId: "wf_session_a", createdAt: Date.now() });

      const hostA = stubHost();
      const resultA = await runWorkflow({
        script,
        args: argsA,
        host: hostA.host,
        journal: { append: (entry: WorkflowJournalEntry) => appendJournal(journalPath, entry) },
      });
      expect(resultA.status).toBe("completed");
      expect(resultA.value).toBe("ok:first|ok:second");
      expect(hostA.calls).toHaveLength(2);

      // Session B: a new runtime and host, the same storage, identical script
      // plus args — everything replays, nothing spawns.
      const found = findJournalByResumeKey(cwd, keyA);
      expect(found).toBe(journalPath);
      const resolved = resolveKeyResumeTarget(keyA, cwd);
      expect(resolved).toEqual({ ok: true, runId: "wf_session_a", journalPath });
      const hostB = stubHost();
      const resultB = await runWorkflow({
        script,
        args: argsA,
        host: hostB.host,
        journal: { entries: readJournal(found!) },
      });
      expect(resultB.status).toBe("completed");
      expect(resultB.value).toBe("ok:first|ok:second");
      expect(resultB.replayedCount).toBe(2);
      expect(hostB.calls).toHaveLength(0);

      // Changed args are a different key: nothing is found, so a third
      // session runs everything live.
      const keyB = workflowResumeKey(script, { tag: "B" });
      expect(keyB).not.toBe(keyA);
      expect(findJournalByResumeKey(cwd, keyB)).toBeUndefined();
      const hostC = stubHost();
      const resultC = await runWorkflow({ script, args: { tag: "B" }, host: hostC.host });
      expect(resultC.replayedCount).toBe(0);
      expect(hostC.calls).toHaveLength(2);
    });

    it("prefers a live run id over a resume key", async () => {
      const booted = makePi();
      subagentsExtension(booted.pi);
      const tool = booted.tools.get("SubagentWorkflow");
      const runCtx = ctx({ cwd });
      const inline = 'export const meta = { name: "idio", description: "d" };\nreturn "v";\n';
      const first = await tool.execute("tc-first", { script: inline }, undefined, undefined, runCtx);
      const runId = /Task ID: (\S+)/.exec(textOf(first))?.[1];
      expect(runId).toBeTruthy();
      // Let the first run settle: resuming a live run is refused, which would
      // prove nothing about precedence.
      await vi.waitFor(
        () =>
          expect(
            booted.pi.sendMessage.mock.calls.some((call: unknown[]) =>
              String((call[0] as { content?: unknown })?.content).includes(runId!),
            ),
          ).toBe(true),
        { timeout: 10_000 },
      );
      // A garbage key alongside a settled id is ignored: the id path wins
      // before any key lookup runs.
      const second = await tool.execute(
        "tc-second",
        { script: inline, resumeFromRunId: runId, resumeFromKey: "0".repeat(64) },
        undefined,
        undefined,
        runCtx,
      );
      expect(textOf(second)).toMatch(new RegExp(`Nothing to replay from ${runId}`));
    });

    it("rejects a malformed key even when a live run id wins", async () => {
      const booted = makePi();
      subagentsExtension(booted.pi);
      const tool = booted.tools.get("SubagentWorkflow");
      const runCtx = ctx({ cwd });
      const inline = 'export const meta = { name: "badkey", description: "d" };\nreturn "v";\n';
      const first = await tool.execute("tc-first-badkey", { script: inline }, undefined, undefined, runCtx);
      const runId = /Task ID: (\S+)/.exec(textOf(first))?.[1];
      expect(runId).toBeTruthy();
      await vi.waitFor(
        () =>
          expect(
            booted.pi.sendMessage.mock.calls.some((call: unknown[]) =>
              String((call[0] as { content?: unknown })?.content).includes(runId!),
            ),
          ).toBe(true),
        { timeout: 10_000 },
      );
      const second = await tool.execute(
        "tc-second-badkey",
        { script: inline, resumeFromRunId: runId, resumeFromKey: "not-a-key" },
        undefined,
        undefined,
        runCtx,
      );
      expect(textOf(second)).toMatch(/No workflow journal for resume key/);
    });
  });
});
