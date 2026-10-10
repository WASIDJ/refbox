import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";

// A test-only HTTP transport for sandboxed environments where TCP bind is denied.
// It invokes each actual Node server request listener, without replacing route logic.
export class InProcessTransport {
  constructor() {
    this.servers = new Map();
    this.counter = 0;
  }
  register(server) {
    const origin = `http://service-${++this.counter}.test`;
    this.servers.set(origin, server);
    return origin;
  }
  remove(origin) {
    this.servers.delete(origin);
  }
  fetch = async (input, options = {}) => {
    const url = new URL(input);
    const server = this.servers.get(url.origin);
    if (!server) throw new Error("Service is offline");
    const req = new PassThrough();
    req.method = options.method ?? "GET";
    req.url = url.pathname + url.search;
    req.headers = Object.fromEntries(new Headers(options.headers).entries());
    return new Promise((resolve, reject) => {
      const res = new EventEmitter();
      res.statusCode = 200;
      res.headersSent = false;
      res.headers = {};
      let controller;
      let resolved = false;
      const stream = new ReadableStream({
        start(c) {
          controller = c;
        },
        cancel() {
          req.emit("close");
        },
      });
      const deliver = () => {
        if (resolved) return;
        resolved = true;
        resolve(
          new Response(stream, {
            status: res.statusCode,
            headers: res.headers,
          }),
        );
      };
      res.writeHead = (status, headers) => {
        res.statusCode = status;
        res.headers = headers;
        res.headersSent = true;
        return res;
      };
      res.write = (chunk) => {
        deliver();
        controller.enqueue(
          Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk)),
        );
        return true;
      };
      res.end = (chunk) => {
        if (chunk) res.write(chunk);
        deliver();
        controller.close();
        req.emit("close");
      };
      req.on("error", reject);
      server.emit("request", req, res);
      if (options.body) req.write(options.body);
      req.end();
    });
  };
}
