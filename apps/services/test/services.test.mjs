import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createHash } from "node:crypto";
import {
  createModels,
  fauxProvider,
  fauxAssistantMessage,
  fauxText,
} from "@earendil-works/pi-ai";
import { BACKGROUND_CONTEXT as context } from "@earendil-works/chord/context";
import {
  body,
  closeServer,
  json,
  listen,
  now,
  serviceServer,
} from "../lib/http.mjs";
import { httpProbe } from "../lib/probes.mjs";
import { createScratchpadService } from "../scratchpad.mjs";
import { MonitorCollector } from "../monitor.mjs";
import { createProverService, PiReviewer, prove } from "../prover.mjs";
import { createFaultFixture } from "../fault-fixture.mjs";

const token = "service-test-token-".repeat(3);
const auth = { Authorization: "Bearer " + token };
async function temporary(t) {
  const dir = await mkdtemp(join(tmpdir(), "refbox-services-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  return dir;
}
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
const affirmative = {
  review: async () => ({
    reviewConversationId: "independent-22",
    text: JSON.stringify({
      approved: true,
      summary: "固定功能断言与新鲜采样均通过。",
    }),
  }),
};

test("business probes reject HTTP 200 with broken functionality and require explicit assertions", async (t) => {
  const fixture = createFaultFixture({ token });
  const url = await listen(fixture.server);
  t.after(() => fixture.close());
  assert.equal((await fetch(url + "/health")).status, 200);
  const bad = await httpProbe({
    id: "business",
    url: url + "/business",
    json: { path: "result", equals: "ready" },
  });
  assert.equal(bad.passed, false);
  assert.match(bad.detail, /business assertion failed/);
  assert.equal(
    (await httpProbe({ id: "status-only", url: url + "/health" })).unavailable,
    true,
  );
  await fetch(url + "/admin/fault", {
    method: "POST",
    headers: auth,
    body: JSON.stringify({ broken: false }),
  });
  assert.equal(
    (
      await httpProbe({
        id: "business",
        url: url + "/business",
        json: { path: "result", equals: "ready" },
      })
    ).passed,
    true,
  );
});

test("Prometheus connector check requires live connections rather than just a metrics page", async (t) => {
  let connections = 0;
  const server = serviceServer((req, res) => {
    res.end(
      `# TYPE cloudflared_tunnel_ha_connections gauge\ncloudflared_tunnel_ha_connections{location="local"} ${connections}\n`,
    );
  });
  const url = await listen(server);
  t.after(() => closeServer(server));
  const check = {
    id: "tunnel",
    url,
    metric: { name: "cloudflared_tunnel_ha_connections", min: 1 },
  };
  assert.equal((await httpProbe(check)).passed, false);
  connections = 2;
  const connected = await httpProbe(check);
  assert.equal(connected.passed, true);
  assert.deepEqual(connected.witness.assertions[0].values, [2]);
  assert.equal(connected.witness.assertions[0].sum, 2);
});

test("real TCP HTTP witnesses preserve response status, raw body hash and observed JSON with bounded excerpts", async (t) => {
  const raw = JSON.stringify({
    result: "ready",
    description: "采样".repeat(2000),
  });
  const server = serviceServer((req, res) => {
    assert.equal(req.headers.authorization, "Bearer " + token);
    res.writeHead(req.url === "/failed" ? 503 : 200);
    res.end(raw);
  });
  const url = await listen(server);
  t.after(() => closeServer(server));
  const check = {
    id: "raw",
    url,
    json: { path: "result", equals: "ready" },
    credentialEnv: "TEST_TOKEN",
  };
  const probe = await httpProbe(check, { env: { TEST_TOKEN: token } });
  assert.equal(probe.passed, true);
  assert.equal(probe.witness.status, 200);
  assert.equal(probe.witness.bodyBytes, Buffer.byteLength(raw));
  assert.equal(
    probe.witness.bodySha256,
    createHash("sha256").update(raw).digest("hex"),
  );
  assert.equal(probe.witness.bodyTruncated, true);
  assert.ok(Buffer.byteLength(probe.witness.bodyExcerpt) <= 4096);
  assert.ok(raw.startsWith(probe.witness.bodyExcerpt));
  assert.deepEqual(probe.witness.assertions[0].observed, {
    present: true,
    value: "ready",
  });
  assert.doesNotMatch(JSON.stringify(probe), new RegExp(token));
  const failed = await httpProbe(
    { ...check, url: url + "/failed" },
    { env: { TEST_TOKEN: token } },
  );
  assert.equal(failed.passed, false);
  assert.equal(failed.witness.status, 503);
  assert.equal(failed.witness.bodySha256, probe.witness.bodySha256);
});

test("oversized 401 and 403 response bodies preserve unavailable authentication without claiming a repairable failure", async (t) => {
  const server = serviceServer((req, res) => {
    res.writeHead(req.url === "/401" ? 401 : 403);
    res.end("x".repeat(1024 * 1024 + 1));
  });
  const url = await listen(server);
  t.after(() => closeServer(server));
  for (const status of [401, 403]) {
    const result = await httpProbe({
      id: "auth",
      url: url + "/" + status,
      contains: "ready",
    });
    assert.equal(result.passed, false);
    assert.equal(result.unavailable, true);
    assert.equal(result.witness.status, status);
    assert.match(result.detail, /Response exceeds 1 MiB evidence limit/);
  }
});

test("deployed prover fetches authoritative recent observations and gives separate Pi conversations raw TCP evidence", async (t) => {
  const dir = await temporary(t);
  const fixture = createFaultFixture({ token, mode: "healthy" });
  const fixtureUrl = await listen(fixture.server);
  t.after(() => fixture.close());
  const resource = {
    id: "business",
    version: "v1",
    environmentId: "test",
    health: "healthy",
    sampledAt: now(),
    healthySamples: 10,
    checks: [
      {
        id: "business",
        url: fixtureUrl + "/business",
        json: { path: "result", equals: "ready" },
      },
    ],
  };
  const history = [32000, 17000, 2000].map((age) => ({
    resourceId: resource.id,
    version: resource.version,
    environmentId: resource.environmentId,
    sampledAt: new Date(Date.now() - age).toISOString(),
    healthy: true,
    method: "http_json",
    detail: "business: Registered business assertion passed.",
  }));
  const platformToken = "independent-platform-token-".repeat(3);
  let historyReads = 0;
  const platform = serviceServer((req, res) => {
    assert.equal(req.headers.authorization, "Bearer " + platformToken);
    if (req.url === "/internal/resources") return json(res, 200, [resource]);
    if (req.url === "/internal/observations?resourceId=business") {
      historyReads++;
      return json(res, 200, { resource, observations: history });
    }
    throw new Error("Unexpected platform request: " + req.url);
  });
  const platformUrl = await listen(platform);
  t.after(() => closeServer(platform));
  const faux = fauxProvider();
  const models = createModels();
  models.setProvider(faux.provider);
  const reviewer = await PiReviewer.open({
    database: join(dir, "raw-evidence.sqlite"),
    models,
    model: faux.getModel().id,
    provider: faux.provider.id,
  });
  const originalReview = reviewer.review.bind(reviewer);
  const payloads = [];
  reviewer.review = async (evidence) => {
    payloads.push(evidence);
    assert.equal(evidence.healthySamples, 10);
    assert.equal(evidence.monitorSeries.providedSampleCount, 3);
    assert.deepEqual(evidence.monitorSeries.observations, history);
    assert.ok(
      evidence.monitorSeries.observations.every(
        (item) => Date.parse(item.sampledAt) < Date.parse(evidence.requestedAt),
      ),
    );
    assert.equal(evidence.checks[0].witness.status, 200);
    assert.equal(
      JSON.parse(evidence.checks[0].witness.bodyExcerpt).result,
      "ready",
    );
    assert.equal(
      evidence.checks[0].witness.assertions[0].observed.value,
      "ready",
    );
    return originalReview(evidence);
  };
  faux.setResponses(
    Array.from({ length: 2 }, () => (transcript) => {
      assert.equal((transcript.tools ?? []).length, 0);
      return fauxAssistantMessage([
        fauxText(
          '{"approved":true,"summary":"原始响应与三次独立健康记录覆盖固定标准。"}',
        ),
      ]);
    }),
  );
  const service = createProverService({
    token,
    platformUrl,
    platformToken,
    reviewer,
  });
  const url = await listen(service.server);
  t.after(() => service.close());
  const call = () =>
    fetch(url + "/verify", {
      method: "POST",
      headers: auth,
      body: JSON.stringify(requestFor(resource)),
    }).then((response) => response.json());
  const first = await call();
  const second = await call();
  assert.equal(first.verdict, "pass");
  assert.equal(second.verdict, "pass");
  assert.notEqual(first.reviewConversationId, second.reviewConversationId);
  assert.equal(historyReads, 2);
  assert.equal(payloads.length, 2);
  history[1].healthy = false;
  const contradicted = await call();
  assert.equal(contradicted.verdict, "inconclusive");
  assert.equal(
    payloads.length,
    2,
    "a contradictory history must never reach model approval",
  );
});

test("fresh healthy counters cannot replace actual consecutive version-bound observation records", async (t) => {
  const fixture = createFaultFixture({ token, mode: "healthy" });
  const url = await listen(fixture.server);
  t.after(() => fixture.close());
  const resource = {
    id: "business",
    version: "v1",
    environmentId: "test",
    health: "healthy",
    sampledAt: now(),
    healthySamples: 10,
    checks: [
      {
        id: "business",
        url: url + "/business",
        json: { path: "result", equals: "ready" },
      },
    ],
  };
  const samples = [32000, 17000, 2000].map((age) => ({
    resourceId: resource.id,
    version: resource.version,
    environmentId: resource.environmentId,
    sampledAt: new Date(Date.now() - age).toISOString(),
    healthy: true,
    method: "http_json",
  }));
  let reviewed = 0;
  const options = {
    resources: async () => [resource],
    observations: async () => samples,
    reviewer: {
      review: async () => {
        reviewed++;
        return affirmative.review();
      },
    },
  };
  const original = structuredClone(samples);
  const mutations = [
    () => samples.splice(0, 1),
    () => {
      samples[1].unavailable = true;
    },
    () => {
      samples[1].healthy = false;
    },
    () => {
      samples[1].version = "old";
    },
    () => {
      samples[1].environmentId = "other";
    },
    () => {
      samples[0].sampledAt = new Date(Date.now() - 60000).toISOString();
    },
    () => {
      samples[2].sampledAt = samples[1].sampledAt;
    },
    () => {
      samples[2].sampledAt = "invalid";
    },
  ];
  for (const mutate of mutations) {
    samples.splice(0, samples.length, ...structuredClone(original));
    mutate();
    assert.equal(
      (await prove(requestFor(resource), options)).verdict,
      "inconclusive",
    );
  }
  assert.equal(reviewed, 0);
  options.observations = async () => {
    throw new Error("platform down");
  };
  assert.equal(
    (await prove(requestFor(resource), options)).verdict,
    "inconclusive",
  );
  assert.equal(reviewed, 0);
});

test("scratchpad plugin persists independent business data across restart and deduplicates writes", async (t) => {
  const dir = await temporary(t);
  const database = join(dir, "notes.sqlite");
  let service = createScratchpadService({ token, database });
  let url = await listen(service.server);
  assert.equal((await fetch(url + "/notes")).status, 401);
  const headers = { ...auth, "Idempotency-Key": "note-create-1" };
  const input = { title: "<script>hello</script>", content: "独立业务数据" };
  const first = await fetch(url + "/notes", {
    method: "POST",
    headers,
    body: JSON.stringify(input),
  }).then((r) => r.json());
  const duplicate = await fetch(url + "/notes", {
    method: "POST",
    headers,
    body: JSON.stringify(input),
  }).then((r) => r.json());
  assert.equal(first.id, duplicate.id);
  assert.equal(
    (
      await fetch(url + "/notes", {
        method: "POST",
        headers,
        body: JSON.stringify({ ...input, content: "changed" }),
      })
    ).status,
    409,
  );
  const workspace = await fetch(url + "/workspace", { headers: auth }).then(
    (r) => r.text(),
  );
  assert.match(workspace, /&lt;script&gt;/);
  assert.doesNotMatch(workspace, /<script>/);
  await service.close();
  service = createScratchpadService({ token, database });
  url = await listen(service.server);
  t.after(() => service.close());
  const read = await fetch(url + "/notes", { headers: auth }).then((r) =>
    r.json(),
  );
  assert.equal(read.notes.length, 1);
  assert.equal(read.notes[0].id, first.id);
  const manifest = await fetch(url + "/manifest", { headers: auth }).then((r) =>
    r.json(),
  );
  assert.equal(manifest.id, "scratchpad");
  assert.equal(manifest.tools.length, 2);
  assert.deepEqual(manifest.events, ["note.created"]);
  const response = await fetch(url + "/events", { headers: auth });
  const reader = response.body.getReader();
  const event = await reader.read();
  assert.match(Buffer.from(event.value).toString(), /event: snapshot/);
  await reader.cancel();
});

test("monitor remains deterministic and reports real failed samples while Pi is unavailable", async (t) => {
  const dir = await temporary(t);
  const fixture = createFaultFixture({ token });
  const fixtureUrl = await listen(fixture.server);
  t.after(() => fixture.close());
  const received = [];
  const resources = [
    {
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
    },
  ];
  const platform = serviceServer(async (req, res) => {
    assert.equal(req.headers.authorization, "Bearer " + token);
    if (req.url === "/internal/resources") return json(res, 200, resources);
    received.push({ path: req.url, data: await body(req) });
    return json(res, 200, { ok: true });
  });
  const platformUrl = await listen(platform);
  t.after(() => closeServer(platform));
  let collector = new MonitorCollector({
    platformUrl,
    platformToken: token,
    database: join(dir, "monitor.sqlite"),
  });
  await collector.collect();
  assert.equal(received[0].data.healthy, false);
  assert.equal(received[0].data.version, "v1");
  assert.match(received[0].data.method, /http_json/);
  assert.equal(collector.samples().length, 1);
  await collector.close();
  collector = new MonitorCollector({
    platformUrl,
    platformToken: token,
    database: join(dir, "monitor.sqlite"),
  });
  t.after(() => collector.close());
  assert.equal(collector.samples().length, 1);
  await fetch(fixtureUrl + "/admin/fault", {
    method: "POST",
    headers: auth,
    body: JSON.stringify({ broken: false }),
  });
  await collector.collect();
  assert.equal(collector.samples()[0].healthy, true);
  await closeServer(platform);
  await collector.collect();
  assert.match(collector.detail, /采集失败/);
});

test("independent prover requires fixed criteria, fresh authoritative samples, and affirmative separate review", async (t) => {
  const fixture = createFaultFixture({ token, mode: "healthy" });
  const url = await listen(fixture.server);
  t.after(() => fixture.close());
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
  const options = { resources: async () => [resource], reviewer: affirmative };
  assert.equal((await prove(requestFor(resource), options)).verdict, "pass");
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
            text: "I think all done",
            reviewConversationId: "23",
          }),
        },
      })
    ).verdict,
    "inconclusive",
  );
  resource.healthySamples = 2;
  assert.equal(
    (await prove(requestFor(resource), options)).verdict,
    "inconclusive",
  );
  resource.healthySamples = 3;
  resource.sampledAt = new Date(Date.now() - 60000).toISOString();
  assert.equal(
    (await prove(requestFor(resource), options)).verdict,
    "inconclusive",
  );
  resource.sampledAt = "invalid";
  assert.equal(
    (await prove(requestFor(resource), options)).verdict,
    "inconclusive",
  );
  resource.sampledAt = now();
  await assert.rejects(
    prove(
      {
        ...requestFor(resource),
        checks: [
          {
            id: "replace",
            url: url + "/health",
            json: { path: "ok", equals: true },
          },
        ],
      },
      options,
    ),
    (err) => err.status === 409,
  );
  await assert.rejects(
    prove({ ...requestFor(resource), version: "old" }, options),
    (err) => err.status === 409,
  );
  await assert.rejects(
    prove(
      {
        ...requestFor(resource),
        requestedAt: new Date(Date.now() - 70000).toISOString(),
      },
      options,
    ),
    (err) => err.status === 400,
  );
  await fetch(url + "/admin/fault", {
    method: "POST",
    headers: auth,
    body: JSON.stringify({ broken: true }),
  });
  assert.equal((await prove(requestFor(resource), options)).verdict, "fail");
});

test("verifier cannot reuse stale checks or pass after the resource changes during review", async (t) => {
  const resource = {
    id: "business",
    version: "v1",
    environmentId: "test",
    health: "healthy",
    sampledAt: now(),
    healthySamples: 3,
    checks: [
      { id: "fixed", url: "http://127.0.0.1:1234/business", contains: "ready" },
    ],
  };
  const options = {
    resources: async () => [resource],
    reviewer: affirmative,
    probe: async (check) => ({
      id: check.id,
      url: check.url,
      passed: true,
      sampledAt: new Date(Date.now() - 1000).toISOString(),
    }),
  };
  assert.equal(
    (await prove(requestFor(resource), options)).verdict,
    "inconclusive",
  );
  options.probe = async (check) => ({
    id: check.id,
    url: check.url,
    passed: true,
    sampledAt: now(),
  });
  options.reviewer = {
    review: async () => {
      resource.version = "v2";
      return affirmative.review();
    },
  };
  assert.equal(
    (await prove(requestFor(resource), options)).verdict,
    "inconclusive",
  );
});

test("verifier HTTP endpoint uses separate token and missing browser capability cannot close a deployed UI incident", async (t) => {
  const resource = {
    id: "ui",
    version: "v1",
    environmentId: "test",
    health: "healthy",
    sampledAt: now(),
    healthySamples: 3,
    checks: [
      {
        id: "real-ui",
        url: "http://127.0.0.1:1/",
        browser: { selector: "main" },
      },
    ],
  };
  const service = createProverService({
    token,
    resources: async () => [resource],
    reviewer: affirmative,
    browser: async (check) => ({
      id: check.id,
      url: check.url,
      passed: false,
      sampledAt: now(),
      unavailable: true,
      detail: "browser missing",
    }),
  });
  const url = await listen(service.server);
  t.after(() => service.close());
  assert.equal(
    (await fetch(url + "/verify", { method: "POST", body: "{}" })).status,
    401,
  );
  const response = await fetch(url + "/verify", {
    method: "POST",
    headers: auth,
    body: JSON.stringify(requestFor(resource)),
  }).then((r) => r.json());
  assert.equal(response.verdict, "inconclusive");
  assert.equal(response.checks[0].passed, false);
});

test("real Pi Durable reviewer has an independent persisted conversation and zero mutation tools", async (t) => {
  const dir = await temporary(t);
  const database = join(dir, "independent-verifier.sqlite");
  const faux = fauxProvider();
  const models = createModels();
  models.setProvider(faux.provider);
  let reviewer = await PiReviewer.open({
    database,
    models,
    model: faux.getModel().id,
    provider: faux.provider.id,
  });
  await assert.rejects(
    PiReviewer.open({
      database,
      models,
      model: faux.getModel().id,
      provider: faux.provider.id,
    }),
    /already has a live owner/,
  );
  faux.setResponses([
    (transcript) => {
      assert.equal(
        (transcript.tools ?? []).length,
        0,
        "model must not receive execution tools",
      );
      return fauxAssistantMessage([
        fauxText(JSON.stringify({ approved: true, summary: "固定证据通过。" })),
      ]);
    },
  ]);
  const first = await reviewer.review({
    resourceId: "service",
    checks: [{ passed: true }],
    healthySamples: 3,
  });
  assert.equal(JSON.parse(first.text).approved, true);
  assert.ok(first.reviewConversationId);
  const conv = await reviewer.harness.conversation(
    Number(first.reviewConversationId),
    context,
  );
  const inspection = await conv.watch(context);
  assert.ok(inspection.value.entries.length > 0);
  await inspection.stop();
  const agent = await conv.agent(context);
  assert.equal(agent.tools.length, 0);
  await reviewer.close();
  reviewer = await PiReviewer.open({
    database,
    models,
    model: faux.getModel().id,
    provider: faux.provider.id,
  });
  t.after(() => reviewer.close());
  const persisted = await reviewer.harness.conversation(
    Number(first.reviewConversationId),
    context,
  );
  assert.ok(persisted);
  faux.setResponses([
    fauxAssistantMessage([
      fauxText(JSON.stringify({ approved: false, summary: "证据不足。" })),
    ]),
  ]);
  const second = await reviewer.review({ resourceId: "service" });
  assert.notEqual(second.reviewConversationId, first.reviewConversationId);
  assert.equal(JSON.parse(second.text).approved, false);
});

test("controlled fixture restart counter persists without touching real infrastructure", async (t) => {
  const dir = await temporary(t);
  const database = join(dir, "fault.sqlite");
  let fixture = createFaultFixture({ token, database });
  let url = await listen(fixture.server);
  assert.equal(
    (await fetch(url + "/business").then((r) => r.json())).ok,
    false,
  );
  await fixture.close();
  fixture = createFaultFixture({ token, database });
  url = await listen(fixture.server);
  t.after(() => fixture.close());
  assert.equal((await fetch(url + "/business").then((r) => r.json())).ok, true);
  assert.equal(fixture.bootCount, 2);
});
