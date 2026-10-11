import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import {
  copyFile,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  realpath,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { dirname, isAbsolute, join, relative, sep } from "node:path";
import { tmpdir } from "node:os";
import { isDeepStrictEqual } from "node:util";
import { HttpError, now } from "./http.mjs";

const hash = (value) => createHash("sha256").update(value).digest("hex");
const ids = /^[a-zA-Z0-9_-]{1,200}$/;
const commandIds = new Set(["tests", "build", "ui", "diff"]);
const forbidden = (path) =>
  path
    .split("/")
    .some(
      (part) =>
        part.toLowerCase() !== ".env.example" &&
        /^(?:\.git|node_modules|\.aws|\.cloudflared|\.env(?:\..*)?|auth\.json|credentials(?:\.json)?|configuration\.private\.json|bootstrap-password\.txt)$/i.test(
          part,
        ),
    ) || /\.(?:sqlite|sqlite3|db)(?:-wal|-shm)?$/i.test(path);
const relativeFile = (path) =>
  typeof path === "string" &&
  path.length > 0 &&
  path.length <= 500 &&
  !isAbsolute(path) &&
  !path.includes("\\") &&
  !path.includes("\0") &&
  !path.includes(":") &&
  path.split("/").every((part) => part && part !== "." && part !== "..") &&
  !forbidden(path);
const bounded = (text, max = 16384) =>
  Buffer.from(text).subarray(0, max).toString("utf8");

/**
 * 为独立固定验收失败的 check 生成可定位、脱敏、限长原因，帮助执行 Agent 在
 * 原冻结方案下自我修复，而不是只看到 check ID。reason 来源是真实 witness，
 * 已经过 sanitizer 脱敏（凭据替换为 [REDACTED]），整体长度由调用方 2000 上限把关。
 */
const SUMMARY_LIMIT = 2000;
const snippet = (text, max) => {
  const normalized = String(text ?? "").replace(/\s+/g, " ").trim();
  return normalized.length <= max ? normalized : `${normalized.slice(0, max)}…`;
};

export function failedCheckFeedback(check, definition = check) {
  // check 为 proveGoalResult 生成的 result；definition 为冻结契约中的原始 check 描述。
  if (check.unavailable)
    return `验证能力不可用：${snippet(check.detail || check.witness?.error || "独立验证环境异常", 300)}`;
  if (check.kind !== "command") {
    if (check.detail) return `文件检查异常：${snippet(check.detail, 300)}`;
    const witness = check.witness ?? {};
    if (!witness.sha256) return `文件缺失或不可读：${snippet(definition.path ?? witness.path ?? "未知路径", 200)}`;
    if (check.kind === "file_contains")
      return `文件缺少期望内容（截断展示）：${snippet(JSON.stringify(definition.contains ?? ""), 200)}`;
    if (check.kind === "json_equals")
      return `JSON 字段不匹配：期望 ${snippet(JSON.stringify(definition.equals), 200)}，实际 ${snippet(witness.observedJson ?? "undefined", 200)}`;
    return "固定文件验收未通过";
  }
  const witness = check.witness ?? {};
  if (witness.fixtureCoverageFailure)
    return `缺失冻结测试：${snippet(witness.fixtureCoverageFailure, 400)}`;
  if (check.detail) return `命令执行异常：${snippet(check.detail, 400)}`;
  const parts = [];
  if (typeof witness.exitCode === "number")
    parts.push(`退出码 ${witness.exitCode}`);
  if (witness.timedOut) parts.push("超时");
  if (witness.unavailable) parts.push("执行不可用");
  const stderr = snippet(witness.stderr ?? "", 300);
  if (stderr) parts.push(`stderr: ${stderr}`);
  else {
    // node --test 等运行器把失败详情写到 stdout。
    const stdout = snippet(witness.stdout ?? "", 300);
    if (stdout) parts.push(`stdout: ${stdout}`);
  }
  return parts.length ? parts.join("；") : "命令未通过且无输出";
}

export function validateGoalChecks(checks) {
  if (!Array.isArray(checks) || !checks.length || checks.length > 32)
    throw new HttpError(400, "目标需要 1–32 个固定验收项。");
  const seen = new Set();
  const seenCommands = new Set();
  return checks.map((check) => {
    if (
      !check ||
      typeof check !== "object" ||
      !ids.test(check.id ?? "") ||
      seen.has(check.id)
    )
      throw new HttpError(400, "验收项 ID 无效或重复。");
    seen.add(check.id);
    const result = { id: check.id, kind: check.kind };
    let allowed;
    if (check.kind === "command") {
      if (!commandIds.has(check.command))
        throw new HttpError(
          400,
          "独立验证只允许固定 command ID: tests/build/ui/diff。",
        );
      if (seenCommands.has(check.command))
        throw new HttpError(400, "固定命令验收不能重复计数。");
      seenCommands.add(check.command);
      result.command = check.command;
      allowed = ["id", "kind", "command"];
    } else {
      if (!relativeFile(check.path))
        throw new HttpError(
          400,
          "验收路径必须是无逃逸、无凭据的工作区相对文件路径。",
        );
      result.path = check.path;
      if (check.kind === "file_exists") allowed = ["id", "kind", "path"];
      else if (check.kind === "file_contains") {
        if (
          typeof check.contains !== "string" ||
          !check.contains ||
          check.contains.length > 8192
        )
          throw new HttpError(400, "file_contains 必须有固定的非空内容标准。");
        result.contains = check.contains;
        allowed = ["id", "kind", "path", "contains"];
      } else if (check.kind === "json_equals") {
        if (
          typeof check.jsonPath !== "string" ||
          !/^[a-zA-Z0-9_-]+(?:\.[a-zA-Z0-9_-]+)*$/.test(check.jsonPath) ||
          check.jsonPath
            .split(".")
            .some((key) =>
              ["__proto__", "constructor", "prototype"].includes(key),
            ) ||
          !Object.hasOwn(check, "equals") ||
          typeof JSON.stringify(check.equals) !== "string" ||
          JSON.stringify(check.equals).length > 8192
        )
          throw new HttpError(
            400,
            "json_equals 必须有固定字段路径和 JSON 期望值。",
          );
        result.jsonPath = check.jsonPath;
        result.equals = check.equals;
        allowed = ["id", "kind", "path", "jsonPath", "equals"];
      } else throw new HttpError(400, "未知的目标验收类型。");
    }
    if (Object.keys(check).some((key) => !allowed.includes(key)))
      throw new HttpError(400, "验收项不能注入命令参数、环境或替代路径。");
    return result;
  });
}

export function reviewDecision(text) {
  if (typeof text !== "string" || text.length > 12000) return null;
  const response = text.trim();
  const fence = response.match(/^```json[ \t]*\r?\n([\s\S]*?)\r?\n```$/);
  try {
    const decision = JSON.parse(fence ? fence[1] : response);
    return decision &&
      !Array.isArray(decision) &&
      typeof decision.approved === "boolean" &&
      typeof decision.summary === "string" &&
      decision.summary.trim()
      ? decision
      : null;
  } catch {
    return null;
  }
}

function sanitizer(env) {
  const secrets = Object.entries(env)
    .filter(
      ([key, value]) =>
        /token|secret|password|api.?key|credential|authorization/i.test(key) &&
        typeof value === "string" &&
        value.length >= 6,
    )
    .map(([, value]) => value);
  return (text) => {
    for (const value of secrets) text = text.split(value).join("[REDACTED]");
    return text
      .replace(/\bBearer\s+[a-zA-Z0-9_.-]+/gi, "Bearer [REDACTED]")
      .replace(/\bsk-[a-zA-Z0-9_-]{12,}/g, "[REDACTED]")
      .replace(
        /((?:api[_-]?key|password|secret|token)\s*[=:]\s*)(?:"[^"\n]+"|'[^'\n]+'|[^\s,;}]+)/gi,
        "$1[REDACTED]",
      );
  };
}

function safeEnvironment(env, scratch) {
  const clean = {};
  for (const key of [
    "PATH",
    "HOME",
    "USER",
    "LOGNAME",
    "TMPDIR",
    "LANG",
    "LC_ALL",
    "GOCACHE",
    "GOROOT",
    "GOMODCACHE",
    "GOPATH",
  ])
    if (env[key]) clean[key] = env[key];
  clean.PATH =
    dirname(process.execPath) +
    ":" +
    (clean.PATH ?? "/usr/bin:/bin:/usr/sbin:/sbin:/opt/homebrew/bin");
  clean.NPM_CONFIG_USERCONFIG = join(scratch, "empty-config");
  clean.NPM_CONFIG_CACHE = join(scratch, "npm-cache");
  clean.GIT_CONFIG_GLOBAL = join(scratch, "empty-config");
  clean.GIT_CONFIG_NOSYSTEM = "1";
  clean.CI = "true";
  return clean;
}

async function run(
  executable,
  args,
  { cwd, env, redact, timeoutMs = 240000, limit = 32768 } = {},
) {
  const startedAt = now();
  let stdout = Buffer.alloc(0),
    stderr = Buffer.alloc(0),
    stdoutBytes = 0,
    stderrBytes = 0;
  const stdoutHash = createHash("sha256"),
    stderrHash = createHash("sha256");
  const passedGoTests = new Set();
  let goOutputLine = "";
  let timedOut = false;
  const child = spawn(executable, args, {
    cwd,
    env,
    detached: process.platform !== "win32",
    stdio: ["ignore", "pipe", "pipe"],
  });
  child.stdout.on("data", (chunk) => {
    stdoutHash.update(chunk);
    stdoutBytes += chunk.length;
    stdout = Buffer.concat([stdout, chunk]).subarray(-limit);
    goOutputLine += chunk.toString();
    const lines = goOutputLine.split("\n");
    goOutputLine = lines.pop().slice(-16384);
    for (const line of lines) {
      const match = line.match(/^--- PASS: (Test[A-Za-z0-9_]+)(?:\s|$)/);
      if (match) passedGoTests.add(match[1]);
    }
  });
  child.stderr.on("data", (chunk) => {
    stderrHash.update(chunk);
    stderrBytes += chunk.length;
    stderr = Buffer.concat([stderr, chunk]).subarray(-limit);
  });
  const kill = () => {
    try {
      process.kill(
        process.platform === "win32" ? child.pid : -child.pid,
        "SIGKILL",
      );
    } catch {}
  };
  const timer = setTimeout(() => {
    timedOut = true;
    kill();
  }, timeoutMs);
  let code, signal, error;
  try {
    ({ code, signal, error } = await new Promise((done) => {
      child.once("error", (err) => done({ code: null, error: err.message }));
      child.once("close", (code, signal) => done({ code, signal }));
    }));
  } finally {
    clearTimeout(timer);
  }
  return {
    argv: [executable, ...args],
    cwd,
    startedAt,
    completedAt: now(),
    exitCode: code ?? -1,
    signal: signal ?? "",
    timedOut,
    ...(error ? { unavailable: true, error: redact(error) } : {}),
    stdout: redact(stdout.toString()),
    stderr: redact(stderr.toString()),
    stdoutBytes,
    stderrBytes,
    stdoutSha256: stdoutHash.digest("hex"),
    stderrSha256: stderrHash.digest("hex"),
    outputTruncated: stdoutBytes > limit || stderrBytes > limit,
    passedGoTests: [...passedGoTests],
  };
}

async function git(cwd, args, options) {
  const result = await run(
    "git",
    ["--no-pager", "-c", "core.hooksPath=/dev/null", ...args],
    { ...options, cwd, timeoutMs: 30000, limit: 512000 },
  );
  if (result.exitCode !== 0)
    throw new Error(
      "Git candidate operation failed: " + result.stderr.slice(0, 500),
    );
  if (result.outputTruncated)
    throw new Error("Git candidate metadata exceeds bounded evidence limits");
  return result.stdout;
}

async function plainFiles(root) {
  const files = [];
  let size = 0;
  async function visit(folder, prefix = "") {
    for (const entry of await readdir(folder, { withFileTypes: true })) {
      const name = prefix ? prefix + "/" + entry.name : entry.name;
      if (forbidden(name)) continue;
      const path = join(folder, entry.name);
      const info = await lstat(path);
      if (info.isSymbolicLink())
        throw new Error("Candidate contains a symlink: " + name);
      if (info.isDirectory()) await visit(path, name);
      else if (info.isFile()) {
        size += info.size;
        if (
          size > 50 * 1024 * 1024 ||
          files.length >= 2000 ||
          info.size > 8 * 1024 * 1024
        )
          throw new Error("Candidate exceeds bounded snapshot limits");
        files.push(name);
      }
    }
  }
  await visit(root);
  return files.sort();
}

async function fileWitness(root, path, redact) {
  if (!relativeFile(path)) throw new Error("Unsafe artifact path");
  root = await realpath(root);
  let current = root;
  for (const part of path.split("/")) {
    current = join(current, part);
    const info = await lstat(current);
    if (info.isSymbolicLink())
      throw new Error("Artifact path contains a symlink");
  }
  const resolved = await realpath(current);
  if (!resolved.startsWith(root + sep) || !(await lstat(resolved)).isFile())
    throw new Error("Artifact escapes snapshot or is not a file");
  const bytes = await readFile(resolved);
  if (bytes.length > 8 * 1024 * 1024)
    throw new Error("Artifact exceeds evidence limit");
  return {
    path,
    bytes: bytes.length,
    sha256: hash(bytes),
    text: redact(bounded(bytes, 16384)),
    textTruncated: bytes.length > 16384,
    fullText: bytes.toString("utf8"),
  };
}

async function manifestHash(root, paths) {
  const entries = [];
  for (const path of paths)
    entries.push([path, hash(await readFile(join(root, path)))]);
  return hash(JSON.stringify(entries));
}

const frozenValidationPath = (path) =>
  /(?:^|\/)(?:test|tests|__tests__|fixtures)\//.test(path) ||
  /(?:_test\.go|\.(?:test|spec)\.[cm]?[jt]sx?)$/.test(path) ||
  /(?:^|\/)(?:package(?:-lock)?\.json|npm-shrinkwrap\.json|go\.mod|go\.sum|tsconfig(?:\.[^/]*)?\.json|(?:vite|vitest|playwright)\.config\.[^/]+)$/.test(
    path,
  );

async function prepareTrustedValidation({
  scratch,
  source,
  candidate,
  context,
  env,
  options,
}) {
  const repository =
    env.REFBOX_GOAL_TRUSTED_BASELINE_REPOSITORY ??
    context.sourceRepository ??
    source;
  const revision =
    env.REFBOX_GOAL_TRUSTED_BASELINE_REVISION ?? context.baselineRevision;
  if (!isAbsolute(repository) || !/^[a-f0-9]{40,64}$/.test(revision ?? ""))
    throw new Error(
      "Independent command checks require an administrator-pinned trusted baseline repository and revision",
    );
  const trusted = join(scratch, "trusted-baseline");
  const verification = join(scratch, "verification");
  for (const [from, target, ref] of [
    [repository, trusted, revision],
    [
      candidate,
      verification,
      (await git(candidate, ["rev-parse", "HEAD"], options)).trim(),
    ],
  ]) {
    const cloned = await run(
      "git",
      [
        "-c",
        "core.hooksPath=/dev/null",
        "clone",
        "--quiet",
        "--no-hardlinks",
        "--no-checkout",
        from,
        target,
      ],
      { ...options, timeoutMs: 60000 },
    );
    if (cloned.exitCode !== 0)
      throw new Error(
        "Trusted validation checkout failed: " + cloned.stderr.slice(0, 500),
      );
    await git(target, ["checkout", "--quiet", "--detach", ref], options);
  }
  const all = (await git(trusted, ["ls-files", "-z"], options))
    .split("\0")
    .filter(Boolean);
  const frozen = all.filter(frozenValidationPath);
  if (!frozen.length || frozen.some((path) => !relativeFile(path)))
    throw new Error("Trusted baseline has no safe fixed validation files");
  const frozenFiles = [],
    modifiedFrozenFiles = [];
  for (const path of frozen) {
    const original = await fileWitness(trusted, path, options.redact);
    frozenFiles.push({ path, sha256: original.sha256 });
    try {
      if (
        (await fileWitness(candidate, path, options.redact)).sha256 !==
        original.sha256
      )
        modifiedFrozenFiles.push(path);
    } catch {
      modifiedFrozenFiles.push(path);
    }
    const destination = join(verification, path);
    await mkdir(dirname(destination), { recursive: true, mode: 0o700 });
    await rm(destination, { force: true });
    await copyFile(join(trusted, path), destination);
  }
  let dependencies = env.REFBOX_GOAL_DEPENDENCIES_DIR;
  if (!dependencies && env.REFBOX_GOAL_SHARED_DEPENDENCIES_ROOT)
    dependencies = join(
      env.REFBOX_GOAL_SHARED_DEPENDENCIES_ROOT,
      "node_modules",
    );
  if (
    !dependencies &&
    (await lstat(join(source, "node_modules")).catch(() => null))
  )
    dependencies = join(source, "node_modules");
  if (
    !dependencies &&
    (await lstat(join(repository, "node_modules")).catch(() => null))
  )
    dependencies = join(repository, "node_modules");
  if (dependencies) {
    dependencies = await realpath(dependencies);
    await symlink(dependencies, join(verification, "node_modules"), "dir");
  }
  const manifest = JSON.parse(
    await readFile(join(trusted, "package.json"), "utf8").catch(() => "{}"),
  );
  const profile =
    manifest.name === "refbox"
      ? "refbox"
      : all.includes("go.mod")
        ? "go"
        : "node";
  const supervisor = {
    repository,
    revision,
    profile,
    frozenFiles,
    modifiedFrozenFiles,
    frozenDefinitionSha256: hash(JSON.stringify(frozenFiles)),
  };
  return { trusted, verification, dependencies, all, supervisor };
}

async function runTrustedCommand(
  command,
  validation,
  { options, timeoutMs, scratch },
) {
  const { verification, dependencies, all, supervisor } = validation;
  const startedAt = now();
  const budget = Date.now() + timeoutMs;
  const runs = [];
  const step = async (executable, args, cwd = verification) => {
    const remaining = budget - Date.now();
    if (remaining <= 0)
      throw new Error("Independent fixed runner command budget exhausted");
    const result = await run(executable, args, {
      ...options,
      cwd,
      timeoutMs: remaining,
    });
    runs.push(result);
    return result.exitCode === 0 && !result.timedOut && !result.unavailable;
  };
  const node = (path) => {
    if (!dependencies)
      throw new Error("Trusted shared Node dependencies are unavailable");
    return join(dependencies, path);
  };
  const goTests = async () => {
    const paths = all.filter((path) => path.endsWith("_test.go"));
    if (!paths.length) throw new Error("Trusted Go test set is empty");
    const required = new Set();
    for (const path of paths) {
      const source = await readFile(join(validation.trusted, path), "utf8");
      for (const match of source.matchAll(
        /^\s*func\s+(Test[A-Za-z0-9_]+)\s*\(/gm,
      ))
        required.add(match[1]);
    }
    supervisor.requiredGoTestNames = [...required].sort();
    if (!required.size)
      throw new Error(
        "Trusted Go baseline contains no executable named test fixtures",
      );
    const success = await step("go", [
      "test",
      "-buildvcs=true",
      "-race",
      "-count=1",
      "-v",
      "./...",
    ]);
    if (!success) return false;
    const witness = runs.at(-1);
    const observed = new Set(witness.passedGoTests);
    const missing = [...required].filter((name) => !observed.has(name));
    if (missing.length) {
      witness.fixtureCoverageFailure =
        "Frozen Go test fixtures were not executed: " + missing.join(", ");
      supervisor.fixtureCoveragePassed = false;
      witness.stderr += "\n" + witness.fixtureCoverageFailure;
      return false;
    }
    return true;
  };
  let passed = true;
  if (supervisor.modifiedFrozenFiles.length) {
    return {
      argv: ["refbox-fixed-runner", command],
      startedAt,
      completedAt: now(),
      exitCode: 1,
      stdout: "",
      stderr:
        "Candidate changed or deleted frozen validation files: " +
        supervisor.modifiedFrozenFiles.join(", "),
      runs,
      trustedBaseline: supervisor,
    };
  }
  if (supervisor.profile === "refbox") {
    if (["tests", "build"].includes(command))
      passed = await step(process.execPath, [
        node("typescript/bin/tsc"),
        "-p",
        join(verification, "apps/runtime/tsconfig.json"),
      ]);
    if (passed && command === "tests") {
      const config = join(scratch, "fixed-vitest.config.mjs");
      const tests = all
        .filter(
          (path) =>
            path.startsWith("apps/runtime/test/") && /\.test\.ts$/.test(path),
        )
        .map((path) => path.slice("apps/runtime/".length));
      if (!tests.length) throw new Error("Trusted runtime test set is empty");
      await writeFile(
        config,
        "export default " +
          JSON.stringify({
            test: {
              include: tests,
              exclude: [],
              passWithNoTests: false,
              // Runner 在密集子进程/资源竞争下默认 10s hook 超时可能偶发误报。
              // 固定 runner 需要稳定复跑既有回归而不削弱其断言或超时外的行为边界。
              hookTimeout: 30000,
              testTimeout: 30000,
            },
          }) +
          ";\n",
        { mode: 0o600 },
      );
      passed = await step(
        process.execPath,
        [
          node("vitest/vitest.mjs"),
          "run",
          "--config",
          config,
          "--root",
          join(verification, "apps/runtime"),
          ...tests,
        ],
        join(verification, "apps/runtime"),
      );
      const serviceTests = all.filter(
        (path) =>
          path.startsWith("apps/services/test/") && /\.test\.mjs$/.test(path),
      );
      if (!serviceTests.length)
        throw new Error("Trusted independent-service test set is empty");
      if (passed)
        passed = await step(process.execPath, ["--test", ...serviceTests]);
      if (passed)
        passed = await step(process.execPath, [
          "--import",
          node("tsx/dist/loader.mjs"),
          "apps/web/test/api-check.mjs",
        ]);
      if (passed) passed = await goTests();
    } else if (passed && command === "build") {
      passed = await step(process.execPath, [
        node("typescript/bin/tsc"),
        "-p",
        join(verification, "apps/web/tsconfig.json"),
      ]);
      if (passed)
        passed = await step(
          process.execPath,
          [
            node("vite/bin/vite.js"),
            "build",
            "--config",
            join(verification, "apps/web/vite.config.ts"),
            "--configLoader",
            "runner",
          ],
          join(verification, "apps/web"),
        );
      if (passed)
        passed = await step("go", [
          "build",
          "-buildvcs=true",
          "-o",
          join(scratch, "build-refbox"),
          "./cmd/refbox",
        ]);
      if (passed)
        passed = await step("go", [
          "build",
          "-buildvcs=true",
          "-o",
          join(scratch, "build-refbox-broker"),
          "./cmd/refbox-broker",
        ]);
    } else if (passed && command === "ui") {
      passed = await step(
        process.execPath,
        [
          node("@playwright/test/cli.js"),
          "test",
          "--config",
          join(verification, "apps/web/playwright.config.ts"),
          "--grep-invert",
          "live deployment",
        ],
        join(verification, "apps/web"),
      );
    }
  } else if (supervisor.profile === "go") {
    if (command === "tests") {
      passed = await goTests();
    } else if (command === "build")
      passed = await step("go", ["build", "-buildvcs=true", "./..."]);
    else
      throw new Error(
        "UI check is not available in this trusted baseline profile",
      );
  } else {
    if (command === "tests") {
      const tests = all.filter((path) =>
        /\.(?:test|spec)\.[cm]?js$/.test(path),
      );
      if (!tests.length) throw new Error("Trusted Node test set is empty");
      passed = await step(process.execPath, ["--test", ...tests]);
    } else if (command === "build") {
      const sources = all.filter(
        (path) => /\.[cm]?js$/.test(path) && !frozenValidationPath(path),
      );
      if (!sources.length)
        throw new Error("Trusted Node build profile has no source files");
      for (const source of sources) {
        passed = await step(process.execPath, ["--check", source]);
        if (!passed) break;
      }
    } else
      throw new Error(
        "UI check is not available in this trusted baseline profile",
      );
  }
  for (const file of supervisor.frozenFiles) {
    if (
      (await fileWitness(verification, file.path, options.redact)).sha256 !==
      file.sha256
    )
      throw new Error(
        "Fixed validation definition changed while commands were running",
      );
  }
  const stdout = bounded(
    runs.map((item) => item.argv.join(" ") + "\n" + item.stdout).join("\n"),
    64000,
  );
  const stderr = bounded(runs.map((item) => item.stderr).join("\n"), 32000);
  return {
    argv: ["refbox-fixed-runner", command],
    cwd: verification,
    startedAt,
    completedAt: now(),
    exitCode: passed
      ? 0
      : (runs.find((item) => item.exitCode !== 0)?.exitCode ?? 1),
    timedOut: runs.some((item) => item.timedOut),
    unavailable: runs.some((item) => item.unavailable),
    stdout,
    stderr,
    runs,
    trustedBaseline: supervisor,
  };
}

function contextScope(context) {
  return JSON.stringify({
    taskId: context.taskId,
    goal: context.goal,
    cwd: context.cwd,
    round: context.round,
    contractHash: context.contract?.hash,
    baselineRevision: context.baselineRevision,
    nativeStatus: context.nativeStatus,
    nativeUpdatedAt: context.nativeUpdatedAt,
  });
}

function frozenContract(context, requestedHash) {
  const contract = context.contract;
  if (
    !contract ||
    contract.version !== 1 ||
    typeof contract.criteria !== "string" ||
    !contract.criteria.trim() ||
    typeof contract.definitionJson !== "string" ||
    contract.definitionJson.length > 128000 ||
    contract.hash !== requestedHash ||
    hash(contract.definitionJson) !== requestedHash ||
    !contract.reviewConversationId
  )
    throw new HttpError(409, "冻结契约缺失、哈希不匹配或未独立审查。");
  let definition;
  try {
    definition = JSON.parse(contract.definitionJson);
  } catch {
    throw new HttpError(409, "冻结契约定义无效。");
  }
  const checks = validateGoalChecks(contract.checks);
  if (
    definition.version !== 1 ||
    definition.goal !== context.goal ||
    contract.goal !== context.goal ||
    definition.criteria !== contract.criteria ||
    !isDeepStrictEqual(definition.checks, checks)
  )
    throw new HttpError(409, "契约定义、目标或固定标准已改变。");
  return { ...contract, checks };
}

export async function reviewGoalContract(
  request,
  { goalContext, reviewer, env = process.env },
) {
  if (
    !ids.test(request?.taskId ?? "") ||
    typeof request.goal !== "string" ||
    !request.goal.trim() ||
    request.goal.length > 20000
  )
    throw new HttpError(400, "目标和 taskId 必须固定且有效。");
  const context = await goalContext(request.taskId);
  if (context.taskId !== request.taskId || context.goal !== request.goal)
    throw new HttpError(409, "调用方不能改变平台原始目标。");
  if (context.contract)
    throw new HttpError(409, "已有冻结契约，执行者不能通过重新审查降低标准。");
  const base = {
    taskId: request.taskId,
    round: context.round,
    verdict: "inconclusive",
    summary: "",
    reviewConversationId: "",
    review: "",
    checks: [],
    evidence: {},
  };
  let checks;
  try {
    if (
      !request.plan ||
      typeof request.plan.criteria !== "string" ||
      !request.plan.criteria.trim() ||
      request.plan.criteria.length > 20000 ||
      typeof request.plan.steps !== "string" ||
      !request.plan.steps.trim()
    )
      throw new HttpError(400, "计划需要可复核的步骤与完成标准。");
    checks = validateGoalChecks(request.plan.checks);
  } catch (err) {
    return { ...base, verdict: "fail", summary: err.message };
  }
  if (!reviewer) return { ...base, summary: "独立契约审查模型不可用。" };
  const redact = sanitizer(env);
  const definition = {
    version: 1,
    goal: context.goal,
    criteria: request.plan.criteria,
    checks,
  };
  const definitionJson = JSON.stringify(definition);
  const contractHash = hash(definitionJson);
  base.contractHash = contractHash;
  base.evidence = {
    kind: "goal_contract_review",
    taskId: request.taskId,
    goal: context.goal,
    round: context.round,
    contractHash,
    criteria: definition.criteria,
    checks,
    planSteps: redact(bounded(request.plan.steps, 20000)),
    baselineRevision: context.baselineRevision ?? "",
    sourceRepository: context.sourceRepository ?? "",
  };
  let review;
  try {
    review = await reviewer.review(base.evidence);
  } catch {
    return { ...base, summary: "独立契约审查未完成。" };
  }
  base.review = String(review.text ?? "").slice(0, 12000);
  base.reviewConversationId = String(review.reviewConversationId ?? "");
  const decision = reviewDecision(review.text);
  if (review.unavailable || !base.reviewConversationId || !decision)
    return { ...base, summary: "独立契约审查缺少有效结论或独立会话来源。" };
  const latest = await goalContext(request.taskId);
  if (contextScope(latest) !== contextScope(context))
    return { ...base, summary: "审查期间目标或规划范围变更，不能冻结旧标准。" };
  base.verdict = decision.approved ? "pass" : "fail";
  base.summary = decision.summary.trim().slice(0, 2000);
  if (!decision.approved) return base;
  return {
    ...base,
    contract: {
      ...definition,
      definitionJson,
      hash: contractHash,
      reviewConversationId: base.reviewConversationId,
      reviewedAt: now(),
      summary: base.summary,
    },
  };
}

export async function proveGoalResult(
  request,
  {
    goalContext,
    reviewer,
    env = process.env,
    proofRoot = tmpdir(),
    commandTimeoutMs = 240000,
  },
) {
  if (
    !ids.test(request?.taskId ?? "") ||
    !/^[a-f0-9]{64}$/.test(request.contractHash ?? "") ||
    Object.keys(request).some(
      (key) => !["taskId", "contractHash"].includes(key),
    )
  )
    throw new HttpError(
      400,
      "只接受平台 taskId 与冻结 contractHash；不能替代标准或路径。",
    );
  const context = await goalContext(request.taskId);
  if (
    context.taskId !== request.taskId ||
    typeof context.cwd !== "string" ||
    !isAbsolute(context.cwd) ||
    !Number.isInteger(context.round) ||
    context.round < 0
  )
    throw new HttpError(409, "平台目标上下文无效。");
  const contract = frozenContract(context, request.contractHash);
  const base = {
    at: now(),
    taskId: request.taskId,
    round: context.round,
    contractHash: request.contractHash,
    candidateId: "",
    verdict: "inconclusive",
    summary: "",
    reviewConversationId: "",
    review: "",
    checks: [],
    evidence: {
      kind: "goal_result_review",
      taskId: request.taskId,
      goal: context.goal,
      round: context.round,
      contractHash: contract.hash,
      criteria: contract.criteria,
      fixedChecks: contract.checks,
      artifacts: [],
      scope: {
        taskId: request.taskId,
        round: context.round,
        contractHash: contract.hash,
        nativeUpdatedAt: context.nativeUpdatedAt ?? "",
        baselineRevision: context.baselineRevision ?? "",
        sourceRepository: context.sourceRepository ?? "",
      },
      environment: {
        platform: process.platform,
        nodeVersion: process.version,
        uid: process.getuid?.(),
        credentialEnvironmentInherited: false,
      },
    },
  };
  if (context.nativeStatus && context.nativeStatus !== "awaiting_verification")
    return { ...base, summary: "执行上下文未进入待独立验证状态。" };
  const source = await realpath(context.cwd);
  await mkdir(proofRoot, { recursive: true, mode: 0o700 });
  const scratch = await mkdtemp(join(proofRoot, "refbox-goal-proof-"));
  const candidate = join(scratch, "candidate");
  const redact = sanitizer(env);
  await writeFile(join(scratch, "empty-config"), "", { mode: 0o600 });
  const processEnv = safeEnvironment(env, scratch);
  const commandDeadline = Date.now() + 480000;
  const options = { env: processEnv, redact };
  let gitCandidate = false,
    revision = "",
    baseline = "",
    files = [],
    sourceHash = "";
  let validation;
  try {
    const gitPath = await lstat(join(source, ".git")).catch(() => null);
    gitCandidate = Boolean(gitPath);
    if (gitCandidate) {
      if (
        (
          await git(
            source,
            ["status", "--porcelain", "--untracked-files=all"],
            options,
          )
        ).trim()
      )
        return {
          ...base,
          summary:
            "Git 候选必须提交并保持工作区干净，不能验证未提交或混合结果。",
        };
      revision = (await git(source, ["rev-parse", "HEAD"], options)).trim();
      baseline =
        context.baselineRevision ||
        (await git(source, ["rev-parse", "HEAD^"], options)).trim();
      if (
        !/^[a-f0-9]{40,64}$/.test(revision) ||
        !/^[a-f0-9]{40,64}$/.test(baseline)
      )
        throw new Error("Candidate revision or baseline is invalid");
      const tree = await git(source, ["ls-tree", "-r", revision], options);
      if (
        tree
          .split("\n")
          .some(
            (line) =>
              line.startsWith("120000 ") ||
              (line.includes("\t") &&
                forbidden(line.split("\t").slice(1).join("\t"))),
          )
      )
        throw new Error(
          "Git candidate contains credential files, databases or symlink escapes",
        );
      await run(
        "git",
        [
          "-c",
          "core.hooksPath=/dev/null",
          "clone",
          "--quiet",
          "--no-hardlinks",
          "--no-checkout",
          source,
          candidate,
        ],
        { ...options, timeoutMs: 60000 },
      ).then((result) => {
        if (result.exitCode !== 0)
          throw new Error(
            "Independent Git checkout failed: " + result.stderr.slice(0, 500),
          );
      });
      await git(
        candidate,
        ["checkout", "--quiet", "--detach", revision],
        options,
      );
      files = (await git(candidate, ["ls-files", "-z"], options))
        .split("\0")
        .filter(Boolean);
      if (files.some((path) => !relativeFile(path)))
        throw new Error("Git candidate contains unsafe file paths");
      base.candidateId = "git:" + revision;
      const diff = await git(
        candidate,
        ["diff", "--no-ext-diff", "--unified=5", baseline, revision, "--"],
        options,
      );
      const changed = (
        await git(
          candidate,
          [
            "diff",
            "--name-only",
            "--diff-filter=ACMR",
            "-z",
            baseline,
            revision,
            "--",
          ],
          options,
        )
      )
        .split("\0")
        .filter(Boolean);
      base.evidence.candidate = {
        kind: "git",
        revision,
        baselineRevision: baseline,
        changedFiles: changed,
        diff: redact(bounded(diff, 128000)),
        diffTruncated: Buffer.byteLength(diff) > 128000,
      };
      files = [
        ...new Set([
          ...contract.checks
            .filter((check) => check.path)
            .map((check) => check.path),
          ...(context.artifacts ?? []).map((path) =>
            isAbsolute(path)
              ? relative(source, path).split(sep).join("/")
              : path,
          ),
          ...changed,
        ]),
      ];
      const dependencies =
        env.REFBOX_GOAL_DEPENDENCIES_DIR ??
        (env.REFBOX_GOAL_SHARED_DEPENDENCIES_ROOT
          ? join(env.REFBOX_GOAL_SHARED_DEPENDENCIES_ROOT, "node_modules")
          : join(source, "node_modules"));
      if (await lstat(dependencies).catch(() => null))
        await symlink(
          await realpath(dependencies),
          join(candidate, "node_modules"),
          "dir",
        );
    } else {
      files = await plainFiles(source);
      await mkdir(candidate, { recursive: true, mode: 0o700 });
      for (const path of files) {
        const target = join(candidate, path);
        await mkdir(dirname(target), { recursive: true, mode: 0o700 });
        await copyFile(join(source, path), target);
      }
      sourceHash = await manifestHash(candidate, files);
      base.candidateId = "snapshot:" + sourceHash;
      base.evidence.candidate = {
        kind: "files",
        snapshotSha256: sourceHash,
        fileCount: files.length,
      };
    }
    base.evidence.candidateId = base.candidateId;
    if (files.length > 64) base.evidence.artifactsTruncated = true;
    for (const path of files.slice(0, 64)) {
      try {
        const { fullText, ...witness } = await fileWitness(
          candidate,
          path,
          redact,
        );
        base.evidence.artifacts.push(witness);
      } catch (err) {
        base.evidence.artifacts.push({
          path,
          unavailable: true,
          reason: redact(err.message),
        });
      }
    }
    for (const check of contract.checks) {
      const result = {
        id: check.id,
        kind: check.kind,
        passed: false,
        sampledAt: now(),
      };
      try {
        if (check.kind === "command") {
          if (!gitCandidate) {
            result.unavailable = true;
            throw new Error(
              "Independent command checks require a committed Git candidate and trusted baseline",
            );
          }
          result.command = check.command;
          const remaining = commandDeadline - Date.now();
          if (remaining <= 0) {
            result.unavailable = true;
            throw new Error("Independent proof command budget exhausted");
          }
          if (check.command === "diff")
            result.witness = await run(
              "git",
              ["diff", "--check", baseline, revision, "--"],
              {
                ...options,
                cwd: candidate,
                timeoutMs: Math.min(commandTimeoutMs, remaining),
              },
            );
          else {
            try {
              validation ??= await prepareTrustedValidation({
                scratch,
                source,
                candidate,
                context,
                env,
                options,
              });
              base.evidence.trustedValidation = validation.supervisor;
              result.witness = await runTrustedCommand(
                check.command,
                validation,
                {
                  options,
                  scratch,
                  timeoutMs: Math.min(commandTimeoutMs, remaining),
                },
              );
            } catch (err) {
              result.unavailable = true;
              throw err;
            }
          }
          result.passed =
            result.witness.exitCode === 0 &&
            !result.witness.timedOut &&
            !result.witness.unavailable;
          if (result.witness.unavailable || result.witness.timedOut)
            result.unavailable = true;
        } else {
          const witness = await fileWitness(candidate, check.path, redact);
          const { fullText, ...publicWitness } = witness;
          result.witness = publicWitness;
          if (check.kind === "file_exists") result.passed = true;
          else if (check.kind === "file_contains") {
            result.passed = fullText.includes(check.contains);
            result.witness.matchIndex = fullText.indexOf(check.contains);
          } else {
            let observed = JSON.parse(fullText);
            for (const key of check.jsonPath.split("."))
              observed =
                observed && Object.hasOwn(observed, key)
                  ? observed[key]
                  : undefined;
            result.passed = isDeepStrictEqual(observed, check.equals);
            result.witness.jsonPath = check.jsonPath;
            result.witness.observedJson = redact(
              bounded(
                JSON.stringify({
                  present: observed !== undefined,
                  value: observed,
                }) ?? "null",
                8192,
              ),
            );
          }
        }
      } catch (err) {
        result.detail = redact(err.message);
        if (/symlink|escape|Unsafe/.test(err.message))
          result.unavailable = true;
      }
      result.completedAt = now();
      base.checks.push(result);
    }
    base.evidence.checks = base.checks;
    if (base.checks.some((check) => check.unavailable))
      return {
        ...base,
        summary: "独立验收能力、环境或安全快照不可用，不能证明成果。",
      };
    if (base.checks.some((check) => !check.passed))
      return {
        ...base,
        verdict: "fail",
        summary: (
          "独立重跑的固定验收项失败：" +
          base.checks
            .filter((check) => !check.passed)
            .map((check) => {
              const definition = contract.checks.find(
                (fixed) => fixed.id === check.id,
              );
              return `${check.id}: ${failedCheckFeedback(check, definition)}`;
            })
            .join("；")
        ).slice(0, SUMMARY_LIMIT),
      };
    if (!base.evidence.artifacts.some((artifact) => !artifact.unavailable))
      return {
        ...base,
        summary: "缺少可独立读取的实际产物或源码内容，不能证明成果。",
      };
    if (!reviewer) return { ...base, summary: "独立成果审查模型不可用。" };
    const review = await reviewer.review(base.evidence);
    base.review = String(review.text ?? "").slice(0, 12000);
    base.reviewConversationId = String(review.reviewConversationId ?? "");
    const decision = reviewDecision(review.text);
    if (review.unavailable || !decision || !base.reviewConversationId)
      return { ...base, summary: "独立成果复核缺少有效结论或独立会话来源。" };
    const latest = await goalContext(request.taskId);
    if (contextScope(latest) !== contextScope(context))
      return {
        ...base,
        summary: "复核期间任务、轮次或冻结契约发生变化，拒绝旧成果。",
      };
    if (gitCandidate) {
      if (
        (await git(source, ["rev-parse", "HEAD"], options)).trim() !==
          revision ||
        (
          await git(
            source,
            ["status", "--porcelain", "--untracked-files=all"],
            options,
          )
        ).trim()
      )
        return { ...base, summary: "独立验证期间原候选版本变更，需重新验证。" };
    } else if (
      (await manifestHash(source, await plainFiles(source))) !== sourceHash
    )
      return {
        ...base,
        summary: "独立验证期间原文件候选发生变化，需重新验证。",
      };
    return {
      ...base,
      verdict: decision.approved ? "pass" : "fail",
      summary: decision.summary.trim().slice(0, 2000),
    };
  } catch (err) {
    return {
      ...base,
      summary: "独立目标验证未完成：" + redact(err.message).slice(0, 1000),
    };
  } finally {
    await rm(scratch, { recursive: true, force: true });
  }
}
