import type { SessionEntry } from "@earendil-works/pi-coding-agent";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../src/agent-runner.js", async () => {
  const actual = await vi.importActual("../src/agent-runner.js");
  return { ...actual, runAgent: vi.fn(), resumeAgent: vi.fn() };
});

import { resumeAgent, runAgent } from "../src/agent-runner.js";
import subagentsExtension from "../src/index.js";
import type { AgentRecord } from "../src/types.js";
import { ctx, type Hermetic, hermeticDir, makePi, textOf } from "./helpers/boot-extension.js";

const report = "FULL REPORT\n" + "Evidence and conclusions.\n".repeat(100);
const snapshot = (id: string, changes: Record<string, unknown> = {}) => ({
  id, type: "Explore", description: "Review evidence", status: "completed",
  result: report, startedAt: 100, completedAt: 200, ...changes,
});
const entry = (data: unknown, customType = "subagents:record"): SessionEntry => ({
  type: "custom", id: "entry", parentId: null, timestamp: "2026-10-23T00:00:00Z", customType, data,
});

describe("retained terminal results in the current parent branch", () => {
  let hermetic: Hermetic;
  let booted: ReturnType<typeof makePi>;
  let context: ReturnType<typeof ctx>;
  let branch: SessionEntry[];
  let getRecord: (id: string) => AgentRecord | undefined;

  beforeEach(() => {
    vi.useFakeTimers();
    vi.clearAllMocks();
    hermetic = hermeticDir({ settings: { schedulingEnabled: false, outputTranscript: false } });
    branch = [];
    booted = makePi();
    booted.pi.appendEntry.mockImplementation((customType: string, data: unknown) => branch.push(entry(data, customType)));
    context = ctx({ cwd: hermetic.dir, sessionManager: { getSessionId: () => "parent", getBranch: () => branch } });
    vi.mocked(runAgent).mockResolvedValue({
      responseText: report, session: { messages: [], dispose: vi.fn() } as unknown as AgentRecord["session"],
      aborted: false, steered: false,
    });
    subagentsExtension(booted.pi);
    getRecord = (globalThis as unknown as Record<symbol, { getRecord: typeof getRecord }>)[Symbol.for("pi-subagents:manager")].getRecord;
  });

  afterEach(async () => {
    await booted.lifecycle.get("session_shutdown")({}, context);
    hermetic.restore();
    vi.useRealTimers();
  });

  async function spawn(background = false) {
    const result = await booted.tools.get("Agent").execute("spawn", {
      subagent_type: "Explore", prompt: "Review evidence", description: "Review evidence", run_in_background: background,
    }, undefined, undefined, context);
    return result.details.agentId as string;
  }
  async function read(id: string, verbose = false) {
    return textOf(await booted.tools.get("get_subagent_result").execute("read", { agent_id: id, verbose, wait: true }, undefined, undefined, context));
  }
  const cleanup = () => booted.lifecycle.get("session_before_switch")({}, context);

  it("retrieves the full result after ten-minute GC without running or resurrecting a child", async () => {
    const id = await spawn();
    await vi.advanceTimersByTimeAsync(11 * 60_000);
    expect(getRecord(id)).toBeUndefined();
    expect(await read(id)).toContain(report.trim());
    expect(await read(id)).toContain("Retained terminal result");
    expect(getRecord(id)).toBeUndefined();
    expect(runAgent).toHaveBeenCalledOnce();
    expect(resumeAgent).not.toHaveBeenCalled();
  });

  it("reads only the current branch, by exact ID rather than a retired handle", async () => {
    const id = await spawn();
    await cleanup();
    expect(await read(id)).toContain(report.trim());
    expect(await read("explore")).toContain("Agent not found");
    const original = branch;
    branch = [entry(snapshot("other-id"))];
    expect(await read(id)).toContain("Agent not found");
    branch = original;
    expect(await read(id)).toContain(report.trim());
    expect(runAgent).toHaveBeenCalledOnce();
    expect(resumeAgent).not.toHaveBeenCalled();
  });

  it("prefers a live record and keeps owned records hidden despite a snapshot", async () => {
    const id = await spawn();
    branch.push(entry(snapshot(id, { result: "stale snapshot" })));
    expect(await read(id)).toContain(report.trim());
    expect(await read(id)).not.toContain("Retained terminal result");
    const record = getRecord(id)!;
    record.workflowId = "owner";
    expect(await read(id)).toContain("Agent not found");
    record.workflowId = undefined;
    record.parentAgentId = "owner";
    expect(await read(id)).toContain("Agent not found");
  });

  it.each([false, true])("retains the newest real resume outcome (background=%s)", async background => {
    const id = await spawn();
    vi.mocked(resumeAgent).mockResolvedValueOnce({ text: "new evidence", failure: "resume failed" });
    await booted.tools.get("Agent").execute("resume", {
      subagent_type: "Explore", prompt: "Continue", description: "Continue", resume: id, run_in_background: background,
    }, undefined, undefined, context);
    await getRecord(id)!.promise;
    await cleanup();
    branch.push(entry(snapshot(id, { result: 42 })));
    const output = await read(id);
    expect(output).toContain("Error: resume failed");
    expect(output).toContain("Partial output before the failure:\nnew evidence");
    expect(output).not.toContain(report.trim());
    expect(branch).toHaveLength(3);
    expect(resumeAgent).toHaveBeenCalledOnce();
  });

  it.each(["completed", "error", "stopped", "aborted", "steered"])("preserves terminal status %s", async status => {
    branch.push(entry(snapshot("terminal", { status, error: "child failed" })));
    const output = await read("terminal", true);
    expect(output).toContain(`Status: ${status}`);
    expect(output).toContain(report.trim());
    expect(output).toContain("Live conversation is unavailable after cleanup");
    expect(output).not.toMatch(/Tool uses:|Context:|Cost:|Compactions:/);
    if (status === "stopped") expect(output).toContain("task was NOT finished");
    if (status === "aborted") expect(output).toContain("output may be incomplete");
    if (status === "steered") expect(output).toContain("output may be partial");
    if (status === "error") expect(output).toContain("Partial output before the failure:");
  });

  it.each([
    null, [], {}, { status: "running" }, { status: "queued" }, { status: "unknown" },
    { type: 42 }, { description: null }, { startedAt: NaN }, { startedAt: Infinity },
    { completedAt: undefined }, { completedAt: Infinity }, { completedAt: "200" }, { result: {} }, { error: 42 },
  ])("ignores malformed or nonterminal snapshots: %j", async changes => {
    branch = [entry(changes === null || Array.isArray(changes) || Object.keys(changes).length === 0 ? changes : snapshot("invalid", changes))];
    expect(await read("invalid")).toContain("Agent not found");
  });

  it("ignores other entry kinds and honestly labels empty output", async () => {
    branch = [entry(snapshot("other"), "other-extension")];
    expect(await read("other")).toContain("Agent not found");
    branch.push(entry(snapshot("empty", { result: undefined, error: undefined })));
    expect(await read("empty")).toContain("No output.");
  });

  it("cancels a pending notification by exact recovered ID without reviving its record", async () => {
    const id = await spawn(true);
    const record = getRecord(id)!;
    await record.promise;
    record.resultConsumed = true;
    await cleanup();
    record.resultConsumed = false;
    expect(getRecord(id)).toBeUndefined();
    expect(await read(id)).toContain(report.trim());
    await vi.advanceTimersByTimeAsync(200);
    expect(booted.pi.sendMessage).not.toHaveBeenCalled();
    expect(getRecord(id)).toBeUndefined();
  });
});
