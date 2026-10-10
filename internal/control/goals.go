package control

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"reflect"
	"regexp"
	"strings"
	"time"
)

type GoalCheck struct {
	ID       string          `json:"id"`
	Kind     string          `json:"kind"`
	Path     string          `json:"path,omitempty"`
	Contains string          `json:"contains,omitempty"`
	JSONPath string          `json:"jsonPath,omitempty"`
	Equals   json.RawMessage `json:"equals,omitempty"`
	Command  string          `json:"command,omitempty"`
}

var requestKeyPattern = regexp.MustCompile(`^[a-zA-Z0-9:_-]{8,128}$`)

type GoalPlan struct {
	Steps               string      `json:"steps"`
	Criteria            string      `json:"criteria"`
	VerificationCommand string      `json:"verificationCommand"`
	Checks              []GoalCheck `json:"checks,omitempty"`
}
type GoalContract struct {
	Version              int         `json:"version"`
	Goal                 string      `json:"goal"`
	Criteria             string      `json:"criteria"`
	Checks               []GoalCheck `json:"checks"`
	DefinitionJSON       string      `json:"definitionJson"`
	Hash                 string      `json:"hash"`
	ReviewConversationID string      `json:"reviewConversationId"`
	ReviewedAt           string      `json:"reviewedAt"`
	Summary              string      `json:"summary"`
}
type GoalReview struct {
	At                   string            `json:"at"`
	TaskID               string            `json:"taskId,omitempty"`
	Round                int               `json:"round,omitempty"`
	Verdict              string            `json:"verdict"`
	Summary              string            `json:"summary"`
	ReviewConversationID string            `json:"reviewConversationId"`
	ContractHash         string            `json:"contractHash"`
	CandidateID          string            `json:"candidateId,omitempty"`
	Checks               []json.RawMessage `json:"checks,omitempty"`
	Evidence             json.RawMessage   `json:"evidence,omitempty"`
	Review               string            `json:"review,omitempty"`
}
type GoalLoop struct {
	Phase            string        `json:"phase"`
	Rounds           int           `json:"rounds"`
	MaxRounds        int           `json:"maxRounds"`
	Reason           string        `json:"reason"`
	Contract         *GoalContract `json:"contract,omitempty"`
	Reviews          []GoalReview  `json:"reviews"`
	BaselineRevision string        `json:"baselineRevision,omitempty"`
	SourceRepository string        `json:"sourceRepository,omitempty"`
	PlanningAttempt  int           `json:"planningAttempt"`
	PlanningIssued   int           `json:"planningIssued"`
	ExecutionIssued  int           `json:"executionIssued"`
	NextRetryAt      string        `json:"nextRetryAt,omitempty"`
	Unknowns         int           `json:"unknowns"`
}
type GoalRequest struct {
	ID               string `json:"id"`
	Hash             string `json:"hash"`
	Goal             string `json:"goal"`
	Model            string `json:"model"`
	Cwd              string `json:"cwd"`
	SourceRepository string `json:"sourceRepository"`
	BaselineRevision string `json:"baselineRevision"`
	Initialized      bool   `json:"initialized"`
	TaskID           string `json:"taskId,omitempty"`
}

func (s *Server) goalNative(ctx context.Context, t *PlatformTask) (nativeTask, error) {
	var n nativeTask
	response, err := s.engineRequest(ctx, "GET", "/api/tasks/"+t.ConversationID, nil, "")
	if err != nil {
		return n, err
	}
	defer response.Body.Close()
	if response.StatusCode != 200 {
		return n, errors.New("执行上下文暂不可用")
	}
	err = json.NewDecoder(io.LimitReader(response.Body, 8<<20)).Decode(&n)
	if err == nil && (n.ID != t.ConversationID || n.Goal != t.Goal || n.Cwd != t.Cwd || !n.Autonomous) {
		err = errors.New("目标与原生上下文不一致")
	}
	return n, err
}
func (s *Server) goalContext(ctx context.Context, id string) (map[string]any, error) {
	t, err := s.platform.task(id)
	if err != nil || t.GoalLoop == nil {
		return nil, errors.New("自主目标不存在")
	}
	n, err := s.goalNative(ctx, t)
	if err != nil {
		return nil, err
	}
	artifacts := []string{}
	for _, experiment := range n.Experiments {
		artifacts = append(artifacts, experiment.Artifacts...)
	}
	return map[string]any{"taskId": t.ID, "goal": t.Goal, "cwd": t.Cwd, "contract": t.GoalLoop.Contract, "round": t.GoalLoop.Rounds, "artifacts": artifacts, "nativeStatus": n.Status, "nativeUpdatedAt": n.UpdatedAt, "baselineRevision": t.GoalLoop.BaselineRevision, "sourceRepository": t.GoalLoop.SourceRepository, "phase": t.GoalLoop.Phase}, nil
}
func (s *Server) goalCommand(ctx context.Context, t *PlatformTask, action string, input any, key string) (nativeTask, error) {
	var n nativeTask
	body, _ := json.Marshal(input)
	response, err := s.engineRequest(ctx, "POST", "/api/tasks/"+t.ConversationID+"/"+action, bytes.NewReader(body), key)
	if err != nil {
		return n, err
	}
	defer response.Body.Close()
	if response.StatusCode >= 300 {
		return n, fmt.Errorf("执行操作 %s 暂未受理（%d）", action, response.StatusCode)
	}
	if err = json.NewDecoder(io.LimitReader(response.Body, 8<<20)).Decode(&n); err != nil {
		return n, err
	}
	if n.ID != t.ConversationID {
		return n, errors.New("执行回执与目标不一致")
	}
	return n, s.platform.syncTasks([]nativeTask{n}, true)
}
func (s *Server) goalProofRequest(ctx context.Context, path string, input any, output any) error {
	if s.config.VerifierURL == "" || len(s.config.VerifierToken) < 32 {
		return errors.New("独立验证器尚未配置")
	}
	if _, err := localURL(s.config.VerifierURL); err != nil {
		return err
	}
	body, _ := json.Marshal(input)
	request, err := http.NewRequestWithContext(ctx, "POST", strings.TrimRight(s.config.VerifierURL, "/")+path, bytes.NewReader(body))
	if err != nil {
		return err
	}
	request.Header.Set("Authorization", "Bearer "+s.config.VerifierToken)
	request.Header.Set("Content-Type", "application/json")
	client := s.goalClient
	if client == nil {
		client = s.serviceClient
	}
	response, err := client.Do(request)
	if err != nil {
		return errors.New("独立验证暂不可用；保留目标与证据后重试")
	}
	defer response.Body.Close()
	if response.StatusCode != 200 {
		return fmt.Errorf("独立验证未完成（%d）", response.StatusCode)
	}
	return json.NewDecoder(io.LimitReader(response.Body, 4<<20)).Decode(output)
}
func validateGoalContract(c *GoalContract, goal string, plan *GoalPlan) error {
	if c == nil || plan == nil || c.Version != 1 || c.Goal != goal || c.Criteria != plan.Criteria || len(c.Checks) == 0 || len(c.Checks) > 32 || c.ReviewConversationID == "" || strings.TrimSpace(c.Summary) == "" {
		return errors.New("共享验收方案缺少目标覆盖、固定标准或独立审查")
	}
	var definition struct {
		Version  int         `json:"version"`
		Goal     string      `json:"goal"`
		Criteria string      `json:"criteria"`
		Checks   []GoalCheck `json:"checks"`
	}
	if len(c.DefinitionJSON) > 100000 || json.Unmarshal([]byte(c.DefinitionJSON), &definition) != nil || definition.Version != c.Version || definition.Goal != c.Goal || definition.Criteria != c.Criteria || !reflect.DeepEqual(definition.Checks, c.Checks) || !reflect.DeepEqual(plan.Checks, c.Checks) {
		return errors.New("验收标准与独立审查内容不一致")
	}
	digest := sha256.Sum256([]byte(c.DefinitionJSON))
	if hex.EncodeToString(digest[:]) != c.Hash {
		return errors.New("验收方案指纹不匹配")
	}
	ids := map[string]bool{}
	for _, check := range c.Checks {
		if !validID.MatchString(check.ID) || ids[check.ID] {
			return errors.New("验收项标识无效")
		}
		ids[check.ID] = true
		switch check.Kind {
		case "command":
			if check.Command != "tests" && check.Command != "build" && check.Command != "ui" && check.Command != "diff" {
				return errors.New("验收命令未注册")
			}
		case "file_exists", "file_contains", "json_equals":
			if check.Path == "" || filepath.IsAbs(check.Path) || filepath.Clean(check.Path) == ".." || strings.HasPrefix(filepath.Clean(check.Path), ".."+string(filepath.Separator)) {
				return errors.New("验收路径超出目标工作区")
			}
		default:
			return errors.New("验收方式未注册")
		}
	}
	return nil
}
// validGoalProof enforces that an independent pass verdict is bound to the
// exact task, round, frozen contract and candidate, that every fixed contract
// check is present with an independently observed passed=true result, and that
// real non-null evidence was collected. Anything weaker can never close the
// goal; the same candidate stays available for an independent retry.
func validGoalProof(proof *GoalReview, taskID string, rounds int, contractHash string, contractChecks []GoalCheck) error {
	if proof.TaskID != taskID || proof.Round != rounds || proof.ContractHash != contractHash {
		return errors.New("独立证据缺少匹配的任务、轮次或方案")
	}
	if proof.Verdict != "pass" {
		return nil
	}
	if proof.CandidateID == "" || proof.ReviewConversationID == "" {
		return errors.New("独立证据缺少匹配的任务、轮次、方案或候选版本")
	}
	if len(proof.Evidence) == 0 || bytes.Equal(bytes.TrimSpace(proof.Evidence), []byte("null")) {
		return errors.New("独立证据缺少真实的结果证据")
	}
	if len(proof.Checks) != len(contractChecks) {
		return errors.New("独立证据缺少固定验收项的完整结果")
	}
	expected := map[string]int{}
	for _, check := range contractChecks {
		expected[check.ID]++
	}
	var observed struct {
		ID     string          `json:"id"`
		Kind   string          `json:"kind"`
		Passed json.RawMessage `json:"passed"`
	}
	for _, raw := range proof.Checks {
		observed = struct {
			ID     string          `json:"id"`
			Kind   string          `json:"kind"`
			Passed json.RawMessage `json:"passed"`
		}{}
		if err := json.Unmarshal(raw, &observed); err != nil {
			return errors.New("独立验收结果无法解析")
		}
		if expected[observed.ID] == 0 {
			return errors.New("独立验收结果与固定验收项不匹配")
		}
		expected[observed.ID]--
		if !bytes.Equal(bytes.TrimSpace(observed.Passed), []byte("true")) {
			return errors.New("固定验收项未独立通过，不能把目标标记完成")
		}
	}
	for _, remaining := range expected {
		if remaining != 0 {
			return errors.New("独立验收结果与固定验收项不匹配")
		}
	}
	return nil
}

func (s *Server) updateGoal(id string, fn func(*PlatformTask, *GoalLoop) error) error {
	return s.platform.mutate(func() error {
		t := s.platform.state.Tasks[id]
		if t == nil || t.GoalLoop == nil {
			return errors.New("自主目标不存在")
		}
		err := fn(t, t.GoalLoop)
		if err == nil {
			t.UpdatedAt = instant()
		}
		return err
	})
}
func (s *Server) deferGoal(id string, phase string, reason string) {
	_ = s.updateGoal(id, func(t *PlatformTask, g *GoalLoop) error {
		if g.Phase != phase {
			return nil
		}
		g.Unknowns++
		g.Reason = reason
		g.NextRetryAt = time.Now().Add(30 * time.Second).UTC().Format(time.RFC3339Nano)
		t.VerificationStatus = "inconclusive"
		if g.Unknowns >= 6 {
			g.Phase = "blocked"
			t.BusinessStatus = "attention"
		}
		return nil
	})
}
func (s *Server) advanceGoal(ctx context.Context, id string) {
	key := "goal:" + id
	if _, loaded := s.platform.operations.LoadOrStore(key, true); loaded {
		return
	}
	defer s.platform.operations.Delete(key)
	t, err := s.platform.task(id)
	if err != nil || t.GoalLoop == nil {
		return
	}
	g := t.GoalLoop
	if g.Phase == "paused" || g.Phase == "blocked" || g.Phase == "completed" || (!parseTime(g.NextRetryAt).IsZero() && time.Now().Before(parseTime(g.NextRetryAt))) {
		return
	}
	n, err := s.goalNative(ctx, t)
	if err != nil {
		s.deferGoal(id, g.Phase, err.Error())
		return
	}
	switch g.Phase {
	case "planning":
		if g.PlanningIssued < g.PlanningAttempt {
			_, err = s.goalCommand(ctx, t, "plan", map[string]any{"guidance": g.Reason}, fmt.Sprintf("goal:%s:plan:%d", id, g.PlanningAttempt))
			if err != nil {
				s.deferGoal(id, g.Phase, err.Error())
				return
			}
			_ = s.updateGoal(id, func(t *PlatformTask, x *GoalLoop) error {
				if x.Phase == "planning" && x.PlanningAttempt == g.PlanningAttempt {
					x.PlanningIssued = x.PlanningAttempt
					x.Unknowns = 0
					x.NextRetryAt = ""
				}
				return nil
			})
			return
		}
		if n.Status == "awaiting_confirmation" && n.Plan != nil {
			_ = s.updateGoal(id, func(t *PlatformTask, x *GoalLoop) error {
				if x.Phase == "planning" {
					x.Phase = "contract_review"
					x.Reason = "独立 Agent 正在核对验收方案是否覆盖原始目标"
				}
				return nil
			})
		} else if n.Status == "blocked" || n.Status == "stopped" {
			_ = s.updateGoal(id, func(t *PlatformTask, x *GoalLoop) error {
				x.Phase = "blocked"
				x.Reason = n.Reason
				t.BusinessStatus = "attention"
				return nil
			})
		}
	case "contract_review":
		if n.Status != "awaiting_confirmation" || n.Plan == nil {
			s.deferGoal(id, g.Phase, "等待完整的 Agent 方案")
			return
		}
		var result struct {
			Verdict              string        `json:"verdict"`
			Summary              string        `json:"summary"`
			ReviewConversationID string        `json:"reviewConversationId"`
			Contract             *GoalContract `json:"contract"`
			Review               string        `json:"review"`
		}
		err = s.goalProofRequest(ctx, "/goal-contract", map[string]any{"taskId": id, "goal": t.Goal, "plan": n.Plan}, &result)
		if err != nil {
			s.deferGoal(id, g.Phase, err.Error())
			return
		}
		if result.Verdict == "pass" {
			if err = validateGoalContract(result.Contract, t.Goal, n.Plan); err != nil {
				result.Verdict = "inconclusive"
				result.Summary = err.Error()
			}
		}
		fresh, e := s.goalNative(ctx, t)
		if e != nil || fresh.Status != "awaiting_confirmation" || !reflect.DeepEqual(fresh.Plan, n.Plan) {
			s.deferGoal(id, g.Phase, "审查期间初始方案改变，重新审查")
			return
		}
		_ = s.updateGoal(id, func(task *PlatformTask, x *GoalLoop) error {
			if x.Phase != "contract_review" || x.PlanningAttempt != g.PlanningAttempt {
				return nil
			}
			x.Reviews = append(x.Reviews, GoalReview{At: instant(), Verdict: result.Verdict, Summary: result.Summary, ReviewConversationID: result.ReviewConversationID, Review: result.Review})
			x.Reason = result.Summary
			if result.Verdict == "pass" {
				x.Contract = result.Contract
				x.Phase = "executing"
				x.Rounds = 1
				x.ExecutionIssued = 0
				x.Unknowns = 0
				x.NextRetryAt = ""
				task.VerificationStatus = "pending"
				s.platform.event("goal.contract_frozen", "", "", task.Title+"：共享验收方案已独立审查并冻结")
			} else if result.Verdict == "fail" {
				x.PlanningAttempt++
				x.PlanningIssued = x.PlanningAttempt - 1
				x.Phase = "planning"
				x.Reason = "独立审查拒绝初稿，请按原始目标补齐：" + result.Summary
				if x.PlanningAttempt >= 6 {
					x.Phase = "blocked"
					task.BusinessStatus = "attention"
				}
			} else {
				x.Unknowns++
				x.NextRetryAt = time.Now().Add(30 * time.Second).UTC().Format(time.RFC3339Nano)
				task.VerificationStatus = "inconclusive"
				if x.Unknowns >= 6 {
					x.Phase = "blocked"
					task.BusinessStatus = "attention"
				}
			}
			return nil
		})
	case "executing":
		if g.Contract == nil {
			s.deferGoal(id, g.Phase, "缺少独立审查后的固定标准")
			return
		}
		if g.ExecutionIssued < g.Rounds {
			action := "continue"
			var payload any = map[string]any{"guidance": g.Reason}
			if g.Rounds == 1 {
				action = "approve"
				payload = n.Plan
			}
			_, err = s.goalCommand(ctx, t, action, payload, fmt.Sprintf("goal:%s:execute:%d", id, g.Rounds))
			if err != nil {
				s.deferGoal(id, g.Phase, err.Error())
				return
			}
			_ = s.updateGoal(id, func(t *PlatformTask, x *GoalLoop) error {
				if x.Phase == "executing" && x.Rounds == g.Rounds {
					x.ExecutionIssued = x.Rounds
					x.Unknowns = 0
					x.NextRetryAt = ""
					t.BusinessStatus = "active"
				}
				return nil
			})
			return
		}
		if n.Status == "awaiting_verification" {
			_ = s.updateGoal(id, func(t *PlatformTask, x *GoalLoop) error {
				if x.Phase == "executing" {
					x.Phase = "verifying"
					x.Reason = "执行者已提交候选成果，独立 Agent 正在实际复验"
					t.VerificationStatus = "pending"
				}
				return nil
			})
		} else if n.Status == "blocked" || n.Status == "stopped" {
			_ = s.updateGoal(id, func(t *PlatformTask, x *GoalLoop) error {
				x.Phase = "blocked"
				x.Reason = n.Reason
				t.BusinessStatus = "attention"
				return nil
			})
		}
	case "verifying":
		if g.Contract == nil || n.Status != "awaiting_verification" {
			s.deferGoal(id, g.Phase, "候选成果尚未完整提交")
			return
		}
		var proof GoalReview
		err = s.goalProofRequest(ctx, "/goal-result", map[string]any{"taskId": id, "contractHash": g.Contract.Hash}, &proof)
		if err != nil {
			s.deferGoal(id, g.Phase, err.Error())
			return
		}
		if err := validGoalProof(&proof, id, g.Rounds, g.Contract.Hash, g.Contract.Checks); err != nil {
			proof.Verdict = "inconclusive"
			proof.Summary = err.Error()
		}
		fresh, e := s.goalNative(ctx, t)
		if e != nil || fresh.Status != "awaiting_verification" || fresh.UpdatedAt != n.UpdatedAt {
			s.deferGoal(id, g.Phase, "验证期间执行上下文改变，旧证据不能闭合")
			return
		}
		if proof.At == "" {
			proof.At = instant()
		}
		_ = s.updateGoal(id, func(task *PlatformTask, x *GoalLoop) error {
			if x.Phase != "verifying" || x.Rounds != g.Rounds || x.Contract == nil || x.Contract.Hash != g.Contract.Hash {
				return nil
			}
			x.Reviews = append(x.Reviews, proof)
			x.Reason = proof.Summary
			if proof.Verdict == "pass" {
				x.Phase = "completed"
				x.Unknowns = 0
				task.VerificationStatus = "pass"
				task.BusinessStatus = "done"
				s.platform.event("goal.verified", "", "", task.Title+"：独立验证通过并交付")
			} else if proof.Verdict == "fail" {
				task.VerificationStatus = "fail"
				if x.Rounds >= x.MaxRounds {
					x.Phase = "blocked"
					task.BusinessStatus = "attention"
					x.Reason = "已达本目标的执行轮次预算；最后缺口：" + proof.Summary
				} else {
					x.Phase = "executing"
					x.Rounds++
					x.Reason = "独立验收未通过。保持原验收方案，修复这些缺口并提交新候选：" + proof.Summary
					s.platform.event("goal.feedback", "", "", task.Title+"：独立验证缺口已反馈，开始下一轮")
				}
			} else {
				task.VerificationStatus = "inconclusive"
				x.Unknowns++
				x.NextRetryAt = time.Now().Add(30 * time.Second).UTC().Format(time.RFC3339Nano)
				if x.Unknowns >= 6 {
					x.Phase = "blocked"
					task.BusinessStatus = "attention"
				}
			}
			return nil
		})
	}
}

func (s *Server) ensureGoalWorkspace(ctx context.Context, request GoalRequest) (GoalRequest, error) {
	if request.Initialized {
		return request, nil
	}
	if err := os.MkdirAll(filepath.Dir(request.Cwd), 0750); err != nil {
		return request, err
	}
	if request.SourceRepository == "" {
		if err := os.MkdirAll(request.Cwd, 0750); err != nil {
			return request, err
		}
	} else {
		command := exec.CommandContext(ctx, "git", "-c", "safe.directory="+request.SourceRepository, "-C", request.SourceRepository, "rev-parse", "HEAD")
		out, err := command.Output()
		if err != nil {
			return request, errors.New("目标源仓库不可读")
		}
		request.BaselineRevision = strings.TrimSpace(string(out))
		if _, err := os.Stat(filepath.Join(request.Cwd, ".git")); os.IsNotExist(err) {
			command = exec.CommandContext(ctx, "git", "-c", "safe.directory="+request.SourceRepository, "-C", request.SourceRepository, "worktree", "add", "--detach", request.Cwd, request.BaselineRevision)
			if err = command.Run(); err != nil {
				return request, errors.New("无法准备独立目标工作区")
			}
		}
	}
	if s.config.GoalDependenciesRoot != "" && request.SourceRepository != "" {
		dependencies := filepath.Join(s.config.GoalDependenciesRoot, "node_modules")
		if info, e := os.Stat(dependencies); e != nil || !info.IsDir() {
			return request, errors.New("目标依赖目录不可用")
		}
		link := filepath.Join(request.Cwd, "node_modules")
		if _, e := os.Lstat(link); os.IsNotExist(e) {
			if e = os.Symlink(dependencies, link); e != nil {
				return request, e
			}
		}
	}
	request.Initialized = true
	err := s.platform.mutate(func() error {
		prior := s.platform.state.GoalRequests[request.ID]
		if prior == nil {
			return errors.New("目标创建回执丢失")
		}
		prior.Initialized = true
		prior.BaselineRevision = request.BaselineRevision
		return nil
	})
	return request, err
}
func (s *Server) createGoal(w http.ResponseWriter, r *http.Request) {
	s.goalCreateMu.Lock()
	defer s.goalCreateMu.Unlock()
	var input struct {
		Goal   string  `json:"goal"`
		Model  string  `json:"model"`
		Source *string `json:"source"`
	}
	if decodeBody(w, r, &input) != nil || strings.TrimSpace(input.Goal) == "" || len(input.Goal) > 20000 {
		jsonError(w, 400, "请描述你希望实现的目标")
		return
	}
	input.Goal = strings.TrimSpace(input.Goal)
	if input.Model == "" {
		input.Model = s.config.GoalModel
	}
	if input.Model == "" {
		input.Model = "kimi-k3"
	}
	source := s.config.GoalSourceRepository
	if input.Source != nil {
		if *input.Source == "" {
			source = ""
		} else if *input.Source != "refbox" {
			jsonError(w, 400, "目标源尚未注册")
			return
		} else if source == "" {
			jsonError(w, 400, "尚未配置 Refbox 源仓库")
			return
		}
	}
	key := r.Header.Get("Idempotency-Key")
	if len(key) < 8 || len(key) > 128 || !requestKeyPattern.MatchString(key) {
		jsonError(w, 400, "需要有效的目标提交回执")
		return
	}
	raw, _ := json.Marshal(map[string]string{"goal": input.Goal, "model": input.Model, "source": source})
	digest := sha256.Sum256(raw)
	hash := hex.EncodeToString(digest[:])
	var request GoalRequest
	workspace := s.config.GoalWorkspaceRoot
	if workspace == "" {
		workspace = filepath.Join(filepath.Dir(s.config.PlatformDatabase), "workspaces", "goals")
	}
	workspace, _ = filepath.Abs(workspace)
	err := s.platform.mutate(func() error {
		if s.platform.state.GoalRequestKeys == nil {
			s.platform.state.GoalRequestKeys = map[string]string{}
		}
		if s.platform.state.GoalRequests == nil {
			s.platform.state.GoalRequests = map[string]*GoalRequest{}
		}
		if priorID := s.platform.state.GoalRequestKeys[key]; priorID != "" {
			prior := s.platform.state.GoalRequests[priorID]
			if prior == nil || prior.Hash != hash {
				return errors.New("此提交回执已用于其他目标")
			}
			request = *prior
			return nil
		}
		id := identifier("goal_")
		request = GoalRequest{ID: id, Hash: hash, Goal: input.Goal, Model: input.Model, Cwd: filepath.Join(workspace, id), SourceRepository: source}
		copy := request
		s.platform.state.GoalRequests[id] = &copy
		s.platform.state.GoalRequestKeys[key] = id
		return nil
	})
	if err != nil {
		jsonError(w, 409, err.Error())
		return
	}
	if request.TaskID != "" {
		task, e := s.platform.task(request.TaskID)
		if e != nil {
			jsonError(w, 503, "目标读取暂不可用")
		} else {
			writeJSON(w, 201, task)
		}
		return
	}
	request, err = s.ensureGoalWorkspace(r.Context(), request)
	if err != nil {
		jsonError(w, 503, err.Error())
		return
	}
	title := []rune(strings.Split(input.Goal, "\n")[0])
	if len(title) > 80 {
		title = title[:80]
	}
	payload, _ := json.Marshal(map[string]any{"title": string(title), "goal": input.Goal, "cwd": request.Cwd, "model": input.Model, "autonomous": true})
	response, err := s.engineRequest(r.Context(), "POST", "/api/tasks", bytes.NewReader(payload), "goal-create:"+request.ID)
	if err != nil {
		jsonError(w, 503, "执行器暂不可用；同一目标提交可安全重试")
		return
	}
	defer response.Body.Close()
	if response.StatusCode >= 300 {
		jsonError(w, 503, "执行器没有受理目标；请检查模型与上下文")
		return
	}
	var n nativeTask
	if json.NewDecoder(io.LimitReader(response.Body, 1<<20)).Decode(&n) != nil || !n.Autonomous || n.Goal != request.Goal || n.Cwd != request.Cwd {
		jsonError(w, 503, "执行上下文不匹配或执行器版本需要更新")
		return
	}
	if err = s.platform.syncTasks([]nativeTask{n}, true); err != nil {
		jsonError(w, 500, "目标已受理，平台状态待同步；同一提交可重试")
		return
	}
	var id string
	err = s.platform.mutate(func() error {
		for _, task := range s.platform.state.Tasks {
			if task.ConversationID == n.ID {
				id = task.ID
				if task.GoalLoop == nil {
					task.GoalLoop = &GoalLoop{Phase: "planning", MaxRounds: 6, PlanningIssued: -1, Reviews: []GoalReview{}, BaselineRevision: request.BaselineRevision, SourceRepository: request.SourceRepository}
					task.BusinessStatus = "active"
					task.VerificationStatus = "pending"
					s.platform.event("goal.created", "", "", task.Title+"：Agent 将自主规划并接受独立验收")
				}
				s.platform.state.GoalRequests[request.ID].TaskID = id
				return nil
			}
		}
		return errors.New("目标映射待恢复")
	})
	if err != nil {
		jsonError(w, 500, err.Error())
		return
	}
	task, _ := s.platform.task(id)
	writeJSON(w, 201, task)
}
func (s *Server) controlGoal(ctx context.Context, t *PlatformTask, action string, input map[string]any) (*PlatformTask, error) {
	switch action {
	case "stop":
		err := s.updateGoal(t.ID, func(task *PlatformTask, g *GoalLoop) error {
			if g.Phase == "completed" {
				return errors.New("目标已独立验收完成")
			}
			g.Phase = "paused"
			g.Reason = "用户暂停；工作区、验收方案和证据保留"
			task.BusinessStatus = "attention"
			return nil
		})
		if err != nil {
			return nil, err
		}
		_, err = s.goalCommand(ctx, t, "stop", map[string]any{}, fmt.Sprintf("goal:%s:pause:%s", t.ID, runeKey()))
		if err != nil {
			_ = s.updateGoal(t.ID, func(task *PlatformTask, g *GoalLoop) error {
				g.Reason += "；执行停止尚未确认，请查看原生状态"
				return nil
			})
		}
	case "continue":
		n, err := s.goalNative(ctx, t)
		if err != nil {
			return nil, err
		}
		err = s.updateGoal(t.ID, func(task *PlatformTask, g *GoalLoop) error {
			if g.Phase != "paused" && g.Phase != "blocked" {
				return errors.New("目标正在自主推进或已完成")
			}
			g.Unknowns = 0
			g.NextRetryAt = ""
			task.BusinessStatus = "active"
			task.VerificationStatus = "pending"
			if g.Contract == nil {
				g.Phase = "planning"
				g.PlanningAttempt++
				g.PlanningIssued = g.PlanningAttempt - 1
			} else if n.Status == "awaiting_verification" {
				g.Phase = "verifying"
			} else if n.Status == "running" {
				g.Phase = "executing"
			} else {
				if g.Rounds >= g.MaxRounds {
					return errors.New("此目标已达执行轮次预算，请根据证据补充新目标")
				}
				g.Phase = "executing"
				g.Rounds++
			}
			g.Reason = "继续自主目标；保留已经冻结的验收标准"
			return nil
		})
		if err != nil {
			return nil, err
		}
	case "steer":
		message, ok := input["message"].(string)
		if !ok || strings.TrimSpace(message) == "" || len(message) > 20000 {
			return nil, errors.New("请填写执行建议")
		}
		if _, err := s.goalCommand(ctx, t, "steer", map[string]any{"message": message}, "goal-steer:"+runeKey()); err != nil {
			return nil, err
		}
	default:
		return nil, errors.New("自主目标无需人工批准计划；请使用暂停、继续或补充执行建议")
	}
	return s.platform.task(t.ID)
}
func runeKey() string { return identifier("action_") }
