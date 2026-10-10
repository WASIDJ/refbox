import { DatabaseSync } from "node:sqlite";
import { mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { randomUUID } from "node:crypto";
import {
  authorized,
  body,
  escape,
  html,
  HttpError,
  json,
  listen,
  now,
  page,
  requireToken,
  serviceServer,
} from "./lib/http.mjs";

export function scratchpadManifest(selfUrl = "http://127.0.0.1:18813") {
  return {
    schemaVersion: 1,
    id: "scratchpad",
    name: "个人随手记",
    version: "1.0.0",
    description:
      "独立业务插件示例：自己的 SQLite、业务工作区、笔记工具、事件和固定验证；平台不保存笔记表。",
    workspace: { title: "随手记", path: "/workspace" },
    resources: [
      {
        id: "scratchpad-service",
        name: "随手记服务",
        kind: "service",
        serviceId: "",
        version: "1",
        environmentId: "macmini-local",
        restartAllowed: false,
        checks: [
          {
            id: "notes-read",
            url: selfUrl + "/health",
            json: { path: "storage", equals: "sqlite-readable" },
            credentialEnv: "REFBOX_SCRATCHPAD_TOKEN",
          },
        ],
      },
    ],
    tools: [
      {
        id: "list-notes",
        name: "读取笔记",
        description: "读取随手记业务数据，无需输入。",
        path: "/notes",
        method: "GET",
        mutates: false,
      },
      {
        id: "create-note",
        name: "创建笔记",
        description:
          '输入 JSON {"title":"标题","content":"内容"}。重复的 Idempotency-Key 返回已有笔记。',
        path: "/notes",
        method: "POST",
        mutates: true,
      },
    ],
    events: ["note.created"],
    verification: { checks: ["SQLite 真实读取", "持久化笔记重启后仍可读取"] },
  };
}

export function createScratchpadService({
  database = ":memory:",
  token,
  selfUrl,
}) {
  requireToken(token, "REFBOX_SCRATCHPAD_TOKEN");
  if (database !== ":memory:")
    mkdirSync(dirname(resolve(database)), { recursive: true, mode: 0o700 });
  const db = new DatabaseSync(database);
  db.exec(
    "PRAGMA journal_mode=WAL; CREATE TABLE IF NOT EXISTS notes(id TEXT PRIMARY KEY,title TEXT NOT NULL,content TEXT NOT NULL,created_at TEXT NOT NULL); CREATE TABLE IF NOT EXISTS commands(key TEXT PRIMARY KEY,input TEXT NOT NULL,note_id TEXT NOT NULL);",
  );
  const clients = new Set();
  const manifest = scratchpadManifest(selfUrl);
  const notes = () =>
    db
      .prepare(
        "SELECT id,title,content,created_at AS createdAt FROM notes ORDER BY created_at DESC,id DESC LIMIT 200",
      )
      .all();
  const server = serviceServer(async (req, res) => {
    if (!authorized(req, token))
      throw new HttpError(401, "Dedicated plugin authentication required");
    const path = new URL(req.url, "http://local").pathname;
    if (req.method === "GET" && path === "/manifest")
      return json(res, 200, manifest);
    if (req.method === "GET" && path === "/health") {
      db.prepare("SELECT COUNT(*) AS count FROM notes").get();
      return json(res, 200, {
        ok: true,
        service: "scratchpad",
        storage: "sqlite-readable",
      });
    }
    if (req.method === "GET" && path === "/notes")
      return json(res, 200, { notes: notes() });
    if (req.method === "POST" && path === "/notes") {
      const input = await body(req);
      if (
        typeof input.title !== "string" ||
        !input.title.trim() ||
        input.title.length > 200 ||
        typeof input.content !== "string" ||
        input.content.length > 20000
      )
        throw new HttpError(
          400,
          "A title (1–200 chars) and content (up to 20000 chars) are required",
        );
      const normalized = JSON.stringify({
        title: input.title.trim(),
        content: input.content,
      });
      const key = req.headers["idempotency-key"];
      if (key && (typeof key !== "string" || key.length > 200))
        throw new HttpError(400, "Invalid Idempotency-Key");
      const prior = key
        ? db.prepare("SELECT input,note_id FROM commands WHERE key=?").get(key)
        : null;
      if (prior) {
        if (prior.input !== normalized)
          throw new HttpError(
            409,
            "Idempotency key is already bound to another note",
          );
        return json(
          res,
          200,
          db
            .prepare(
              "SELECT id,title,content,created_at AS createdAt FROM notes WHERE id=?",
            )
            .get(prior.note_id),
        );
      }
      const note = {
        id: randomUUID(),
        title: input.title.trim(),
        content: input.content,
        createdAt: now(),
      };
      db.exec("BEGIN IMMEDIATE");
      try {
        db.prepare("INSERT INTO notes VALUES(?,?,?,?)").run(
          note.id,
          note.title,
          note.content,
          note.createdAt,
        );
        if (key)
          db.prepare("INSERT INTO commands VALUES(?,?,?)").run(
            key,
            normalized,
            note.id,
          );
        db.exec("COMMIT");
      } catch (err) {
        db.exec("ROLLBACK");
        throw err;
      }
      for (const client of clients)
        client.write(`event: note.created\ndata: ${JSON.stringify(note)}\n\n`);
      return json(res, 201, note);
    }
    if (req.method === "GET" && path === "/workspace") {
      const articles = notes()
        .map(
          (note) =>
            `<article><h2>${escape(note.title)}</h2><time>${escape(note.createdAt)}</time><pre>${escape(note.content)}</pre></article>`,
        )
        .join("");
      return html(
        res,
        page(
          "个人随手记",
          `<p>使用工作区旁的「创建笔记」工具记录想法。此插件只处理自己的笔记业务；平台负责工具调用、可用性与证据索引。</p>${articles || "<article>还没有笔记。创建第一条后刷新工作区即可查看。</article>"}`,
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
        `event: snapshot\ndata: ${JSON.stringify({ notes: notes() })}\n\n`,
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
    manifest,
    db,
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
  const port = Number(process.env.REFBOX_SCRATCHPAD_PORT ?? 18813);
  const service = createScratchpadService({
    database: process.env.REFBOX_SCRATCHPAD_DATABASE ?? "var/scratchpad.sqlite",
    token: process.env.REFBOX_SCRATCHPAD_TOKEN,
    selfUrl: `http://127.0.0.1:${port}`,
  });
  await listen(service.server, port);
  console.log(`refbox scratchpad plugin: 127.0.0.1:${port}`);
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
