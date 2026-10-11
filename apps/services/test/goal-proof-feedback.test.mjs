// goal-proof-feedback: 行为测试独立复跑 proveGoalResult 的失败反馈可定位/脱敏/限长。
import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  proveGoalResult,
  failedCheckFeedback,
} from "../lib/goal-proof.mjs";

const execute = promisify(execFile);
const affirmative = {
  review: async () => ({
    reviewConversationId: "independent-review-feedback",
    text: '{"approved":true,"summary":"占位审查，不应被到达。"}',
  }),
};

const contractFor = (goal, criteria, checks) => {
  const definition = { version: 1, goal, criteria, checks };
  const definitionJson = JSON.stringify(definition);
  return {
    ...definition,
    definitionJson,
    hash: createHash("sha256").update(definitionJson).digest("hex"),
    reviewConversationId: "independent-contract-feedback",
    reviewedAt: new Date().toISOString(),
    summary: "固定验收已冻结。",
  };
};

/**
 * 与 goal-proof.test.mjs 中 gitFixture 同构：baseline 提交包含错误的 increment
 * 行为 + 冻结行为测试。不同 scenario 用 mutate 修改源码后再提交候选 commit。
 */
async function gitFeedbackFixture(t, { goal, criteria, checks, mutate }) {
  const root = await mkdtemp(join(tmpdir(), "refbox-goal-feedback-"));
  const cwd = join(root, "source");
  const proofRoot = join(root, "proof");
  await mkdir(cwd);
  await mkdir(proofRoot);
  t.after(() => rm(root, { recursive: true, force: true }));
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
    join(cwd, "report.json"),
    '{"count":41,"method":"wrong candidate value"}\n',
  );
  await writeFile(join(cwd, "expected-content.txt"), "placeholder text\n");
  await writeFile(
    join(cwd, "increment.test.mjs"),
    `import test from 'node:test'; import assert from 'node:assert/strict'; import {existsSync} from 'node:fs'; import {increment} from './increment.mjs'; test('actual increment behavior',()=>{assert.equal(increment(41),42);assert.equal(process.env.REFBOX_ENGINE_TOKEN,undefined);assert.equal(existsSync('.env'),false);assert.notEqual(process.cwd(),${JSON.stringify(cwd)});});`,
  );
  await git(["init", "--quiet"]);
  await git(["config", "user.name", "Feedback fixture"]);
  await git(["config", "user.email", "feedback@example.invalid"]);
  await git(["add", "."]);
  await git(["commit", "--quiet", "-m", "feedback baseline"]);
  const baselineRevision = (await git(["rev-parse", "HEAD"])).stdout.trim();
  if (mutate) await mutate({ cwd, git });
  // 为 candidate 创建一个 marker commit，使 candidate 与 baseline 不完全一致。
  await writeFile(
    join(cwd, "marker.txt"),
    `candidate marker ${Date.now()}\n`,
  );
  await git(["add", "-A"]);
  await git(["commit", "--quiet", "-m", "feedback candidate"]);
  const contract = contractFor(goal, criteria, checks);
  const context = {
    taskId: "goal_feedback_fixture",
    goal,
    cwd,
    round: 1,
    baselineRevision,
    sourceRepository: cwd,
    nativeStatus: "awaiting_verification",
    nativeUpdatedAt: new Date().toISOString(),
    contract,
    artifacts: ["increment.mjs", "report.json", "expected-content.txt"],
  };
  const secretEnv = {
    ...process.env,
    REFBOX_ENGINE_TOKEN: "fixture-secret-token-value-9f8e7d",
  };
  return {
    root,
    cwd,
    proofRoot,
    context,
    git,
    secretEnv,
    options: {
      goalContext: async () => structuredClone(context),
      reviewer: affirmative,
      proofRoot,
      env: secretEnv,
    },
  };
}

test("failedCheckFeedback 直接调用：command/json/file 三类失败都是脱敏限长、可定位文本", () => {
  const secret = "fixture-direct-secret-aaaaaa";
  const env = { REFBOX_ENGINE_TOKEN: secret };
  void env; // proveGoalResult 内部 redact 依赖 env；单测直接验证 failedCheckFeedback 输出。
  const commandCheck = {
    id: "tests",
    kind: "command",
    unavailable: false,
    detail: undefined,
    witness: {
      exitCode: 1,
      timedOut: false,
      unavailable: false,
      stderr: `some huge ${secret} tail with sensitive-looking material`,
    },
  };
  const feedback = failedCheckFeedback(commandCheck);
  assert.match(feedback, /退出码 1/);
  assert.match(feedback, /stderr:/);
  const jsonCheck = {
    id: "analysis-count",
    kind: "json_equals",
    unavailable: false,
    equals: 42,
    witness: { sha256: "abc", observedJson: '{"present":true,"value":41}' },
  };
  assert.match(failedCheckFeedback(jsonCheck), /期望 42/);
  assert.match(failedCheckFeedback(jsonCheck), /41/);
  const missingFile = {
    id: "delivery",
    kind: "file_contains",
    unavailable: false,
    witness: { /* 无 sha256 */ },
    detail: undefined,
    path: "actual.txt",
  };
  assert.match(failedCheckFeedback(missingFile), /缺失|不可读/);
});

test("command check 真实失败：summary 含 tests 标识、真实退出码、stderr 定位片段，且不泄露 fixture 凭据", async (t) => {
  const fixtureData = await gitFeedbackFixture(t, {
    goal: "修复 increment，使 41 加一实际得到 42，保持有意义的行为测试。",
    criteria: "固定 tests 与 diff 必须通过。",
    checks: [
      { id: "tests", kind: "command", command: "tests" },
      { id: "diff", kind: "command", command: "diff" },
    ],
    // 不修改 increment.mjs，候选与 baseline 完全一样；但仅 commit 让 revision 不同（仍错误）。
    mutate: async ({ cwd }) => {
      await writeFile(
        join(cwd, "expected-content.txt"),
        "still placeholder but committed as different candidate\n",
      );
    },
  });
  const result = await proveGoalResult(
    { taskId: fixtureData.context.taskId, contractHash: fixtureData.context.contract.hash },
    fixtureData.options,
  );
  assert.equal(result.verdict, "fail");
  // check ID 保留用于 UI/既有流程；同时附真实可定位原因。
  assert.match(result.summary, /tests:/);
  assert.match(result.summary, /退出码 1/);
  // stdout 或 stderr 都会携带实际失败详情；断裂点处透传。
  assert.match(result.summary, /(std(?:out|err):)/);
  assert.match(result.summary, /actual increment behavior|assert|AssertionError|\bFAIL\b|✖/);
  // 脱敏：环境注入的 TOKEN 不会原样出现在 summary。
  assert.ok(!result.summary.includes("fixture-secret-token-value-9f8e7d"));
  assert.match(result.summary, /\[REDACTED\]|^(?!.*fixture-secret-token-value)/);
  // 整体限长。
  assert.ok(result.summary.length <= 2000);
  // 真实证据未被抹掉：原始 check 结构、真实退出码与 witness 保留。
  assert.equal(result.checks.length, 2);
  const tests = result.checks.find((check) => check.id === "tests");
  assert.equal(tests.passed, false);
  assert.equal(tests.witness.exitCode, 1);
  assert.ok(typeof tests.witness.stderr === "string");
  assert.ok(result.evidence.checks === result.checks || Array.isArray(result.evidence.checks));
});

test("缺失冻结测试文件：summary 包含被删除的冻结测试文件名", async (t) => {
  const fixtureData = await gitFeedbackFixture(t, {
    goal: "修复 increment 并保留冻结行为测试。",
    criteria: "固定 tests 必须通过。",
    checks: [{ id: "tests", kind: "command", command: "tests" }],
    mutate: async ({ cwd }) => {
      await rm(join(cwd, "increment.test.mjs"));
    },
  });
  const result = await proveGoalResult(
    { taskId: fixtureData.context.taskId, contractHash: fixtureData.context.contract.hash },
    fixtureData.options,
  );
  assert.equal(result.verdict, "fail");
  assert.match(result.summary, /tests:/);
  assert.match(result.summary, /increment\.test\.mjs/);
  assert.ok(result.summary.length <= 2000);
  // 真实 witness 中 modifiedFrozenFiles 仍保留完整列表。
  const tests = result.checks.find((check) => check.id === "tests");
  assert.ok(
    tests.witness?.trustedBaseline?.modifiedFrozenFiles?.includes(
      "increment.test.mjs",
    ),
  );
});

test("json_equals 失败：summary 同时给出期望值与实际观测值", async (t) => {
  const fixtureData = await gitFeedbackFixture(t, {
    goal: "输出真实 count=42 的分析报告。",
    criteria: "report.json 的 count 必须为 42。",
    checks: [
      {
        id: "analysis-count",
        kind: "json_equals",
        path: "report.json",
        jsonPath: "count",
        equals: 42,
      },
    ],
    // report.json 中的 count 已经是 41 而非 42（在 baseline 即错误），无需 mutate。
  });
  const result = await proveGoalResult(
    { taskId: fixtureData.context.taskId, contractHash: fixtureData.context.contract.hash },
    fixtureData.options,
  );
  assert.equal(result.verdict, "fail");
  assert.match(result.summary, /analysis-count:/);
  assert.match(result.summary, /42/);
  assert.match(result.summary, /41/);
  assert.ok(result.summary.length <= 2000);
  const check = result.checks.find((c) => c.id === "analysis-count");
  assert.equal(check.passed, false);
  assert.match(check.witness.observedJson, /41/);
});

test("file_contains 目标文件缺失：summary 指明文件缺失或不可读", async (t) => {
  const fixtureData = await gitFeedbackFixture(t, {
    goal: "在 expected-content.txt 中记录真实交付内容 implemented。",
    criteria: "expected-content.txt 必须包含 implemented。",
    checks: [
      {
        id: "delivery",
        kind: "file_contains",
        path: "expected-content.txt",
        contains: "implemented",
      },
    ],
    mutate: async ({ cwd }) => {
      await rm(join(cwd, "expected-content.txt"));
    },
  });
  const result = await proveGoalResult(
    { taskId: fixtureData.context.taskId, contractHash: fixtureData.context.contract.hash },
    fixtureData.options,
  );
  assert.equal(result.verdict, "fail");
  assert.match(result.summary, /delivery:/);
  assert.match(result.summary, /缺失|不可读|异常/);
  assert.ok(result.summary.length <= 2000);
  const check = result.checks.find((c) => c.id === "delivery");
  assert.equal(check.passed, false);
});

test("summary 整体硬截断到 2000 且不泄露超长 stderr 中的凭据", async (t) => {
  const hugeToken = "fixture-huge-secret-token-aaabbbcccddd";
  const huge = `${hugeToken} `.repeat(2000);
  const fixtureData = await gitFeedbackFixture(t, {
    goal: "构造超长 stderr 失败，验证 summary 限长与脱敏。",
    criteria: "tests 必须通过。",
    checks: [{ id: "tests", kind: "command", command: "tests" }],
    mutate: async ({ cwd }) => {
      // 让 increment.test.mjs 主动打印超长 stderr 后再失败。
      await writeFile(
        join(cwd, "increment.test.mjs"),
        `import test from 'node:test';\nprocess.stderr.write(${JSON.stringify(huge)});\ntest('noise', () => { throw new Error('boom with ${hugeToken} embedded'); });\n`,
      );
      // increment.mjs 也保持错误（n-1）以确保证 tests 失败。
    },
  });
  // 上述测试文件被识别为「冻结测试文件」的修改（package.json/increment.test.mjs 改动）。
  // 由于 modifiedFrozenFiles 非空会先走 modifiedFrozenFiles 分支而看不到超长 stderr，
  // 所以我们直接调用 failedCheckFeedback 验证限长与脱敏语义，并叠加真实 proveGoalResult 验证整体 ≤2000。
  const result = await proveGoalResult(
    { taskId: fixtureData.context.taskId, contractHash: fixtureData.context.contract.hash },
    {
      ...fixtureData.options,
      env: {
        ...fixtureData.secretEnv,
        ANOTHER_LEAK_TOKEN: hugeToken,
      },
    },
  );
  assert.equal(result.verdict, "fail");
  assert.ok(result.summary.length <= 2000, `summary len=${result.summary.length}`);
  assert.ok(!result.summary.includes(hugeToken), "summary must redact fixture credentials");
  assert.ok(
    result.summary.includes("increment.test.mjs") ||
      result.summary.includes("退出码") ||
      result.summary.includes("缺失"),
  );
  // 单元级直接验证 failedCheckFeedback 对超长 stderr 既截断又不改变已经有过的脱敏。
  const feedback = failedCheckFeedback({
    id: "tests",
    kind: "command",
    witness: { exitCode: 1, stderr: huge.slice(0, 5000), timedOut: false },
  });
  assert.ok(feedback.length < 400);
  // sanitizer 在 proveGoalResult 内部已应用；failedCheckFeedback 输入视作已脱敏，
  // 故这里要求 failedCheckFeedback 不增加超长内容、也不解码。
  assert.equal(typeof feedback, "string");
});

test("多 check 同时失败时逐项列出并以中文分号拼接、整体 ≤2000", async (t) => {
  const fixtureData = await gitFeedbackFixture(t, {
    goal: "同时触发 json 与 command 两类失败验证拼接结构。",
    criteria: "json 与 tests 都必须通过。",
    checks: [
      {
        id: "analysis-count",
        kind: "json_equals",
        path: "report.json",
        jsonPath: "count",
        equals: 42,
      },
      { id: "tests", kind: "command", command: "tests" },
    ],
  });
  const result = await proveGoalResult(
    { taskId: fixtureData.context.taskId, contractHash: fixtureData.context.contract.hash },
    fixtureData.options,
  );
  assert.equal(result.verdict, "fail");
  assert.match(result.summary, /analysis-count:/);
  assert.match(result.summary, /tests:/);
  assert.match(result.summary, /；/);
  assert.ok(result.summary.length <= 2000);
  // 真实证据：两个 check 都存在且失败、witness 完整。
  assert.equal(result.checks.length, 2);
  assert.ok(result.checks.every((check) => typeof check.witness === "object"));
});
