import { test, expect } from "@playwright/test";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

// Production acceptance is opt-in so a normal UI test run never changes a live task.
test.skip(
  !process.env.REFBOX_LIVE_TEST,
  "set REFBOX_LIVE_TEST=1 with REFBOX_TEST_URL for live acceptance",
);
test("live deployment: login and inspect preserved native execution proof", async ({
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
