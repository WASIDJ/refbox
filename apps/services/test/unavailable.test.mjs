import test from "node:test";
import assert from "node:assert/strict";
import { MonitorCollector, monitorManifest } from "../monitor.mjs";
import { httpProbe } from "../lib/probes.mjs";

test("default public-route monitoring never authorizes restarting a healthy Cloudflare connector", () => {
  const manifest = monitorManifest({
    publicUrl: "https://refbox.example.test",
  });
  const resources = Object.fromEntries(
    manifest.resources.map((resource) => [resource.id, resource]),
  );
  assert.equal(resources["refbox-engine"].restartAllowed, true);
  assert.equal(resources["refbox-control"].restartAllowed, false);
  assert.equal(resources.macmini.restartAllowed, false);
  assert.equal(resources["refbox-tunnel"].restartAllowed, false);
  assert.ok(
    resources["refbox-tunnel"].checks.some(
      (check) => check.metric?.name === "cloudflared_tunnel_ha_connections",
    ),
  );
  assert.ok(
    resources["refbox-tunnel"].checks.some(
      (check) => check.id === "deployed-control",
    ),
  );
  assert.ok(
    resources["refbox-tunnel"].checks.some(
      (check) => check.id === "deployed-ui" && check.browser,
    ),
  );
});

test("Cloudflare connector restart requires an explicit boolean opt-in and cannot change other resource permissions", () => {
  for (const allowTunnelRestart of [undefined, false, "false", "true", 1]) {
    assert.equal(
      monitorManifest({ allowTunnelRestart }).resources.find(
        (resource) => resource.id === "refbox-tunnel",
      ).restartAllowed,
      false,
    );
  }
  const manifest = monitorManifest({ allowTunnelRestart: true });
  const resources = Object.fromEntries(
    manifest.resources.map((resource) => [resource.id, resource]),
  );
  assert.equal(resources["refbox-tunnel"].restartAllowed, true);
  assert.equal(resources["refbox-engine"].restartAllowed, true);
  assert.equal(resources["refbox-control"].restartAllowed, false);
  assert.equal(resources.macmini.restartAllowed, false);
});

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
