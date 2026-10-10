import { test, expect as baseExpect } from "@playwright/test";
import { readFile, mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { createHash } from "node:crypto";
import type { Task, GoalReview } from "../src/types";

const expect = baseExpect.configure({ timeout: 20_000 });
const ids = (process.env.REFBOX_GOAL_TEST_IDS ?? "")
  .split(",")
  .map((value) => value.trim())
  .filter(Boolean);
test.skip(
  !process.env.REFBOX_LIVE_TEST || !ids.length,
  "explicit existing goal IDs and live opt-in required; this test never creates or finishes a goal",
);

test("live deployment: autonomous goals expose shared contracts and actual independent proof", async ({
  page,
}) => {
  test.setTimeout(180_000);
  const root = resolve(import.meta.dirname, "../../..");
  const password =
    process.env.REFBOX_TEST_PASSWORD ??
    (
      await readFile(resolve(root, "var/bootstrap-password.txt"), "utf8")
    ).trim();
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  const writes: string[] = [];
  page.on("request", (request) => {
    if (
      request.method() === "POST" &&
      !["/api/login", "/api/logout"].includes(new URL(request.url()).pathname)
    )
      writes.push(new URL(request.url()).pathname);
  });
  await mkdir(resolve(root, "var/screenshots"), { recursive: true });
  await page.goto("/");
  await page.getByLabel("管理员密码").fill(password);
  await page.getByLabel("管理员密码").press("Enter");
  await expect(page.getByTestId("platform-shell")).toBeVisible();
  await page.getByRole("button", { name: "长期任务", exact: true }).click();
  const evidence: Record<string, unknown>[] = [];
  for (const [index, id] of ids.entries()) {
    expect(/^[a-zA-Z0-9_-]+$/.test(id)).toBe(true);
    const response = await page.request.get(
      `/api/platform/tasks/${encodeURIComponent(id)}`,
    );
    expect(response.status()).toBe(200);
    const task = (await response.json()) as Task;
    expect(task.id).toBe(id);
    expect(task.goalLoop).toBeTruthy();
    const loop = task.goalLoop!,
      contract = loop.contract!;
    expect(contract).toBeTruthy();
    expect(contract.goal).toBe(task.goal);
    expect(contract.hash).toBe(
      createHash("sha256")
        .update(contract.definitionJson, "utf8")
        .digest("hex"),
    );
    expect(contract.reviewConversationId).toBeTruthy();
    const expectedPass = (process.env.REFBOX_GOAL_TEST_PASS_IDS ?? ids[0])
      .split(",")
      .includes(id);
    if (expectedPass) {
      expect(loop.phase).toBe("completed");
      expect(task.businessStatus).toBe("done");
      expect(task.verificationStatus).toBe("pass");
    }
    const reviews = loop.reviews ?? [];
    if (loop.phase === "completed") {
      const pass = reviews
        .filter((review) => review.verdict === "pass" && review.candidateId)
        .at(-1);
      expect(pass).toBeTruthy();
      expect(pass!.contractHash).toBe(contract.hash);
      expect(pass!.reviewConversationId).toBeTruthy();
      const checks =
        pass!.checks ??
        (pass!.evidence && typeof pass!.evidence === "object"
          ? (pass!.evidence as Record<string, unknown>).checks
          : undefined);
      expect(Array.isArray(checks) && checks.length > 0).toBe(true);
    } else {
      expect(task.businessStatus).not.toBe("done");
      expect(task.verificationStatus).not.toBe("pass");
    }
    await page
      .locator(".task-card")
      .filter({ has: page.getByText(task.goal, { exact: true }) })
      .click();
    const dialog = page.getByRole("dialog", { name: "任务详情" });
    await expect(
      dialog.getByText(contract.criteria, { exact: true }),
    ).toBeVisible();
    await expect(dialog.getByLabel("执行检查命令")).toHaveCount(0);
    await expect(dialog.getByLabel("验收依据")).toHaveCount(0);
    await expect(
      dialog.getByRole("button", { name: "确认标准并开始执行" }),
    ).toHaveCount(0);
    await dialog.getByText("查看独立审查与标准溯源", { exact: true }).click();
    await expect(
      dialog.getByText(contract.hash, { exact: true }),
    ).toBeVisible();
    await expect(
      dialog.getByText(contract.reviewConversationId, { exact: true }),
    ).toBeVisible();
    await dialog
      .getByRole("button", { name: "成果与独立证明", exact: true })
      .click();
    expect(reviews.length).toBeGreaterThan(0);
    for (const review of reviews)
      await expect(
        dialog.getByText(review.summary, { exact: true }).first(),
      ).toBeVisible();
    const latest = reviews.at(-1) as GoalReview;
    const proofCard = dialog.locator(".goal-reviews .section-card").first();
    await proofCard.getByText("查看实际检查与证明", { exact: true }).click();
    await expect(
      proofCard.getByText(latest.reviewConversationId, { exact: true }),
    ).toBeVisible();
    if (latest.candidateId)
      await expect(
        proofCard.getByText(latest.candidateId, { exact: true }),
      ).toBeVisible();
    await expect(proofCard.locator("pre").first()).toBeVisible();
    await page.setViewportSize({ width: 1440, height: 1000 });
    await dialog.evaluate((element) => {
      element.scrollTop = 0;
    });
    await page.screenshot({
      path: resolve(root, `var/screenshots/live-goal-${index + 1}-desktop.png`),
      animations: "disabled",
    });
    await page.setViewportSize({ width: 375, height: 844 });
    expect(
      await dialog.evaluate(
        (element) => element.scrollWidth <= element.clientWidth,
      ),
    ).toBe(true);
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= innerWidth,
      ),
    ).toBe(true);
    await dialog.evaluate((element) => {
      element.scrollTop = 0;
    });
    await page.screenshot({
      path: resolve(root, `var/screenshots/live-goal-${index + 1}-mobile.png`),
      animations: "disabled",
    });
    await page.getByRole("button", { name: "关闭任务详情" }).press("Escape");
    await expect(dialog).toHaveCount(0);
    evidence.push({
      id: task.id,
      goal: task.goal,
      businessStatus: task.businessStatus,
      verificationStatus: task.verificationStatus,
      goalLoop: loop,
    });
    await page.setViewportSize({ width: 1440, height: 1000 });
  }
  await page
    .getByRole("button", { name: /Homelab/ })
    .first()
    .click();
  await expect(
    page.getByRole("heading", { name: "Homelab", exact: true }),
  ).toBeVisible();
  await page.getByRole("button", { name: "退出登录", exact: true }).click();
  await expect(page.getByLabel("管理员密码")).toBeVisible();
  expect(errors).toEqual([]);
  expect(writes).toEqual([]);
  await writeFile(
    resolve(root, "var/screenshots/live-goal-acceptance.json"),
    JSON.stringify(
      {
        at: new Date().toISOString(),
        url: process.env.REFBOX_TEST_URL,
        tasks: evidence,
        javascriptErrors: errors,
        goalWrites: writes,
      },
      null,
      2,
    ),
  );
});
