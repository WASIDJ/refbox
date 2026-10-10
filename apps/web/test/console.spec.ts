import { test, expect as baseExpect } from "@playwright/test";
import { readFile, mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";

// Production acceptance is opt-in so a normal UI test run never changes a live task.
test.skip(
  !process.env.REFBOX_LIVE_TEST,
  "set REFBOX_LIVE_TEST=1 with REFBOX_TEST_URL for live acceptance",
);
// Production measurements showed ~6.6s for a successful status request and
// multi-second Cloudflare snapshot transfers. Keep strict assertions while
// allowing that observed latency; the mocked regression budget stays 8s.
const expect = baseExpect.configure({ timeout: 20_000 });
// Record edge/server failures without retaining request headers, cookies,
// login bodies, or a browser trace containing the administrator password.
test.beforeEach(async ({ page }, testInfo) => {
  const failures: {
    url: string;
    status: number;
    body: string;
    at: string;
    cfRay: string;
    responseMs: number;
  }[] = [];
  const requests = new Map<
    object,
    {
      url: string;
      method: string;
      startedAt: string;
      started: number;
      responseMs?: number;
      status?: number;
      completed?: boolean;
      completedMs?: number;
      failed?: string;
    }
  >();
  const pending: Promise<void>[] = [];
  page.on("request", (request) =>
    requests.set(request, {
      url: request.url(),
      method: request.method(),
      startedAt: new Date().toISOString(),
      started: Date.now(),
    }),
  );
  page.on("requestfinished", (request) => {
    const item = requests.get(request);
    if (item) {
      item.completed = true;
      item.completedMs = Date.now() - item.started;
    }
  });
  page.on("requestfailed", (request) => {
    const item = requests.get(request);
    if (item) item.failed = request.failure()?.errorText ?? "request failed";
  });
  page.on("response", (response) => {
    const item = requests.get(response.request());
    const responseMs = item ? Date.now() - item.started : 0;
    if (item) {
      item.responseMs = responseMs;
      item.status = response.status();
    }
    if (
      response.status() < 500 ||
      new URL(response.url()).pathname === "/api/login"
    )
      return;
    pending.push(
      (async () => {
        failures.push({
          url: response.url(),
          status: response.status(),
          at: new Date().toISOString(),
          cfRay: response.headers()["cf-ray"] ?? "",
          responseMs,
          body: (
            await response.text().catch(() => "response body unavailable")
          ).slice(0, 16000),
        });
      })(),
    );
  });
  page.on("close", () => void Promise.allSettled(pending));
  testInfo.annotations.push({
    type: "live-diagnostics",
    description:
      "HTTP >=500 response body capture; no authentication data or request body",
  });
  (
    testInfo as typeof testInfo & { liveFailures: () => Promise<unknown> }
  ).liveFailures = async () => {
    await Promise.allSettled(pending);
    return {
      failures,
      requests: [...requests.values()].map(({ started, ...item }) => ({
        ...item,
        elapsedMs: Date.now() - started,
      })),
    };
  };
});
test.afterEach(async ({}, testInfo) => {
  const diagnostics = (await (
    testInfo as typeof testInfo & { liveFailures?: () => Promise<unknown> }
  ).liveFailures?.()) as
    { failures: unknown[]; requests: unknown[] } | undefined;
  if (
    !diagnostics ||
    (testInfo.status === "passed" && !diagnostics.failures.length)
  )
    return;
  const root = resolve(import.meta.dirname, "../../..");
  await mkdir(resolve(root, "var/screenshots"), { recursive: true });
  const path = resolve(
    root,
    `var/screenshots/live-http-failures-${Date.now()}.json`,
  );
  await writeFile(
    path,
    JSON.stringify(
      {
        at: new Date().toISOString(),
        title: testInfo.title,
        status: testInfo.status,
        ...diagnostics,
      },
      null,
      2,
    ),
  );
  await testInfo.attach("live-http-failures", {
    path,
    contentType: "application/json",
  });
});
test("live deployment: login and inspect preserved native execution proof", async ({
  page,
}) => {
  test.setTimeout(120_000);
  const root = resolve(import.meta.dirname, "../../..");
  const password =
    process.env.REFBOX_TEST_PASSWORD ??
    (
      await readFile(resolve(root, "var/bootstrap-password.txt"), "utf8")
    ).trim();
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto("/");
  await page.getByLabel("管理员密码").fill(password);
  await page.getByLabel("管理员密码").press("Enter");
  await expect(page.getByTestId("platform-shell")).toBeVisible();
  await page.getByRole("button", { name: "长期任务", exact: true }).click();
  await page
    .locator(".task-card")
    .filter({
      hasText:
        process.env.REFBOX_TEST_TASK_TITLE ??
        "验收：root 常驻与 Tailscale HTTPS",
    })
    .click();
  const dialog = page.getByRole("dialog", { name: "任务详情" });
  await dialog.getByRole("button", { name: "实验与成果", exact: true }).click();
  await expect(dialog.getByText("退出码 0", { exact: true })).toBeVisible();
  await dialog
    .getByRole("button", {
      name: new RegExp(process.env.REFBOX_TEST_ARTIFACT ?? "root-proof.txt"),
    })
    .click();
  await expect(
    page.getByRole("dialog", { name: "产物内容" }).locator("pre"),
  ).toHaveText(process.env.REFBOX_TEST_EXPECTED ?? "ROOT_VERIFIED");
  expect(errors).toEqual([]);
});

test("live deployment: persisted business status, plugin data, keyboard and mobile paths", async ({
  page,
}) => {
  test.setTimeout(120_000);
  const root = resolve(import.meta.dirname, "../../..");
  const password =
    process.env.REFBOX_TEST_PASSWORD ??
    (
      await readFile(resolve(root, "var/bootstrap-password.txt"), "utf8")
    ).trim();
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  const stamp = new Date().toISOString();
  const title = `[验收] 看板状态与人工验收 ${stamp}`;
  const noteTitle = `[验收] 插件数据 ${stamp}`;
  const noteContent =
    "经真实 Cloudflare 界面写入，由插件独立 SQLite 保存；刷新后仍可读取。";
  await mkdir(resolve(root, "var/screenshots"), { recursive: true });
  expect((await page.request.get("/api/platform/snapshot")).status()).toBe(401);
  await page.goto("/");
  await page.getByLabel("管理员密码").fill(password);
  await page.getByLabel("管理员密码").press("Enter");
  await expect(page.getByTestId("platform-shell")).toBeVisible();
  await expect(page.locator(".resource-row").first()).toBeVisible();
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.screenshot({
    path: resolve(root, "var/screenshots/live-homelab-desktop.png"),
    animations: "disabled",
  });

  await page.getByRole("button", { name: "长期任务", exact: true }).click();
  await page.getByRole("button", { name: "新建目标", exact: true }).click();
  await page.getByLabel("目标名称").fill(title);
  await page
    .getByLabel("目标与背景")
    .fill(
      "只验收 Refbox 创建目标、修改状态、刷新持久化与人工验收。不要制定或执行 Agent 计划，不修改文件或系统服务。",
    );
  await page
    .getByLabel("工作目录")
    .fill("/Library/Application Support/refbox/var/workspaces");
  await expect(page.getByLabel("模型")).toHaveValue("kimi-k3");
  const createdResponse = page.waitForResponse(
    (response) =>
      response.url().endsWith("/api/platform/tasks") &&
      response.request().method() === "POST",
  );
  await page.getByRole("button", { name: "创建目标", exact: true }).click();
  const taskResponse = await createdResponse;
  expect(taskResponse.ok()).toBe(true);
  const created = await taskResponse.json();
  let dialog = page.getByRole("dialog", { name: "任务详情" });
  await expect(dialog).toBeVisible();
  await dialog.getByLabel("任务状态").selectOption("active");
  await dialog.getByRole("button", { name: "保存状态" }).click();
  await expect(dialog.locator(".badge.state-active")).toHaveText("进行中");
  await dialog.getByLabel("任务状态").selectOption("done");
  await dialog.getByRole("button", { name: "保存状态" }).click();
  await expect(dialog.getByRole("alert")).toHaveText(
    "独立验收尚未通过，不能标记完成；执行自检记录仍保留",
  );
  await page.reload();
  await expect(page.getByTestId("platform-shell")).toBeVisible();
  await page.getByRole("button", { name: "长期任务", exact: true }).click();
  await page.locator(".task-card").filter({ hasText: title }).click();
  dialog = page.getByRole("dialog", { name: "任务详情" });
  await expect(dialog.getByLabel("任务状态")).toHaveValue("active");
  await expect(dialog.locator(".badge.state-draft")).toBeVisible();
  await expect(dialog.locator(".badge.state-pending")).toBeVisible();
  await dialog.getByText("人工验收", { exact: true }).click();
  await dialog
    .getByLabel("验收依据")
    .fill(
      "真实浏览器已确认：状态保存后刷新仍为进行中；未验证的完成请求被拒绝；模型未启动，执行仍为草稿。此验收仅针对界面回归目标。",
    );
  await dialog.getByRole("button", { name: "确认人工验收" }).click();
  await expect(dialog.locator(".badge.state-manual")).toHaveText("人工验收");
  await expect(dialog.locator(".badge.state-done")).toHaveText("已完成");
  await page.getByRole("button", { name: "关闭任务详情" }).press("Escape");
  await expect(dialog).toHaveCount(0);

  await page.getByRole("button", { name: "插件管理", exact: true }).click();
  const scratchpad = page
    .locator(".plugin-card")
    .filter({ hasText: "个人随手记" });
  await scratchpad
    .getByRole("button", { name: "打开工作区", exact: true })
    .click();
  await expect(
    page
      .frameLocator("iframe")
      .getByRole("heading", { name: "个人随手记", exact: true }),
  ).toBeVisible();
  await expect(page.locator("iframe")).toHaveAttribute(
    "sandbox",
    "allow-scripts allow-forms",
  );
  await page.getByText("插件工具", { exact: false }).click();
  await page.getByLabel("选择工具").selectOption("create-note");
  await page
    .getByLabel("工具参数（JSON）")
    .fill(JSON.stringify({ title: noteTitle, content: noteContent }));
  await page.getByRole("button", { name: "执行工具", exact: true }).click();
  await expect(page.getByLabel("工具结果")).toContainText(noteTitle);
  await expect(
    page
      .frameLocator("iframe")
      .getByRole("heading", { name: noteTitle, exact: true }),
  ).toBeVisible();
  await page.getByLabel("选择工具").selectOption("list-notes");
  await page.getByLabel("工具参数（JSON）").fill("{}");
  const listedResponse = page.waitForResponse(
    (response) =>
      response
        .url()
        .endsWith("/api/platform/plugins/scratchpad/tools/list-notes") &&
      response.request().method() === "POST",
  );
  await page.getByRole("button", { name: "执行工具", exact: true }).click();
  expect((await listedResponse).ok()).toBe(true);
  await expect(page.getByLabel("工具结果")).toContainText('"notes"');
  await expect(page.getByLabel("工具结果")).toContainText(noteContent);
  const notes = JSON.parse((await page.getByLabel("工具结果").textContent())!)
    .notes as { id: string; title: string }[];
  const persistedNote = notes.find((note) => note.title === noteTitle);
  expect(persistedNote?.id).toBeTruthy();
  await page.reload();
  await expect(page.getByTestId("platform-shell")).toBeVisible();
  await page.getByRole("button", { name: "随手记", exact: true }).click();
  await expect(
    page
      .frameLocator("iframe")
      .getByRole("heading", { name: noteTitle, exact: true }),
  ).toBeVisible();
  await page.screenshot({
    path: resolve(root, "var/screenshots/live-plugin-desktop.png"),
    animations: "disabled",
  });
  for (const width of [1024, 768, 375]) {
    await page.setViewportSize({ width, height: 844 });
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= innerWidth,
      ),
    ).toBe(true);
    expect(
      await page
        .frameLocator("iframe")
        .locator("body")
        .evaluate(() => document.documentElement.scrollWidth <= innerWidth),
    ).toBe(true);
  }
  await page
    .getByRole("button", { name: /Homelab/ })
    .first()
    .click();
  await expect(
    page.getByRole("heading", { name: "Homelab", exact: true }),
  ).toBeVisible();
  await expect(
    page.getByRole("button", { name: "Homelab", exact: true }),
  ).toHaveAttribute("aria-current", "page");
  await page.screenshot({
    path: resolve(root, "var/screenshots/live-homelab-mobile.png"),
    animations: "disabled",
  });
  await page.getByRole("button", { name: "退出", exact: true }).click();
  await expect(page.getByLabel("管理员密码")).toBeVisible();
  expect((await page.request.get("/api/platform/snapshot")).status()).toBe(401);
  expect(errors).toEqual([]);
  await writeFile(
    resolve(root, "var/screenshots/live-ui-acceptance.json"),
    JSON.stringify(
      {
        at: new Date().toISOString(),
        url: process.env.REFBOX_TEST_URL,
        businessTaskId: created.id,
        title,
        noteTitle,
        noteId: persistedNote!.id,
        noteCount: notes.length,
        checks: [
          "keyboard-login",
          "real-resource-table",
          "default-model-kimi-k3",
          "status-persisted-after-reload",
          "unverified-done-rejected",
          "manual-acceptance-separated",
          "plugin-write-read-reload",
          "mobile-no-overflow",
          "logout",
        ],
        javascriptErrors: errors,
      },
      null,
      2,
    ),
  );
});
