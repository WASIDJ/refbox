import assert from "node:assert/strict";
import { api } from "../src/api.ts";

const originalFetch = globalThis.fetch;
const keys = [];
let attempt = 0;
try {
  globalThis.fetch = async (_path, options) => {
    keys.push(options.headers["Idempotency-Key"]);
    attempt++;
    if (attempt === 1)
      throw new TypeError("connection interrupted before response");
    if (attempt === 2)
      return new Response(
        JSON.stringify({ error: "platform sync unavailable" }),
        { status: 503 },
      );
    return new Response(JSON.stringify({ id: "task-one" }), { status: 200 });
  };
  const goal = { title: "create exactly once", goal: "recover admission" };
  await assert.rejects(api("/platform/tasks", goal), /connection interrupted/);
  await assert.rejects(
    api("/platform/tasks", goal),
    /platform sync unavailable/,
  );
  assert.deepEqual(await api("/platform/tasks", goal), { id: "task-one" });
  assert.equal(keys[0], keys[1]);
  assert.equal(keys[1], keys[2]);
  await api("/platform/tasks", goal);
  assert.notEqual(
    keys[2],
    keys[3],
    "a successful intent must not suppress a later deliberate action",
  );
  globalThis.fetch = async (_path, options) => {
    keys.push(options.headers["Idempotency-Key"]);
    return new Response("null", { status: 400 });
  };
  await assert.rejects(
    api("/platform/tasks/task-one/status", { status: "invalid" }),
    /请求失败（400）/,
  );
  await assert.rejects(
    api("/platform/tasks/task-one/status", { status: "invalid" }),
    /请求失败（400）/,
  );
  assert.notEqual(
    keys[4],
    keys[5],
    "a rejected input is not an ambiguous admitted action",
  );
  process.stdout.write(
    "API recovery checks passed: ambiguous retries share receipts; later actions and rejected inputs get new receipts.\n",
  );
} finally {
  globalThis.fetch = originalFetch;
}
