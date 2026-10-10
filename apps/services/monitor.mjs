import { DatabaseSync } from "node:sqlite";
import { mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import {
  hostname,
  platform,
  uptime,
  totalmem,
  freemem,
  loadavg,
} from "node:os";
import {
  authorized,
  json,
  html,
  page,
  escape,
  HttpError,
  listen,
  now,
  platformRequest,
  requireToken,
  serviceServer,
} from "./lib/http.mjs";
import { httpProbe } from "./lib/probes.mjs";

export function monitorManifest({
  selfUrl = "http://127.0.0.1:18811",
  engineUrl = "http://127.0.0.1:18801",
  controlUrl = "http://127.0.0.1:8080",
  tunnelMetricsUrl = "http://127.0.0.1:18803",
  publicUrl = "",
  environmentId = "macmini-local",
  resourceVersion = "2",
} = {}) {
  const deployed = publicUrl
    ? [
        {
          id: "deployed-control",
          url: new URL("/health", publicUrl).href,
          json: { path: "service", equals: "refbox-control" },
        },
        {
          id: "deployed-ui",
          url: new URL("/", publicUrl).href,
          browser: {
            selector: '[data-resource-id="refbox-engine"]',
            text: "Pi 执行服务",
            passwordEnv: "REFBOX_VERIFY_PASSWORD",
          },
        },
      ]
    : [
        {
          id: "local-ui",
          url: new URL("/", controlUrl).href,
          browser: {
            selector: '[data-resource-id="refbox-engine"]',
            text: "Pi 执行服务",
            passwordEnv: "REFBOX_VERIFY_PASSWORD",
          },
        },
      ];
  const resource = (id, name, kind, serviceId, checks, restartAllowed) => ({
    id,
    name,
    kind,
    serviceId,
    version: resourceVersion,
    environmentId,
    checks,
    restartAllowed,
  });
  return {
    schemaVersion: 1,
    id: "monitor",
    name: "家庭基础设施",
    version: "2.0.0",
    description:
      "独立采集 Mac mini 与注册服务状态，保存采样记录；基础设施诊断、行动与验证由平台编排。",
    workspace: { title: "Mac mini 采样", path: "/workspace" },
    resources: [
      resource(
        "macmini",
        "Mac mini",
        "machine",
        "",
        [
          {
            id: "machine",
            url: selfUrl + "/machine",
            json: { path: "ok", equals: true },
            credentialEnv: "REFBOX_MONITOR_TOKEN",
          },
        ],
        false,
      ),
      resource(
        "refbox-engine",
        "Pi 执行服务",
        "service",
        "engine",
        [
          {
            id: "pi-health",
            url: engineUrl + "/api/health",
            json: { path: "engine", equals: "pi-durable" },
            credentialEnv: "REFBOX_ENGINE_TOKEN",
          },
        ],
        true,
      ),
      resource(
        "refbox-control",
        "Refbox 控制层",
        "service",
        "control",
        [
          {
            id: "control-health",
            url: controlUrl + "/health",
            json: { path: "service", equals: "refbox-control" },
          },
          ...deployed,
        ],
        false,
      ),
      resource(
        "refbox-tunnel",
        "Cloudflare 入口",
        "service",
        "tunnel",
        [
          {
            id: "tunnel-connected",
            url: tunnelMetricsUrl + "/metrics",
            metric: { name: "cloudflared_tunnel_ha_connections", min: 1 },
          },
          ...deployed,
        ],
        true,
      ),
    ],
    tools: [
      {
        id: "samples",
        name: "读取采样",
        description: "读取独立采集器最近的采样记录。",
        path: "/samples",
        method: "GET",
        mutates: false,
      },
    ],
    events: ["observation.recorded", "collector.unavailable"],
    verification: {
      checks: [
        "固定功能断言",
        "至少 3 次连续健康采样",
        "独立模型复核",
        "用户访问路径实际浏览器验证",
      ],
    },
  };
}

export class MonitorCollector {
  constructor({
    database = ":memory:",
    platformUrl,
    platformToken,
    env = process.env,
    intervalMs = 15000,
    fetchImpl = fetch,
    onEvent = () => {},
  }) {
    if (database !== ":memory:")
      mkdirSync(dirname(resolve(database)), { recursive: true, mode: 0o700 });
    this.db = new DatabaseSync(database);
    this.db.exec(
      "PRAGMA journal_mode=WAL; CREATE TABLE IF NOT EXISTS samples(id INTEGER PRIMARY KEY,resource_id TEXT NOT NULL,sampled_at TEXT NOT NULL,payload TEXT NOT NULL);",
    );
    this.platformUrl = platformUrl;
    this.platformToken = requireToken(platformToken, "REFBOX_PLATFORM_TOKEN");
    this.env = env;
    this.intervalMs = intervalMs;
    this.fetchImpl = fetchImpl;
    this.onEvent = onEvent;
    this.running = false;
    this.detail = "等待首次采样";
    this.lastSeen = null;
  }
  async collect() {
    if (this.running) return;
    this.running = true;
    try {
      const result = await platformRequest(
        this.platformUrl,
        "/internal/resources",
        this.platformToken,
        {},
        this.fetchImpl,
      );
      const resources = Array.isArray(result) ? result : result.resources;
      if (!Array.isArray(resources))
        throw new Error("Platform resource list is invalid");
      for (const resource of resources) {
        if (resource.enabled === false) continue;
        const fixed = (resource.checks ?? []).filter((check) => !check.browser);
        const probes = await Promise.all(
          fixed.map((check) =>
            httpProbe(check, { env: this.env, fetchImpl: this.fetchImpl }),
          ),
        );
        const sampledAt = now();
        const observation = {
          resourceId: resource.id,
          sampledAt,
          method:
            [...new Set(probes.map((p) => p.method))].join("+") ||
            "unavailable",
          healthy: probes.length > 0 && probes.every((p) => p.passed),
          detail:
            probes.map((p) => `${p.id}: ${p.detail}`).join(" | ") ||
            "没有可用的固定功能探针",
          version: resource.version,
          environmentId: resource.environmentId,
        };
        this.db
          .prepare(
            "INSERT INTO samples(resource_id,sampled_at,payload) VALUES(?,?,?)",
          )
          .run(
            resource.id,
            sampledAt,
            JSON.stringify({ ...observation, checks: probes }),
          );
        this.db
          .prepare(
            "DELETE FROM samples WHERE id <= (SELECT COALESCE(MAX(id),0)-5000 FROM samples)",
          )
          .run();
        await platformRequest(
          this.platformUrl,
          "/internal/observations",
          this.platformToken,
          { method: "POST", body: JSON.stringify(observation) },
          this.fetchImpl,
        );
        this.onEvent("observation.recorded", observation);
      }
      this.lastSeen = now();
      this.detail = `已采集 ${resources.length} 个资源`;
      await platformRequest(
        this.platformUrl,
        "/internal/heartbeat",
        this.platformToken,
        {
          method: "POST",
          body: JSON.stringify({
            id: "monitor-local",
            role: "monitor",
            detail: this.detail,
          }),
        },
        this.fetchImpl,
      );
    } catch (err) {
      this.detail = "采集失败：" + err.message.slice(0, 300);
      this.onEvent("collector.unavailable", { at: now(), detail: this.detail });
    } finally {
      this.running = false;
    }
  }
  samples(resourceId) {
    const rows =
      resourceId === undefined
        ? this.db
            .prepare("SELECT payload FROM samples ORDER BY id DESC LIMIT 100")
            .all()
        : this.db
            .prepare(
              "SELECT payload FROM samples WHERE resource_id=? ORDER BY id DESC LIMIT 100",
            )
            .all(resourceId);
    return rows.map((row) => JSON.parse(row.payload));
  }
  start() {
    if (this.timer) return;
    void this.collect();
    this.timer = setInterval(() => void this.collect(), this.intervalMs);
  }
  async close() {
    clearInterval(this.timer);
    while (this.running) await new Promise((r) => setTimeout(r, 20));
    this.db.close();
  }
}

export function createMonitorService(options) {
  const token = requireToken(options.token, "REFBOX_MONITOR_TOKEN");
  const clients = new Set();
  const emit = (kind, payload) => {
    for (const res of clients)
      res.write(`event: ${kind}\ndata: ${JSON.stringify(payload)}\n\n`);
  };
  const collector = new MonitorCollector({ ...options, onEvent: emit });
  const manifest = monitorManifest(options);
  const server = serviceServer(async (req, res) => {
    if (!authorized(req, token))
      throw new HttpError(401, "Dedicated plugin authentication required");
    const requestUrl = new URL(req.url, "http://local");
    const path = requestUrl.pathname;
    if (req.method === "GET" && path === "/manifest")
      return json(res, 200, manifest);
    if (req.method === "GET" && path === "/health")
      return json(res, 200, {
        ok: true,
        service: "refbox-monitor",
        lastSeen: collector.lastSeen,
        detail: collector.detail,
      });
    if (req.method === "GET" && path === "/machine")
      return json(res, 200, {
        ok: true,
        hostname: hostname(),
        platform: platform(),
        uptimeSeconds: uptime(),
        memory: { total: totalmem(), free: freemem() },
        loadAverage: loadavg(),
        sampledAt: now(),
      });
    if (req.method === "GET" && path === "/samples") {
      const resourceId = requestUrl.searchParams.has("resourceId")
        ? requestUrl.searchParams.get("resourceId")
        : undefined;
      if (
        resourceId !== undefined &&
        !/^[a-zA-Z0-9_-]{1,200}$/.test(resourceId)
      )
        throw new HttpError(400, "Invalid resourceId scope");
      const samples = collector.samples(resourceId);
      return json(res, 200, {
        samples,
        lastSeen:
          resourceId === undefined
            ? collector.lastSeen
            : (samples[0]?.sampledAt ?? null),
        detail:
          resourceId === undefined
            ? collector.detail
            : `返回指定资源的 ${samples.length} 条采样`,
      });
    }
    if (req.method === "GET" && path === "/workspace") {
      const rows = collector
        .samples()
        .slice(0, 20)
        .map(
          (s) =>
            `<tr><td>${escape(s.resourceId)}</td><td>${s.healthy ? "探针通过" : "探针失败"}</td><td>${escape(s.method)}</td><td>${escape(s.sampledAt)}</td></tr>`,
        )
        .join("");
      return html(
        res,
        page(
          "Mac mini 独立采样",
          `<p>${escape(collector.detail)}。完整健康状态、事件与修复证据在平台资源工作区查看。</p><article><p>主机 ${escape(hostname())} · ${escape(platform())} · 可用内存 ${(freemem() / 1024 ** 3).toFixed(1)} GiB</p><table><thead><tr><th>资源</th><th>固定断言</th><th>采样方法</th><th>采样时间</th></tr></thead><tbody>${rows || '<tr><td colspan="4">尚无采样。检查平台配置与注册资源。</td></tr>'}</tbody></table></article>`,
        ),
      );
    }
    if (req.method === "GET" && path === "/events") {
      res.writeHead(200, {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache",
        Connection: "keep-alive",
      });
      res.write(
        `event: snapshot\ndata: ${JSON.stringify({ samples: collector.samples() })}\n\n`,
      );
      clients.add(res);
      const heartbeat = setInterval(() => res.write(": heartbeat\n\n"), 15000);
      req.on("close", () => {
        clearInterval(heartbeat);
        clients.delete(res);
      });
      return;
    }
    throw new HttpError(404, "Plugin route not found");
  });
  return {
    server,
    collector,
    manifest,
    async close() {
      server.closeAllConnections();
      await new Promise((r) => server.close(r));
      await collector.close();
    },
  };
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(resolve(process.argv[1])).href
) {
  const port = Number(process.env.REFBOX_MONITOR_PORT ?? 18811);
  const service = createMonitorService({
    token: process.env.REFBOX_MONITOR_TOKEN,
    platformToken: process.env.REFBOX_PLATFORM_TOKEN,
    platformUrl: process.env.REFBOX_PLATFORM_URL ?? "http://127.0.0.1:8080",
    database: process.env.REFBOX_MONITOR_DATABASE ?? "var/monitor.sqlite",
    selfUrl: `http://127.0.0.1:${port}`,
    engineUrl: process.env.REFBOX_ENGINE_URL,
    controlUrl: process.env.REFBOX_PLATFORM_URL,
    tunnelMetricsUrl: process.env.REFBOX_TUNNEL_METRICS_URL,
    publicUrl: process.env.REFBOX_PUBLIC_URL ?? "",
    environmentId: process.env.REFBOX_ENVIRONMENT_ID ?? "macmini-local",
    env: process.env,
  });
  await listen(service.server, port);
  service.collector.start();
  console.log(`refbox independent monitor: 127.0.0.1:${port}`);
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
