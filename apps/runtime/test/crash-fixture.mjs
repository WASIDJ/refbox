import {
  createModels,
  fauxProvider,
  fauxAssistantMessage,
  fauxToolCall,
} from "@earendil-works/pi-ai";
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node";
import { Engine } from "../dist/engine.js";
import { join } from "node:path";
const [mode, dir] = process.argv.slice(2);
const faux = fauxProvider();
const models = createModels();
models.setProvider(faux.provider);
const tool = (name, args) =>
  fauxAssistantMessage([fauxToolCall(name, args)], { stopReason: "toolUse" });
if (mode === "recover")
  faux.setResponses([
    tool("write", { path: "result.txt", content: "recovered" }),
    tool("verify_result", { summary: "在真实进程崩溃后恢复" }),
  ]);
const engine = await new Engine(
  models,
  faux.getModel().id,
  faux.provider.id,
).open(await openNodeSqliteStorage(join(dir, "crash.sqlite")));
if (mode === "crash") {
  const task = await engine.create(
    { title: "崩溃恢复", goal: "保留执行进度", cwd: dir },
    "crash-create-1234",
  );
  const plan = {
    steps: "执行",
    criteria: "文件存在",
    verificationCommand: "test -f result.txt",
  };
  await engine.update(task.id, (t) => {
    t.status = "awaiting_confirmation";
    t.plan = plan;
  });
  faux.setResponses([
    tool("bash", {
      command: "printf 'once\\n' >> attempts.txt; touch ready; sleep 4",
    }),
  ]);
  await engine.command(task.id, "approve", plan, "crash-approve-1234");
  setInterval(() => {}, 1000);
} else {
  for (let n = 0; n < 200; n++) {
    const tasks = Object.values((await engine.board()).tasks);
    if (tasks[0]?.status === "completed") {
      await engine.close();
      process.exit(0);
    }
    await new Promise((r) => setTimeout(r, 20));
  }
  console.error("恢复未完成");
  await engine.close();
  process.exit(1);
}
