import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { body, json, now, serviceServer } from "../lib/http.mjs";
import { httpProbe } from "../lib/probes.mjs";
import { createFaultFixture } from "../fault-fixture.mjs";
import { createScratchpadService } from "../scratchpad.mjs";
import { MonitorCollector, createMonitorService } from "../monitor.mjs";
import { createProverService, prove } from "../prover.mjs";
import { InProcessTransport } from "./transport.mjs";

const token = "independent-in-process-test-".repeat(2);
const auth = { Authorization: "Bearer " + token };
const affirmative = {
  review: async () => ({
    reviewConversationId: "separate-1",
    text: '{"approved":true,"summary":"新鲜固定功能断言、连续采样均通过。"}',
  }),
};
const requestFor = (resource) => ({
  incidentId: "incident-1",
  resourceId: resource.id,
  actionId: "action-1",
  version: resource.version,
  environmentId: resource.environmentId,
  requestedAt: now(),
  checks: resource.checks,
  healthySamples: 99,
});

test("in-process HTTP exercises broken business with HTTP 200 and deterministic metric criteria", async (t) => {
  const transport = new InProcessTransport();
  const fixture = createFaultFixture({ token });
  t.after(() => fixture.close());
  const url = transport.register(fixture.server);
  assert.equal((await transport.fetch(url + "/health")).status, 200);
  const check = {
    id: "business",
    url: url + "/business",
    json: { path: "result", equals: "ready" },
  };
  assert.equal(
    (await httpProbe(check, { fetchImpl: transport.fetch })).passed,
    false,
  );
  assert.equal(
    (
      await httpProbe(
        { id: "empty", url: url + "/health" },
        { fetchImpl: transport.fetch },
      )
    ).unavailable,
    true,
  );
  await transport.fetch(url + "/admin/fault", {
    method: "POST",
    headers: auth,
    body: '{"broken":false}',
  });
  assert.equal(
    (await httpProbe(check, { fetchImpl: transport.fetch })).passed,
    true,
  );
  let connected = 0;
  const metrics = serviceServer((req, res) =>
    res.end(`cloudflared_tunnel_ha_connections{a="one"} ${connected}\n`),
  );
  const metricsUrl = transport.register(metrics);
  const metric = {
    id: "connector",
    url: metricsUrl,
    metric: { name: "cloudflared_tunnel_ha_connections", min: 1 },
  };
  assert.equal(
    (await httpProbe(metric, { fetchImpl: transport.fetch })).passed,
    false,
  );
  connected = 2;
  assert.equal(
    (await httpProbe(metric, { fetchImpl: transport.fetch })).passed,
    true,
  );
});

test("in-process HTTP invokes authenticated scratchpad tools, events, escaped workspace and actual SQLite reopen", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "refbox-scratchpad-test-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const database = join(dir, "notes.sqlite");
  const transport = new InProcessTransport();
  let service = createScratchpadService({ token, database });
  let url = transport.register(service.server);
  assert.equal((await transport.fetch(url + "/notes")).status, 401);
  const headers = { ...auth, "Idempotency-Key": "create-note" };
  const input = { title: "<script>bad</script>", content: "真实 SQLite" };
  const first = await transport
    .fetch(url + "/notes", {
      method: "POST",
      headers,
      body: JSON.stringify(input),
    })
    .then((r) => r.json());
  const second = await transport
    .fetch(url + "/notes", {
      method: "POST",
      headers,
      body: JSON.stringify(input),
    })
    .then((r) => r.json());
  assert.equal(first.id, second.id);
  assert.equal(
    (
      await transport.fetch(url + "/notes", {
        method: "POST",
        headers,
        body: JSON.stringify({ ...input, content: "changed" }),
      })
    ).status,
    409,
  );
  assert.match(
    await transport
      .fetch(url + "/workspace", { headers: auth })
      .then((r) => r.text()),
    /&lt;script&gt;/,
  );
  const events = await transport.fetch(url + "/events", { headers: auth });
  const reader = events.body.getReader();
  assert.match(Buffer.from((await reader.read()).value).toString(), /snapshot/);
  await reader.cancel();
  await service.close();
  service = createScratchpadService({ token, database });
  url = transport.register(service.server);
  t.after(() => service.close());
  const read = await transport
    .fetch(url + "/notes", { headers: auth })
    .then((r) => r.json());
  assert.equal(read.notes.length, 1);
  assert.equal(read.notes[0].id, first.id);
  const manifest = await transport
    .fetch(url + "/manifest", { headers: auth })
    .then((r) => r.json());
  assert.equal(
    manifest.tools.find((tool) => tool.id === "list-notes").method,
    "GET",
  );
  assert.equal(
    manifest.tools.find((tool) => tool.id === "create-note").method,
    "POST",
  );
});

test("in-process independent monitor stores samples and handles offline platform without Pi", async (t) => {
  const transport = new InProcessTransport();
  const fixture = createFaultFixture({ token });
  t.after(() => fixture.close());
  const fixtureUrl = transport.register(fixture.server);
  const resource = {
    id: "business",
    version: "v1",
    environmentId: "test",
    checks: [
      {
        id: "business",
        url: fixtureUrl + "/business",
        json: { path: "result", equals: "ready" },
      },
    ],
  };
  const received = [];
  const platform = serviceServer(async (req, res) => {
    assert.equal(req.headers.authorization, "Bearer " + token);
    if (req.url === "/internal/resources") return json(res, 200, [resource]);
    received.push(await body(req));
    return json(res, 200, { ok: true });
  });
  const platformUrl = transport.register(platform);
  const dir = await mkdtemp(join(tmpdir(), "refbox-monitor-test-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  let collector = new MonitorCollector({
    platformUrl,
    platformToken: token,
    fetchImpl: transport.fetch,
    database: join(dir, "samples.sqlite"),
  });
  await collector.collect();
  assert.equal(received[0].healthy, false);
  assert.equal(received[0].version, "v1");
  assert.equal(collector.samples().length, 1);
  await collector.close();
  collector = new MonitorCollector({
    platformUrl,
    platformToken: token,
    fetchImpl: transport.fetch,
    database: join(dir, "samples.sqlite"),
  });
  t.after(() => collector.close());
  assert.equal(collector.samples().length, 1);
  await transport.fetch(fixtureUrl + "/admin/fault", {
    method: "POST",
    headers: auth,
    body: '{"broken":false}',
  });
  await collector.collect();
  assert.equal(collector.samples()[0].healthy, true);
  transport.remove(platformUrl);
  await collector.collect();
  assert.match(collector.detail, /采集失败/);
});

test("in-process proof endpoint refuses replaced criteria, missing model, stale sample, browser unavailable and broken business", async (t) => {
  const transport = new InProcessTransport();
  const fixture = createFaultFixture({ token, mode: "healthy" });
  t.after(() => fixture.close());
  const fixtureUrl = transport.register(fixture.server);
  const resource = {
    id: "business",
    version: "v1",
    environmentId: "test",
    health: "healthy",
    healthySamples: 3,
    sampledAt: now(),
    checks: [
      {
        id: "business",
        url: fixtureUrl + "/business",
        json: { path: "result", equals: "ready" },
      },
    ],
  };
  const options = {
    resources: async () => [resource],
    reviewer: affirmative,
    probe: (check) => httpProbe(check, { fetchImpl: transport.fetch }),
  };
  const service = createProverService({ token, ...options });
  const url = transport.register(service.server);
  t.after(() => service.close());
  assert.equal(
    (await transport.fetch(url + "/verify", { method: "POST", body: "{}" }))
      .status,
    401,
  );
  const call = (request) =>
    transport.fetch(url + "/verify", {
      method: "POST",
      headers: auth,
      body: JSON.stringify(request),
    });
  assert.equal(
    (await call(requestFor(resource)).then((r) => r.json())).verdict,
    "pass",
  );
  assert.equal(
    (
      await call({
        ...requestFor(resource),
        checks: [
          {
            id: "looser",
            url: fixtureUrl + "/health",
            json: { path: "ok", equals: true },
          },
        ],
      })
    ).status,
    409,
  );
  assert.equal(
    (await prove(requestFor(resource), { ...options, reviewer: undefined }))
      .verdict,
    "inconclusive",
  );
  assert.equal(
    (
      await prove(requestFor(resource), {
        ...options,
        reviewer: {
          review: async () => ({
            reviewConversationId: "separate-malformed",
            text: "Looks done",
          }),
        },
      })
    ).verdict,
    "inconclusive",
  );
  assert.equal(
    (
      await prove(requestFor(resource), {
        ...options,
        reviewer: {
          review: async () => ({
            reviewConversationId: "separate-rejected",
            text: '{"approved":false,"summary":"复核拒绝证据不足。"}',
          }),
        },
      })
    ).verdict,
    "fail",
  );
  resource.healthySamples = 1;
  assert.equal(
    (await call(requestFor(resource)).then((r) => r.json())).verdict,
    "inconclusive",
  );
  resource.healthySamples = 3;
  resource.sampledAt = new Date(Date.now() - 60000).toISOString();
  assert.equal(
    (await call(requestFor(resource)).then((r) => r.json())).verdict,
    "inconclusive",
  );
  resource.sampledAt = now();
  await transport.fetch(fixtureUrl + "/admin/fault", {
    method: "POST",
    headers: auth,
    body: '{"broken":true}',
  });
  assert.equal(
    (await call(requestFor(resource)).then((r) => r.json())).verdict,
    "fail",
  );
  resource.checks = [
    { id: "ui", url: fixtureUrl + "/workspace", browser: { selector: "main" } },
  ];
  assert.equal(
    (
      await prove(requestFor(resource), {
        ...options,
        browser: async (check) => ({
          id: check.id,
          url: check.url,
          passed: false,
          sampledAt: now(),
          unavailable: true,
        }),
      })
    ).verdict,
    "inconclusive",
  );
});

test("independent proof accepts only an entire JSON fence and retains every assertion and evidence gate", async (t) => {
  const transport = new InProcessTransport();
  const fixture = createFaultFixture({ token, mode: "healthy" });
  t.after(() => fixture.close());
  const url = transport.register(fixture.server);
  const resource = {
    id: "business",
    version: "v1",
    environmentId: "test",
    health: "healthy",
    sampledAt: now(),
    healthySamples: 3,
    checks: [
      {
        id: "business",
        url: url + "/business",
        json: { path: "result", equals: "ready" },
      },
    ],
  };
  const samples = [2000, 1000, 0].map((age) => ({
    resourceId: resource.id,
    version: resource.version,
    environmentId: resource.environmentId,
    sampledAt: new Date(Date.now() - age).toISOString(),
    healthy: true,
    method: "http_json",
  }));
  let text;
  let reviewCount = 0;
  const options = {
    resources: async () => [resource],
    observations: async () => samples,
    probe: (check) => httpProbe(check, { fetchImpl: transport.fetch }),
    reviewer: {
      review: async () => {
        reviewCount++;
        return {
          reviewConversationId: "independent-fenced-" + reviewCount,
          text,
        };
      },
    },
  };
  const approved = '{"approved":true,"summary":"新鲜功能与连续采样通过。"}';
  const fenced = "```json\n" + approved + "\n```";
  text = fenced;
  const accepted = await prove(requestFor(resource), options);
  assert.equal(accepted.verdict, "pass");
  assert.equal(
    accepted.review,
    fenced,
    "stored evidence must retain the raw response, including its fence",
  );
  assert.equal(accepted.monitorSeries.observations.length, 3);
  assert.equal(
    accepted.checks[0].witness.assertions[0].observed.value,
    "ready",
  );
  text =
    '```json\r\n{"approved":false,"summary":"证据不足，拒绝通过。"}\r\n```';
  assert.equal((await prove(requestFor(resource), options)).verdict, "fail");
  const rejected = [
    "Review complete.\n" + fenced,
    fenced + "\nEverything passed.",
    fenced + "\n" + fenced,
    "```json\n" + approved,
    "```json\n{broken}\n```",
    "```json\nnull\n```",
    "```json\n[]\n```",
    '```json\n{"approved":"true","summary":"wrong type"}\n```',
    '```json\n{"approved":true,"summary":""}\n```',
    approved + " ".repeat(12000) + "surrounding commentary",
  ];
  for (text of rejected)
    assert.equal(
      (await prove(requestFor(resource), options)).verdict,
      "inconclusive",
    );
  text = fenced;
  const beforeGate = reviewCount;
  samples[1].healthy = false;
  assert.equal(
    (await prove(requestFor(resource), options)).verdict,
    "inconclusive",
  );
  assert.equal(
    reviewCount,
    beforeGate,
    "a fenced approval cannot bypass invalid monitor history",
  );
  samples[1].healthy = true;
  await transport.fetch(url + "/admin/fault", {
    method: "POST",
    headers: auth,
    body: '{"broken":true}',
  });
  assert.equal((await prove(requestFor(resource), options)).verdict, "fail");
  assert.equal(
    reviewCount,
    beforeGate,
    "a fenced approval cannot bypass failed fixed business checks",
  );
});

test("monitor skips disabled resources and scoped samples never include another resource", async (t) => {
  const transport = new InProcessTransport();
  const fixture = createFaultFixture({ token, mode: "healthy" });
  const fixtureUrl = transport.register(fixture.server);
  t.after(() => fixture.close());
  const resources = [
    {
      id: "disabled",
      enabled: false,
      version: "v1",
      environmentId: "test",
      checks: [
        {
          id: "unreachable",
          url: "http://disabled.test/private",
          contains: "unused",
        },
      ],
    },
    {
      id: "alpha",
      enabled: true,
      version: "v1",
      environmentId: "test",
      checks: [
        {
          id: "business",
          url: fixtureUrl + "/business",
          json: { path: "result", equals: "ready" },
        },
      ],
    },
    {
      id: "beta",
      enabled: true,
      version: "v1",
      environmentId: "test",
      checks: [
        {
          id: "health",
          url: fixtureUrl + "/health",
          json: { path: "ok", equals: true },
        },
      ],
    },
  ];
  const observations = [];
  const platform = serviceServer(async (req, res) => {
    if (req.url === "/internal/resources") return json(res, 200, resources);
    const input = await body(req);
    if (req.url === "/internal/observations") observations.push(input);
    return json(res, 200, { ok: true });
  });
  const platformUrl = transport.register(platform);
  const service = createMonitorService({
    token,
    platformToken: token,
    platformUrl,
    fetchImpl: transport.fetch,
  });
  const url = transport.register(service.server);
  t.after(() => service.close());
  await service.collector.collect();
  assert.deepEqual(
    observations.map((item) => item.resourceId),
    ["alpha", "beta"],
  );
  assert.ok(observations.every((item) => item.healthy));
  const read = (query) =>
    transport
      .fetch(url + "/samples" + query, { headers: auth })
      .then((response) => response.json());
  assert.equal((await read("")).samples.length, 2);
  const scoped = await read("?resourceId=alpha");
  assert.equal(scoped.samples.length, 1);
  assert.equal(scoped.samples[0].resourceId, "alpha");
  assert.doesNotMatch(JSON.stringify(scoped), /beta|disabled/);
  assert.equal((await read("?resourceId=unknown")).samples.length, 0);
  assert.equal(
    (await transport.fetch(url + "/samples?resourceId=", { headers: auth }))
      .status,
    400,
  );
});

test("in-process controlled fault fixture persists restart count and recovers only its disposable business", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "refbox-fault-test-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const database = join(dir, "fixture.sqlite");
  const transport = new InProcessTransport();
  let fixture = createFaultFixture({ token, database });
  let url = transport.register(fixture.server);
  assert.equal(
    (await transport.fetch(url + "/business").then((r) => r.json())).ok,
    false,
  );
  await fixture.close();
  fixture = createFaultFixture({ token, database });
  url = transport.register(fixture.server);
  t.after(() => fixture.close());
  assert.equal(
    (await transport.fetch(url + "/business").then((r) => r.json())).ok,
    true,
  );
  assert.equal(fixture.bootCount, 2);
});
