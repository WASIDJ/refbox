import { test, expect, type Page } from "@playwright/test";
import { createServer, type ServerResponse } from "node:http";
import { readFile } from "node:fs/promises";
import { extname, resolve, sep } from "node:path";
import type { Socket } from "node:net";

const dist = resolve(
  process.env.REFBOX_POLLING_TEST_DIST ??
    resolve(import.meta.dirname, "../dist"),
);
const evidence = `Evidence start\n${"Complete independent witness\n".repeat(4000)}Evidence end`;
const at = new Date().toISOString();
const task = {
  id: "slow-goal",
  conversationId: "native-slow-goal",
  title: "查看完整验证记录",
  goal: "验证慢响应不会累积或阻止退出",
  cwd: "/isolated/slow-goal",
  model: "kimi-k3",
  businessStatus: "done",
  executionStatus: "awaiting_verification",
  verificationStatus: "pass",
  createdAt: at,
  updatedAt: at,
  legacyVerified: false,
  engineAvailable: true,
  goalLoop: {
    phase: "completed",
    rounds: 1,
    maxRounds: 6,
    reason: "实际成果通过独立验证",
    reviews: [],
  },
};
const snapshot = {
  tasks: [task],
  plugins: [],
  resources: [],
  incidents: [],
  workers: [],
  evidence: [],
  events: [],
};
const nativeView = {
  task: {
    ...task,
    id: task.conversationId,
    status: "awaiting_verification",
    plan: null,
    approvedPlan: null,
    reason: "",
    verified: false,
    experiments: [],
    verifications: [],
    reports: [],
  },
  view: {
    entries: [
      {
        id: "complete-witness",
        kind: "model",
        model: [{ role: "assistant", content: evidence }],
      },
    ],
    docs: {},
  },
};

// Use real HTTP responses rather than held Playwright routes. Closing an aborted
// response is then observable at the server, including a body still in flight.
async function slowServer(stallFirstLogout = false) {
  let authenticated = false;
  const sockets = new Set<Socket>();
  const pending = {
    snapshot: new Set<ServerResponse>(),
    view: new Set<ServerResponse>(),
    events: new Set<ServerResponse>(),
    logout: new Set<ServerResponse>(),
  };
  const logoutReceipts: string[] = [];
  const counts = { snapshot: 0, view: 0, logout: 0 };
  const peak = { snapshot: 0, view: 0 };
  const server = createServer(async (request, response) => {
    const path = new URL(request.url!, "http://localhost").pathname;
    const json = (body: unknown, status = 200) => {
      response.writeHead(status, { "Content-Type": "application/json" });
      response.end(JSON.stringify(body));
    };
    if (!path.startsWith("/api/")) {
      const file =
        path === "/" ? resolve(dist, "index.html") : resolve(dist, "." + path);
      if (!file.startsWith(dist + sep)) return response.writeHead(404).end();
      try {
        response.writeHead(200, {
          "Content-Type":
            extname(file) === ".js"
              ? "text/javascript"
              : extname(file) === ".css"
                ? "text/css"
                : "text/html",
        });
        response.end(await readFile(file));
      } catch {
        response.end();
      }
      return;
    }
    if (path === "/api/session") return json({ authenticated });
    if (path === "/api/login") {
      authenticated = true;
      return json({});
    }
    if (path === "/api/logout") {
      counts.logout++;
      logoutReceipts.push(String(request.headers["idempotency-key"]));
      authenticated = false;
      if (stallFirstLogout && counts.logout === 1) {
        pending.logout.add(response);
        response.on("close", () => pending.logout.delete(response));
        response.writeHead(200, { "Content-Type": "application/json" });
        response.write('{"ok":');
        return;
      }
      return json({});
    }
    if (!authenticated) return json({ error: "请登录" }, 401);
    if (path === "/api/models")
      return json([{ id: "kimi-k3", name: "Kimi K3" }]);
    if (path === "/api/platform/events") {
      pending.events.add(response);
      response.on("close", () => pending.events.delete(response));
      response.writeHead(200, { "Content-Type": "text/event-stream" });
      // Keep the connection open without a snapshot event: polling is the
      // fallback when the streaming transport has not delivered state.
      response.write(": waiting for snapshot\n\n");
      return;
    }
    const endpoint =
      path === "/api/platform/snapshot"
        ? "snapshot"
        : path === "/api/platform/tasks/slow-goal/view"
          ? "view"
          : null;
    if (endpoint) {
      counts[endpoint]++;
      const body = endpoint === "snapshot" ? snapshot : nativeView;
      if (counts[endpoint] === 1) return json(body);
      pending[endpoint].add(response);
      peak[endpoint] = Math.max(peak[endpoint], pending[endpoint].size);
      response.on("close", () => pending[endpoint].delete(response));
      response.writeHead(200, { "Content-Type": "application/json" });
      // Deliver headers and the beginning of the actual complete JSON body.
      // The remaining body waits until the user navigates away or releases it.
      response.write(JSON.stringify(body).slice(0, 24));
      return;
    }
    json({ error: "unexpected route" }, 404);
  });
  server.on("connection", (socket) => {
    sockets.add(socket);
    socket.on("close", () => sockets.delete(socket));
  });
  await new Promise<void>((ready) => server.listen(0, "127.0.0.1", ready));
  const address = server.address();
  if (!address || typeof address === "string")
    throw new Error("test server did not bind");
  return {
    url: `http://127.0.0.1:${address.port}`,
    pending,
    counts,
    peak,
    logoutReceipts,
    patch(fields: Record<string, unknown>) {
      for (const response of pending.events)
        response.write(
          `event: snapshot_patch\ndata: ${JSON.stringify(fields)}\n\n`,
        );
    },
    release() {
      for (const endpoint of ["snapshot", "view"] as const) {
        const body = JSON.stringify(
          endpoint === "snapshot" ? snapshot : nativeView,
        );
        for (const response of pending[endpoint]) response.end(body.slice(24));
      }
    },
    async close() {
      for (const socket of sockets) socket.destroy();
      await new Promise<void>((done, reject) =>
        server.close((error) => (error ? reject(error) : done())),
      );
    },
  };
}

async function openCompleteEvidence(page: Page, url: string) {
  await page.clock.install();
  await page.goto(url);
  await page.getByLabel("管理员密码").fill("app-password");
  await page.getByLabel("管理员密码").press("Enter");
  await expect(page.getByTestId("platform-shell")).toBeVisible();
  await page.getByRole("button", { name: "长期任务", exact: true }).click();
  await page.getByRole("button", { name: /查看完整验证记录/ }).click();
  const dialog = page.getByRole("dialog", { name: "任务详情" });
  await dialog.getByRole("button", { name: "运行过程", exact: true }).click();
  await expect(dialog.locator(".log-entry pre")).toHaveText(evidence);
  return dialog;
}

test("slow snapshot and native-view bodies have at most one outstanding read each", async ({
  page,
}) => {
  const server = await slowServer();
  try {
    await openCompleteEvidence(page, server.url);
    // Cross both real polling intervals while the server holds full response
    // bodies. Advancing the browser clock avoids a 35-second wall-clock sleep.
    await page.clock.runFor(35_000);
    await expect.poll(() => server.counts.snapshot).toBeGreaterThanOrEqual(2);
    await expect.poll(() => server.counts.view).toBeGreaterThanOrEqual(2);
    expect(server.peak.snapshot).toBe(1);
    expect(server.peak.view).toBe(1);
    expect(server.counts.snapshot).toBe(2);
    expect(server.counts.view).toBe(2);
  } finally {
    server.release();
    await server.close();
  }
});

test("independently completed goal shows execution ended while preserving native self-check state", async ({
  page,
}) => {
  const server = await slowServer();
  try {
    const dialog = await openCompleteEvidence(page, server.url);
    await expect(
      dialog.locator(".state-triple").getByText("执行结束", { exact: true }),
    ).toBeVisible();
    await expect(
      dialog
        .locator(".state-triple")
        .getByText("等待独立验证", { exact: true }),
    ).toHaveCount(0);
    await dialog.getByRole("button", { name: "关闭任务详情" }).click();
    await expect(
      page
        .locator(".task-card .state-triple")
        .getByText("执行结束", { exact: true }),
    ).toBeVisible();
    expect(nativeView.task.status).toBe("awaiting_verification");
    expect(nativeView.task.verified).toBe(false);
  } finally {
    server.release();
    await server.close();
  }
});

test("stalled logout retries the same receipt and waits for server acknowledgement", async ({
  page,
}) => {
  const server = await slowServer(true);
  try {
    const dialog = await openCompleteEvidence(page, server.url);
    await dialog.getByRole("button", { name: "关闭任务详情" }).click();
    await page.getByRole("button", { name: "退出登录", exact: true }).click();
    await expect.poll(() => server.pending.logout.size).toBe(1);
    await expect(page.getByLabel("管理员密码")).toHaveCount(0);
    await page.clock.runFor(6000);
    await expect(page.getByLabel("管理员密码")).toBeVisible();
    expect(server.counts.logout).toBe(2);
    expect(server.logoutReceipts[0]).toBeTruthy();
    expect(server.logoutReceipts[1]).toBe(server.logoutReceipts[0]);
    await expect.poll(() => server.pending.logout.size).toBe(0);
  } finally {
    server.release();
    await server.close();
  }
});

test("incremental live state keeps complete evidence and replaces changed collections", async ({
  page,
}) => {
  const server = await slowServer();
  try {
    const dialog = await openCompleteEvidence(page, server.url);
    await expect.poll(() => server.pending.events.size).toBe(1);
    server.patch({
      resources: [
        {
          id: "nas",
          name: "家庭 NAS",
          kind: "machine",
          health: "healthy",
          sampledAt: at,
          failures: 0,
          healthySamples: 1,
          checks: [],
        },
      ],
    });
    await expect(dialog.locator(".log-entry pre")).toHaveText(evidence);
    await dialog.getByRole("button", { name: "关闭任务详情" }).click();
    await page.getByRole("button", { name: "Homelab", exact: true }).click();
    await expect(
      page.getByRole("heading", { name: "家庭 NAS", exact: true }),
    ).toBeVisible();
    server.patch({ resources: [] });
    await expect(
      page.getByRole("heading", { name: "家庭 NAS", exact: true }),
    ).toHaveCount(0);
    await page.getByRole("button", { name: "长期任务", exact: true }).click();
    await expect(page.locator(".task-card")).toHaveCount(1);
    server.patch({ tasks: [] });
    await expect(page.locator(".task-card")).toHaveCount(0);
  } finally {
    server.release();
    await server.close();
  }
});

test("closing slow evidence aborts its read and logout releases pending snapshot and stream", async ({
  page,
}) => {
  const server = await slowServer();
  try {
    const dialog = await openCompleteEvidence(page, server.url);
    // Allow the initial stream handshake grace, then enter the actual fallback
    // interval with both complete HTTP bodies still held by the server.
    await page.clock.runFor(31_000);
    await expect.poll(() => server.pending.view.size).toBeGreaterThan(0);
    await expect.poll(() => server.pending.snapshot.size).toBeGreaterThan(0);
    await expect.poll(() => server.pending.events.size).toBe(1);
    await dialog.getByRole("button", { name: "关闭任务详情" }).click();
    await expect(dialog).not.toBeVisible();
    await expect.poll(() => server.pending.view.size).toBe(0);
    await page.getByRole("button", { name: "退出登录", exact: true }).click();
    await expect(page.getByLabel("管理员密码")).toBeVisible();
    expect(server.counts.logout).toBe(1);
    await expect.poll(() => server.pending.snapshot.size).toBe(0);
    await expect.poll(() => server.pending.events.size).toBe(0);
    // Late responses must neither restore authenticated state nor surface an
    // abort error after leaving the dialog/session. Full evidence stays intact.
    server.release();
    await page.clock.runFor(35_000);
    await expect(page.getByTestId("platform-shell")).not.toBeVisible();
    await expect(page.getByRole("alert")).toHaveCount(0);
  } finally {
    server.release();
    await server.close();
  }
});
