import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { join, dirname } from "node:path";
import { tmpdir } from "node:os";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { createHash } from "node:crypto";
import { proveGoalResult } from "../lib/goal-proof.mjs";

const execute = promisify(execFile);
test("independent Go tests and builds retain real VCS metadata despite a user buildvcs=false default", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "refbox-vcs-policy-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const cwd = join(root, "source"),
    home = join(root, "home");
  await mkdir(cwd);
  await mkdir(home);
  const env = {
    ...process.env,
    HOME: home,
    GOCACHE: process.env.GOCACHE ?? join(root, "go-cache"),
  };
  delete env.REFBOX_GOAL_TRUSTED_BASELINE_REPOSITORY;
  delete env.REFBOX_GOAL_TRUSTED_BASELINE_REVISION;
  delete env.GOFLAGS;
  delete env.GOENV;
  const goEnv = (await execute("go", ["env", "GOENV"], { env })).stdout.trim();
  await mkdir(dirname(goEnv), { recursive: true });
  await writeFile(goEnv, "GOFLAGS=-buildvcs=false\n");
  assert.equal(
    (await execute("go", ["env", "GOFLAGS"], { env })).stdout.trim(),
    "-buildvcs=false",
  );
  await writeFile(
    join(cwd, "go.mod"),
    "module example.com/refbox-vcs-fixture\n\ngo 1.25\n",
  );
  await writeFile(
    join(cwd, "main.go"),
    `package main
import ("fmt"; "runtime/debug")
func revision() string { info, ok := debug.ReadBuildInfo(); if ok { for _, s := range info.Settings { if s.Key == "vcs.revision" { return s.Value } } }; return "unknown" }
func main() { fmt.Println(revision()) }
`,
  );
  await writeFile(
    join(cwd, "main_test.go"),
    `package main
import "testing"
func TestRealVCSMetadata(t *testing.T) { if revision() == "unknown" { t.Fatal("trusted test binary must retain actual Git metadata") } }
`,
  );
  await writeFile(join(cwd, "report.json"), '{"count":41}\n');
  const git = async (...args) =>
    (await execute("git", ["-C", cwd, ...args], { env })).stdout.trim();
  await git("init", "--quiet");
  await git("add", ".");
  await git(
    "-c",
    "user.name=VCS fixture",
    "-c",
    "user.email=fixture@localhost",
    "commit",
    "--quiet",
    "-m",
    "test: pin VCS metadata criterion",
  );
  const baselineRevision = await git("rev-parse", "HEAD");
  await writeFile(join(cwd, "report.json"), '{"count":42}\n');
  await git("add", "report.json");
  await git(
    "-c",
    "user.name=VCS fixture",
    "-c",
    "user.email=fixture@localhost",
    "commit",
    "--quiet",
    "-m",
    "feat: produce verified report",
  );
  const goal = "输出真实 count=42 报告并保留程序构建的Git信息";
  const checks = [
    {
      id: "count",
      kind: "json_equals",
      path: "report.json",
      jsonPath: "count",
      equals: 42,
    },
    { id: "tests", kind: "command", command: "tests" },
    { id: "build", kind: "command", command: "build" },
  ];
  const definition = {
    version: 1,
    goal,
    criteria: "真实报告为42，既有Go测试全部实际执行，构建保留真实VCS。",
    checks,
  };
  const definitionJson = JSON.stringify(definition);
  const contract = {
    ...definition,
    definitionJson,
    hash: createHash("sha256").update(definitionJson).digest("hex"),
    reviewConversationId: "contract-vcs-fixture",
    reviewedAt: new Date().toISOString(),
    summary: "固定原始目标与既有Go测试。",
  };
  const context = {
    taskId: "goal_vcs_fixture",
    goal,
    cwd,
    round: 1,
    baselineRevision,
    sourceRepository: cwd,
    nativeStatus: "awaiting_verification",
    nativeUpdatedAt: new Date().toISOString(),
    contract,
    artifacts: ["report.json", "main.go"],
  };
  const result = await proveGoalResult(
    { taskId: context.taskId, contractHash: contract.hash },
    {
      env,
      proofRoot: join(root, "proofs"),
      goalContext: async () => structuredClone(context),
      reviewer: {
        review: async () => ({
          reviewConversationId: "result-vcs-fixture",
          text: '{"approved":true,"summary":"真实报告和固定Go测试已复验。"}',
        }),
      },
    },
  );
  assert.equal(
    result.verdict,
    "pass",
    JSON.stringify(
      result.checks
        .filter((c) => !c.passed)
        .map((c) => ({ id: c.id, stderr: c.witness?.stderr })),
    ),
  );
  for (const check of result.checks.filter((c) => c.kind === "command")) {
    const runs = check.witness.runs.filter((r) => r.argv[0] === "go");
    assert.ok(runs.length > 0);
    assert.ok(
      runs.every((r) => r.argv.includes("-buildvcs=true")),
      "host must explicitly bind its VCS build policy",
    );
  }
});
