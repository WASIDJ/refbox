import { afterEach, describe, expect, it } from "vitest";
import { mkdtemp, readFile, writeFile, rm } from "node:fs/promises";
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
import { Engine } from "../src/engine.js";
import { BoardDoc } from "../src/state.js";
import { BACKGROUND_CONTEXT as context } from "@earendil-works/chord/context";
import { runtimeServer } from "../src/server.js";

const engines: Engine[] = [];
const dirs: string[] = [];
afterEach(async () => {
  for (const engine of engines.splice(0)) await engine.close();
  for (const d of dirs.splice(0)) await rm(d, { recursive: true, force: true });
});
async function fixture(storage?: MemoryStorage) {
  const dir = await mkdtemp(join(tmpdir(), "refbox-test-"));
  dirs.push(dir);
  const faux = fauxProvider();
  const models = createModels();
  models.setProvider(faux.provider);
  const engine = await new Engine(
    models,
    faux.getModel().id,
    faux.provider.id,
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
    await new Promise<void>((resolve) =>
      server.listen(0, "127.0.0.1", resolve),
    );
    const addr = server.address();
    if (!addr || typeof addr === "string") throw Error("server");
    const url = `http://127.0.0.1:${addr.port}`;
    try {
      expect((await fetch(url + "/api/tasks")).status).toBe(401);
      await engine.create(
        { title: "断线后可见", goal: "保持状态", cwd: dir },
        "sse-task-123",
      );
      const abort = new AbortController();
      const res = await fetch(url + "/api/events", {
        headers: { Authorization: "Bearer " + token },
        signal: abort.signal,
      });
      const reader = res.body!.getReader();
      const first = await reader.read();
      expect(new TextDecoder().decode(first.value)).toContain("断线后可见");
      abort.abort();
    } finally {
      server.closeAllConnections();
      await new Promise<void>((r) => server.close(() => r()));
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
