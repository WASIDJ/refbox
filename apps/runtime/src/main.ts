import { mkdir, open, unlink } from "node:fs/promises";
import { resolve, dirname } from "node:path";
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node";
import { Engine } from "./engine.js";
import { engyModels } from "./provider.js";
import { runtimeServer } from "./server.js";

const database = resolve(process.env.REFBOX_DATABASE ?? "var/refbox.sqlite");
await mkdir(dirname(database), { recursive: true, mode: 0o700 });
// Pi storage requires a single owner. Do not remove another live owner's lock.
const lockPath = database + ".lock";
try {
  const content = await import("node:fs/promises")
    .then((fs) => fs.readFile(lockPath, "utf8"))
    .catch(() => "");
  if (content) {
    const pid = Number(content);
    let alive = true;
    try {
      process.kill(pid, 0);
    } catch (e) {
      alive = (e as NodeJS.ErrnoException).code !== "ESRCH";
    }
    if (alive) throw new Error("数据库已有运行进程；请勿启动第二个执行服务");
    await unlink(lockPath);
  }
  const lock = await open(lockPath, "wx", 0o600);
  await lock.writeFile(String(process.pid));
  await lock.close();
} catch {
  console.error("无法独占数据库，请检查执行服务或锁文件。");
  process.exit(1);
}
let engine: Engine | undefined;
try {
  engine = await new Engine(
    await engyModels(),
    process.env.REFBOX_MODEL ?? "kimi-k3",
  ).open(await openNodeSqliteStorage(database));
  const server = runtimeServer(engine, process.env.REFBOX_ENGINE_TOKEN ?? "");
  const port = Number(process.env.REFBOX_ENGINE_PORT ?? 18801);
  server.listen(port, "127.0.0.1", () =>
    console.log(
      `refbox 执行服务：127.0.0.1:${port}，uid=${process.getuid?.()}`,
    ),
  );
  let closing = false;
  const stop = async () => {
    if (closing) return;
    closing = true;
    server.close();
    server.closeAllConnections();
    await engine!.close();
    await unlink(lockPath).catch(() => {});
    process.exit(0);
  };
  process.on("SIGINT", () => void stop());
  process.on("SIGTERM", () => void stop());
  server.on("error", () => {
    console.error("执行服务端口无法使用");
    void stop();
  });
} catch {
  console.error("执行服务启动失败，请检查 Pi 配置、数据库与内部接口配置。");
  await engine?.close().catch(() => {});
  await unlink(lockPath).catch(() => {});
  process.exit(1);
}
