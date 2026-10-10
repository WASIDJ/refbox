import test from "node:test";
import assert from "node:assert/strict";
import { MonitorCollector } from "../monitor.mjs";
import { httpProbe } from "../lib/probes.mjs";

test("missing probe credentials and rejected authentication remain unknown, without claiming service failure", async (t) => {
  const check = {
    id: "functional",
    url: "http://127.0.0.1:1/health",
    json: { path: "ok", equals: true },
    credentialEnv: "NOT_CONFIGURED",
  };
  assert.equal((await httpProbe(check, { env: {} })).unavailable, true);
  assert.equal(
    (
      await httpProbe(
        { ...check, credentialEnv: undefined },
        { fetchImpl: async () => new Response("{}", { status: 401 }) },
      )
    ).unavailable,
    true,
  );
  const received = [];
  const fetchImpl = async (url, options = {}) => {
    const path = new URL(url).pathname;
    if (path === "/internal/resources")
      return Response.json([
        { id: "engine", version: "1", environmentId: "test", checks: [check] },
      ]);
    received.push(JSON.parse(options.body));
    return Response.json({ ok: true });
  };
  const collector = new MonitorCollector({
    platformUrl: "http://127.0.0.1:8080",
    platformToken: "test-token".repeat(5),
    env: {},
    fetchImpl,
  });
  t.after(() => collector.close());
  await collector.collect();
  assert.equal(received[0].healthy, false);
  assert.equal(received[0].unavailable, true);
  assert.equal(collector.samples()[0].unavailable, true);
});
