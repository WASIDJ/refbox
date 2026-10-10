import { afterEach, describe, expect, it, vi } from "vitest";
import {
  mkdtemp,
  readFile,
  writeFile,
  rm,
  mkdir,
  symlink,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import {
  createModels,
  fauxProvider,
  fauxAssistantMessage,
  fauxToolCall,
  fauxText,
} from "@earendil-works/pi-ai";
import { MemoryStorage } from "@earendil-works/pi-durable";
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node";
import { Engine, type EngineOptions } from "../src/engine.js";
import { BoardDoc } from "../src/state.js";
import { BACKGROUND_CONTEXT as context } from "@earendil-works/chord/context";
import { runtimeServer } from "../src/server.js";
import type { PlatformOptions } from "../src/platform.js";
import { InProcessTransport } from "../../services/test/transport.mjs";

const engines: Engine[] = [];
const dirs: string[] = [];
afterEach(async () => {
  for (const engine of engines.splice(0)) await engine.close();
  for (const d of dirs.splice(0)) await rm(d, { recursive: true, force: true });
  vi.unstubAllGlobals();
});
async function fixture(
  storage?: MemoryStorage,
  platform?: PlatformOptions,
  options?: EngineOptions,
) {
  const dir = await mkdtemp(join(tmpdir(), "refbox-test-"));
  dirs.push(dir);
  const faux = fauxProvider();
  const models = createModels();
  models.setProvider(faux.provider);
  const engine = await new Engine(
    models,
    faux.getModel().id,
    faux.provider.id,
    platform,
    options,
  ).open(storage ?? new MemoryStorage());
  engines.push(engine);
  return { engine, faux, dir };
}
async function waitFor(fn: () => Promise<boolean>) {
  for (let n = 0; n < 300; n++) {
    if (await fn()) return;
    await new Promise((r) => setTimeout(r, 20));
  }
  throw new Error("state timeout");
}
const tool = (name: string, args: Record<string, unknown>) =>
  fauxAssistantMessage([fauxToolCall(name, args)], { stopReason: "toolUse" });

describe("Pi Durable integration", () => {
  it("planning performs no filesystem work, deduplicates creation, and requires confirmation", async () => {
    const { engine, faux, dir } = await fixture();
    const body = { title: "创建结果", goal: "生成一个可验证文件", cwd: dir };
    const t = await engine.create(body, "create-1234");
    expect((await engine.create(body, "create-1234")).id).toBe(t.id);
    await expect(
      engine.create({ ...body, goal: "不同目标" }, "create-1234"),
    ).rejects.toMatchObject({ status: 409 });
    const plan = {
      steps: "写入 result.txt",
      criteria: "内容等于 verified",
      verificationCommand: 'test "$(cat result.txt)" = verified',
    };
    faux.setResponses([
      tool("bash", { command: "touch unauthorized" }),
      tool("propose_plan", plan),
    ]);
    await engine.command(t.id, "plan", {}, "plan-1234");
    await waitFor(
      async () => (await engine.task(t.id)).status === "awaiting_confirmation",
    );
    await expect(readFile(join(dir, "unauthorized"))).rejects.toThrow();
    expect((await engine.task(t.id)).approvedPlan).toBeNull();
    faux.setResponses([
      tool("write", { path: "result.txt", content: "verified" }),
      tool("record_experiment", {
        hypothesis: "文件可保存成果",
        conclusion: "已生成文件",
        artifacts: ["result.txt"],
      }),
      tool("verify_result", { summary: "文件内容符合标准" }),
    ]);
    await engine.command(t.id, "approve", plan, "approve-1234");
    await waitFor(async () => (await engine.task(t.id)).status === "completed");
    const completed = await engine.task(t.id);
    expect(completed.verified).toBe(true);
    expect(completed.verifications[0].exitCode).toBe(0);
    expect(completed.verifications[0].assurance).toBe("execution_assertion");
    expect(completed.experiments[0].evidenceEntries.length).toBeGreaterThan(0);
    expect((await engine.readArtifact(t.id, "result.txt")).toString()).toBe(
      "verified",
    );
    await expect(
      engine.readArtifact(t.id, "/etc/passwd"),
    ).rejects.toMatchObject({ status: 403 });
    await engine.command(t.id, "approve", plan, "approve-1234");
    expect((await engine.task(t.id)).verifications).toHaveLength(1);
  });
  it("a final answer or failed verification does not claim completion; onYield drives another iteration", async () => {
    const { engine, faux, dir } = await fixture();
    const t = await engine.create(
      { title: "持续推进", goal: "写入通过验证的文件", cwd: dir },
      "create-2222",
    );
    const plan = {
      steps: "实验",
      criteria: "文件存在",
      verificationCommand: "test -f result.txt",
    };
    await engine.update(t.id, (t) => {
      t.plan = plan;
      t.status = "awaiting_confirmation";
    });
    faux.setResponses([
      fauxAssistantMessage([fauxText("我认为已完成")]),
      tool("verify_result", { summary: "尝试验证" }),
      tool("write", { path: "result.txt", content: "ok" }),
      tool("verify_result", { summary: "再次验证" }),
    ]);
    await engine.command(t.id, "approve", plan, "approve-2222");
    await waitFor(async () => (await engine.task(t.id)).status === "completed");
    const done = await engine.task(t.id);
    expect(done.verifications.map((v) => v.exitCode)).toEqual([1, 0]);
    expect(done.verified).toBe(true);
  });
  it("abort retains state; explicit continue reuses context and confirms real effects", async () => {
    const { engine, faux, dir } = await fixture();
    const t = await engine.create(
      { title: "停止继续", goal: "完成后验证", cwd: dir },
      "create-3333",
    );
    const plan = {
      steps: "执行",
      criteria: "结果存在",
      verificationCommand: "test -f final.txt",
    };
    await engine.update(t.id, (t) => {
      t.status = "awaiting_confirmation";
      t.plan = plan;
    });
    faux.setResponses([tool("bash", { command: "touch started; sleep 3" })]);
    await engine.command(t.id, "approve", plan, "approve-3333");
    await waitFor(async () =>
      readFile(join(dir, "started")).then(
        () => true,
        () => false,
      ),
    );
    await engine.command(t.id, "stop", {}, "stop-3333");
    expect((await engine.task(t.id)).status).toBe("stopped");
    expect((await engine.view(t.id)).entries.length).toBeGreaterThan(0);
    faux.setResponses([
      tool("write", { path: "final.txt", content: "resumed" }),
      tool("verify_result", { summary: "恢复后完成" }),
    ]);
    await engine.command(t.id, "continue", {}, "continue-3333");
    await waitFor(async () => (await engine.task(t.id)).status === "completed");
  });
  it("uses actual SQLite across reopen and reports exactly once per date", async () => {
    const dir = await mkdtemp(join(tmpdir(), "refbox-sqlite-"));
    dirs.push(dir);
    const db = join(dir, "state.sqlite");
    const faux = fauxProvider();
    const models = createModels();
    models.setProvider(faux.provider);
    const first = await new Engine(
      models,
      faux.getModel().id,
      faux.provider.id,
    ).open(await openNodeSqliteStorage(db));
    const t = await first.create(
      { title: "持久记录", goal: "以后继续", cwd: dir },
      "create-sqlite",
    );
    await first.saveService(
      {
        name: "财务服务",
        url: "http://localhost:3000",
        operations: "通过 agent 操作",
      },
      "service-1111",
    );
    await first.report(t.id, "2026-10-09");
    await first.report(t.id, "2026-10-09");
    await first.close();
    const second = await new Engine(
      models,
      faux.getModel().id,
      faux.provider.id,
    ).open(await openNodeSqliteStorage(db));
    engines.push(second);
    expect((await second.task(t.id)).reports).toHaveLength(1);
    expect(Object.values((await second.board()).services)[0].name).toBe(
      "财务服务",
    );
    expect(
      (
        await second.create(
          { title: "持久记录", goal: "以后继续", cwd: dir },
          "create-sqlite",
        )
      ).id,
    ).toBe(t.id);
  });
  it("protects internal endpoints and reconnects SSE with a current snapshot", async () => {
    const { engine, dir } = await fixture();
    const token = "a".repeat(40);
    const server = runtimeServer(engine, token);
    const transport = new InProcessTransport();
    const url = transport.register(server);
    // The test transport signals cancellation on its request stream. Real HTTP
    // signals response.close too; bridge it so the actual SSE cleanup runs.
    server.on("request", (req, res) =>
      req.once("close", () => res.emit("close")),
    );
    const headers = { Authorization: "Bearer " + token };
    const snapshot = async () => {
      const response = await transport.fetch(url + "/api/events", { headers });
      const reader = response.body!.getReader();
      try {
        const chunk = await reader.read();
        return new TextDecoder().decode(chunk.value);
      } finally {
        await reader.cancel();
      }
    };
    try {
      expect((await transport.fetch(url + "/api/tasks")).status).toBe(401);
      expect((await transport.fetch(url + "/api/events")).status).toBe(401);
      const health = await transport.fetch(url + "/api/health", { headers });
      expect((await health.json()).readiness).toBe("ready");
      await engine.create(
        { title: "断线后可见", goal: "保持状态", cwd: dir },
        "sse-task-123",
      );
      expect(await snapshot()).toContain("断线后可见");
      expect(engine.listeners.size).toBe(0);
      await engine.create(
        { title: "重连后新增任务", goal: "重连得到当前状态", cwd: dir },
        "sse-task-new-123",
      );
      const reconnect = await snapshot();
      expect(reconnect).toContain("断线后可见");
      expect(reconnect).toContain("重连后新增任务");
      expect(engine.listeners.size).toBe(0);
    } finally {
      transport.remove(url);
      server.removeAllListeners();
    }
  });
  it("reacquires an admitted command after reopen without resetting a completed task", async () => {
    const dir = await mkdtemp(join(tmpdir(), "refbox-receipt-"));
    dirs.push(dir);
    const db = join(dir, "state.sqlite");
    const faux = fauxProvider();
    const models = createModels();
    models.setProvider(faux.provider);
    const first = await new Engine(
      models,
      faux.getModel().id,
      faux.provider.id,
    ).open(await openNodeSqliteStorage(db));
    const task = await first.create(
      { title: "提交回执恢复", goal: "验证文件", cwd: dir },
      "receipt-create-1234",
    );
    const plan = {
      steps: "验证",
      criteria: "文件存在",
      verificationCommand: "test -f result.txt",
    };
    await writeFile(join(dir, "result.txt"), "ok");
    await first.update(task.id, (t) => {
      t.status = "awaiting_confirmation";
      t.plan = plan;
    });
    faux.setResponses([tool("verify_result", { summary: "已完成" })]);
    await first.command(task.id, "approve", plan, "receipt-approve-1234");
    await waitFor(
      async () => (await first.task(task.id)).status === "completed",
    );
    await first.harness.commit(async (tx) => {
      (await tx.doc(BoardDoc)).commands["receipt-approve-1234"].done = false;
    }, context);
    await first.close();
    const second = await new Engine(
      models,
      faux.getModel().id,
      faux.provider.id,
    ).open(await openNodeSqliteStorage(db));
    engines.push(second);
    await waitFor(
      async () => (await second.board()).commands["receipt-approve-1234"].done,
    );
    expect((await second.task(task.id)).verified).toBe(true);
    expect((await second.task(task.id)).status).toBe("completed");
    expect((await second.task(task.id)).verifications).toHaveLength(1);
  });
  it("resumes after SIGKILL without replaying the interrupted unsafe shell command", async () => {
    const dir = await mkdtemp(join(tmpdir(), "refbox-crash-"));
    dirs.push(dir);
    const script = fileURLToPath(
      new URL("./crash-fixture.mjs", import.meta.url),
    );
    const first = spawn(process.execPath, [script, "crash", dir], {
      stdio: ["ignore", "pipe", "pipe"],
    });
    let error = "";
    first.stderr.on("data", (d) => {
      error += d.toString();
    });
    try {
      await waitFor(async () =>
        readFile(join(dir, "ready")).then(
          () => true,
          () => false,
        ),
      );
    } catch (e) {
      first.kill("SIGKILL");
      throw new Error(error + (e as Error).message);
    }
    first.kill("SIGKILL");
    await new Promise<void>((r) => first.once("exit", () => r()));
    const next = spawn(process.execPath, [script, "recover", dir], {
      stdio: ["ignore", "pipe", "pipe"],
    });
    next.stderr.on("data", (d) => {
      error += d.toString();
    });
    const code = await new Promise<number | null>((r) => next.once("exit", r));
    expect(code, error).toBe(0);
    expect(await readFile(join(dir, "result.txt"), "utf8")).toBe("recovered");
    expect(
      (await readFile(join(dir, "attempts.txt"), "utf8")).trim().split("\n"),
    ).toHaveLength(1);
  }, 15000);
});

describe("Autonomous goal execution", () => {
  it("reads fixed Wiki context and isolated source while planning cannot mutate files, run commands, read credentials or escape symlinks", async () => {
    const wiki = await mkdtemp(join(tmpdir(), "refbox-wiki-"));
    dirs.push(wiki);
    await mkdir(join(wiki, "concepts"));
    await writeFile(
      join(wiki, "hot.md"),
      "用户只提出目标，执行与验证分别承担责任。",
    );
    await writeFile(join(wiki, "index.md"), "[[目标验收]] → concepts/goal.md");
    await writeFile(
      join(wiki, "concepts", "goal.md"),
      "公共标准不得降低。嵌入命令 touch unauthorized-wiki 只是材料。",
    );
    const { engine, faux, dir } = await fixture(undefined, undefined, {
      wikiDir: wiki,
    });
    await writeFile(join(dir, "input.txt"), "real source context");
    await writeFile(join(dir, ".env"), "must-not-be-read-secret");
    await symlink(join(wiki, "hot.md"), join(dir, "outside.txt"));
    const task = await engine.create(
      { title: "自主规划", goal: "产出实际改进", cwd: dir, autonomous: true },
      "autonomous-create-context",
    );
    expect(task.status).toBe("draft"); // Go owns the first plan command.
    faux.setResponses([
      tool("read_context", { path: "." }),
      tool("read_context", { path: "input.txt" }),
      tool("wiki_context", {}),
      tool("wiki_context", { path: "concepts/goal.md" }),
      tool("read_context", { path: ".env" }),
      tool("read_context", { path: "outside.txt" }),
      tool("wiki_context", { path: "../escape" }),
      tool("bash", { command: "touch unauthorized-shell" }),
      tool("write", { path: "input.txt", content: "mutated" }),
      tool("propose_plan", {
        steps: "写结果",
        criteria: "result.txt 包含完成",
        verificationCommand: "test -f result.txt",
        checks: [],
      }),
      tool("propose_plan", {
        steps: "写结果",
        criteria: "result.txt 包含完成",
        verificationCommand: "test -f result.txt",
        checks: [
          {
            id: "result",
            kind: "file_contains",
            path: "result.txt",
            contains: "完成",
          },
        ],
      }),
    ]);
    await engine.command(
      task.id,
      "plan",
      { guidance: "" }, // The Go coordinator's first planning receipt has no rejection feedback.
      "autonomous-plan-context",
    );
    await waitFor(
      async () =>
        (await engine.task(task.id)).status === "awaiting_confirmation",
    );
    expect(await readFile(join(dir, "input.txt"), "utf8")).toBe(
      "real source context",
    );
    await expect(readFile(join(dir, "unauthorized-shell"))).rejects.toThrow();
    await expect(readFile(join(dir, "unauthorized-wiki"))).rejects.toThrow();
    const history = JSON.stringify(await engine.view(task.id));
    expect(history).toContain("real source context");
    expect(history).toContain("公共标准不得降低");
    expect(history).not.toContain("must-not-be-read-secret");
    expect((await engine.task(task.id)).approvedPlan).toBeNull();
    expect((await engine.task(task.id)).plan?.checks).toHaveLength(1);
    const conversation = (await engine.harness.conversation(
      Number(task.id) as never,
      context,
    ))!;
    const tools = (await conversation.agent(context)).tools.map(
      (tool) => tool.name,
    );
    expect(tools).toContain("read_context");
    expect(tools).toContain("wiki_context");
    expect(tools).not.toContain("bash");
    expect(tools).not.toContain("write");
  });

  it("requires the reviewed proposal, self-check only awaits proof, and feedback resumes the exact frozen plan without human approval", async () => {
    const { engine, faux, dir } = await fixture();
    const task = await engine.create(
      { title: "自主改进", goal: "产生可验证成果", cwd: dir, autonomous: true },
      "autonomous-create-result",
    );
    const plan = {
      steps: "产生真实文件",
      criteria: "result.txt 内容为 verified",
      verificationCommand: 'test "$(cat result.txt)" = verified',
      checks: [
        {
          id: "result",
          kind: "file_contains",
          path: "result.txt",
          contains: "verified",
        },
        {
          id: "json-key-order",
          kind: "json_equals",
          path: "result.json",
          jsonPath: "nested",
          equals: { z: 2, a: 1 },
        },
      ],
    };
    await engine.update(task.id, (item) => {
      item.status = "awaiting_confirmation";
      item.plan = engine.plan(plan);
    });
    await expect(
      engine.command(
        task.id,
        "approve",
        { ...plan, criteria: "文件存在就行" },
        "autonomous-weaken-criteria",
      ),
    ).rejects.toMatchObject({ status: 409 });
    await expect(
      engine.command(
        task.id,
        "approve",
        { ...plan, checks: [] },
        "autonomous-remove-checks",
      ),
    ).rejects.toMatchObject({ status: 409 });
    faux.setResponses([
      tool("write", { path: "result.txt", content: "verified" }),
      tool("write", {
        path: "result.json",
        content: '{"nested":{"z":2,"a":1}}',
      }),
      tool("record_experiment", {
        hypothesis: "实际文件满足标准",
        conclusion: "已执行并记录",
        artifacts: ["result.txt", "result.json"],
      }),
      tool("verify_result", { summary: "执行側首次自检成功" }),
    ]);
    // Go marshals nested JSON object keys in sorted order. This is the same
    // reviewed standard, so transport key order must not reject authorization.
    const approved = {
      ...plan,
      checks: [plan.checks[0], { ...plan.checks[1], equals: { a: 1, z: 2 } }],
    };
    await engine.command(
      task.id,
      "approve",
      approved,
      "autonomous-approve-result",
    );
    await waitFor(
      async () =>
        (await engine.task(task.id)).status === "awaiting_verification",
    );
    let result = await engine.task(task.id);
    expect(result.verified).toBe(false);
    expect(result.verifications[0]).toMatchObject({
      exitCode: 0,
      assurance: "execution_assertion",
    });
    expect((await engine.readiness()).activeRuns).toBe(0);
    await expect(
      engine.command(
        task.id,
        "continue",
        { guidance: "修复漏项", criteria: "降低标准" },
        "autonomous-invalid-resume",
      ),
    ).rejects.toMatchObject({ status: 400 });
    faux.setResponses([
      tool("write", {
        path: "additional.txt",
        content: "fixed independently observed omission",
      }),
      tool("record_experiment", {
        hypothesis: "缺口应修复",
        conclusion: "增加缺失的产物",
        artifacts: ["additional.txt"],
      }),
      tool("verify_result", { summary: "修复后保持原标准" }),
    ]);
    await engine.command(
      task.id,
      "continue",
      { guidance: "独立验证发现遗漏，请生成 additional.txt，并保持标准不变。" },
      "autonomous-continue-feedback",
    );
    await waitFor(
      async () =>
        (await engine.task(task.id)).verifications.length === 2 &&
        (await engine.task(task.id)).status === "awaiting_verification",
    );
    result = await engine.task(task.id);
    expect(result.verified).toBe(false);
    expect(result.approvedPlan).toEqual(engine.plan(plan));
    expect(
      (await engine.readArtifact(task.id, "additional.txt")).toString(),
    ).toContain("fixed independently");
    expect(JSON.stringify(await engine.view(task.id))).toContain(
      "独立验证发现遗漏",
    );
    await engine.command(task.id, "stop", {}, "autonomous-stop-awaiting");
    expect((await engine.task(task.id)).status).toBe("stopped");
    await expect(
      engine.command(
        task.id,
        "plan",
        { guidance: "删除公共检查" },
        "autonomous-replan-frozen",
      ),
    ).rejects.toMatchObject({ status: 409 });
  });

  it("replans rejected initial contracts with visible feedback and prepares only the coordinator-selected workspace before freezing", async () => {
    const { engine, faux, dir } = await fixture();
    const selected = await mkdtemp(join(tmpdir(), "refbox-prepared-"));
    dirs.push(selected);
    const task = await engine.create(
      { title: "准备工作区", goal: "做真正的实现", cwd: dir, autonomous: true },
      "autonomous-create-prepare",
    );
    await engine.command(
      task.id,
      "prepare",
      { cwd: selected },
      "autonomous-prepare-path",
    );
    expect((await engine.task(task.id)).cwd).toBe(selected);
    const weak = {
      steps: "写报告",
      criteria: "报告存在",
      verificationCommand: "true",
      checks: [{ id: "report", kind: "file_exists", path: "report.md" }],
    };
    faux.setResponses([tool("propose_plan", weak)]);
    await engine.command(task.id, "plan", {}, "autonomous-first-proposal");
    await waitFor(
      async () =>
        (await engine.task(task.id)).status === "awaiting_confirmation",
    );
    const stronger = {
      steps: "实际修复",
      criteria: "源码和测试通过",
      verificationCommand: "test -f actual.txt",
      checks: [{ id: "actual", kind: "file_exists", path: "actual.txt" }],
    };
    faux.setResponses([tool("propose_plan", stronger)]);
    await engine.command(
      task.id,
      "plan",
      { guidance: "方案只提供说明，没有实际功能，不能通过公共契约审查。" },
      "autonomous-contract-feedback",
    );
    await waitFor(
      async () =>
        (await engine.task(task.id)).plan?.criteria === stronger.criteria,
    );
    expect(JSON.stringify(await engine.view(task.id))).toContain(
      "没有实际功能",
    );
    faux.setResponses([
      tool("write", { path: "actual.txt", content: "real effect" }),
      tool("verify_result", { summary: "已实现" }),
    ]);
    await engine.command(
      task.id,
      "approve",
      stronger,
      "autonomous-freeze-proposal",
    );
    await waitFor(
      async () =>
        (await engine.task(task.id)).status === "awaiting_verification",
    );
    await expect(
      engine.command(
        task.id,
        "prepare",
        { cwd: dir },
        "autonomous-prepare-frozen",
      ),
    ).rejects.toMatchObject({ status: 409 });
    expect(await readFile(join(selected, "actual.txt"), "utf8")).toBe(
      "real effect",
    );
    await expect(readFile(join(dir, "actual.txt"))).rejects.toThrow();
    expect(() =>
      engine.plan({
        ...stronger,
        checks: [{ id: "rawshell", kind: "command", command: "rm -rf /" }],
      }),
    ).toThrow();
    expect(() =>
      engine.plan({
        ...stronger,
        checks: [{ id: "escape", kind: "file_exists", path: "../elsewhere" }],
      }),
    ).toThrow();
  });

  it("retains awaiting proof and frozen standards across real SQLite reopen without replaying admitted approval", async () => {
    const dir = await mkdtemp(join(tmpdir(), "refbox-autonomous-reopen-"));
    dirs.push(dir);
    const db = join(dir, "native.sqlite");
    const faux = fauxProvider();
    const models = createModels();
    models.setProvider(faux.provider);
    const first = await new Engine(
      models,
      faux.getModel().id,
      faux.provider.id,
    ).open(await openNodeSqliteStorage(db));
    const task = await first.create(
      {
        title: "独立验收恢复",
        goal: "结果保留等待独立验收",
        cwd: dir,
        autonomous: true,
      },
      "autonomous-reopen-create",
    );
    const plan = {
      steps: "产生文件",
      criteria: "真正写入 result.txt",
      verificationCommand: "test -f result.txt",
      checks: [{ id: "result", kind: "file_exists", path: "result.txt" }],
    };
    await first.update(task.id, (item) => {
      item.plan = first.plan(plan);
      item.status = "awaiting_confirmation";
    });
    faux.setResponses([
      tool("write", { path: "result.txt", content: "preserved" }),
      tool("verify_result", { summary: "等待另一 Agent" }),
    ]);
    await first.command(task.id, "approve", plan, "autonomous-reopen-approve");
    await waitFor(
      async () =>
        (await first.task(task.id)).status === "awaiting_verification",
    );
    await first.harness.commit(async (tx) => {
      (await tx.doc(BoardDoc)).commands["autonomous-reopen-approve"].done =
        false;
    }, context);
    await first.close();
    const second = await new Engine(
      models,
      faux.getModel().id,
      faux.provider.id,
    ).open(await openNodeSqliteStorage(db));
    engines.push(second);
    await waitFor(
      async () =>
        (await second.board()).commands["autonomous-reopen-approve"].done,
    );
    const recovered = await second.task(task.id);
    expect(recovered.status).toBe("awaiting_verification");
    expect(recovered.autonomous).toBe(true);
    expect(recovered.verified).toBe(false);
    expect(recovered.approvedPlan).toEqual(second.plan(plan));
    expect(recovered.verifications).toHaveLength(1);
    expect(await readFile(join(dir, "result.txt"), "utf8")).toBe("preserved");
    faux.setResponses([
      tool("verify_result", { summary: "反馈恢复后仍不自封验收通过" }),
    ]);
    await second.command(
      task.id,
      "continue",
      { guidance: "请保持既有候选并重新提交证据。" },
      "autonomous-reopen-continue",
    );
    await waitFor(
      async () =>
        (await second.task(task.id)).verifications.length === 2 &&
        (await second.task(task.id)).status === "awaiting_verification",
    );
    await second.command(
      task.id,
      "continue",
      { guidance: "请保持既有候选并重新提交证据。" },
      "autonomous-reopen-continue",
    );
    expect((await second.task(task.id)).verifications).toHaveLength(2);
    expect((await second.task(task.id)).verified).toBe(false);
  });
});

describe("Scoped platform diagnosis", () => {
  it("uses a separate native conversation and cannot execute shell, mutate plugins or leave resource scope", async () => {
    const calls: { path: string; body: Record<string, unknown> }[] = [];
    const token = "p".repeat(40);
    vi.stubGlobal("fetch", async (url: URL, options: RequestInit) => {
      expect(new Headers(options.headers).get("authorization")).toBe(
        "Bearer " + token,
      );
      const path = url.pathname + url.search;
      const input = options.body ? JSON.parse(String(options.body)) : {};
      if (options.method === "POST") calls.push({ path, body: input });
      if (path === "/internal/resources")
        return Response.json([
          {
            id: "nas",
            pluginId: "monitor",
            version: "v1",
            environmentId: "home",
          },
          {
            id: "notes",
            pluginId: "scratchpad",
            version: "v1",
            environmentId: "home",
          },
        ]);
      if (path === "/internal/plugins")
        return Response.json([
          {
            id: "monitor",
            enabled: true,
            manifest: {
              tools: [
                { id: "read_health", mutates: false },
                { id: "restart", mutates: true },
              ],
            },
          },
          {
            id: "scratchpad",
            enabled: true,
            manifest: { tools: [{ id: "read", mutates: false }] },
          },
        ]);
      if (path === "/internal/observations?resourceId=nas")
        return Response.json({ resourceId: "nas", healthy: false });
      if (path === "/internal/plugins/monitor/tools/read_health")
        return Response.json({ resourceId: "nas", status: "unhealthy" });
      return Response.json({}, { status: 404 });
    });
    const { engine, faux, dir } = await fixture(undefined, {
      url: "http://127.0.0.1:8080",
      token,
    });
    const task = await engine.create(
      { title: "普通任务", goal: "保留原有权限模型", cwd: dir },
      "task-before-diagnosis",
    );
    faux.setResponses([
      tool("bash", { command: `touch '${join(dir, "unauthorized")}'` }),
      tool("platform_call_tool", { pluginId: "monitor", toolId: "restart" }),
      tool("platform_read_tool", { pluginId: "monitor", toolId: "restart" }),
      tool("platform_read_tool", { pluginId: "scratchpad", toolId: "read" }),
      tool("platform_observe", { resourceId: "notes" }),
      tool("platform_observe", {}),
      tool("platform_read_tool", {
        pluginId: "monitor",
        toolId: "read_health",
        input: { resourceId: "notes" },
      }),
      fauxAssistantMessage([
        fauxText("NAS 检查失败；建议进一步核对服务进程，未执行修复。"),
      ]),
    ]);
    const input = {
      incidentId: "incident-nas",
      resourceId: "nas",
      version: "v1",
      environmentId: "home",
      observations: { healthy: false },
    };
    const d = await engine.diagnose(input, "diagnosis-1111");
    await waitFor(
      async () => (await engine.diagnosis(d.id)).status === "completed",
    );
    expect(d.conversationId).not.toBe(task.id);
    expect((await engine.board()).tasks[d.conversationId]).toBeUndefined();
    expect((await engine.task(task.id)).status).toBe("draft");
    await expect(readFile(join(dir, "unauthorized"))).rejects.toThrow();
    expect(calls).toHaveLength(1);
    expect(calls[0].path).toBe("/internal/plugins/monitor/tools/read_health");
    expect(calls[0].body).toMatchObject({
      readOnly: true,
      resourceId: "nas",
      input: { resourceId: "nas" },
    });
    expect(calls[0].body._idempotencyKey).toMatch(/^pi-tool:/);
    expect((await engine.diagnosis(d.id)).summary).toContain("未执行修复");
    expect((await engine.diagnose(input, "diagnosis-1111")).id).toBe(d.id);
    await expect(
      engine.diagnose({ ...input, resourceId: "notes" }, "diagnosis-1111"),
    ).rejects.toMatchObject({ status: 409 });
    const conversation = (await engine.harness.conversation(
      Number(d.conversationId) as never,
      context,
    ))!;
    expect(
      (await conversation.agent(context)).tools.map((t) => t.name),
    ).toEqual(["platform_observe", "platform_read_tool"]);
  });

  it("preserves completed diagnosis and idempotency after SQLite reopen", async () => {
    const dir = await mkdtemp(join(tmpdir(), "refbox-diagnosis-"));
    dirs.push(dir);
    const db = join(dir, "state.sqlite");
    const faux = fauxProvider();
    const models = createModels();
    models.setProvider(faux.provider);
    const first = await new Engine(
      models,
      faux.getModel().id,
      faux.provider.id,
    ).open(await openNodeSqliteStorage(db));
    faux.setResponses([
      fauxAssistantMessage([fauxText("仅基于初始观察，证据不足。")]),
    ]);
    const input = {
      incidentId: "incident-1",
      resourceId: "service-1",
      version: "v1",
      environmentId: "home",
      observations: { healthy: false },
    };
    const diagnosis = await first.diagnose(input, "persistent-diagnosis-1");
    await waitFor(
      async () => (await first.diagnosis(diagnosis.id)).status === "completed",
    );
    await first.close();
    const second = await new Engine(
      models,
      faux.getModel().id,
      faux.provider.id,
    ).open(await openNodeSqliteStorage(db));
    engines.push(second);
    expect((await second.diagnosis(diagnosis.id)).summary).toBe(
      "仅基于初始观察，证据不足。",
    );
    expect((await second.diagnose(input, "persistent-diagnosis-1")).id).toBe(
      diagnosis.id,
    );
    expect((await second.readiness()).activeRuns).toBe(0);
    expect(Object.values((await second.board()).tasks)).toHaveLength(0);
  });
});
