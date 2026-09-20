import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AgentManager } from "../src/agent-manager.js";
import { registerAgents } from "../src/agent-types.js";
import { loadCustomAgents } from "../src/custom-agents.js";
import { createNestedSubagentTools } from "../src/nested-tools.js";
import { layoutWorkflowCard, plainWorkflowCardLines } from "../src/ui/workflow-card.js";
import {
  handleWorkflowDialogKey,
  layoutWorkflowDialog,
  plainWorkflowDialogLines,
  resolveWorkflowDialog,
} from "../src/ui/workflow-dialog.js";
import { createWorkflowHost } from "../src/workflow/host.js";
import {
  collapse,
  stats,
  type WorkflowAgentEntry,
  type WorkflowEntry,
} from "../src/workflow/progress.js";
import {
  type RunWorkflowOptions,
  runWorkflow,
  type WorkflowHost,
  type WorkflowRunResult,
  type WorkflowSpawnRequest,
} from "../src/workflow/runtime.js";
import { createWorkflowTask, updateWorkflowProgressBatch } from "../src/workflow/task.js";

vi.mock("../src/agent-runner.js", () => ({
  runAgent: vi.fn(),
  resumeAgent: vi.fn(),
}));

import { runAgent } from "../src/agent-runner.js";

const mockPi = {} as any;
const mockCtx = { cwd: "/tmp" } as any;

const HEAD = 'export const meta = { name: "probe", description: "a test workflow" };\n';

function run(body: string, options: Omit<RunWorkflowOptions, "script">): Promise<WorkflowRunResult> {
  return runWorkflow({ script: HEAD + body, ...options });
}

function agentEntry(partial: Partial<WorkflowAgentEntry> & { index: number }): WorkflowAgentEntry {
  return {
    type: "workflow_agent",
    label: `agent-${partial.index}`,
    state: "start",
    ...partial,
  };
}

/* ------------------------------------------------------------------------- *
 * Stamping
 * ------------------------------------------------------------------------- */

let cwd: string;
let records: Map<string, any>;
let captured: any;
let spawnAndWait: ReturnType<typeof vi.fn>;

function writeAgent(name: string): void {
  const dir = join(cwd, ".pi", "agents");
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, `${name}.md`), `---\ndescription: ${name}\ntools: read\n---\n${name}\n`);
}

function toolCtx() {
  return {
    cwd,
    model: undefined,
    modelRegistry: {
      find: (provider: string, id: string) => ({ provider, id }),
      getAvailable: () => [],
      getAll: () => [],
    },
  } as any;
}

function nestedTools(workflowId?: string, parentAgentId = "parent-1") {
  const manager = {
    spawn: vi.fn(),
    spawnAndWait,
    awaitStartup: vi.fn(async () => {}),
    getRecord: (id: string) => records.get(id),
    setNestParentIndex: vi.fn(),
    resume: vi.fn(),
  } as any;
  const tools = createNestedSubagentTools({
    manager,
    pi: {} as any,
    parentAgentId,
    depth: 1,
    maxSubagentDepth: 3,
    ...(workflowId !== undefined ? { workflowId } : {}),
    allowedSubagents: "all",
    configCwd: cwd,
  });
  return { manager, tools };
}

describe("nested workflow stamping", () => {
  let manager: AgentManager | undefined;

  beforeEach(() => {
    cwd = mkdtempSync(join(tmpdir(), "wf-nested-test-"));
    writeAgent("scout");
    registerAgents(loadCustomAgents(cwd));
    records = new Map();
    captured = undefined;
    spawnAndWait = vi.fn(async (_pi: any, _ctx: any, type: string, _prompt: string, options: any) => {
      captured = options;
      const id = `child-${records.size + 1}`;
      const record = { id, type, status: "completed", result: "done", parentAgentId: options.parentAgentId };
      records.set(id, record);
      return { id, record };
    });
  });

  afterEach(() => {
    manager?.dispose();
    manager = undefined;
    rmSync(cwd, { recursive: true, force: true });
  });

  it("stamps a workflow agent's child with the run id", async () => {
    const { tools } = nestedTools("wf_run1");
    const result = await tools[0].execute(
      "call-1",
      { prompt: "Do work", description: "child work", subagent_type: "scout" } as any,
      undefined,
      undefined,
      toolCtx(),
    );
    expect(result.isError).toBe(false);
    expect(captured.parentAgentId).toBe("parent-1");
    expect(captured.workflowId).toBe("wf_run1");
  });

  it("stamps a grandchild through the same plumbing", async () => {
    const { tools } = nestedTools("wf_run1", "child-1");
    await tools[0].execute(
      "call-1",
      { prompt: "Do deeper work", description: "grandchild work", subagent_type: "scout" } as any,
      undefined,
      undefined,
      toolCtx(),
    );
    expect(captured.workflowId).toBe("wf_run1");
    expect(captured.parentAgentId).toBe("child-1");
  });

  it("leaves a standalone agent's child unstamped", async () => {
    const { tools } = nestedTools(undefined);
    const result = await tools[0].execute(
      "call-1",
      { prompt: "Do work", description: "child work", subagent_type: "scout" } as any,
      undefined,
      undefined,
      toolCtx(),
    );
    expect(result.isError).toBe(false);
    expect("workflowId" in captured).toBe(false);
    expect(captured.workflowId).toBeUndefined();
  });

  it("hands the run id and hooks to the child's own runtime bridge", async () => {
    vi.mocked(runAgent).mockResolvedValue({
      responseText: "done",
      session: { dispose: vi.fn() } as any,
      aborted: false,
      steered: false,
    });
    manager = new AgentManager();
    const hooks = {
      registerNested: () => ({ ok: true as const, index: 1 }),
      updateNestedRecordId: () => {},
      acquireNestedSlot: async () => () => {},
      settleNested: () => {},
    };
    const id = manager.spawn(mockPi, mockCtx, "general-purpose", "parent work", {
      description: "parent",
      isBackground: true,
      workflowId: "wf_bridge",
      nestingHooks: hooks,
      nestParentIndex: 0,
    });
    await vi.waitFor(() => expect(vi.mocked(runAgent)).toHaveBeenCalled());
    const bridge = vi.mocked(runAgent).mock.calls[0][3].nestedRuntime;
    expect(bridge.parentAgentId).toBe(id);
    expect(bridge.workflowId).toBe("wf_bridge");
    expect(bridge.nestingHooks).toBe(hooks);
    expect(bridge.nestParentIndex).toBe(0);
  });
});

/* ------------------------------------------------------------------------- *
 * Runtime nested scope: cap, progress, slots (stub host)
 * ------------------------------------------------------------------------- */

function nestedStubHost(
  onSpawn?: (request: WorkflowSpawnRequest) => void,
): { host: WorkflowHost; calls: WorkflowSpawnRequest[] } {
  const calls: WorkflowSpawnRequest[] = [];
  return {
    calls,
    host: {
      async spawnAgent(request) {
        calls.push(request);
        onSpawn?.(request);
        return { ok: true, text: `ok:${request.prompt}` };
      },
      abortAgent() {},
    },
  };
}

describe("runtime nested scope", () => {
  it("emits a nested row carrying its parent's index; top-level rows have none", async () => {
    const { host } = nestedStubHost(request => {
      const scope = request.nestedScope!;
      const reg = scope.registerNested({ label: "kid" });
      expect(reg.ok).toBe(true);
      if (reg.ok) {
        scope.updateNestedRecordId(reg.index, "rec-kid");
        scope.settleNested(reg.index, { ok: true });
      }
    });
    const result = await run('await agent("parent");\nreturn null;', { host });
    expect(result.status).toBe("completed");
    const { agents: entries } = collapse(result.progress);
    expect(entries).toHaveLength(2);
    expect(entries[0].parentIndex).toBeUndefined();
    expect(entries[1].parentIndex).toBe(entries[0].index);
    expect(entries[1].recordId).toBe("rec-kid");
    expect(result.agentCount).toBe(2);
  });

  it("fails the run on a nested grandchild breach with the direct breach error", async () => {
    const direct = nestedStubHost();
    const directResult = await run(
      'await agent("a");\nawait agent("b");\nawait agent("c");\nreturn null;',
      { host: direct.host, agentCap: 2 },
    );
    expect(directResult.status).toBe("failed");
    expect(directResult.error).toContain("cap of 2 agents");

    const failingHost: WorkflowHost = {
      async spawnAgent(request) {
        const scope = request.nestedScope!;
        const child = scope.registerNested({ label: "kid" });
        if (!child.ok) return { ok: false, error: child.error, fatal: true };
        const grandchild = scope.registerNested({ label: "grandkid" }, child.index);
        if (!grandchild.ok) return { ok: false, error: grandchild.error, fatal: true };
        scope.settleNested(child.index, { ok: true });
        return { ok: true, text: "parent done" };
      },
      abortAgent() {},
    };
    const nestedResult = await run('await agent("parent");\nreturn null;', {
      host: failingHost,
      agentCap: 2,
    });
    expect(nestedResult.status).toBe("failed");
    expect(nestedResult.error).toBe(directResult.error);
  });

  it("admits a parent-awaited child at concurrency 1, three levels deep", async () => {
    const host: WorkflowHost = {
      async spawnAgent(request) {
        const scope = request.nestedScope!;
        const acquireChain = async (depth: number): Promise<(() => void)[]> => {
          if (depth === 0) return [];
          const release = await scope.acquireNestedSlot(true);
          const rest = await acquireChain(depth - 1);
          return [release, ...rest];
        };
        const releases = await acquireChain(3);
        const c1 = scope.registerNested({ label: "child" });
        const c2 = c1.ok ? scope.registerNested({ label: "grandchild" }, c1.index) : c1;
        const c3 = c2.ok ? scope.registerNested({ label: "great-grandchild" }, c2.index) : c2;
        expect(c1.ok && c2.ok && c3.ok).toBe(true);
        if (c1.ok) scope.settleNested(c1.index, { ok: true });
        if (c2.ok) scope.settleNested(c2.index, { ok: true });
        if (c3.ok) scope.settleNested(c3.index, { ok: true });
        for (const release of releases) release();
        return { ok: true, text: "deep done" };
      },
      abortAgent() {},
    };
    const result = await run('return await agent("parent");', { host, concurrency: 1 });
    expect(result.status).toBe("completed");
    expect(result.value).toBe("deep done");
    expect(result.agentCount).toBe(4);
    const { agents: nestedAgents } = collapse(result.progress);
    expect(nestedAgents.map(e => e.parentIndex)).toEqual([undefined, 0, 1, 2]);
  });
});

/* ------------------------------------------------------------------------- *
 * Nested rows in UI surfaces
 * ------------------------------------------------------------------------- */

describe("nested rows in UI surfaces", () => {
  const progress: WorkflowEntry[] = [
    agentEntry({ index: 0, label: "parent", state: "done" }),
    agentEntry({ index: 1, label: "child", state: "done", parentIndex: 0, recordId: "rec-child" }),
  ];

  it("indents the nested row under its parent on the card", () => {
    const lines = plainWorkflowCardLines(
      layoutWorkflowCard({
        progress,
        task: { status: "completed", workflowName: "wf", startTime: 1_000_000 },
        now: 1_001_000,
        width: 120,
      }),
    );
    const parent = lines.find(l => l.includes("parent"))!;
    const child = lines.find(l => l.includes("child"))!;
    expect(parent).toMatch(/✔ parent/);
    expect(child).toMatch(/✔ {3}child/);
  });

  it("opens a nested row's conversation on c like a top-level row", () => {
    const input = {
      progress,
      task: { status: "completed" as const, workflowName: "wf", startTime: 1_000_000 },
      state: { selectedPhase: 0, selectedAgent: 1, level: "agent" as const, filter: "all" as const, promptExpanded: false },
    };
    const view = resolveWorkflowDialog(input);
    expect(view.selectedEntry?.label).toBe("child");
    const result = handleWorkflowDialogKey("c", input.state, view);
    expect(result?.action).toEqual({ kind: "open", recordId: "rec-child" });
    const rendered = plainWorkflowDialogLines(layoutWorkflowDialog({ ...input, width: 86, now: 1_001_000 }));
    expect(rendered.find(l => l.includes("child") && l.includes("✔"))).toContain("  child");
  });

  it("counts nested agents in collapsed rows and task totals", () => {
    const { agents } = collapse(progress);
    expect(agents).toHaveLength(2);
    expect(stats(progress, 2).total).toBe(2);
    const task = createWorkflowTask({ id: "wf_x", script: "x" });
    updateWorkflowProgressBatch(task, progress);
    expect(task.agentCount).toBe(2);
    expect(task.doneCount).toBe(2);
  });
});

describe("workflow host nested breach", () => {
  let hostManager: AgentManager | undefined;

  afterEach(() => {
    hostManager?.dispose();
    hostManager = undefined;
  });

  it("returns a fatal breach when a nested child exceeds the cap mid-run", async () => {
    let calls = 0;
    vi.mocked(runAgent).mockImplementationOnce(async (_ctx: any, _type: string, _prompt: string, options: any) => {
      options.nestedRuntime?.nestingHooks?.registerNested({ label: "kid" });
      options.nestedRuntime?.nestingHooks?.registerNested({ label: "kid2" });
      return {
        responseText: "parent done",
        session: { dispose: vi.fn() },
        aborted: false,
        steered: false,
      } as any;
    });
    hostManager = new AgentManager();
    const host = createWorkflowHost({ pi: mockPi, ctx: hostCtx(), manager: hostManager, workflowId: "wf_host" });
    const result = await host.spawnAgent({
      agentId: "wf-agent-0",
      index: 0,
      prompt: "parent work",
      label: "parent",
      agentType: "general-purpose",
      nestedScope: {
        registerNested: (_child: any, _parent?: number) => {
          calls++;
          if (calls > 1) return { ok: false, error: "Workflow exceeded its cap of 2 agents." };
          return { ok: true, index: calls };
        },
        updateNestedRecordId: () => {},
        acquireNestedSlot: async () => () => {},
        settleNested: () => {},
      },
    });
    expect(calls).toBe(2);
    expect(result).toMatchObject({ ok: false, error: "Workflow exceeded its cap of 2 agents.", fatal: true });
  });
});

function hostCtx() {
  return {
    cwd: "/tmp",
    model: undefined,
    modelRegistry: { find: () => undefined, getAvailable: () => [] },
  } as any;
}

/* ------------------------------------------------------------------------- *
 * Background nested slot defers to the await path (finding 1)
 * ------------------------------------------------------------------------- */

describe("background nested slot", () => {
  let bgCwd: string;

  beforeEach(() => {
    bgCwd = mkdtempSync(join(tmpdir(), "wf-nested-bg-"));
    const dir = join(bgCwd, ".pi", "agents");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "scout.md"), "---\ndescription: scout\ntools: read\n---\nscout\n");
    registerAgents(loadCustomAgents(bgCwd));
  });

  afterEach(() => {
    rmSync(bgCwd, { recursive: true, force: true });
  });

  it("completes a background nested spawn awaited at concurrency 1", async () => {
    const bgRecords = new Map<string, any>();
    let seq = 0;
    const fakeManager = {
      spawn: (_pi: any, _ctx: any, type: string, _prompt: string, options: any): string => {
        seq += 1;
        const id = `bg-${seq}`;
        const record = {
          id,
          type,
          status: "completed",
          result: "bg done",
          parentAgentId: "direct-parent",
          lifetimeUsage: { input: 0, output: 0, cacheWrite: 0, cost: 0 },
          toolUses: 0,
        };
        bgRecords.set(id, record);
        // The child is already done by the time the parent awaits it.
        options.onAgentSettled?.(record);
        return id;
      },
      awaitStartup: async (): Promise<void> => {},
      getRecord: (id: string): any => bgRecords.get(id),
      setNestParentIndex: (): void => {},
      resume: async (): Promise<undefined> => undefined,
    } as any;
    const bgCtx = {
      cwd: bgCwd,
      model: undefined,
      modelRegistry: {
        find: (provider: string, id: string) => ({ provider, id }),
        getAvailable: () => [],
        getAll: () => [],
      },
    } as any;
    const host: WorkflowHost = {
      async spawnAgent(request) {
        const tools = createNestedSubagentTools({
          manager: fakeManager,
          pi: {} as any,
          parentAgentId: "direct-parent",
          depth: 1,
          maxSubagentDepth: 3,
          nestingHooks: request.nestedScope,
          nestParentIndex: request.index,
          allowedSubagents: "all",
          configCwd: bgCwd,
        });
        const spawned: any = await (tools[0] as any).execute(
          "call-1",
          { prompt: "Do work", description: "bg work", subagent_type: "scout", run_in_background: true },
          undefined,
          undefined,
          bgCtx,
        );
        expect(spawned.isError).toBe(false);
        const id: string = /Agent ID: (\S+)/.exec(spawned.content[0].text)?.[1] ?? "";
        expect(id).not.toBe("");
        const awaited: any = await (tools[1] as any).execute("call-2", { agent_id: id, wait: true }, undefined);
        expect(awaited.isError).toBe(false);
        return { ok: true, text: "parent done" };
      },
      abortAgent(): void {},
    };
    const result = await runWorkflow({
      script: HEAD + 'await agent("parent");\nreturn null;',
      host,
      concurrency: 1,
    });
    expect(result.status).toBe("completed");
    const { agents } = collapse(result.progress);
    expect(agents).toHaveLength(2);
    expect(agents[0].parentIndex).toBeUndefined();
    expect(agents[1].parentIndex).toBe(agents[0].index);
    expect(agents[1].state).toBe("done");
  });
});

/* ------------------------------------------------------------------------- *
 * Host aborts the over-cap child mid-run; first breach wins (findings 2, 4)
 * ------------------------------------------------------------------------- */

describe("workflow host nested breach aborts the child", () => {
  let breachManager: AgentManager | undefined;

  afterEach(() => {
    breachManager?.dispose();
    breachManager = undefined;
  });

  it("aborts the over-cap child mid-run instead of letting it finish", async () => {
    const events: string[] = [];
    vi.mocked(runAgent).mockImplementationOnce(async (_ctx: any, _type: string, _prompt: string, options: any) => {
      // Let onSpawned land first: a real child only calls tools after its
      // session exists, which is after the spawn callback ran.
      await new Promise<void>(resolve => setTimeout(resolve, 0));
      const hooks = options.nestedRuntime?.nestingHooks;
      const first = hooks?.registerNested({ label: "kid-1" });
      events.push(first?.ok === true ? "first:ok" : "first:breach");
      const second = hooks?.registerNested({ label: "kid-2" });
      events.push(second?.ok === true ? "second:ok" : "second:breach");
      return { responseText: "parent done", session: { dispose: vi.fn() }, aborted: false, steered: false } as any;
    });
    breachManager = new AgentManager();
    const abortSpy = vi.spyOn(breachManager, "abort");
    let calls = 0;
    const host = createWorkflowHost({ pi: mockPi, ctx: hostCtx(), manager: breachManager, workflowId: "wf_breach" });
    const result = await host.spawnAgent({
      agentId: "wf-agent-0",
      index: 0,
      prompt: "parent work",
      label: "parent",
      agentType: "general-purpose",
      nestedScope: {
        registerNested: () => {
          calls += 1;
          if (calls > 1) return { ok: false, error: "Workflow exceeded its cap of 2 agents." };
          return { ok: true, index: calls };
        },
        updateNestedRecordId: () => {},
        acquireNestedSlot: async () => () => {},
        settleNested: () => {},
      },
    });
    expect(events).toEqual(["first:ok", "second:breach"]);
    expect(abortSpy).toHaveBeenCalledTimes(1);
    expect(result).toMatchObject({ ok: false, error: "Workflow exceeded its cap of 2 agents.", fatal: true });
    const abortedId = abortSpy.mock.calls[0][0] as string;
    expect(breachManager.getRecord(abortedId)?.status).toBe("stopped");
  });

  it("keeps the first breach error when later breaches disagree", async () => {
    const CAP = "Workflow exceeded its cap of 2 agents.";
    const request: WorkflowSpawnRequest = {
      agentId: "wf-agent-0",
      index: 0,
      prompt: "parent work",
      label: "parent",
      agentType: "general-purpose",
      nestedScope: {
        registerNested: () => {
          calls += 1;
          return calls === 1 ? { ok: false, error: CAP } : { ok: false, error: "Workflow aborted." };
        },
        updateNestedRecordId: () => {},
        acquireNestedSlot: async () => () => {},
        settleNested: () => {},
      },
    };
    let calls = 0;
    vi.mocked(runAgent).mockImplementationOnce(async (_ctx: any, _type: string, _prompt: string, options: any) => {
      await new Promise<void>(resolve => setTimeout(resolve, 0));
      const hooks = options.nestedRuntime?.nestingHooks;
      hooks?.registerNested({ label: "kid-1" });
      hooks?.registerNested({ label: "kid-2" });
      request.nestedScope = undefined;
      hooks?.registerNested({ label: "kid-3" });
      return { responseText: "parent done", session: { dispose: vi.fn() }, aborted: false, steered: false } as any;
    });
    breachManager = new AgentManager();
    const abortSpy = vi.spyOn(breachManager, "abort");
    const host = createWorkflowHost({ pi: mockPi, ctx: hostCtx(), manager: breachManager, workflowId: "wf_breach" });
    const result = await host.spawnAgent(request);
    expect(result).toMatchObject({ ok: false, error: CAP, fatal: true });
    expect(abortSpy).toHaveBeenCalled();
  });
});

/* ------------------------------------------------------------------------- *
 * Fatal failures journal like normal failures; late settles emit nothing
 * (findings 3, 5)
 * ------------------------------------------------------------------------- */

describe("nested fatal journal and late settle", () => {
  it("journals a fatal breach as a failure so resume retries the parent live", async () => {
    const appended: any[] = [];
    let calls = 0;
    const fatalHost: WorkflowHost = {
      async spawnAgent() {
        calls += 1;
        return { ok: false, error: "Workflow exceeded its cap of 2 agents.", fatal: true };
      },
      abortAgent() {},
    };
    const first = await run('await agent("parent");\nreturn null;', {
      host: fatalHost,
      journal: { append: entry => { appended.push(entry); } },
    });
    expect(first.status).toBe("failed");
    expect(calls).toBe(1);
    expect(appended).toHaveLength(1);
    expect(appended[0]).toMatchObject({ ok: false, error: "Workflow exceeded its cap of 2 agents." });
    const second = await run('await agent("parent");\nreturn null;', {
      host: fatalHost,
      journal: { entries: appended },
    });
    expect(second.status).toBe("failed");
    expect(second.replayedCount).toBe(0);
    expect(calls).toBe(2);
  });

  it("ignores a nested settle that lands after the run resolved", async () => {
    let capturedScope: any;
    let nestedIdx = -1;
    const host: WorkflowHost = {
      async spawnAgent(request) {
        const scope = request.nestedScope!;
        const reg = scope.registerNested({ label: "bg" });
        expect(reg.ok).toBe(true);
        if (reg.ok) {
          nestedIdx = reg.index;
          capturedScope = scope;
        }
        return { ok: true, text: "parent done" };
      },
      abortAgent() {},
    };
    const result = await run('await agent("parent");\nreturn null;', { host });
    expect(result.status).toBe("completed");
    const before = result.progress.length;
    capturedScope.settleNested(nestedIdx, { ok: true });
    expect(result.progress.length).toBe(before);
  });
});
