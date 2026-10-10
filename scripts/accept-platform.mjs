import assert from "node:assert/strict";
import { createServer } from "node:http";
import { DatabaseSync } from "node:sqlite";
import { randomBytes, pbkdf2Sync } from "node:crypto";
import { spawn, execFile } from "node:child_process";
import { promisify } from "node:util";
import {
  mkdir,
  copyFile,
  writeFile,
  open,
  stat,
  readFile,
} from "node:fs/promises";
import { resolve, dirname, join } from "node:path";
import { homedir } from "node:os";
import { pathToFileURL } from "node:url";

const execute = promisify(execFile);
const repo = resolve(
  process.env.REFBOX_ACCEPT_REPO ?? resolve(import.meta.dirname, ".."),
);
const runId =
  new Date().toISOString().replace(/[-:.TZ]/g, "") +
  "-" +
  randomBytes(3).toString("hex");
const runDir = resolve(
  process.env.REFBOX_ACCEPT_DIR ?? join(repo, "var", "acceptance-" + runId),
);
const basePort = Number(process.env.REFBOX_ACCEPT_PORT ?? 24800);
if (!Number.isInteger(basePort) || basePort < 24000 || basePort > 49000)
  throw new Error("Use an isolated acceptance port range 24000–49000");
const ports = {
  control: basePort,
  engine: basePort + 1,
  monitor: basePort + 11,
  prover: basePort + 12,
  scratchpad: basePort + 13,
  broker: basePort + 14,
  fixture: basePort + 15,
};
const urls = Object.fromEntries(
  Object.entries(ports).map(([name, port]) => [
    name,
    `http://127.0.0.1:${port}`,
  ]),
);
const uid = process.getuid?.();
if (!Number.isInteger(uid) || uid === 0)
  throw new Error(
    "Run isolated acceptance as the normal Mac user; disposable launchctl jobs need no sudo",
  );
let preferredDomain = `user/${uid}`;
try {
  await execute("/bin/launchctl", ["print", `gui/${uid}`]);
  preferredDomain = `gui/${uid}`;
} catch {}
const domain = process.env.REFBOX_ACCEPT_DOMAIN ?? preferredDomain;
if (!["user/" + uid, "gui/" + uid].includes(domain))
  throw new Error("Acceptance may only use this user's user/gui domain");
const label = "ai.refbox.accept-fixture." + runId;
const target = domain + "/" + label;
const report = {
  startedAt: new Date().toISOString(),
  runId,
  runDir,
  status: "running",
  model: "engy/kimi-k3",
  mode: "real TCP, separate processes, actual launchctl broker, real independent model",
  cases: [],
  evidence: [],
  processes: [],
  cleanup: {},
};
const children = new Map();
let fixtureOwned = false;
let cookie = "";
let interrupted = false;
let configuration;
const now = () => new Date().toISOString();
const sleep = (ms) =>
  new Promise((resolveSleep) => setTimeout(resolveSleep, ms));
const progress = (message) =>
  console.log(JSON.stringify({ at: now(), message }));
const summarize = (snapshot) => ({
  resources: snapshot.resources.map(
    ({ id, health, healthySamples, failures, enabled }) => ({
      id,
      health,
      healthySamples,
      failures,
      enabled,
    }),
  ),
  incidents: snapshot.incidents.map(
    ({ id, resourceId, status, attempts, verification, reason }) => ({
      id,
      resourceId,
      status,
      attempts,
      verification,
      reason,
    }),
  ),
});

async function tcpPreflight() {
  for (const port of Object.values(ports)) {
    const server = createServer();
    try {
      await new Promise((ok, reject) => {
        server.once("error", reject);
        server.listen(port, "127.0.0.1", ok);
      });
    } finally {
      if (server.listening) await new Promise((ok) => server.close(ok));
    }
  }
}
async function waitFor(name, predicate, timeoutMs = 180000) {
  const deadline = Date.now() + timeoutMs;
  let last;
  while (Date.now() < deadline) {
    if (interrupted) throw new Error("Acceptance interrupted");
    try {
      last = await predicate();
      if (last) return last;
    } catch (err) {
      last = err.message;
    }
    await sleep(300);
  }
  throw new Error(
    name + " timed out" + (typeof last === "string" ? ": " + last : ""),
  );
}
async function jsonRequest(
  url,
  { method = "GET", body, headers = {}, status = 200, timeoutMs = 70000 } = {},
) {
  const response = await fetch(url, {
    method,
    headers: {
      ...(body === undefined ? {} : { "Content-Type": "application/json" }),
      ...headers,
    },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(timeoutMs),
  });
  const text = await response.text();
  let value;
  try {
    value = JSON.parse(text);
  } catch {
    throw new Error(
      `Non-JSON from ${new URL(url).pathname} (HTTP ${response.status})`,
    );
  }
  if (status !== undefined && response.status !== status)
    throw new Error(
      `HTTP ${response.status} from ${new URL(url).pathname}: ${String(value.error ?? "unexpected status")}`,
    );
  return { response, value };
}
async function login() {
  const { response } = await jsonRequest(urls.control + "/api/login", {
    method: "POST",
    body: { password: configuration.password },
    headers: { Origin: urls.control, "X-Refbox-Request": "1" },
  });
  cookie = response.headers.get("set-cookie")?.split(";")[0] ?? "";
  assert.ok(cookie, "isolated application session must be established");
}
const api = async (path, options = {}) =>
  (
    await jsonRequest(urls.control + path, {
      ...options,
      headers: {
        Cookie: cookie,
        Origin: urls.control,
        "X-Refbox-Request": "1",
        ...options.headers,
      },
    })
  ).value;
const snapshot = () => api("/api/platform/snapshot");
const fixtureState = () =>
  jsonRequest(urls.fixture + "/state", {
    headers: {
      Authorization: "Bearer " + configuration.env.REFBOX_FAULT_TOKEN,
    },
    timeoutMs: 3000,
  }).then((result) => result.value);
const fixtureFault = (broken) =>
  jsonRequest(urls.fixture + "/admin/fault", {
    method: "POST",
    headers: {
      Authorization: "Bearer " + configuration.env.REFBOX_FAULT_TOKEN,
    },
    body: { broken },
  }).then((result) => result.value);

async function start(name) {
  assert.ok(!children.has(name), name + " already started");
  const programs = {
    control: [join(repo, "bin/refbox"), []],
    broker: [join(repo, "bin/refbox-broker"), []],
    engine: [process.execPath, [join(repo, "apps/runtime/dist/main.js")]],
    monitor: [process.execPath, [join(runDir, "monitor-worker.mjs")]],
    prover: [process.execPath, [join(repo, "apps/services/prover.mjs")]],
    scratchpad: [
      process.execPath,
      [join(repo, "apps/services/scratchpad.mjs")],
    ],
  };
  const log = await open(join(runDir, name + ".log"), "a", 0o600);
  const [program, args] = programs[name];
  const child = spawn(program, args, {
    cwd: repo,
    env: { ...process.env, ...configuration.env },
    stdio: ["ignore", log.fd, log.fd],
  });
  children.set(name, { child, log });
  const record = { name, pid: child.pid, stopped: false };
  report.processes.push(record);
  child.once("exit", (code, signal) => {
    record.stopped = true;
    record.exitCode = code;
    record.signalCode = signal;
  });
  child.once("error", (err) =>
    progress(`${name} could not start: ${err.code ?? "process error"}`),
  );
  return child;
}
async function stop(name) {
  const owner = children.get(name);
  if (!owner) return;
  const child = owner.child;
  if (child.exitCode === null && child.signalCode === null) {
    child.kill("SIGTERM");
    await Promise.race([
      new Promise((ok) => child.once("exit", ok)),
      sleep(5000),
    ]);
    if (child.exitCode === null && child.signalCode === null) {
      child.kill("SIGKILL");
      await Promise.race([
        new Promise((ok) => child.once("exit", ok)),
        sleep(5000),
      ]);
    }
  }
  if (child.pid && child.exitCode === null && child.signalCode === null)
    throw new Error(name + " termination was not confirmed");
  await owner.log.close();
  children.delete(name);
}
async function createConfiguration() {
  await mkdir(runDir, { recursive: true, mode: 0o700 });
  await mkdir(join(runDir, "fixture/lib"), { recursive: true, mode: 0o700 });
  for (const file of ["fault-fixture.mjs", "lib/http.mjs"])
    await copyFile(
      join(repo, "apps/services", file),
      join(runDir, "fixture", file),
    );
  const password = randomBytes(26).toString("base64url");
  const salt = randomBytes(16);
  const hash = `pbkdf2-sha256$100000$${salt.toString("base64url")}$${pbkdf2Sync(password, salt, 100000, 32, "sha256").toString("base64url")}`;
  const env = {
    REFBOX_ENGINE_TOKEN: randomBytes(32).toString("hex"),
    REFBOX_PLATFORM_TOKEN: randomBytes(32).toString("hex"),
    REFBOX_BROKER_TOKEN: randomBytes(32).toString("hex"),
    REFBOX_MONITOR_TOKEN: randomBytes(32).toString("hex"),
    REFBOX_VERIFIER_TOKEN: randomBytes(32).toString("hex"),
    REFBOX_SCRATCHPAD_TOKEN: randomBytes(32).toString("hex"),
    REFBOX_FAULT_TOKEN: randomBytes(32).toString("hex"),
    REFBOX_PASSWORD_HASH: hash,
    REFBOX_MODEL: "kimi-k3",
    PI_PROFILE_DIR: process.env.PI_PROFILE_DIR ?? join(homedir(), ".pi/agent"),
    REFBOX_SECURE_COOKIE: "false",
    REFBOX_AUTO_REPAIR: "true",
    REFBOX_PLUGIN_MANIFESTS: "[]",
    REFBOX_ENVIRONMENT_ID: "isolated-acceptance",
    REFBOX_PUBLIC_URL: "",
    REFBOX_VERIFY_PASSWORD: password,
    REFBOX_LISTEN: `127.0.0.1:${ports.control}`,
    REFBOX_ENGINE_PORT: String(ports.engine),
    REFBOX_MONITOR_PORT: String(ports.monitor),
    REFBOX_VERIFIER_PORT: String(ports.prover),
    REFBOX_SCRATCHPAD_PORT: String(ports.scratchpad),
    REFBOX_BROKER_LISTEN: `127.0.0.1:${ports.broker}`,
    REFBOX_FAULT_PORT: String(ports.fixture),
    REFBOX_ENGINE_URL: urls.engine,
    REFBOX_PLATFORM_URL: urls.control,
    REFBOX_VERIFIER_URL: urls.prover,
    REFBOX_BROKER_URL: urls.broker,
    REFBOX_WEB_DIR: join(repo, "apps/web/dist"),
    REFBOX_DATABASE: join(runDir, "engine.sqlite"),
    REFBOX_PLATFORM_DATABASE: join(runDir, "platform.sqlite"),
    REFBOX_MONITOR_DATABASE: join(runDir, "monitor.sqlite"),
    REFBOX_VERIFIER_DATABASE: join(runDir, "verifier.sqlite"),
    REFBOX_SCRATCHPAD_DATABASE: join(runDir, "scratchpad.sqlite"),
    REFBOX_BROKER_DATABASE: join(runDir, "broker.sqlite"),
    REFBOX_FAULT_DATABASE: join(runDir, "fault.sqlite"),
    REFBOX_BROKER_SERVICES: JSON.stringify({ fixture: { domain, label } }),
  };
  configuration = { password, env };
  await writeFile(
    join(runDir, "configuration.private.json"),
    JSON.stringify(configuration),
    { mode: 0o600 },
  );
  const monitorModule = pathToFileURL(
    join(repo, "apps/services/monitor.mjs"),
  ).href;
  const worker = `import {createMonitorService} from ${JSON.stringify(monitorModule)}; const env=process.env; const app=createMonitorService({token:env.REFBOX_MONITOR_TOKEN,platformToken:env.REFBOX_PLATFORM_TOKEN,platformUrl:env.REFBOX_PLATFORM_URL,database:env.REFBOX_MONITOR_DATABASE,selfUrl:'http://127.0.0.1:'+env.REFBOX_MONITOR_PORT,intervalMs:500,env}); await new Promise((ok,reject)=>{app.server.once('error',reject);app.server.listen(Number(env.REFBOX_MONITOR_PORT),'127.0.0.1',ok)}); app.collector.start(); let stopping=false; const stop=async()=>{if(stopping)return;stopping=true;await app.close();process.exit(0)}; process.on('SIGTERM',()=>void stop()); process.on('SIGINT',()=>void stop());`;
  await writeFile(join(runDir, "monitor-worker.mjs"), worker, { mode: 0o600 });
}
const xml = (value) =>
  String(value).replace(
    /[&<>"']/g,
    (ch) =>
      ({
        "&": "&amp;",
        "<": "&lt;",
        ">": "&gt;",
        '"': "&quot;",
        "'": "&apos;",
      })[ch],
  );
async function installFixture(mode = "recover") {
  if (fixtureOwned) {
    await execute("/bin/launchctl", ["bootout", target]);
    fixtureOwned = false;
    await sleep(300);
  }
  const fixtureEnv = Object.fromEntries(
    ["REFBOX_FAULT_TOKEN", "REFBOX_FAULT_PORT", "REFBOX_FAULT_DATABASE"].map(
      (key) => [key, configuration.env[key]],
    ),
  );
  fixtureEnv.REFBOX_FAULT_MODE = mode;
  const dictionary = Object.entries(fixtureEnv)
    .map(
      ([key, value]) => `<key>${xml(key)}</key><string>${xml(value)}</string>`,
    )
    .join("");
  const plist = `<?xml version="1.0" encoding="UTF-8"?><!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd"><plist version="1.0"><dict><key>Label</key><string>${xml(label)}</string><key>ProgramArguments</key><array><string>${xml(process.execPath)}</string><string>${xml(join(runDir, "fixture/fault-fixture.mjs"))}</string></array><key>EnvironmentVariables</key><dict>${dictionary}</dict><key>WorkingDirectory</key><string>${xml(runDir)}</string><key>RunAtLoad</key><true/><key>KeepAlive</key><true/><key>ThrottleInterval</key><integer>1</integer><key>StandardOutPath</key><string>${xml(join(runDir, "fixture.log"))}</string><key>StandardErrorPath</key><string>${xml(join(runDir, "fixture.log"))}</string></dict></plist>`;
  const path = join(runDir, "fixture.plist");
  await writeFile(path, plist, { mode: 0o600 });
  await execute("/bin/launchctl", ["bootstrap", domain, path]);
  fixtureOwned = true;
  await waitFor("disposable fixture startup", () => fixtureState(), 20000);
}
async function saveReport() {
  await writeFile(
    join(runDir, "report.json"),
    JSON.stringify(report, null, 2),
    { mode: 0o600 },
  );
}
async function passed(name, data = {}) {
  report.cases.push({ name, status: "passed", at: now(), ...data });
  progress("Passed: " + name);
  await saveReport();
}
async function collectEvidence(incidentId) {
  const state = await snapshot();
  const evidence = state.evidence.filter(
    (item) => item.incidentId === incidentId,
  );
  report.evidence.push(...evidence);
  await saveReport();
  return evidence;
}
async function waitIncident(
  name,
  previousIds = [],
  desired = () => true,
  timeoutMs = 180000,
) {
  return waitFor(
    name,
    async () => {
      const state = await snapshot();
      const incident = state.incidents.find(
        (item) =>
          item.resourceId === "controlled-service" &&
          !previousIds.includes(item.id),
      );
      return incident && desired(incident, state) ? { incident, state } : false;
    },
    timeoutMs,
  );
}

async function run() {
  await tcpPreflight();
  for (const file of [
    "bin/refbox",
    "bin/refbox-broker",
    "apps/runtime/dist/main.js",
    "apps/runtime/dist/provider.js",
    "apps/web/dist/index.html",
  ])
    assert.ok(
      (await stat(join(repo, file))).isFile(),
      "Build required: " + file,
    );
  await createConfiguration();
  progress(
    "Isolated real service acceptance started; generated credentials remain private.",
  );
  await installFixture("recover");
  await start("broker");
  await start("control");
  await start("engine");
  await start("prover");
  await start("scratchpad");
  await waitFor(
    "control health",
    () =>
      jsonRequest(urls.control + "/health", { timeoutMs: 1000 }).then(
        (r) => r.value.ok,
      ),
    30000,
  );
  await waitFor(
    "executor readiness",
    () =>
      jsonRequest(urls.engine + "/api/health", {
        headers: {
          Authorization: "Bearer " + configuration.env.REFBOX_ENGINE_TOKEN,
        },
        timeoutMs: 1000,
      }).then((r) => r.value.readiness === "ready"),
    30000,
  );
  await waitFor(
    "real independent model availability",
    () =>
      jsonRequest(urls.prover + "/health", {
        headers: {
          Authorization: "Bearer " + configuration.env.REFBOX_VERIFIER_TOKEN,
        },
        timeoutMs: 1000,
      }).then((r) => r.value.reviewerAvailable),
    30000,
  );
  await waitFor(
    "scratchpad readiness",
    () =>
      jsonRequest(urls.scratchpad + "/health", {
        headers: {
          Authorization: "Bearer " + configuration.env.REFBOX_SCRATCHPAD_TOKEN,
        },
        timeoutMs: 1000,
      }).then((r) => r.value.ok),
    10000,
  );
  await login();
  await api("/api/platform/plugins", {
    method: "POST",
    body: {
      manifestUrl: urls.fixture + "/manifest",
      credentialEnv: "REFBOX_FAULT_TOKEN",
    },
    status: 201,
  });
  await api("/api/platform/plugins", {
    method: "POST",
    body: {
      manifestUrl: urls.scratchpad + "/manifest",
      credentialEnv: "REFBOX_SCRATCHPAD_TOKEN",
    },
    status: 201,
  });
  const draft = await api("/api/platform/tasks", {
    method: "POST",
    body: {
      title: "隔离验收草稿",
      goal: "保留上下文供平台离线检查；不规划或执行",
      cwd: runDir,
      model: "kimi-k3",
    },
    status: 201,
    headers: { "Idempotency-Key": "accept-create-" + runId },
  });
  assert.notEqual(draft.id, draft.conversationId);
  await stop("engine");
  await waitFor(
    "Pi offline state",
    async () => {
      const current = await snapshot();
      return current.tasks.some(
        (task) => task.id === draft.id && !task.engineAvailable,
      );
    },
    20000,
  );
  assert.equal((await jsonRequest(urls.control + "/health")).value.ok, true);
  const sse = await fetch(urls.control + "/api/platform/events", {
    headers: { Cookie: cookie },
    signal: AbortSignal.timeout(5000),
  });
  const reader = sse.body.getReader();
  assert.match(
    new TextDecoder().decode((await reader.read()).value),
    /event: snapshot/,
  );
  await reader.cancel();
  await passed(
    "Pi down: platform snapshot, cached business task and independent SSE remain available",
    { taskId: draft.id, conversationId: draft.conversationId },
  );
  const broken = await jsonRequest(urls.fixture + "/business");
  assert.equal(broken.response.status, 200);
  assert.equal(broken.value.result, "broken");
  await start("monitor");
  const opened = await waitIncident("two actual failed probes open incident");
  const sampleDb = new DatabaseSync(configuration.env.REFBOX_MONITOR_DATABASE, {
    readOnly: true,
  });
  const failedBeforeOpen = sampleDb
    .prepare("SELECT payload FROM samples WHERE resource_id=? ORDER BY id")
    .all("controlled-service")
    .map((row) => JSON.parse(row.payload))
    .filter(
      (sample) =>
        !sample.healthy &&
        !sample.unavailable &&
        Date.parse(sample.sampledAt) <= Date.parse(opened.incident.openedAt),
    );
  sampleDb.close();
  assert.ok(
    failedBeforeOpen.length >= 2,
    "incident requires two actual failed functional samples before opening",
  );
  const closed = await waitIncident(
    "real broker restart and independent Engy proof",
    [],
    (incident) =>
      incident.status === "closed" && incident.verification === "pass",
    180000,
  );
  assert.equal(closed.incident.id, opened.incident.id);
  assert.equal(closed.incident.attempts, 1);
  const recovered = await fixtureState();
  assert.equal(recovered.broken, false);
  assert.equal(recovered.bootCount, 2);
  const firstEvidence = await collectEvidence(closed.incident.id);
  const proof = firstEvidence.find((item) => item.verdict === "pass");
  assert.ok(proof?.reviewConversationId);
  assert.equal(JSON.parse(proof.review).approved, true);
  assert.ok(proof.checks.every((check) => check.passed));
  const reviewDb = new DatabaseSync(
    configuration.env.REFBOX_VERIFIER_DATABASE,
    { readOnly: true },
  );
  assert.equal(
    reviewDb
      .prepare("SELECT COUNT(*) AS count FROM conversations WHERE id=?")
      .get(Number(proof.reviewConversationId)).count,
    1,
  );
  assert.equal(
    reviewDb
      .prepare(
        "SELECT COUNT(*) AS count FROM entries WHERE json_extract(record,'$.kind') LIKE 'pi.tool%'",
      )
      .get().count,
    0,
  );
  reviewDb.close();
  await passed(
    "HTTP 200 broken business: two real failures, named launchctl restart, three healthy samples and actual independent model proof close incident",
    {
      incidentId: closed.incident.id,
      actionId: closed.incident.actionId,
      reviewConversationId: proof.reviewConversationId,
      bootCount: recovered.bootCount,
    },
  );

  await stop("prover");
  await fixtureFault(true);
  const unavailable = await waitIncident(
    "verifier unavailable cannot close incident",
    [closed.incident.id],
    (incident, state) =>
      incident.verification === "inconclusive" &&
      incident.status === "attention" &&
      state.resources.find((resource) => resource.id === "controlled-service")
        .healthySamples >= 3,
  );
  assert.equal(unavailable.incident.attempts, 1);
  await collectEvidence(unavailable.incident.id);
  await passed("Unavailable verifier leaves recovered business unclosed", {
    incidentId: unavailable.incident.id,
    verification: unavailable.incident.verification,
  });
  await start("prover");
  await waitFor(
    "independent reviewer restarted",
    () =>
      jsonRequest(urls.prover + "/health", {
        headers: {
          Authorization: "Bearer " + configuration.env.REFBOX_VERIFIER_TOKEN,
        },
        timeoutMs: 2000,
      }).then((r) => r.value.reviewerAvailable),
    20000,
  );
  await api("/api/platform/incidents/" + unavailable.incident.id + "/verify", {
    method: "POST",
    body: {},
  });
  const retried = (await snapshot()).incidents.find(
    (incident) => incident.id === unavailable.incident.id,
  );
  assert.equal(retried.status, "closed");
  assert.equal(retried.verification, "pass");
  await collectEvidence(retried.id);
  await passed(
    "Independent verifier restart plus explicit fresh proof closes prior inconclusive incident",
    { incidentId: retried.id },
  );

  const note = await api("/api/platform/plugins/scratchpad/tools/create-note", {
    method: "POST",
    body: { title: "隔离验收笔记", content: "独立业务数据由插件持久化" },
    status: 201,
    headers: { "Idempotency-Key": "accept-note-" + runId },
  });
  const notes = await api("/api/platform/plugins/scratchpad/tools/list-notes", {
    method: "POST",
    body: {},
  });
  assert.ok(notes.notes.some((item) => item.id === note.id));
  await waitFor(
    "plugin event reaches platform",
    async () =>
      (await snapshot()).events.some(
        (event) => event.kind === "plugin.scratchpad.note.created",
      ),
    15000,
  );
  await api("/api/platform/plugins/scratchpad/enable", {
    method: "POST",
    body: { enabled: false },
  });
  await sleep(1500);
  const disabled = await snapshot();
  assert.equal(
    disabled.plugins.find((plugin) => plugin.id === "scratchpad").enabled,
    false,
  );
  assert.equal(
    disabled.resources.find((resource) => resource.id === "scratchpad-service")
      .enabled,
    false,
  );
  await api("/api/platform/plugins/scratchpad/enable", {
    method: "POST",
    body: { enabled: true },
  });
  await waitFor(
    "scratchpad resampled",
    async () =>
      (await snapshot()).resources.find(
        (resource) => resource.id === "scratchpad-service",
      ).healthySamples >= 3,
    10000,
  );
  await stop("scratchpad");
  await waitFor(
    "plugin offline remains visible",
    async () =>
      (await snapshot()).plugins.find((plugin) => plugin.id === "scratchpad")
        .online === false,
    20000,
  );
  await passed(
    "Unrelated plugin persists data, emits a real SSE event, disables independently and stays visible offline",
    { noteId: note.id },
  );

  await stop("monitor");
  progress("Waiting 46 seconds to validate actual stale-sample handling.");
  await sleep(46000);
  const stale = await snapshot();
  assert.equal(
    stale.resources.find((resource) => resource.id === "controlled-service")
      .health,
    "stale",
  );
  await passed(
    "Collector offline: prior resource sample becomes stale and platform remains available",
  );

  const priorIds = (await snapshot()).incidents.map((incident) => incident.id);
  await installFixture("always-broken");
  const beforeRetries = await fixtureState();
  await start("monitor");
  const exhausted = await waitIncident(
    "always broken exhausts exactly two restarts",
    priorIds,
    (incident) => incident.attempts === 2 && incident.status === "attention",
    120000,
  );
  const afterRetries = await fixtureState();
  assert.equal(afterRetries.bootCount, beforeRetries.bootCount + 2);
  assert.equal(afterRetries.broken, true);
  await sleep(11000);
  assert.equal((await fixtureState()).bootCount, afterRetries.bootCount);
  const denied = await jsonRequest(
    urls.control +
      "/api/platform/incidents/" +
      exhausted.incident.id +
      "/repair",
    {
      method: "POST",
      body: {},
      status: 409,
      headers: {
        Cookie: cookie,
        Origin: urls.control,
        "X-Refbox-Request": "1",
      },
    },
  );
  assert.match(denied.value.error, /two restarts/);
  await passed(
    "Always broken: exactly two real launchctl restarts, escalation, stable boot count and third repair rejected",
    {
      incidentId: exhausted.incident.id,
      attempts: 2,
      bootCount: afterRetries.bootCount,
    },
  );
  await stop("control");
  await start("control");
  await waitFor(
    "platform restarted",
    () =>
      jsonRequest(urls.control + "/health", { timeoutMs: 1000 }).then(
        (r) => r.value.ok,
      ),
    20000,
  );
  await login();
  const preserved = await snapshot();
  const kept = preserved.incidents.find(
    (incident) => incident.id === exhausted.incident.id,
  );
  assert.equal(kept.attempts, 2);
  assert.equal(kept.status, "attention");
  assert.ok(preserved.evidence.some((item) => item.id === proof.id));
  assert.ok(
    preserved.tasks.some(
      (task) =>
        task.id === draft.id && task.conversationId === draft.conversationId,
    ),
  );
  await jsonRequest(urls.broker + "/restart", {
    method: "POST",
    headers: {
      Authorization: "Bearer " + configuration.env.REFBOX_BROKER_TOKEN,
    },
    body: { serviceId: "fixture", actionId: kept.actionId },
  });
  assert.equal((await fixtureState()).bootCount, afterRetries.bootCount);
  await passed(
    "Platform restart preserves task/history/repair budget; broker action replay does not repeat restart",
    { incidentId: kept.id, attempts: kept.attempts },
  );
  report.snapshot = summarize(preserved);
  report.status = "passed";
}
async function cleanup() {
  report.cleanup.errors = [];
  for (const name of [
    "monitor",
    "prover",
    "scratchpad",
    "engine",
    "control",
    "broker",
  ])
    await stop(name).catch((err) =>
      report.cleanup.errors.push(name + ": " + err.message),
    );
  if (fixtureOwned) {
    try {
      await execute("/bin/launchctl", ["bootout", target]);
      report.cleanup.fixtureRemoved = true;
      fixtureOwned = false;
    } catch {
      report.cleanup.fixtureRemoved = false;
      report.cleanup.fixtureTarget = target;
      report.cleanup.errors.push("fixture bootout was not confirmed");
    }
  }
  report.cleanup.fixtureRemoved = false;
  for (let i = 0; i < 50; i++) {
    try {
      await execute("/bin/launchctl", ["print", target]);
    } catch (err) {
      if (
        /Could not find service|Could not find specified service|service not found/i.test(
          err.stderr ?? "",
        )
      ) {
        report.cleanup.fixtureRemoved = true;
        break;
      }
      report.cleanup.errors.push("fixture absence was not confirmed");
      break;
    }
    await sleep(200);
  }
  if (!report.cleanup.fixtureRemoved && report.cleanup.errors.length === 0)
    report.cleanup.errors.push("fixture remained registered after shutdown");
  report.cleanup.childProcessesStopped =
    children.size === 0 && report.processes.every((record) => record.stopped);
  if (
    !report.cleanup.childProcessesStopped ||
    !report.cleanup.fixtureRemoved ||
    report.cleanup.errors.length
  ) {
    report.status = "failed";
    report.cleanupError = "Acceptance cleanup was not confirmed";
    report.error ??= report.cleanupError;
    process.exitCode = 1;
  }
}
process.on("SIGINT", () => {
  interrupted = true;
});
process.on("SIGTERM", () => {
  interrupted = true;
});
try {
  await run();
} catch (err) {
  report.status = "failed";
  report.error = err.message;
  progress("Acceptance failed: " + err.message);
  process.exitCode = 1;
} finally {
  await mkdir(runDir, { recursive: true, mode: 0o700 });
  await cleanup();
  report.finishedAt = now();
  await saveReport();
  progress(
    `Acceptance ${report.status}; report: ${join(runDir, "report.json")}`,
  );
}
