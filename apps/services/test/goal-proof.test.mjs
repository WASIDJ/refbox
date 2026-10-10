import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import {
  mkdtemp,
  mkdir,
  readFile,
  readdir,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  proveGoalResult,
  reviewGoalContract,
  validateGoalChecks,
} from "../lib/goal-proof.mjs";
import { createProverService } from "../prover.mjs";
import { listen, serviceServer, json, closeServer } from "../lib/http.mjs";

const execute = promisify(execFile);
const token = "independent-goal-verifier-token-".repeat(2);
const platformToken = "independent-goal-platform-token-".repeat(2);
const affirmative = {
  review: async () => ({
    reviewConversationId: "independent-review-1",
    text: '{"approved":true,"summary":"实际文件与复跑的固定检查完整覆盖目标。"}',
  }),
};
const goal = "输出包含 count=42 的实际分析报告";
const fileChecks = [
  {
    id: "analysis-count",
    kind: "json_equals",
    path: "report.json",
    jsonPath: "count",
    equals: 42,
  },
];
const contractFor = (checks = fileChecks, target = goal) => {
  const definition = {
    version: 1,
    goal: target,
    criteria: "真实报告中的 count 必须为 42；不能以文字自述替代报告。",
    checks,
  };
  const definitionJson = JSON.stringify(definition);
  return {
    ...definition,
    definitionJson,
    hash: createHash("sha256").update(definitionJson).digest("hex"),
    reviewConversationId: "independent-contract-1",
    reviewedAt: new Date().toISOString(),
    summary: "固定标准覆盖原始目标。",
  };
};
async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), "refbox-goal-tests-"));
  const cwd = join(root, "source");
  const proofRoot = join(root, "proof");
  await mkdir(cwd);
  await mkdir(proofRoot);
  t.after(() => rm(root, { recursive: true, force: true }));
  await writeFile(
    join(cwd, "report.json"),
    '{"count":42,"method":"actual analysis"}',
  );
  const context = {
    taskId: "task_goal",
    goal,
    cwd,
    round: 1,
    nativeStatus: "awaiting_verification",
    nativeUpdatedAt: "2026-10-10T01:00:00Z",
    contract: contractFor(),
    artifacts: ["report.json"],
  };
  return {
    root,
    cwd,
    proofRoot,
    context,
    options: {
      goalContext: async () => structuredClone(context),
      reviewer: affirmative,
      proofRoot,
    },
  };
}

test("goal checks cannot smuggle caller shell, credential paths, traversal, JSON prototypes or duplicate commands", () => {
  const invalid = [
    [{ id: "shell", kind: "command", command: "echo done" }],
    [
      {
        id: "shell",
        kind: "command",
        command: "tests",
        args: ["--always-pass"],
      },
    ],
    [{ id: "secret", kind: "file_exists", path: ".env" }],
    [{ id: "database", kind: "file_exists", path: "var/business.sqlite" }],
    [{ id: "escape", kind: "file_exists", path: "../report.json" }],
    [{ id: "escape", kind: "file_exists", path: "/report.json" }],
    [
      {
        id: "prototype",
        kind: "json_equals",
        path: "report.json",
        jsonPath: "constructor.name",
        equals: "Object",
      },
    ],
    [
      {
        id: "undefined",
        kind: "json_equals",
        path: "report.json",
        jsonPath: "missing",
        equals: undefined,
      },
    ],
    [
      { id: "one", kind: "command", command: "tests" },
      { id: "two", kind: "command", command: "tests" },
    ],
  ];
  for (const checks of invalid) assert.throws(() => validateGoalChecks(checks));
});

test("contract review preserves original goal and freezes exact independently reviewed definition hash", async (t) => {
  const { context, options } = await fixture(t);
  delete context.contract;
  context.nativeStatus = "awaiting_confirmation";
  const request = {
    taskId: context.taskId,
    goal,
    plan: {
      steps: "分析数据并写出实际 JSON 报告",
      criteria: "报告 count=42",
      verificationCommand: "exit 0",
      checks: fileChecks,
    },
  };
  const result = await reviewGoalContract(request, options);
  assert.equal(result.verdict, "pass");
  assert.equal(result.contract.goal, goal);
  assert.equal(
    result.contract.hash,
    createHash("sha256").update(result.contract.definitionJson).digest("hex"),
  );
  assert.equal(result.contract.reviewConversationId, "independent-review-1");
  assert.equal(result.evidence.kind, "goal_contract_review");
  assert.ok(
    !result.contract.definitionJson.includes("exit 0"),
    "executor command must never become the independent check",
  );
  await assert.rejects(
    reviewGoalContract({ ...request, goal: "仅创建空文件" }, options),
    (err) => err.status === 409,
  );
  const rejected = await reviewGoalContract(request, {
    ...options,
    reviewer: {
      review: async () => ({
        reviewConversationId: "coverage-review",
        text: '{"approved":false,"summary":"缺少原始目标要求的业务负例，标准过弱。"}',
      }),
    },
  });
  assert.equal(rejected.verdict, "fail");
  assert.equal(rejected.contract, undefined);
  const changed = await reviewGoalContract(request, {
    ...options,
    reviewer: {
      review: async () => {
        context.round++;
        return affirmative.review();
      },
    },
  });
  assert.equal(changed.verdict, "inconclusive");
});

test("file goal proof independently snapshots actual bytes, binds scope, hides private files and cleans evidence directory", async (t) => {
  const { cwd, proofRoot, context, options } = await fixture(t);
  await writeFile(join(cwd, ".env"), "TOKEN=private-original-token");
  await writeFile(join(cwd, "business.sqlite"), "PRIVATE DATABASE");
  let reviewed;
  const result = await proveGoalResult(
    { taskId: context.taskId, contractHash: context.contract.hash },
    {
      ...options,
      reviewer: {
        review: async (evidence) => {
          reviewed = evidence;
          return affirmative.review();
        },
      },
    },
  );
  assert.equal(result.verdict, "pass");
  assert.equal(result.taskId, context.taskId);
  assert.equal(result.round, 1);
  assert.match(result.candidateId, /^snapshot:[a-f0-9]{64}$/);
  assert.equal(result.checks[0].passed, true);
  assert.match(result.checks[0].witness.observedJson, /42/);
  assert.equal(
    result.checks[0].witness.sha256,
    createHash("sha256")
      .update(await readFile(join(cwd, "report.json")))
      .digest("hex"),
  );
  assert.match(reviewed.artifacts[0].text, /actual analysis/);
  assert.ok(
    reviewed.artifacts.every(
      (artifact) =>
        !artifact.path.endsWith("sqlite") && artifact.path !== ".env",
    ),
  );
  assert.deepEqual(await readdir(proofRoot), []);
  assert.equal(
    await readFile(join(cwd, ".env"), "utf8"),
    "TOKEN=private-original-token",
  );
});

test("file proof refuses symlink escapes, changed candidates, stale round, invalid frozen definitions and failed assertions", async (t) => {
  const { root, cwd, context, options, proofRoot } = await fixture(t);
  const request = {
    taskId: context.taskId,
    contractHash: context.contract.hash,
  };
  await assert.rejects(
    proveGoalResult({ ...request, checks: [] }, options),
    (err) => err.status === 400,
  );
  await assert.rejects(
    proveGoalResult({ ...request, contractHash: "0".repeat(64) }, options),
    (err) => err.status === 409,
  );
  await writeFile(join(cwd, "report.json"), '{"count":41}');
  let called = 0;
  assert.equal(
    (
      await proveGoalResult(request, {
        ...options,
        reviewer: {
          review: async () => {
            called++;
            return affirmative.review();
          },
        },
      })
    ).verdict,
    "fail",
  );
  assert.equal(called, 0);
  await writeFile(join(cwd, "report.json"), '{"count":42}');
  assert.equal(
    (
      await proveGoalResult(request, {
        ...options,
        reviewer: {
          review: async () => {
            await writeFile(join(cwd, "report.json"), '{"count":43}');
            return affirmative.review();
          },
        },
      })
    ).verdict,
    "inconclusive",
  );
  await writeFile(join(cwd, "report.json"), '{"count":42}');
  assert.equal(
    (
      await proveGoalResult(request, {
        ...options,
        reviewer: {
          review: async () => {
            context.round++;
            return affirmative.review();
          },
        },
      })
    ).verdict,
    "inconclusive",
  );
  await writeFile(join(root, "outside.json"), '{"count":42}');
  await rm(join(cwd, "report.json"));
  await symlink(join(root, "outside.json"), join(cwd, "report.json"));
  assert.equal(
    (await proveGoalResult(request, options)).verdict,
    "inconclusive",
  );
  assert.deepEqual(await readdir(proofRoot), []);
});

async function gitFixture(t) {
  const fixtureData = await fixture(t);
  const { cwd, context } = fixtureData;
  const git = (args) => execute("git", args, { cwd });
  await writeFile(join(cwd, ".gitignore"), ".env\nnode_modules\n");
  await writeFile(
    join(cwd, ".env.example"),
    "REFBOX_ENGINE_TOKEN=\nREFBOX_MODEL=kimi-k3\n",
  );
  await writeFile(
    join(cwd, "package.json"),
    JSON.stringify({
      type: "module",
      scripts: {
        test: "node --test increment.test.mjs",
        build: "node --check increment.mjs",
      },
    }),
  );
  await writeFile(
    join(cwd, "increment.mjs"),
    "export const increment = n => n - 1;\n",
  );
  await writeFile(
    join(cwd, "increment.test.mjs"),
    `import test from 'node:test'; import assert from 'node:assert/strict'; import {existsSync} from 'node:fs'; import {increment} from './increment.mjs'; test('actual increment behavior',()=>{assert.equal(increment(41),42);assert.equal(process.env.REFBOX_ENGINE_TOKEN,undefined);assert.equal(existsSync('.env'),false);assert.notEqual(process.cwd(),${JSON.stringify(cwd)});});`,
  );
  await git(["init", "--quiet"]);
  await git(["config", "user.name", "Independent goal fixture"]);
  await git(["config", "user.email", "goal-fixture@example.invalid"]);
  await git(["add", "."]);
  await git(["commit", "--quiet", "-m", "fixture baseline"]);
  context.baselineRevision = (await git(["rev-parse", "HEAD"])).stdout.trim();
  context.goal =
    "修复 increment，使 41 加一实际得到 42，保持有意义的行为测试。";
  context.contract = contractFor(
    [
      { id: "real-tests", kind: "command", command: "tests" },
      { id: "real-build", kind: "command", command: "build" },
      { id: "diff", kind: "command", command: "diff" },
    ],
    context.goal,
  );
  context.artifacts = ["increment.mjs"];
  return { ...fixtureData, git };
}

test("Git proof runs actual tests in independent clean committed checkout with source diff, sanitized environment and artifact hashes", async (t) => {
  const { cwd, context, options, git, proofRoot } = await gitFixture(t);
  await writeFile(join(cwd, ".env"), "REFBOX_ENGINE_TOKEN=do-not-copy-this");
  await writeFile(
    join(cwd, "increment.mjs"),
    "export const increment = n => n + 1;\n",
  );
  await git(["add", "increment.mjs"]);
  await git(["commit", "--quiet", "-m", "fix real increment behavior"]);
  const revision = (await git(["rev-parse", "HEAD"])).stdout.trim();
  let evidence;
  const result = await proveGoalResult(
    { taskId: context.taskId, contractHash: context.contract.hash },
    {
      ...options,
      env: {
        ...process.env,
        REFBOX_ENGINE_TOKEN: "do-not-forward-secret-token",
      },
      reviewer: {
        review: async (input) => {
          evidence = input;
          return affirmative.review();
        },
      },
    },
  );
  assert.equal(result.verdict, "pass", result.summary);
  assert.equal(result.candidateId, "git:" + revision);
  assert.equal(result.checks.length, 3);
  assert.ok(result.checks.every((check) => check.passed));
  assert.match(result.checks[0].witness.stdout, /actual increment behavior/);
  assert.deepEqual(result.checks[0].witness.argv, [
    "refbox-fixed-runner",
    "tests",
  ]);
  assert.equal(result.checks[0].witness.runs[0].argv[0], process.execPath);
  assert.deepEqual(result.checks[0].witness.runs[0].argv.slice(1), [
    "--test",
    "increment.test.mjs",
  ]);
  assert.equal(
    result.evidence.trustedValidation.revision,
    context.baselineRevision,
  );
  assert.ok(
    result.evidence.trustedValidation.frozenFiles.some(
      (file) => file.path === "increment.test.mjs",
    ),
  );
  assert.match(evidence.candidate.diff, /n \+ 1/);
  assert.match(
    evidence.artifacts.find((artifact) => artifact.path === "increment.mjs")
      .text,
    /n \+ 1/,
  );
  assert.deepEqual(await readdir(proofRoot), []);
  assert.equal(
    (
      await git(["status", "--porcelain", "--untracked-files=all"])
    ).stdout.trim(),
    "",
  );
});

test("independent host runner ignores candidate npm scripts and rejects weakened or deleted frozen test definitions", async (t) => {
  const { cwd, context, options, git } = await gitFixture(t);
  let reviews = 0;
  const request = {
    taskId: context.taskId,
    contractHash: context.contract.hash,
  };
  const failed = await proveGoalResult(request, {
    ...options,
    reviewer: {
      review: async () => {
        reviews++;
        return affirmative.review();
      },
    },
  });
  assert.equal(failed.verdict, "fail");
  assert.equal(failed.checks[0].passed, false);
  assert.equal(reviews, 0);
  await writeFile(
    join(cwd, "increment.mjs"),
    "export const increment = () => 42;\n",
  );
  await writeFile(
    join(cwd, "package.json"),
    JSON.stringify({
      type: "module",
      scripts: {
        test: "node -e \"console.log('no assertions')\"",
        build: "node --check increment.mjs",
      },
    }),
  );
  await git(["add", "."]);
  await git([
    "commit",
    "--quiet",
    "-m",
    "weaken test to avoid exercising goal",
  ]);
  const rejected = await proveGoalResult(request, {
    ...options,
    reviewer: {
      review: async (evidence) => {
        assert.match(evidence.candidate.diff, /no assertions/);
        assert.ok(
          evidence.artifacts.some(
            (file) =>
              file.path === "package.json" &&
              file.text.includes("no assertions"),
          ),
        );
        assert.ok(evidence.checks.every((check) => check.passed));
        return {
          reviewConversationId: "independent-shortcut-review",
          text: '{"approved":false,"summary":"候选删掉真实测试且实现恒定返回值，没有达成原始目标。"}',
        };
      },
    },
  });
  assert.equal(rejected.verdict, "fail");
  assert.match(rejected.checks[0].witness.stderr, /frozen validation files/);
  assert.ok(
    rejected.checks[0].witness.trustedBaseline.modifiedFrozenFiles.includes(
      "package.json",
    ),
  );
  await rm(join(cwd, "increment.test.mjs"));
  await git(["add", "-A"]);
  await git([
    "commit",
    "--quiet",
    "-m",
    "attempt to delete frozen behavior test",
  ]);
  const deleted = await proveGoalResult(request, options);
  assert.equal(deleted.verdict, "fail");
  assert.ok(
    deleted.checks[0].witness.trustedBaseline.modifiedFrozenFiles.includes(
      "increment.test.mjs",
    ),
  );
  await writeFile(
    join(cwd, "increment.mjs"),
    "export const increment = n => n + 1;\n",
  );
  const dirty = await proveGoalResult(request, options);
  assert.equal(dirty.verdict, "inconclusive");
  assert.match(dirty.summary, /干净/);
});

test("trusted external Go fixtures stay red for broken implementation and green for valid implementation including legal pass", async (t) => {
  const { cwd, context, options, proofRoot } = await fixture(t);
  const git = (args) => execute("git", args, { cwd });
  await writeFile(
    join(cwd, "go.mod"),
    "module example.invalid/frozen-go-fixture\n\ngo 1.24\n",
  );
  await writeFile(
    join(cwd, "validation.go"),
    "package validation\ntype Proof struct { Evidence any; CheckID string; Passed bool }\nfunc Validate(p Proof) bool { return true }\n",
  );
  await writeFile(
    join(cwd, "validation_test.go"),
    `package validation
import "testing"
func TestFrozenProofBoundary(t *testing.T) {
 cases := []struct{name string; p Proof; want bool}{
  {"legal pass",Proof{map[string]bool{"real":true},"fixed",true},true},
  {"null evidence",Proof{nil,"fixed",true},false},
  {"wrong ID",Proof{map[string]bool{"real":true},"wrong",true},false},
  {"passed false",Proof{map[string]bool{"real":true},"fixed",false},false},
 }
 for _, c := range cases { t.Run(c.name,func(t *testing.T){if Validate(c.p)!=c.want{t.Fatalf("wrong boundary decision for %s",c.name)}}) }
}
`,
  );
  await git(["init", "--quiet"]);
  await git(["config", "user.name", "Frozen proof fixture"]);
  await git(["config", "user.email", "frozen@example.invalid"]);
  await git(["add", "."]);
  await git([
    "commit",
    "--quiet",
    "-m",
    "frozen external RED fixtures and legal PASS",
  ]);
  const trustedRevision = (await git(["rev-parse", "HEAD"])).stdout.trim();
  context.baselineRevision = trustedRevision;
  context.goal = "修复证明边界，拒绝错误证明并允许真实合法证明。";
  context.contract = contractFor(
    [{ id: "fixed-boundary", kind: "command", command: "tests" }],
    context.goal,
  );
  context.artifacts = ["validation.go"];
  const fixed = {
    ...options,
    env: {
      ...process.env,
      GOROOT: (await execute("go", ["env", "GOROOT"])).stdout.trim(),
      REFBOX_GOAL_TRUSTED_BASELINE_REPOSITORY: cwd,
      REFBOX_GOAL_TRUSTED_BASELINE_REVISION: trustedRevision,
    },
  };
  const request = {
    taskId: context.taskId,
    contractHash: context.contract.hash,
  };
  const red = await proveGoalResult(request, fixed);
  assert.equal(red.verdict, "fail", red.summary);
  assert.deepEqual(red.checks[0].witness.runs[0].argv, [
    "go",
    "test",
    "-race",
    "-count=1",
    "-v",
    "./...",
  ]);
  assert.match(red.checks[0].witness.stdout, /PASS:.*legal_pass/);
  assert.match(red.checks[0].witness.stdout, /FAIL:.*null_evidence/);
  assert.match(red.checks[0].witness.stdout, /FAIL:.*wrong_ID/);
  assert.match(red.checks[0].witness.stdout, /FAIL:.*passed_false/);
  await writeFile(
    join(cwd, "validation.go"),
    'package validation\ntype Proof struct { Evidence any; CheckID string; Passed bool }\nfunc Validate(p Proof) bool { return p.Evidence != nil && p.CheckID == "fixed" && p.Passed }\n',
  );
  await git(["add", "validation.go"]);
  await git([
    "commit",
    "--quiet",
    "-m",
    "real valid implementation preserving external fixed fixtures",
  ]);
  const green = await proveGoalResult(request, fixed);
  assert.equal(green.verdict, "pass", green.summary);
  assert.match(green.checks[0].witness.stdout, /PASS:.*legal_pass/);
  assert.match(green.checks[0].witness.stdout, /PASS:.*null_evidence/);
  assert.match(green.checks[0].witness.stdout, /PASS:.*wrong_ID/);
  assert.match(green.checks[0].witness.stdout, /PASS:.*passed_false/);
  assert.deepEqual(await readdir(proofRoot), []);
});

test("authenticated goal endpoints fetch authoritative platform scope and reject replacement criteria", async (t) => {
  const { context, options } = await fixture(t);
  const platform = serviceServer((request, response) => {
    assert.equal(request.headers.authorization, "Bearer " + platformToken);
    assert.equal(request.url, "/internal/goals/" + context.taskId + "/context");
    return json(response, 200, context);
  });
  const platformUrl = await listen(platform);
  t.after(() => closeServer(platform));
  const service = createProverService({
    token,
    platformToken,
    platformUrl,
    reviewer: affirmative,
    proofRoot: options.proofRoot,
  });
  const url = await listen(service.server);
  t.after(() => service.close());
  const request = {
    taskId: context.taskId,
    contractHash: context.contract.hash,
  };
  assert.equal(
    (
      await fetch(url + "/goal-result", {
        method: "POST",
        body: JSON.stringify(request),
      })
    ).status,
    401,
  );
  const call = (input) =>
    fetch(url + "/goal-result", {
      method: "POST",
      headers: { Authorization: "Bearer " + token },
      body: JSON.stringify(input),
    });
  assert.equal(
    (await call(request).then((response) => response.json())).verdict,
    "pass",
  );
  assert.equal(
    (await call({ ...request, cwd: "/tmp/replacement" })).status,
    400,
  );
});
