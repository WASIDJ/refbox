package control

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"path/filepath"
	"reflect"
	"strings"
	"sync"
	"testing"
	"time"
)

type goalCommandWitness struct {
	Action string
	Key    string
	Body   map[string]any
}

// Stateful HTTP peers exercise the coordinator's real request/auth/state
// boundaries without replacing the goal state machine or contacting a model.
type goalFixture struct {
	t               *testing.T
	mu              sync.Mutex
	s               *Server
	api             *httptest.Server
	engine          *httptest.Server
	prover          *httptest.Server
	cookie          *http.Cookie
	native          nativeTask
	creates         int
	commands        []goalCommandWitness
	receipts        map[string]bool
	contractVerdict string
	contractHook    func(*GoalContract)
	proofHook       func(GoalReview) GoalReview
	proofRequests   []map[string]any
}

func newGoalFixture(t *testing.T) *goalFixture {
	t.Helper()
	f := &goalFixture{t: t, receipts: map[string]bool{}, contractVerdict: "pass"}
	f.engine = httptest.NewServer(http.HandlerFunc(f.engineHandler))
	f.prover = httptest.NewServer(http.HandlerFunc(f.proofHandler))
	cfg := configForTest(f.engine.URL)
	cfg.PlatformDatabase = filepath.Join(t.TempDir(), "platform.sqlite")
	cfg.GoalWorkspaceRoot = filepath.Join(t.TempDir(), "goals")
	cfg.PlatformToken = strings.Repeat("p", 40)
	cfg.VerifierURL = f.prover.URL
	cfg.VerifierToken = strings.Repeat("v", 40)
	var err error
	f.s, err = New(cfg)
	if err != nil {
		t.Fatal(err)
	}
	f.api = httptest.NewServer(f.s)
	f.login()
	t.Cleanup(func() { f.api.Close(); f.s.Close(); f.engine.Close(); f.prover.Close() })
	return f
}

func (f *goalFixture) login() {
	f.t.Helper()
	request, _ := http.NewRequest("POST", f.api.URL+"/api/login", strings.NewReader(`{"password":"test-password"}`))
	request.Header.Set("X-Refbox-Request", "1")
	response, err := f.api.Client().Do(request)
	if err != nil {
		f.t.Fatal(err)
	}
	defer response.Body.Close()
	if response.StatusCode != 200 || len(response.Cookies()) == 0 {
		f.t.Fatal("goal fixture login failed")
	}
	f.cookie = response.Cookies()[0]
}

func (f *goalFixture) request(method, path, key string, body any) (int, []byte) {
	f.t.Helper()
	encoded, err := json.Marshal(body)
	if err != nil {
		f.t.Fatal(err)
	}
	request, _ := http.NewRequest(method, f.api.URL+path, bytes.NewReader(encoded))
	request.AddCookie(f.cookie)
	request.Header.Set("X-Refbox-Request", "1")
	request.Header.Set("Content-Type", "application/json")
	if key != "" {
		request.Header.Set("Idempotency-Key", key)
	}
	response, err := f.api.Client().Do(request)
	if err != nil {
		f.t.Fatal(err)
	}
	defer response.Body.Close()
	data, err := io.ReadAll(response.Body)
	if err != nil {
		f.t.Fatal(err)
	}
	return response.StatusCode, data
}

func (f *goalFixture) create() *PlatformTask {
	f.t.Helper()
	status, data := f.request("POST", "/api/platform/goals", "goal-test-create", map[string]any{"goal": "构建真正可用的 Refbox 目标执行与独立验证系统"})
	if status != 201 {
		f.t.Fatalf("create status=%d %s", status, data)
	}
	var task PlatformTask
	if err := json.Unmarshal(data, &task); err != nil {
		f.t.Fatal(err)
	}
	if task.GoalLoop == nil {
		f.t.Fatal("goal-only submission did not start autonomous coordination")
	}
	return &task
}

func (f *goalFixture) engineHandler(w http.ResponseWriter, r *http.Request) {
	if r.Header.Get("Authorization") != "Bearer "+strings.Repeat("t", 40) || r.Header.Get("Cookie") != "" {
		f.t.Error("runtime role credential or cookie boundary violated")
		w.WriteHeader(401)
		return
	}
	f.mu.Lock()
	defer f.mu.Unlock()
	if r.Method == "POST" && r.URL.Path == "/api/tasks" {
		var input nativeTask
		if json.NewDecoder(r.Body).Decode(&input) != nil || !input.Autonomous || input.Cwd == "" || input.Goal == "" {
			w.WriteHeader(400)
			return
		}
		key := r.Header.Get("Idempotency-Key")
		if !f.receipts[key] {
			f.creates++
			input.ID, input.Status = "101", "draft"
			input.CreatedAt, input.UpdatedAt = instant(), instant()
			f.native = input
			f.receipts[key] = true
		}
		writeJSON(w, 201, f.native)
		return
	}
	if r.Method == "GET" && r.URL.Path == "/api/tasks/101" {
		writeJSON(w, 200, f.native)
		return
	}
	if r.Method == "POST" && strings.HasPrefix(r.URL.Path, "/api/tasks/101/") {
		action := strings.TrimPrefix(r.URL.Path, "/api/tasks/101/")
		var body map[string]any
		if json.NewDecoder(r.Body).Decode(&body) != nil {
			w.WriteHeader(400)
			return
		}
		key := r.Header.Get("Idempotency-Key")
		f.commands = append(f.commands, goalCommandWitness{action, key, body})
		if !f.receipts[key] {
			switch action {
			case "plan":
				f.native.Status = "planning"
			case "approve":
				encoded, _ := json.Marshal(body)
				var plan GoalPlan
				_ = json.Unmarshal(encoded, &plan)
				if !reflect.DeepEqual(f.native.Plan, &plan) {
					w.WriteHeader(409)
					return
				}
				f.native.ApprovedPlan = &plan
				f.native.Status = "running"
			case "continue":
				if f.native.ApprovedPlan == nil {
					w.WriteHeader(409)
					return
				}
				f.native.Status = "running"
			case "stop":
				f.native.Status = "stopped"
			case "steer":
			default:
				w.WriteHeader(404)
				return
			}
			f.native.UpdatedAt = instant()
			f.receipts[key] = true
		}
		writeJSON(w, 200, f.native)
		return
	}
	w.WriteHeader(404)
}

func goalTestContract(goal string, plan GoalPlan) *GoalContract {
	definition, _ := json.Marshal(struct {
		Version  int         `json:"version"`
		Goal     string      `json:"goal"`
		Criteria string      `json:"criteria"`
		Checks   []GoalCheck `json:"checks"`
	}{1, goal, plan.Criteria, plan.Checks})
	hash := sha256.Sum256(definition)
	return &GoalContract{Version: 1, Goal: goal, Criteria: plan.Criteria, Checks: plan.Checks, DefinitionJSON: string(definition), Hash: hex.EncodeToString(hash[:]), ReviewConversationID: "contract-review-22", ReviewedAt: instant(), Summary: "实际源码、行为测试与独立复跑覆盖原始目标"}
}

func (f *goalFixture) proofHandler(w http.ResponseWriter, r *http.Request) {
	if r.Header.Get("Authorization") != "Bearer "+strings.Repeat("v", 40) || r.Header.Get("Cookie") != "" {
		f.t.Error("verifier role credential or cookie boundary violated")
		w.WriteHeader(401)
		return
	}
	if r.URL.Path == "/goal-contract" {
		var input struct {
			TaskID string   `json:"taskId"`
			Goal   string   `json:"goal"`
			Plan   GoalPlan `json:"plan"`
		}
		if json.NewDecoder(r.Body).Decode(&input) != nil {
			w.WriteHeader(400)
			return
		}
		f.mu.Lock()
		verdict, modify := f.contractVerdict, f.contractHook
		f.mu.Unlock()
		contract := goalTestContract(input.Goal, input.Plan)
		if modify != nil {
			modify(contract)
		}
		writeJSON(w, 200, map[string]any{"verdict": verdict, "summary": "初稿缺少真正的目标行为，请补齐实现与反例验证", "reviewConversationId": "contract-review-22", "contract": contract, "review": "Independent contract review"})
		return
	}
	if r.URL.Path == "/goal-result" {
		var request map[string]any
		if json.NewDecoder(r.Body).Decode(&request) != nil {
			w.WriteHeader(400)
			return
		}
		f.mu.Lock()
		f.proofRequests = append(f.proofRequests, request)
		modify := f.proofHook
		f.mu.Unlock()
		task, err := f.s.platform.task(fmt.Sprint(request["taskId"]))
		if err != nil || task.GoalLoop.Contract == nil {
			w.WriteHeader(409)
			return
		}
		goal := task.GoalLoop
		checks := []json.RawMessage{}
		for _, check := range goal.Contract.Checks {
			encoded, _ := json.Marshal(map[string]any{"id": check.ID, "kind": check.Kind, "passed": true, "sampledAt": instant(), "witness": map[string]any{"actual": "verified artifact content"}})
			checks = append(checks, encoded)
		}
		candidate := "git:" + strings.Repeat("a", 40)
		evidence, _ := json.Marshal(map[string]any{"kind": "goal_result_review", "taskId": task.ID, "goal": task.Goal, "round": goal.Rounds, "contractHash": goal.Contract.Hash, "candidateId": candidate, "criteria": goal.Contract.Criteria, "artifacts": []map[string]any{{"path": "actual.txt", "sha256": strings.Repeat("b", 64), "text": "actual delivered source"}}})
		proof := GoalReview{At: instant(), TaskID: task.ID, Round: goal.Rounds, Verdict: "pass", Summary: "独立读取真实源码与复跑测试，目标完成", ReviewConversationID: "result-review-35", ContractHash: goal.Contract.Hash, CandidateID: candidate, Checks: checks, Evidence: evidence, Review: "Independent model reviewed omissions and implementation quality"}
		if modify != nil {
			proof = modify(proof)
		}
		writeJSON(w, 200, proof)
		return
	}
	w.WriteHeader(404)
}

func (f *goalFixture) setNative(status string, plan *GoalPlan) {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.native.Status, f.native.UpdatedAt = status, instant()
	if plan != nil {
		f.native.Plan = plan
	}
}
func (f *goalFixture) commandsFor(action string) []goalCommandWitness {
	f.mu.Lock()
	defer f.mu.Unlock()
	var result []goalCommandWitness
	for _, command := range f.commands {
		if command.Action == action {
			result = append(result, command)
		}
	}
	return result
}
func (f *goalFixture) task(id string) *PlatformTask {
	f.t.Helper()
	task, err := f.s.platform.task(id)
	if err != nil {
		f.t.Fatal(err)
	}
	return task
}
func goalTestPlan() *GoalPlan {
	return &GoalPlan{Steps: "实际改进 Refbox，提交源码与行为测试", Criteria: "actual.txt 记录真实交付，固定测试通过", VerificationCommand: "test -f actual.txt", Checks: []GoalCheck{{ID: "delivery", Kind: "file_contains", Path: "actual.txt", Contains: "implemented"}, {ID: "tests", Kind: "command", Command: "tests"}}}
}
func (f *goalFixture) freeze() *PlatformTask {
	f.t.Helper()
	task := f.create()
	f.s.advanceGoal(context.Background(), task.ID)
	f.setNative("awaiting_confirmation", goalTestPlan())
	f.s.advanceGoal(context.Background(), task.ID)
	f.s.advanceGoal(context.Background(), task.ID)
	if f.task(task.ID).GoalLoop.Contract == nil {
		f.t.Fatal("independent contract failed to freeze")
	}
	f.s.advanceGoal(context.Background(), task.ID)
	if len(f.commandsFor("approve")) != 1 {
		f.t.Fatal("reviewed plan was not approved exactly once")
	}
	return f.task(task.ID)
}
func (f *goalFixture) awaitingProof(id string) {
	f.t.Helper()
	f.setNative("awaiting_verification", nil)
	f.s.advanceGoal(context.Background(), id)
	if f.task(id).GoalLoop.Phase != "verifying" {
		f.t.Fatal("execution candidate did not enter independent verification")
	}
}

func TestAutonomousGoalSubmissionAndIndependentContractGate(t *testing.T) {
	f := newGoalFixture(t)
	task := f.create()
	status, data := f.request("POST", "/api/platform/goals", "goal-test-create", map[string]any{"goal": task.Goal})
	var repeated PlatformTask
	_ = json.Unmarshal(data, &repeated)
	if status != 201 || repeated.ID != task.ID || f.creates != 1 {
		t.Fatalf("duplicate goal created another native task: %d %s creates=%d", status, data, f.creates)
	}
	if status, _ = f.request("POST", "/api/platform/goals", "goal-test-create", map[string]any{"goal": "不同目标"}); status != 409 {
		t.Fatal("same submission key accepted different goal")
	}
	if status, _ = f.request("POST", "/api/platform/goals", "goal-new-source", map[string]any{"goal": "goal", "source": "/etc"}); status != 400 {
		t.Fatal("caller selected arbitrary source path")
	}
	f.s.advanceGoal(context.Background(), task.ID)
	f.s.advanceGoal(context.Background(), task.ID)
	if commands := f.commandsFor("plan"); len(commands) != 1 || commands[0].Key != "goal:"+task.ID+":plan:0" {
		t.Fatalf("planning receipt is unstable: %+v", commands)
	}
	f.setNative("awaiting_confirmation", goalTestPlan())
	f.s.advanceGoal(context.Background(), task.ID)
	if f.task(task.ID).GoalLoop.Phase != "contract_review" || len(f.commandsFor("approve")) != 0 {
		t.Fatal("executor plan bypassed independent review")
	}
	f.mu.Lock()
	f.contractVerdict = "fail"
	f.mu.Unlock()
	f.s.advanceGoal(context.Background(), task.ID)
	afterRejection := f.task(task.ID)
	if afterRejection.GoalLoop.Phase != "planning" || afterRejection.GoalLoop.PlanningAttempt != 1 || afterRejection.GoalLoop.Contract != nil || len(f.commandsFor("approve")) != 0 {
		t.Fatalf("rejected contract executed: %+v", afterRejection.GoalLoop)
	}
	f.s.advanceGoal(context.Background(), task.ID)
	plans := f.commandsFor("plan")
	if len(plans) != 2 || plans[1].Key != "goal:"+task.ID+":plan:1" || !strings.Contains(fmt.Sprint(plans[1].Body["guidance"]), "真正的目标行为") {
		t.Fatalf("independent rejection not fed back to planning: %+v", plans)
	}
	f.setNative("awaiting_confirmation", goalTestPlan())
	f.s.advanceGoal(context.Background(), task.ID)
	f.mu.Lock()
	f.contractVerdict = "pass"
	f.mu.Unlock()
	f.s.advanceGoal(context.Background(), task.ID)
	if task = f.task(task.ID); task.GoalLoop.Contract == nil || task.GoalLoop.Phase != "executing" || len(f.commandsFor("approve")) != 0 {
		t.Fatal("contract must freeze before issuing execution")
	}
	f.s.advanceGoal(context.Background(), task.ID)
	if commands := f.commandsFor("approve"); len(commands) != 1 || commands[0].Key != "goal:"+task.ID+":execute:1" {
		t.Fatalf("execution receipt is unstable: %+v", commands)
	}
	if status, _ = f.request("POST", "/api/platform/tasks/"+task.ID+"/accept", "manual-goal-accept", map[string]any{"reason": "不做独立验证，直接结束"}); status != 409 {
		t.Fatal("manual acceptance bypassed independent goal proof")
	}
	if status, _ = f.request("POST", "/api/platform/tasks/"+task.ID+"/approve", "manual-goal-approve", goalTestPlan()); status != 409 {
		t.Fatal("normal goal requires manual plan control")
	}
}

func TestAutonomousGoalIndependentFeedbackAndCompletion(t *testing.T) {
	f := newGoalFixture(t)
	task := f.freeze()
	f.mu.Lock()
	f.native.Verified = true
	f.mu.Unlock() // Even a dishonest execution flag cannot finish the goal.
	f.awaitingProof(task.ID)
	if task = f.task(task.ID); task.BusinessStatus == "done" || task.VerificationStatus == "pass" {
		t.Fatal("execution assertion was promoted to independent completion")
	}
	contractHash := task.GoalLoop.Contract.Hash
	f.mu.Lock()
	f.proofHook = func(proof GoalReview) GoalReview {
		proof.Verdict = "fail"
		proof.Summary = "真实 UI 没有接通目标输入，执行者只写了说明"
		return proof
	}
	f.mu.Unlock()
	f.s.advanceGoal(context.Background(), task.ID)
	failed := f.task(task.ID)
	if failed.GoalLoop.Phase != "executing" || failed.GoalLoop.Rounds != 2 || failed.GoalLoop.Contract.Hash != contractHash || failed.VerificationStatus != "fail" {
		t.Fatalf("failed proof did not create fixed-contract iteration: %+v", failed)
	}
	f.s.advanceGoal(context.Background(), task.ID)
	continues := f.commandsFor("continue")
	if len(continues) != 1 || continues[0].Key != "goal:"+task.ID+":execute:2" || len(continues[0].Body) != 1 || !strings.Contains(fmt.Sprint(continues[0].Body["guidance"]), "只写了说明") {
		t.Fatalf("feedback or fixed-plan boundary lost: %+v", continues)
	}
	f.awaitingProof(task.ID)
	f.mu.Lock()
	f.proofHook = nil
	f.mu.Unlock()
	f.s.advanceGoal(context.Background(), task.ID)
	done := f.task(task.ID)
	if done.BusinessStatus != "done" || done.VerificationStatus != "pass" || done.GoalLoop.Phase != "completed" || done.GoalLoop.Rounds != 2 || done.GoalLoop.Contract.Hash != contractHash || len(done.GoalLoop.Reviews) != 3 {
		t.Fatalf("matching independent proof did not complete goal: %+v", done)
	}
	f.mu.Lock()
	requests := append([]map[string]any(nil), f.proofRequests...)
	f.mu.Unlock()
	for _, request := range requests {
		if len(request) != 2 || request["taskId"] != task.ID || request["contractHash"] != contractHash {
			t.Fatalf("caller replaced authoritative result scope: %+v", request)
		}
	}
}

func TestAutonomousGoalIncompleteIndependentProofCannotFinish(t *testing.T) {
	cases := map[string]func(GoalReview) GoalReview{
		"wrong task":     func(p GoalReview) GoalReview { p.TaskID = "someone-else"; return p },
		"wrong round":    func(p GoalReview) GoalReview { p.Round++; return p },
		"wrong contract": func(p GoalReview) GoalReview { p.ContractHash = strings.Repeat("0", 64); return p },
		"no candidate":   func(p GoalReview) GoalReview { p.CandidateID = ""; return p },
		"no checks":      func(p GoalReview) GoalReview { p.Checks = nil; return p },
		"no evidence":    func(p GoalReview) GoalReview { p.Evidence = nil; return p },
		"null evidence":  func(p GoalReview) GoalReview { p.Evidence = json.RawMessage(`null`); return p },
		"wrong check ID": func(p GoalReview) GoalReview {
			p.Checks[0] = json.RawMessage(`{"id":"different","kind":"file_contains","passed":true}`)
			return p
		},
		"failed fixed check": func(p GoalReview) GoalReview {
			p.Checks[0] = json.RawMessage(`{"id":"delivery","kind":"file_contains","passed":false}`)
			return p
		},
		"missing independent review": func(p GoalReview) GoalReview { p.ReviewConversationID = ""; return p },
	}
	for name, modify := range cases {
		t.Run(name, func(t *testing.T) {
			f := newGoalFixture(t)
			task := f.freeze()
			f.awaitingProof(task.ID)
			f.mu.Lock()
			f.proofHook = modify
			f.mu.Unlock()
			f.s.advanceGoal(context.Background(), task.ID)
			after := f.task(task.ID)
			if after.BusinessStatus == "done" || after.VerificationStatus == "pass" || after.GoalLoop.Phase == "completed" {
				t.Fatalf("%s proof closed business goal: %+v", name, after.GoalLoop)
			}
			if after.VerificationStatus != "inconclusive" || after.GoalLoop.Rounds != 1 || after.GoalLoop.NextRetryAt == "" {
				t.Fatalf("bad proof did not retain same candidate for independent retry: %+v", after)
			}
		})
	}
}

func TestAutonomousGoalPauseRejectsLateIndependentPass(t *testing.T) {
	f := newGoalFixture(t)
	task := f.freeze()
	f.awaitingProof(task.ID)
	started, release := make(chan struct{}), make(chan struct{})
	f.mu.Lock()
	f.proofHook = func(proof GoalReview) GoalReview { close(started); <-release; return proof }
	f.mu.Unlock()
	finished := make(chan struct{})
	go func() { f.s.advanceGoal(context.Background(), task.ID); close(finished) }()
	select {
	case <-started:
	case <-time.After(3 * time.Second):
		t.Fatal("independent worker did not start")
	}
	status, data := f.request("POST", "/api/platform/tasks/"+task.ID+"/stop", "pause-during-independent-proof", map[string]any{})
	if status != 200 {
		close(release)
		<-finished
		t.Fatalf("pause failed: %d %s", status, data)
	}
	close(release)
	select {
	case <-finished:
	case <-time.After(3 * time.Second):
		t.Fatal("late verification did not return")
	}
	after := f.task(task.ID)
	if after.GoalLoop.Phase != "paused" || after.BusinessStatus == "done" || after.VerificationStatus == "pass" || after.GoalLoop.Rounds != 1 {
		t.Fatalf("late independent pass overrode user pause: %+v", after)
	}
}

func TestAutonomousGoalSQLiteRecoveryPreservesContractBudgetAndCommandReceipts(t *testing.T) {
	f := newGoalFixture(t)
	task := f.freeze()
	before := f.task(task.ID)
	// Simulate a crash after native command admission but before Go persisted its
	// issuance counter. The durable command ID must be reacquired, never renewed.
	if err := f.s.updateGoal(task.ID, func(_ *PlatformTask, g *GoalLoop) error { g.ExecutionIssued = 0; g.MaxRounds = 3; return nil }); err != nil {
		t.Fatal(err)
	}
	if err := f.s.Close(); err != nil {
		t.Fatal(err)
	}
	reopened, err := OpenPlatform(f.s.config.PlatformDatabase)
	if err != nil {
		t.Fatal(err)
	}
	f.s.platform = reopened
	recovered := f.task(task.ID)
	if recovered.GoalLoop.Contract.Hash != before.GoalLoop.Contract.Hash || recovered.GoalLoop.Rounds != 1 || recovered.GoalLoop.MaxRounds != 3 || recovered.GoalLoop.Phase != "executing" || recovered.GoalLoop.PlanningIssued != before.GoalLoop.PlanningIssued {
		t.Fatalf("restart lost frozen contract/budget: %+v", recovered.GoalLoop)
	}
	f.s.advanceGoal(context.Background(), task.ID)
	approvals := f.commandsFor("approve")
	if len(approvals) != 2 || approvals[0].Key != approvals[1].Key || len(f.receipts) != 3 {
		t.Fatalf("restart changed native command receipt or re-executed admission: %+v receipts=%d", approvals, len(f.receipts))
	}
	status, data := f.request("POST", "/api/platform/goals", "goal-test-create", map[string]any{"goal": task.Goal})
	var repeated PlatformTask
	_ = json.Unmarshal(data, &repeated)
	if status != 201 || repeated.ID != task.ID || f.creates != 1 {
		t.Fatalf("restart duplicated goal submission: %d %s creates=%d", status, data, f.creates)
	}
	f.awaitingProof(task.ID)
	f.mu.Lock()
	f.proofHook = func(proof GoalReview) GoalReview {
		proof.Verdict = "fail"
		proof.Summary = "继续失败"
		return proof
	}
	f.mu.Unlock()
	for round := 1; round <= 3; round++ {
		f.s.advanceGoal(context.Background(), task.ID)
		state := f.task(task.ID)
		if round < 3 {
			f.s.advanceGoal(context.Background(), task.ID)
			f.awaitingProof(task.ID)
		} else if state.GoalLoop.Phase != "blocked" || state.GoalLoop.Rounds != 3 || state.BusinessStatus != "attention" {
			t.Fatalf("persisted execution budget was exceeded: %+v", state)
		}
	}
	if len(f.commandsFor("continue")) != 2 {
		t.Fatal("budget allowed an extra execution round")
	}
}
