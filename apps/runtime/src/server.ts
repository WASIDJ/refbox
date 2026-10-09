import {
  createServer,
  type IncomingMessage,
  type ServerResponse,
} from "node:http";
import { timingSafeEqual } from "node:crypto";
import type { Engine } from "./engine.js";
import { HttpError, required } from "./state.js";

async function body(req: IncomingMessage): Promise<Record<string, string>> {
  let text = "";
  for await (const chunk of req) {
    text += chunk;
    if (text.length > 128000) throw new HttpError(413, "请求过大");
  }
  if (!text) return {};
  let value;
  try {
    value = JSON.parse(text);
  } catch {
    throw new HttpError(400, "JSON 格式错误");
  }
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new HttpError(400, "需要 JSON 对象");
  return value;
}
function send(res: ServerResponse, status: number, value: unknown) {
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
  });
  res.end(JSON.stringify(value));
}
export function runtimeServer(engine: Engine, token: string) {
  if (token.length < 32)
    throw new Error("REFBOX_ENGINE_TOKEN 必须至少 32 字符");
  return createServer(async (req, res) => {
    const supplied = Buffer.from(req.headers.authorization ?? "");
    const expected = Buffer.from("Bearer " + token);
    if (
      supplied.length !== expected.length ||
      !timingSafeEqual(supplied, expected)
    ) {
      send(res, 401, { error: "未授权" });
      return;
    }
    try {
      const url = new URL(req.url ?? "/", "http://127.0.0.1");
      const parts = url.pathname.split("/").filter(Boolean);
      if (req.method === "GET" && url.pathname === "/api/health") {
        send(res, 200, {
          ok: true,
          engine: "pi-durable",
          version: "1.1.0",
          uid: process.getuid?.(),
          provider: "engy",
        });
        return;
      }
      if (req.method === "GET" && url.pathname === "/api/models") {
        send(res, 200, engine.modelList());
        return;
      }
      if (req.method === "GET" && url.pathname === "/api/tasks") {
        send(res, 200, Object.values((await engine.board()).tasks));
        return;
      }
      if (req.method === "GET" && url.pathname === "/api/services") {
        send(res, 200, Object.values((await engine.board()).services));
        return;
      }
      if (req.method === "GET" && url.pathname === "/api/events") {
        res.writeHead(200, {
          "Content-Type": "text/event-stream",
          "Cache-Control": "no-cache",
          Connection: "keep-alive",
          "X-Accel-Buffering": "no",
        });
        let dirty = true;
        let sending = false;
        let closed = false;
        const listener = () => {
          dirty = true;
        };
        engine.listeners.add(listener);
        const timer = setInterval(async () => {
          if (closed || sending || !dirty || res.writableNeedDrain) return;
          sending = true;
          dirty = false;
          try {
            const board = await engine.board();
            const taskId = url.searchParams.get("task");
            const view = taskId ? await engine.view(taskId) : null;
            if (!closed)
              res.write(
                `event: snapshot\ndata: ${JSON.stringify({ tasks: Object.values(board.tasks), services: Object.values(board.services), view })}\n\n`,
              );
          } catch {
            if (!closed)
              res.write('event: error\ndata: {"error":"状态读取失败"}\n\n');
          } finally {
            sending = false;
          }
        }, 250);
        const heartbeat = setInterval(() => {
          if (!res.writableNeedDrain) res.write(": heartbeat\n\n");
        }, 15000);
        const close = () => {
          closed = true;
          clearInterval(timer);
          clearInterval(heartbeat);
          engine.listeners.delete(listener);
        };
        res.once("close", close);
        return;
      }
      if (req.method === "GET" && parts[1] === "tasks" && parts[2]) {
        if (parts[3] === "view") send(res, 200, await engine.view(parts[2]));
        else if (parts[3] === "artifact") {
          const data = await engine.readArtifact(
            parts[2],
            required(url.searchParams.get("path"), "产物路径"),
          );
          res.writeHead(200, {
            "Content-Type": "text/plain; charset=utf-8",
            "Cache-Control": "no-store",
            "X-Content-Type-Options": "nosniff",
          });
          res.end(data);
        } else send(res, 200, await engine.task(parts[2]));
        return;
      }
      if (req.method === "POST") {
        const key = required(
          req.headers["idempotency-key"],
          "Idempotency-Key",
          128,
        );
        if (
          !/^[a-zA-Z0-9:_-]{8,128}$/.test(key) ||
          ["__proto__", "constructor", "prototype"].includes(key)
        )
          throw new HttpError(400, "请求标识格式错误");
        const payload = await body(req);
        if (url.pathname === "/api/tasks")
          send(res, 201, await engine.create(payload, key));
        else if (url.pathname === "/api/services")
          send(res, 200, await engine.saveService(payload, key));
        else if (parts[1] === "tasks" && parts[2] && parts[3])
          send(
            res,
            200,
            await engine.command(parts[2], parts[3], payload, key),
          );
        else throw new HttpError(404, "接口不存在");
        return;
      }
      throw new HttpError(404, "接口不存在");
    } catch (error) {
      if (!res.headersSent)
        send(res, error instanceof HttpError ? error.status : 500, {
          error:
            error instanceof HttpError
              ? error.message
              : "执行接口异常，请查看任务日志或运行服务日志",
        });
      else res.end();
    }
  });
}
