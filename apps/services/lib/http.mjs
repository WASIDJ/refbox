import { createServer } from "node:http";
import { timingSafeEqual } from "node:crypto";

export const now = () => new Date().toISOString();
export class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}
export function authorized(req, token) {
  const got = Buffer.from(req.headers.authorization ?? "");
  const expected = Buffer.from("Bearer " + token);
  return (
    typeof token === "string" &&
    token.length >= 32 &&
    got.length === expected.length &&
    timingSafeEqual(got, expected)
  );
}
export async function body(req, max = 128 * 1024) {
  let length = 0;
  const chunks = [];
  for await (const chunk of req) {
    length += chunk.length;
    if (length > max) throw new HttpError(413, "Request too large");
    chunks.push(chunk);
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString() || "{}");
  } catch {
    throw new HttpError(400, "Invalid JSON");
  }
}
export function json(res, status, data) {
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
  });
  res.end(JSON.stringify(data));
}
export function html(res, text) {
  res.writeHead(200, {
    "Content-Type": "text/html; charset=utf-8",
    "Cache-Control": "no-store",
    "Content-Security-Policy":
      "default-src 'none'; style-src 'unsafe-inline'; form-action 'none'; base-uri 'none'",
  });
  res.end(text);
}
export function escape(value) {
  return String(value ?? "").replace(
    /[&<>"']/g,
    (ch) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[
        ch
      ],
  );
}
export const page = (title, content) =>
  `<!doctype html><html lang="zh-CN"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${escape(title)}</title><style>body{font:16px/1.6 system-ui,sans-serif;color:#17253b;background:#f6f8fc;margin:0;padding:28px}h1{font-size:24px;margin:0 0 8px}p{color:#495b74}article{padding:16px 20px;border:1px solid #d8e0ec;border-radius:12px;background:white;margin:16px 0}time{font-size:13px;color:#495b74}pre{white-space:pre-wrap;word-break:break-word}table{width:100%;border-collapse:collapse}td,th{text-align:left;padding:10px;border-bottom:1px solid #d8e0ec}</style><main><h1>${escape(title)}</h1>${content}</main></html>`;
export function serviceServer(route) {
  return createServer((req, res) =>
    Promise.resolve(route(req, res)).catch((err) => {
      if (!res.headersSent)
        json(res, err.status ?? 500, {
          error: err.status ? err.message : "Service operation failed",
        });
      else res.end();
    }),
  );
}
export async function listen(server, port = 0) {
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, "127.0.0.1", resolve);
  });
  return `http://127.0.0.1:${server.address().port}`;
}
export async function closeServer(server) {
  server.closeAllConnections();
  await new Promise((resolve) => server.close(resolve));
}
export function requireToken(token, name) {
  if (typeof token !== "string" || token.length < 32)
    throw new Error(`${name} must contain at least 32 characters`);
  return token;
}
export async function platformRequest(
  url,
  path,
  token,
  options = {},
  fetchImpl = fetch,
) {
  const res = await fetchImpl(new URL(path, url), {
    ...options,
    headers: {
      Authorization: "Bearer " + token,
      "Content-Type": "application/json",
      ...options.headers,
    },
    signal: AbortSignal.timeout(5000),
  });
  if (!res.ok) throw new Error(`Platform returned HTTP ${res.status}`);
  return res.json();
}
