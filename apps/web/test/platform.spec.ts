import { test, expect, type Page } from "@playwright/test";
import { readFile, mkdir } from "node:fs/promises";
import { resolve, extname, sep } from "node:path";

const root = resolve(import.meta.dirname, "../../..");
const dist = resolve(root, "apps/web/dist");
const now = new Date().toISOString();
const earlier = new Date(Date.now() - 90_000).toISOString();
const baseTask = {
  id: "task-opaque",
  conversationId: "32",
  title: "生成本月报告",
  goal: "生成报告并保留检查证据",
  cwd: "/tmp/work",
  model: "kimi-k3",
  businessStatus: "attention",
  executionStatus: "stopped",
  verificationStatus: "pending",
  createdAt: now,
  updatedAt: now,
  legacyVerified: true,
  engineAvailable: true,
};
const plan = {
  steps: "读取数据，生成报告",
  criteria: "报告包含三项统计",
  verificationCommand: "test -s report.txt",
};
const legacy = {
  id: "32",
  title: baseTask.title,
  goal: baseTask.goal,
  cwd: baseTask.cwd,
  model: "kimi-k3",
  status: "stopped",
  plan,
  approvedPlan: plan,
  reason: "等待用户继续",
  verified: true,
  experiments: [
    {
      id: "experiment-1",
      at: now,
      hypothesis: "统计可用于月度报告",
      conclusion: "已生成报告",
      artifacts: ["report.txt"],
      evidenceEntries: ["entry-1"],
    },
  ],
  verifications: [
    {
      at: now,
      command: plan.verificationCommand,
      exitCode: 0,
      output: "report exists",
      summary: "报告文件存在",
    },
  ],
  reports: [] as { date: string; at: string; markdown: string }[],
};
const manifest = {
  schemaVersion: 1,
  resources: [],
  tools: [
    {
      id: "add",
      name: "添加便笺",
      description: "添加一条个人便笺",
      path: "/notes",
      mutates: true,
    },
  ],
  events: ["note-added"],
  verification: { checks: ["notes-persisted"] },
};
const initial = {
  plugins: [
    {
      id: "scratchpad",
      name: "个人便笺",
      version: "1.0.0",
      description: "独立持久化的个人便笺",
      workspace: { title: "便笺工作区", path: "/workspace" },
      enabled: true,
      online: true,
      error: "",
      manifestUrl: "http://127.0.0.1:18804/manifest",
      manifest,
    },
    {
      id: "offline-domain",
      name: "离线业务",
      version: "1.0.0",
      description: "保留注册记录",
      workspace: { title: "离线工作区", path: "/workspace" },
      enabled: false,
      online: false,
      error: "connection refused",
      manifestUrl: "http://127.0.0.1:19999/manifest",
      manifest: { ...manifest, tools: [] },
    },
  ],
  resources: [
    {
      id: "runtime",
      pluginId: "monitor",
      name: "Agent 执行服务",
      kind: "service",
      serviceId: "engine",
      version: "1.0.0",
      environmentId: "mac-mini",
      health: "stale",
      sampledAt: earlier,
      method: "HTTP JSON 业务探针",
      detail: "上一份健康样本已经过期",
      failures: 0,
      healthySamples: 3,
      restartAllowed: true,
      checks: [],
    },
  ],
  incidents: [
    {
      id: "incident-1",
      resourceId: "runtime",
      status: "attention",
      openedAt: earlier,
      updatedAt: now,
      attempts: 2,
      actionId: "action-2",
      reason: "两次重启后仍需排查",
      diagnosisId: "diagnosis-9",
      diagnosisStatus: "completed",
      diagnosisSummary:
        "进程有响应，但用户工作台未正常加载；先检查路由和静态资源。",
      verification: "inconclusive",
      version: "1.0.0",
      environmentId: "mac-mini",
    },
  ],
  tasks: [baseTask],
  workers: [
    {
      id: "monitor-1",
      role: "monitor",
      status: "online",
      lastSeen: now,
      detail: "独立采集，15 秒一次",
    },
    {
      id: "executor-1",
      role: "executor",
      status: "offline",
      lastSeen: earlier,
      detail: "执行服务未就绪",
    },
  ],
  evidence: [
    {
      id: "evidence-1",
      incidentId: "incident-1",
      resourceId: "runtime",
      actionId: "action-2",
      version: "1.0.0",
      environmentId: "mac-mini",
      at: now,
      verdict: "inconclusive",
      summary: "仅 HTTP 200，业务检查尚无结果",
      checks: [
        {
          id: "user-route",
          url: "https://refbox.example.test",
          passed: false,
          detail: "界面未呈现工作台",
          sampledAt: now,
          witness: {
            navigationStatus: 200,
            visible: false,
            finalUrl: "https://refbox.example.test",
            selector: "main",
          },
        },
      ],
      reviewConversationId: "review-7",
      review: "缺少用户实际路径证据，保留事件。",
    },
  ],
  events: [
    {
      id: "event-1",
      at: now,
      kind: "attention",
      resourceId: "runtime",
      incidentId: "incident-1",
      message: "重启次数已用完，等待处理",
    },
  ],
};

type Mock = {
  state: typeof initial;
  legacy: typeof legacy;
  calls: { path: string; body: Record<string, unknown> }[];
};
async function installMock(page: Page): Promise<Mock> {
  const mock: Mock = {
    state: structuredClone(initial),
    legacy: structuredClone(legacy),
    calls: [],
  };
  let authenticated = false;
  await page.route("https://refbox.test/**", async (route) => {
    const request = route.request(),
      path = new URL(request.url()).pathname;
    const json = (body: unknown, status = 200) =>
      route.fulfill({
        status,
        contentType: "application/json",
        body: JSON.stringify(body),
      });
    if (!path.startsWith("/api/")) {
      const file =
        path === "/" ? resolve(dist, "index.html") : resolve(dist, "." + path);
      if (!file.startsWith(dist + sep)) return route.fulfill({ status: 404 });
      const type =
        extname(file) === ".js"
          ? "text/javascript"
          : extname(file) === ".css"
            ? "text/css"
            : "text/html; charset=utf-8";
      return route.fulfill({ contentType: type, body: await readFile(file) });
    }
    if (path === "/api/session") return json({ authenticated });
    if (path === "/api/login") {
      authenticated = request.postDataJSON().password === "app-password";
      return json(
        authenticated ? {} : { error: "管理员密码错误" },
        authenticated ? 200 : 401,
      );
    }
    if (!authenticated) return json({ error: "请登录" }, 401);
    if (path === "/api/logout") {
      authenticated = false;
      return json({});
    }
    if (path === "/api/models")
      return json([{ id: "kimi-k3", name: "Kimi K3" }]);
    if (path === "/api/platform/snapshot") return json(mock.state);
    if (path === "/api/platform/events")
      return route.fulfill({
        contentType: "text/event-stream",
        body: `event: snapshot\ndata: ${JSON.stringify(mock.state)}\n\n`,
      });
    if (path.endsWith("/proxy/workspace"))
      return route.fulfill({
        contentType: "text/html; charset=utf-8",
        body: "<!doctype html><html lang='zh-CN'><body><h1>个人便笺服务</h1><p>业务数据由独立服务保留。</p></body></html>",
      });
    if (request.method() === "POST") {
      const body = request.postDataJSON() as Record<string, unknown>;
      mock.calls.push({ path, body });
      if (path.endsWith("/status")) {
        if (
          body.status === "done" &&
          !["pass", "manual"].includes(mock.state.tasks[0].verificationStatus)
        )
          return json({ error: "完成需要独立验证或人工验收" }, 409);
        mock.state.tasks[0].businessStatus = String(body.status);
        return json(mock.state.tasks[0]);
      }
      if (path.endsWith("/accept")) {
        mock.state.tasks[0].businessStatus = "done";
        mock.state.tasks[0].verificationStatus = "manual";
        return json(mock.state.tasks[0]);
      }
      if (path.endsWith("/continue") || path.endsWith("/approve")) {
        mock.legacy.status = "running";
        mock.state.tasks[0].executionStatus = "running";
        mock.legacy.reason = "";
        return json({});
      }
      if (path.endsWith("/stop")) {
        mock.legacy.status = "stopped";
        mock.state.tasks[0].executionStatus = "stopped";
        return json({});
      }
      if (path.endsWith("/report")) {
        mock.legacy.reports = [
          {
            date: now.slice(0, 10),
            at: now,
            markdown: "实际产物：report.txt\n检查：文件存在",
          },
        ];
        return json({});
      }
      if (path.endsWith("/verify")) {
        mock.state.incidents[0].status = "closed";
        mock.state.incidents[0].verification = "pass";
        mock.state.evidence.push({
          ...mock.state.evidence[0],
          id: "evidence-2",
          verdict: "pass",
          summary: "三个健康样本及实际用户路径检查通过",
          checks: [
            {
              ...mock.state.evidence[0].checks[0],
              passed: true,
              detail: "工作台已呈现",
            },
          ],
        });
        return json({});
      }
      if (path.endsWith("/enable")) {
        const item = mock.state.plugins.find((candidate) =>
          path.includes(`/${candidate.id}/`),
        )!;
        item.enabled = !!body.enabled;
        return json(item);
      }
      if (path === "/api/platform/plugins") {
        if (!String(body.manifestUrl).includes("18804"))
          return json({ error: "插件不可达，无法读取能力清单" }, 502);
        return json(mock.state.plugins[0]);
      }
      if (path.endsWith("/tools/add"))
        return json({ id: "note-1", text: body.text });
      if (path === "/api/platform/tasks") {
        const added = {
          ...baseTask,
          ...body,
          id: "task-new",
          businessStatus: "backlog",
          executionStatus: "draft",
          verificationStatus: "pending",
          legacyVerified: false,
        };
        mock.state.tasks.push(added);
        return json(added);
      }
      return json({});
    }
    if (path.endsWith("/view"))
      return json({
        task: mock.legacy,
        view: {
          entries: [
            {
              id: "entry-1",
              kind: "model",
              model: [{ role: "assistant", content: "报告产物已保存" }],
            },
          ],
          docs: {},
        },
      });
    if (path.endsWith("/artifact"))
      return route.fulfill({
        contentType: "text/plain",
        body: "REFBOX_VERIFIED",
      });
    return json({ error: "unknown mock route" }, 404);
  });
  return mock;
}
async function login(page: Page) {
  await page.goto("https://refbox.test/");
  await page.getByLabel("管理员密码").fill("app-password");
  await page.getByLabel("管理员密码").press("Enter");
  await expect(page.getByTestId("platform-shell")).toBeVisible();
  await expect(
    page.getByRole("heading", { name: "Homelab", exact: true }),
  ).toBeVisible();
}

test("freshness, independent evidence and two-restart limit stay distinct", async ({
  page,
}) => {
  const mock = await installMock(page);
  await login(page);
  await expect(page.getByText("样本过期", { exact: true })).toBeVisible();
  await expect(
    page.getByText("HTTP JSON 业务探针", { exact: true }),
  ).toBeVisible();
  await expect(page.getByText("执行服务未就绪", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: /两次重启后仍需排查/ }).click();
  const dialog = page.getByRole("dialog", { name: "修复事件" });
  await expect(
    dialog.getByRole("button", { name: "重启服务并检查" }),
  ).toBeDisabled();
  await expect(
    dialog.getByText("已用完两次重启，需要你处理；Agent 仍可继续诊断。"),
  ).toBeVisible();
  await expect(dialog.getByText("仅 HTTP 200，业务检查尚无结果")).toBeVisible();
  await expect(dialog.getByText("诊断完成", { exact: true })).toBeVisible();
  await expect(
    dialog.getByText(
      "进程有响应，但用户工作台未正常加载；先检查路由和静态资源。",
    ),
  ).toBeVisible();
  await dialog.getByText("查看检查与溯源").click();
  await expect(dialog.getByText("界面未呈现工作台")).toBeVisible();
  await expect(dialog.getByText("review-7")).toBeVisible();
  await dialog.getByText("原始采样证据", { exact: true }).click();
  await expect(
    dialog.locator("pre").filter({ hasText: '"navigationStatus": 200' }),
  ).toBeVisible();
  await dialog.getByRole("button", { name: "重新验证" }).click();
  await expect(
    dialog.getByText("三个健康样本及实际用户路径检查通过"),
  ).toBeVisible();
  await expect(dialog.getByText("已恢复", { exact: true })).toBeVisible();
  expect(mock.calls.some((call) => call.path.endsWith("/repair"))).toBe(false);
});

test("business status errors surface and human acceptance preserves the proof distinction", async ({
  page,
}) => {
  const mock = await installMock(page);
  await login(page);
  await page.getByRole("button", { name: "长期任务", exact: true }).click();
  await page.getByRole("button", { name: /生成本月报告/ }).click();
  const dialog = page.getByRole("dialog", { name: "任务详情" });
  await dialog.getByLabel("任务状态").selectOption("done");
  await dialog.getByRole("button", { name: "保存状态" }).click();
  await expect(dialog.getByRole("alert")).toHaveText(
    "完成需要独立验证或人工验收",
  );
  await dialog.getByLabel("任务状态").selectOption("active");
  await dialog.getByRole("button", { name: "保存状态" }).click();
  await expect(dialog.locator(".badge.state-active")).toHaveText("进行中");
  await dialog.getByRole("button", { name: "继续已批准的任务" }).click();
  await expect(
    dialog.getByRole("button", { name: "停止当前执行" }),
  ).toBeVisible();
  await dialog.getByRole("button", { name: "停止当前执行" }).click();
  await dialog.getByRole("button", { name: "实验与成果", exact: true }).click();
  await dialog.getByRole("button", { name: "report.txt", exact: true }).click();
  await expect(
    page.getByRole("dialog", { name: "产物内容" }).locator("pre"),
  ).toHaveText("REFBOX_VERIFIED");
  await page.getByRole("button", { name: "关闭产物内容" }).click();
  await dialog.getByRole("button", { name: "汇报", exact: true }).click();
  await dialog.getByRole("button", { name: "保存今日汇报" }).click();
  await expect(dialog.getByText(/实际产物：report.txt/)).toBeVisible();
  await dialog.getByRole("button", { name: "目标与控制", exact: true }).click();
  await dialog.getByText("人工验收", { exact: true }).click();
  await dialog.getByLabel("验收依据").fill("亲自打开报告，确认包含三项统计。");
  await dialog.getByRole("button", { name: "确认人工验收" }).click();
  await expect(
    dialog.getByText("人工验收", { exact: true }).first(),
  ).toBeVisible();
  expect(mock.state.tasks[0].verificationStatus).toBe("manual");
  expect(
    mock.calls.find((call) => call.path.endsWith("/accept"))?.body.reason,
  ).toContain("三项统计");
});

test("acknowledged business status is visible while background snapshot refresh waits", async ({
  page,
}) => {
  const mock = await installMock(page);
  await login(page);
  await page.getByRole("button", { name: "长期任务", exact: true }).click();
  await page.getByRole("button", { name: /生成本月报告/ }).click();
  const dialog = page.getByRole("dialog", { name: "任务详情" });
  let release!: () => void;
  const blocked = new Promise<void>((resolve) => {
    release = resolve;
  });
  let refreshRequested = false;
  await page.route(
    "https://refbox.test/api/platform/snapshot",
    async (route) => {
      refreshRequested = true;
      await blocked;
      await route.fulfill({
        contentType: "application/json",
        body: JSON.stringify(mock.state),
      });
    },
  );
  try {
    await dialog.getByLabel("任务状态").selectOption("active");
    await dialog.getByRole("button", { name: "保存状态" }).click();
    await expect(dialog.locator(".badge.state-active")).toHaveText("进行中", {
      timeout: 1000,
    });
    expect(refreshRequested).toBe(true);
    expect(
      mock.calls.find((call) => call.path.endsWith("/status"))?.body,
    ).toEqual({ status: "active" });
  } finally {
    release();
  }
  await expect(dialog.getByText("正在提交请求…", { exact: true })).toHaveCount(
    0,
  );
});

test("plugins expose real workspaces and declared tools, with offline registration errors", async ({
  page,
}) => {
  const mock = await installMock(page);
  await login(page);
  await page.getByRole("button", { name: "插件管理", exact: true }).click();
  await expect(page.getByText("离线业务", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "注册插件", exact: true }).click();
  await page
    .getByLabel("Manifest 地址")
    .fill("http://127.0.0.1:19999/manifest");
  await page.getByRole("button", { name: "注册并读取能力" }).click();
  await expect(page.getByRole("alert")).toHaveText(
    "插件不可达，无法读取能力清单",
  );
  await page.getByRole("button", { name: "关闭注册插件" }).click();
  await page
    .getByRole("button", { name: "打开工作区", exact: true })
    .first()
    .click();
  await expect(
    page.frameLocator("iframe").getByRole("heading", { name: "个人便笺服务" }),
  ).toBeVisible();
  await expect(page.locator("iframe")).toHaveAttribute(
    "sandbox",
    "allow-scripts allow-forms",
  );
  await page.getByText("插件工具", { exact: false }).click();
  await page
    .getByLabel("工具参数（JSON）")
    .fill('{"text":"plugin-owned note"}');
  await page.getByRole("button", { name: "执行工具" }).click();
  await expect(page.getByLabel("工具结果")).toContainText("plugin-owned note");
  expect(
    mock.calls.find((call) => call.path.endsWith("/tools/add"))?.body,
  ).toEqual({ text: "plugin-owned note" });
});

test("keyboard login, default model, and responsive layouts have no horizontal overflow", async ({
  page,
}) => {
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await installMock(page);
  await login(page);
  await mkdir(resolve(root, "var/screenshots"), { recursive: true });
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.screenshot({
    path: resolve(root, "var/screenshots/platform-desktop.png"),
    fullPage: true,
  });
  for (const width of [1024, 768, 375]) {
    await page.setViewportSize({ width, height: 844 });
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= window.innerWidth,
      ),
    ).toBe(true);
  }
  await page.screenshot({
    path: resolve(root, "var/screenshots/platform-mobile.png"),
    fullPage: true,
  });
  await page.getByRole("button", { name: "长期任务", exact: true }).click();
  await page.getByRole("button", { name: "新建目标", exact: true }).click();
  await expect(page.getByLabel("模型")).toHaveValue("kimi-k3");
  await page.getByRole("button", { name: "关闭新建目标" }).press("Escape");
  await expect(page.getByRole("dialog", { name: "新建目标" })).toHaveCount(0);
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= window.innerWidth,
    ),
  ).toBe(true);
  expect(errors).toEqual([]);
});
