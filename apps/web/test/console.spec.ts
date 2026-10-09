import { test, expect } from "@playwright/test";
import { readFile, mkdir } from "node:fs/promises";
import { resolve } from "node:path";

test("login, confirm the real acceptance task, inspect results and reports, and render mobile", async ({
  page,
}) => {
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
  await page.getByRole("button", { name: "进入 refbox →" }).click();
  await expect(page.getByText("工作空间已连接")).toBeVisible();
  await page
    .locator(".task-card")
    .filter({
      hasText: process.env.REFBOX_TEST_TASK_TITLE ?? "验收：后台执行与成果验证",
    })
    .click();
  const approve = page.getByRole("button", { name: "确认标准并开始执行 →" });
  if (await approve.isVisible()) await approve.click();
  await expect(page.locator(".drawer .tag")).toHaveText("已完成", {
    timeout: 55000,
  });
  await page.getByRole("button", { name: "实验与成果", exact: true }).click();
  await expect(page.getByText("退出码 0", { exact: true })).toBeVisible();
  const artifact = page
    .locator(".result-card .artifact")
    .filter({ hasText: process.env.REFBOX_TEST_ARTIFACT ?? "result.txt" });
  await expect(artifact).toBeVisible();
  await artifact.click();
  await expect(page.locator(".artifact-modal pre")).toHaveText(
    process.env.REFBOX_TEST_EXPECTED ?? "REFBOX_VERIFIED",
  );
  await page.getByRole("button", { name: "关闭产物" }).click();
  await page.getByRole("button", { name: "汇报", exact: true }).click();
  await page.getByRole("button", { name: "保存今日汇报" }).click();
  await expect(page.locator(".report-card")).toBeVisible();
  await page.getByRole("button", { name: "关闭任务详情" }).click();
  await expect(page.getByText("工作空间已连接")).toBeVisible();
  await page.setViewportSize({ width: 1440, height: 1000 });
  await mkdir(resolve(root, "var/screenshots"), { recursive: true });
  await page.screenshot({
    path: resolve(root, "var/screenshots/desktop.png"),
    fullPage: true,
  });
  await page.getByRole("button", { name: "＋ 新建目标" }).click();
  await expect(page.getByLabel("模型")).toHaveValue("kimi-k3");
  await page.getByRole("button", { name: "关闭新建窗口" }).click();
  await page.setViewportSize({ width: 390, height: 844 });
  await page.screenshot({
    path: resolve(root, "var/screenshots/mobile.png"),
    fullPage: true,
  });
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= window.innerWidth,
    ),
  ).toBe(true);
  await page.getByRole("button", { name: /服务入口/ }).click();
  await expect(page.getByText("为你的服务留一个入口")).toBeVisible();
  expect(errors).toEqual([]);
});
