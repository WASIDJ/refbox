# Autonomous goal loop v1 integration contract

User submits `POST /api/platform/goals {goal, model?, source?}`. Only goal is required. Existing `/api/platform/tasks` and legacy manual tasks remain compatible. A normal goal never needs the user to edit a command or approve a plan.

Go owns the goal state and frozen verification contract in platform.sqlite. Each task exposes optional `goalLoop`:

```ts
type GoalLoop = {
  phase: 'planning'|'contract_review'|'executing'|'verifying'|'completed'|'blocked'|'paused';
  rounds: number;
  maxRounds: number; // default 6 actual execution rounds, not a timer
  reason: string;
  contract?: GoalContract;
  reviews: GoalReview[];
};
type GoalCheck = {
  id: string;
  kind: 'file_exists'|'file_contains'|'json_equals'|'command';
  path?: string; // relative to goal workspace, no symlink/path escapes
  contains?: string;
  jsonPath?: string;
  equals?: unknown;
  command?: 'tests'|'build'|'ui'|'diff'; // fixed host argv, never caller shell
};
type GoalPlan = {
  steps: string;
  criteria: string;
  verificationCommand: string; // execution-side check, never independent proof
  checks?: GoalCheck[];
};
type GoalContract = {
  version: 1;
  goal: string;
  criteria: string;
  checks: GoalCheck[];
  definitionJson: string; // JSON.stringify({version:1,goal,criteria,checks})
  hash: string; // SHA256 of exact UTF-8 definitionJson
  reviewConversationId: string;
  reviewedAt: string;
  summary: string;
};
type GoalReview = {
  at: string;
  verdict: 'pass'|'fail'|'inconclusive';
  summary: string;
  reviewConversationId: string;
  contractHash: string;
  candidateId?: string;
  checks?: unknown[];
  evidence?: unknown;
};
```

Runtime task gains optional `autonomous:boolean`. Autonomous planning has read-only context/file tools and proposes GoalPlan. Execution still uses Pi Durable's existing generation/tool/recovery loop. Self-check success for an autonomous task enters `awaiting_verification`, preserving execution_assertion; it never marks the business goal completed. Existing `approve` accepts the exact reviewed plan. `continue` accepts `awaiting_verification` with verifier feedback in body.guidance; `plan` accepts verifier feedback for rejected initial contracts. No model tool can edit a frozen contract. A runtime `prepare` command can set the coordinator-selected workspace only while draft/planning/awaiting_confirmation. Runtime receives context paths in constructor options/env; automatic Wiki use is read-only.

Go creates an isolated goal workspace (default source repository configured by administrator; blank source allows file-only tasks), defaults title/model from goal/config, queues planning itself, and drives phases from actual native status. Independent contract rejection is fed back to planning. Result fail resumes execution with exact deficiencies and the same frozen contract. Inconclusive keeps pending/blocked with visible evidence and permits explicit retry. Stop pauses the goal loop. Startup/repeated ticks use stable command receipts and preserve rounds/contracts/proofs. Completion is set only from a matching independent pass bound to task, contract and candidate.

Verifier service adds two authenticated endpoints using its existing dedicated token:

- `POST /goal-contract {taskId, goal, plan}`: validate checks, review goal coverage independently, return `{verdict,summary,reviewConversationId,contract?}`. A malformed/insufficient or goal-reducing proposal cannot be approved. The candidate executor does not choose the model's conclusion.
- `POST /goal-result {taskId, contractHash}`: authoritative context comes from `GET /internal/goals/{taskId}/context` with platform token, returning `{taskId,goal,cwd,contract,round,artifacts?,nativeStatus?}`. Never trust caller replacement criteria or paths. Copy/snapshot the candidate independently, retain file hashes and actual bounded content; for Git workspaces use the committed clean candidate and its revision, and run checks in a separate temporary checkout/copy. Fixed command IDs map to host-controlled test/build/browser argv and git diff --check; candidate npm scripts cannot redefine them. Existing tests, manifests and build configurations come from the frozen goal baseline. All named Go fixtures must actually PASS, and Go tests/builds explicitly retain VCS metadata. Reuse shared dependencies without copying .env, credentials, business DBs or node_modules into evidence. Test/build/UI failures cannot pass; every asserted check is executed by the host independently before model review. Preserve captured witness and review text, reject missing provenance and scope/candidate changes. Cleanup proof workspace, retain evidence.

Shared proof context must include the raw goal, frozen criteria, task/round/contract/candidate IDs, actual artifact content and checks. The independent model also checks omissions, old artifacts, trivial implementations and weakened tests, not merely process exits. Role separation on the same root-enabled machine is not adversarial root isolation.

First real acceptance goal improves Refbox itself in its isolated worktree. It must produce an actual source change, reproduce meaningful tests and pass this independent workflow. The orchestrator, not the execution Agent, publishes a verified implementation to the live installation under the user's current authorization. Existing Cloudflare configuration and Tailscale are untouched.
