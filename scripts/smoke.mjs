import { mkdir } from "node:fs/promises";
import { resolve } from "node:path";
process.chdir(resolve(import.meta.dirname, ".."));
process.loadEnvFile(".env");
await mkdir("var/acceptance", { recursive: true });
const headers = {
  Authorization: "Bearer " + process.env.REFBOX_ENGINE_TOKEN,
  "Content-Type": "application/json",
};
const call = async (path, body, key) => {
  const response = await fetch(
    (process.env.REFBOX_ENGINE_URL ?? "http://127.0.0.1:8801") + "/api" + path,
    {
      method: body ? "POST" : "GET",
      headers: { ...headers, "Idempotency-Key": key ?? "" },
      ...(body ? { body: JSON.stringify(body) } : {}),
    },
  );
  const value = await response.json();
  if (!response.ok) throw new Error(value.error ?? "执行服务请求失败");
  return value;
};
const existing = (await call("/tasks")).find(
  (t) =>
    t.title === "验收：后台执行与成果验证" &&
    t.cwd === resolve("var/acceptance"),
);
const task =
  existing ??
  (await call(
    "/tasks",
    {
      title: "验收：后台执行与成果验证",
      goal: '只在指定工作目录中生成 result.txt，内容为 REFBOX_VERIFIED。先制定计划，不执行命令；计划须使用 test "$(cat result.txt)" = REFBOX_VERIFIED 验证。执行时记录一条实验并登记 result.txt，最后调用 verify_result。不要操作其他文件或服务。',
      cwd: resolve("var/acceptance"),
      model: process.env.REFBOX_MODEL ?? "kimi-k3",
    },
    "refbox-smoke-create-v1",
  ));
if (task.status === "draft")
  await call("/tasks/" + task.id + "/plan", {}, "refbox-smoke-plan-v1");
console.log("验收任务已准备，请在控制台确认后执行，或运行 npm run test:ui。");
