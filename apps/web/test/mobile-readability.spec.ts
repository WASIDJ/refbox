import { test, expect, type Page } from "@playwright/test";
import { readFile } from "node:fs/promises";
import { resolve, extname, sep } from "node:path";
import type { Task } from "../src/types";

const root = resolve(import.meta.dirname, "../../..");
const dist = resolve(root, "apps/web/dist");
const now = new Date().toISOString();

// Long, realistic, unbroken text samples that must remain fully readable
// (no hiding, clipping, or truncation) on a 375px mobile viewport.
// These include long runs without any spaces, which reproduced the original
// overflow (dialog clientWidth 337 / scrollWidth 655+) before the fix.
const longGoal =
  "修复Refbox自主目标看板的手机可读性：" +
  "在真实375px视口中任务详情的长目标、长验收标准、contract hash、长独立审查原因必须完整可读且无横向溢出，" +
  "only-fix-necessary-frontend-layout-without-hiding-clipping-or-truncating-any-content-" +
  "and-preserve-the-desktop-experience-and-existing-services-while-adding-real-browser-regression-tests" +
  "g".repeat(200);
const longCriteria =
  "在真实Chromium375px视口中任务详情弹窗完整可读，dialog scrollWidth小于等于clientWidth，" +
  "document无横向溢出；桌面1440px下同样内容完整可读无溢出。" +
  "the-quick-brown-fox-jumps-over-the-lazy-dog-0123456789-".repeat(3) +
  "既有测试全部通过，不削弱任何既有测试、依赖与package.json。" +
  "c".repeat(300);
const longHash =
  "a1b2c3d4e5f60718293a4b5c6d7e8f90a1b2c3d4e5f60718293a4b5c6d7e8f90a1b2";
const longReviewSummary =
  "独立验证未通过：实际产物中缺少对真实375px视口的端到端回归测试，" +
  "existing-tests-only-cover-desktop-layouts-and-do-not-assert-dialog-scrollWidth-versus-clientWidth-" +
  "请补充真实浏览器回归测试并确认长文本在移动端完整可读且无横向溢出，" +
  "do-not-hide-clip-or-truncate-any-content-while-fixing-the-layout-".repeat(
    2,
  ) +
  "s".repeat(300);
const longCandidateId =
  "candidate-9f8e7d6c5b4a39281706f5e4d3c2b1a09876f5e4d3c2b1a0987654321fedcba";
const longReviewConversationId =
  "result-review-conversation-4f3a2b1c0d9e8f7a6b5c4d3e2f1a0b9c8d7e6f5a4b3c2d1e0f";
const longDefinitionJson =
  '{"version":1,"goal":"' +
  "x".repeat(400) +
  '","criteria":"' +
  "y".repeat(400) +
  '","checks":[{"id":"mobile-readability-regression","kind":"file_contains","path":"apps/web/test/mobile-readability.spec.ts","contains":"' +
  "z".repeat(300) +
  '"}]}';
const longEvidence = {
  checks: [
    {
      id: "dialog-overflow-" + "i".repeat(100),
      passed: false,
      detail:
        "dialog clientWidth 337 scrollWidth 655 in real Chromium 375px viewport; " +
        "horizontal-overflow-detected-on-long-unbroken-strings-".repeat(2) +
        "d".repeat(400),
      witness: {
        viewport: "375x844",
        scrollWidth: 655,
        clientWidth: 337,
        userAgent:
          "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15" +
          "u".repeat(200),
      },
    },
  ],
};

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

const initial = {
  plugins: [],
  resources: [],
  incidents: [],
  tasks: [baseTask as Task],
  workers: [],
  evidence: [],
  events: [],
};

const legacy = {
  id: "32",
  title: baseTask.title,
  goal: baseTask.goal,
  cwd: baseTask.cwd,
  model: "kimi-k3",
  status: "stopped",
  plan: null,
  approvedPlan: null,
  reason: "",
  verified: false,
  experiments: [],
  verifications: [],
  reports: [] as { date: string; at: string; markdown: string }[],
};

async function installMock(page: Page) {
  const state = structuredClone(initial);
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
    if (path === "/api/models") return json([{ id: "kimi-k3", name: "Kimi K3" }]);
    if (path === "/api/platform/snapshot") return json(state);
    if (path === "/api/platform/events")
      return route.fulfill({
        contentType: "text/event-stream",
        body: `event: snapshot\ndata: ${JSON.stringify(state)}\n\n`,
      });
    if (path.endsWith("/view"))
      return json({
        task: (() => {
          const auto = state.tasks.find(
            (task) => task.goalLoop && path.includes(`/${task.id}/`),
          );
          return auto
            ? {
                ...legacy,
                ...auto,
                id: auto.conversationId,
                status: auto.executionStatus,
              }
            : legacy;
        })(),
        view: { entries: [], docs: {} },
      });
    if (request.method() === "POST") return json({});
    return json({ error: "unknown mock route" }, 404);
  });
  return { state };
}

async function login(page: Page) {
  await page.goto("https://refbox.test/");
  await page.getByLabel("管理员密码").fill("app-password");
  await page.getByLabel("管理员密码").press("Enter");
  await expect(page.getByTestId("platform-shell")).toBeVisible();
}

function longTextTask(): Task {
  return {
    ...baseTask,
    id: "goal-long-text",
    conversationId: "native-long-text",
    title: "移动端长文本可读性回归",
    goal: longGoal,
    businessStatus: "active",
    executionStatus: "running",
    verificationStatus: "pending",
    legacyVerified: false,
    goalLoop: {
      phase: "executing",
      rounds: 2,
      maxRounds: 6,
      reason:
        "独立验证未通过，正在按反馈改进：" +
        "long-unbroken-reason-string-without-any-spaces-".repeat(3),
      contract: {
        version: 1,
        goal: longGoal,
        criteria: longCriteria,
        checks: [
          {
            id: "mobile-readability",
            kind: "file_contains",
            path: "apps/web/test/mobile-readability.spec.ts",
            contains:
              "very-long-contains-string-that-describes-the-expected-regression-test-content-".repeat(
                2,
              ),
          },
        ],
        definitionJson: longDefinitionJson,
        hash: longHash,
        reviewConversationId:
          "contract-review-conversation-1a2b3c4d5e6f708192a3b4c5d6e7f8091a2b3c4d",
        reviewedAt: now,
        summary:
          "独立审查已确认目标覆盖，验收标准固定。" +
          "additional-long-summary-text-without-spaces-".repeat(3),
      },
      reviews: [
        {
          at: now,
          verdict: "fail",
          summary: longReviewSummary,
          reviewConversationId: longReviewConversationId,
          contractHash: longHash,
          candidateId: longCandidateId,
          checks: [
            {
              id: "dialog-overflow",
              passed: false,
              detail:
                "dialog clientWidth 337 scrollWidth 655；" +
                "long-unbroken-detail-string-".repeat(4) +
                "e".repeat(300),
              witness: { scrollWidth: 655, clientWidth: 337 },
            },
          ],
          evidence: longEvidence,
        },
      ],
    },
  };
}

async function expectNoHorizontalOverflow(
  page: Page,
  dialog: ReturnType<Page["getByRole"]>,
) {
  expect(
    await dialog.evaluate(
      (element) => element.scrollWidth <= element.clientWidth,
    ),
  ).toBe(true);
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= window.innerWidth,
    ),
  ).toBe(true);
}

async function expectFullyReadable(locator: ReturnType<Page["getByText"]>) {
  await expect(locator).toBeVisible();
  expect(
    await locator.evaluate(
      (element) => element.scrollWidth <= element.clientWidth,
    ),
  ).toBe(true);
}

test("long goal, criteria, contract hash and review reasons stay fully readable without horizontal overflow at 375px and 1440px", async ({
  page,
}) => {
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  const { state } = await installMock(page);
  state.tasks.push(longTextTask());
  await login(page);

  await page.setViewportSize({ width: 375, height: 844 });
  await page.getByRole("button", { name: "长期任务", exact: true }).click();
  await page.locator(".task-card").filter({ hasText: "移动端长文本" }).click();
  const dialog = page.getByRole("dialog", { name: "任务详情" });
  await expect(dialog).toBeVisible();

  // Long goal in the detail title must be fully visible and not overflow.
  await expectFullyReadable(dialog.getByText(longGoal, { exact: true }));
  // Long criteria in the shared contract must be fully visible.
  await expectFullyReadable(dialog.getByText(longCriteria, { exact: true }));
  // Long independent review summary (fail feedback) must be fully visible.
  await expectFullyReadable(
    dialog.getByText(longReviewSummary, { exact: true }),
  );
  await expectNoHorizontalOverflow(page, dialog);

  // Contract provenance: 64-char hash and long review conversation id.
  await dialog.getByText("查看独立审查与标准溯源", { exact: true }).click();
  await expectFullyReadable(dialog.getByText(longHash, { exact: true }));
  await expectFullyReadable(
    dialog.getByText(
      "contract-review-conversation-1a2b3c4d5e6f708192a3b4c5d6e7f8091a2b3c4d",
      { exact: true },
    ),
  );
  // Long single-line definitionJson pre block must wrap, not overflow.
  const definitionPre = dialog.locator(".goal-contract pre");
  await expect(definitionPre).toBeVisible();
  expect(
    await definitionPre.evaluate(
      (element) => element.scrollWidth <= element.clientWidth,
    ),
  ).toBe(true);
  await expectNoHorizontalOverflow(page, dialog);

  // Results tab: long candidate id, long review conversation id, long evidence pre.
  await dialog
    .getByRole("button", { name: "成果与独立证明", exact: true })
    .click();
  await expectFullyReadable(
    dialog.getByText(longReviewSummary, { exact: true }).first(),
  );
  await dialog.getByText("查看实际检查与证明", { exact: true }).click();
  await expectFullyReadable(
    dialog.getByText(longCandidateId, { exact: true }),
  );
  await expectFullyReadable(
    dialog.getByText(longReviewConversationId, { exact: true }),
  );
  await expectFullyReadable(dialog.getByText(longHash, { exact: true }));
  const evidencePre = dialog.locator(".goal-reviews pre").last();
  await expect(evidencePre).toBeVisible();
  expect(
    await evidencePre.evaluate(
      (element) => element.scrollWidth <= element.clientWidth,
    ),
  ).toBe(true);
  await expectNoHorizontalOverflow(page, dialog);

  // Desktop experience must not regress: same content fully readable at 1440px.
  await page.setViewportSize({ width: 1440, height: 1000 });
  await expectFullyReadable(dialog.getByText(longGoal, { exact: true }));
  await expectFullyReadable(
    dialog.getByText(longReviewSummary, { exact: true }).first(),
  );
  await expectFullyReadable(
    dialog.getByText(longCandidateId, { exact: true }),
  );
  await expectNoHorizontalOverflow(page, dialog);

  expect(errors).toEqual([]);
});
