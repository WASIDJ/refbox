import { DatabaseSync } from "node:sqlite";
import { mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import {
  authorized,
  body,
  html,
  HttpError,
  json,
  listen,
  page,
  requireToken,
  serviceServer,
} from "./lib/http.mjs";

/** A deliberately disposable service, never a launchctl wrapper or production action broker. */
export function createFaultFixture({
  database = ":memory:",
  token,
  mode = "recover",
  selfUrl = "http://127.0.0.1:18815",
}) {
  requireToken(token, "REFBOX_FAULT_TOKEN");
  if (database !== ":memory:")
    mkdirSync(dirname(resolve(database)), { recursive: true, mode: 0o700 });
  const db = new DatabaseSync(database);
  db.exec("CREATE TABLE IF NOT EXISTS boots(id INTEGER PRIMARY KEY,at TEXT);");
  db.prepare("INSERT INTO boots(at) VALUES(?)").run(new Date().toISOString());
  const bootCount = db
    .prepare("SELECT COUNT(*) AS count FROM boots")
    .get().count;
  let broken =
    mode === "always-broken" || (mode === "recover" && bootCount === 1);
  const manifest = {
    schemaVersion: 1,
    id: "controlled-fault",
    name: "可控故障验收服务",
    version: "1.0.0",
    description: "专门用于隔离验收；不执行生产基础设施命令。",
    workspace: { title: "受控业务", path: "/workspace" },
    resources: [
      {
        id: "controlled-service",
        name: "受控服务",
        kind: "service",
        serviceId: "fixture",
        version: "fixture-1",
        environmentId: "isolated-test",
        restartAllowed: true,
        checks: [
          {
            id: "business-ready",
            url: selfUrl + "/business",
            json: { path: "result", equals: "ready" },
          },
          {
            id: "real-workspace",
            url: selfUrl + "/workspace",
            contains: 'data-business-ready="true"',
          },
        ],
      },
    ],
    tools: [],
    events: [],
    verification: {
      checks: ["真实业务响应恢复", "真实工作区恢复", "重启次数有持久化记录"],
    },
  };
  const server = serviceServer(async (req, res) => {
    const path = new URL(req.url, "http://local").pathname;
    if (req.method === "GET" && path === "/health")
      return json(res, 200, { ok: true, processAlive: true, bootCount });
    if (req.method === "GET" && path === "/business")
      return json(res, 200, {
        ok: !broken,
        result: broken ? "broken" : "ready",
      });
    if (req.method === "GET" && path === "/workspace")
      return html(
        res,
        page(
          "受控业务服务",
          `<article data-business-ready="${!broken}">${broken ? "业务故障，进程依然存活且 HTTP 仍返回 200。" : "业务已恢复，固定功能断言可以实际通过。"}</article>`,
        ),
      );
    if (!authorized(req, token))
      throw new HttpError(401, "Disposable fixture token required");
    if (req.method === "GET" && path === "/manifest")
      return json(res, 200, manifest);
    if (req.method === "GET" && path === "/state")
      return json(res, 200, { broken, bootCount, mode });
    if (req.method === "POST" && path === "/admin/fault") {
      const input = await body(req);
      if (typeof input.broken !== "boolean")
        throw new HttpError(400, "broken must be boolean");
      broken = input.broken;
      return json(res, 200, { broken, bootCount });
    }
    throw new HttpError(404, "Fixture route not found");
  });
  return {
    server,
    manifest,
    bootCount,
    async close() {
      server.closeAllConnections();
      await new Promise((r) => server.close(r));
      db.close();
    },
  };
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(resolve(process.argv[1])).href
) {
  const port = Number(process.env.REFBOX_FAULT_PORT ?? 18815);
  const service = createFaultFixture({
    database:
      process.env.REFBOX_FAULT_DATABASE ?? "var/disposable-fault.sqlite",
    token: process.env.REFBOX_FAULT_TOKEN,
    mode: process.env.REFBOX_FAULT_MODE ?? "recover",
    selfUrl: `http://127.0.0.1:${port}`,
  });
  await listen(service.server, port);
  console.log(
    JSON.stringify({
      service: "controlled-fault",
      port,
      bootCount: service.bootCount,
    }),
  );
  let closing = false;
  const stop = async () => {
    if (closing) return;
    closing = true;
    await service.close();
    process.exit(0);
  };
  process.on("SIGTERM", () => void stop());
  process.on("SIGINT", () => void stop());
}
