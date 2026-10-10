package control

import (
	"bytes"
	"context"
	"crypto/rand"
	"database/sql"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"regexp"
	"sort"
	"strings"
	"sync"
	"syscall"
	"time"

	_ "modernc.org/sqlite"
)

type Check struct {
	ID            string `json:"id"`
	URL           string `json:"url"`
	Contains      string `json:"contains,omitempty"`
	CredentialEnv string `json:"credentialEnv,omitempty"`
	JSON          *struct {
		Path   string `json:"path"`
		Equals any    `json:"equals"`
	} `json:"json,omitempty"`
	Metric *struct {
		Name string  `json:"name"`
		Min  float64 `json:"min"`
	} `json:"metric,omitempty"`
	Browser *struct {
		Selector    string `json:"selector"`
		Text        string `json:"text,omitempty"`
		PasswordEnv string `json:"passwordEnv,omitempty"`
	} `json:"browser,omitempty"`
}
type Resource struct {
	ID             string  `json:"id"`
	PluginID       string  `json:"pluginId"`
	Name           string  `json:"name"`
	Kind           string  `json:"kind"`
	ServiceID      string  `json:"serviceId"`
	Version        string  `json:"version"`
	EnvironmentID  string  `json:"environmentId"`
	Health         string  `json:"health"`
	SampledAt      string  `json:"sampledAt"`
	Method         string  `json:"method"`
	Detail         string  `json:"detail"`
	Failures       int     `json:"failures"`
	HealthySamples int     `json:"healthySamples"`
	RestartAllowed bool    `json:"restartAllowed"`
	Checks         []Check `json:"checks"`
	Enabled        bool    `json:"enabled"`
}
type Tool struct {
	ID          string `json:"id"`
	Name        string `json:"name"`
	Description string `json:"description"`
	Path        string `json:"path"`
	Method      string `json:"method,omitempty"`
	Mutates     bool   `json:"mutates"`
}
type Workspace struct {
	Title string `json:"title"`
	Path  string `json:"path"`
}
type Manifest struct {
	SchemaVersion int        `json:"schemaVersion"`
	ID            string     `json:"id"`
	Name          string     `json:"name"`
	Version       string     `json:"version"`
	Description   string     `json:"description"`
	Workspace     Workspace  `json:"workspace"`
	Resources     []Resource `json:"resources"`
	Tools         []Tool     `json:"tools"`
	Events        []string   `json:"events"`
	Verification  struct {
		Checks []string `json:"checks"`
	} `json:"verification"`
}
type Plugin struct {
	ID            string    `json:"id"`
	Name          string    `json:"name"`
	Version       string    `json:"version"`
	Description   string    `json:"description"`
	Workspace     Workspace `json:"workspace"`
	Enabled       bool      `json:"enabled"`
	Online        bool      `json:"online"`
	Error         string    `json:"error"`
	ManifestURL   string    `json:"manifestUrl"`
	Manifest      Manifest  `json:"manifest"`
	CredentialEnv string    `json:"-"`
}

// Secrets are names only, stored separately because public JSON deliberately omits them.
type Incident struct {
	ID               string `json:"id"`
	ResourceID       string `json:"resourceId"`
	Status           string `json:"status"`
	OpenedAt         string `json:"openedAt"`
	UpdatedAt        string `json:"updatedAt"`
	ClosedAt         string `json:"closedAt,omitempty"`
	Attempts         int    `json:"attempts"`
	ActionID         string `json:"actionId"`
	Reason           string `json:"reason"`
	Verification     string `json:"verification"`
	Version          string `json:"version"`
	EnvironmentID    string `json:"environmentId"`
	ActionAt         string `json:"actionAt"`
	DiagnosisID      string `json:"diagnosisId,omitempty"`
	DiagnosisStatus  string `json:"diagnosisStatus,omitempty"`
	DiagnosisSummary string `json:"diagnosisSummary,omitempty"`
}
type Evidence struct {
	ID                   string            `json:"id"`
	IncidentID           string            `json:"incidentId"`
	ResourceID           string            `json:"resourceId"`
	ActionID             string            `json:"actionId"`
	Version              string            `json:"version"`
	EnvironmentID        string            `json:"environmentId"`
	At                   string            `json:"at"`
	Verdict              string            `json:"verdict"`
	Summary              string            `json:"summary"`
	Checks               []json.RawMessage `json:"checks"`
	ReviewConversationID string            `json:"reviewConversationId"`
	Review               string            `json:"review"`
}
type PlatformTask struct {
	ID                 string `json:"id"`
	ConversationID     string `json:"conversationId"`
	Title              string `json:"title"`
	Goal               string `json:"goal"`
	Cwd                string `json:"cwd"`
	Model              string `json:"model"`
	BusinessStatus     string `json:"businessStatus"`
	ExecutionStatus    string `json:"executionStatus"`
	VerificationStatus string `json:"verificationStatus"`
	CreatedAt          string `json:"createdAt"`
	UpdatedAt          string `json:"updatedAt"`
	LegacyVerified     bool   `json:"legacyVerified"`
	EngineAvailable    bool   `json:"engineAvailable"`
	ManualReason       string `json:"manualReason,omitempty"`
	AcceptedAt         string `json:"acceptedAt,omitempty"`
}
type Worker struct {
	ID       string `json:"id"`
	Role     string `json:"role"`
	Status   string `json:"status"`
	LastSeen string `json:"lastSeen"`
	Detail   string `json:"detail"`
}
type Event struct {
	ID         string `json:"id"`
	At         string `json:"at"`
	Kind       string `json:"kind"`
	ResourceID string `json:"resourceId"`
	IncidentID string `json:"incidentId"`
	Message    string `json:"message"`
}
type Observation struct {
	ResourceID    string `json:"resourceId"`
	SampledAt     string `json:"sampledAt"`
	Method        string `json:"method"`
	Healthy       bool   `json:"healthy"`
	Detail        string `json:"detail"`
	Version       string `json:"version"`
	EnvironmentID string `json:"environmentId"`
	Unavailable   bool   `json:"unavailable,omitempty"`
}
type platformState struct {
	Schema          int                      `json:"schema"`
	Plugins         map[string]*Plugin       `json:"plugins"`
	Credentials     map[string]string        `json:"credentials"`
	Resources       map[string]*Resource     `json:"resources"`
	Incidents       map[string]*Incident     `json:"incidents"`
	Tasks           map[string]*PlatformTask `json:"tasks"`
	Workers         map[string]*Worker       `json:"workers"`
	Evidence        []*Evidence              `json:"evidence"`
	Events          []*Event                 `json:"events"`
	Observations    []Observation            `json:"observations"`
	CommandReceipts map[string]bool          `json:"commandReceipts"`
}
type Snapshot struct {
	Plugins   []*Plugin       `json:"plugins"`
	Resources []*Resource     `json:"resources"`
	Incidents []*Incident     `json:"incidents"`
	Tasks     []*PlatformTask `json:"tasks"`
	Workers   []*Worker       `json:"workers"`
	Evidence  []*Evidence     `json:"evidence"`
	Events    []*Event        `json:"events"`
}
type Platform struct {
	mu         sync.Mutex
	db         *sql.DB
	state      platformState
	operations sync.Map
	lock       *os.File
}

func instant() string { return time.Now().UTC().Format(time.RFC3339Nano) }
func identifier(prefix string) string {
	b := make([]byte, 12)
	if _, err := rand.Read(b); err != nil {
		panic(err)
	}
	return prefix + hex.EncodeToString(b)
}

var validID = regexp.MustCompile(`^[a-zA-Z0-9_-]{1,128}$`)
var validEnv = regexp.MustCompile(`^[A-Z][A-Z0-9_]{0,127}$`)

func OpenPlatform(path string) (*Platform, error) {
	if path == "" {
		path = ":memory:"
	} else if path != ":memory:" {
		if err := os.MkdirAll(filepath.Dir(path), 0700); err != nil {
			return nil, err
		}
	}
	db, err := sql.Open("sqlite", path)
	if err != nil {
		return nil, err
	}
	db.SetMaxOpenConns(1)
	if _, err = db.Exec(`PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000; CREATE TABLE IF NOT EXISTS platform_state (id INTEGER PRIMARY KEY CHECK(id=1), schema INTEGER NOT NULL, payload BLOB NOT NULL);`); err != nil {
		db.Close()
		return nil, err
	}
	p := &Platform{db: db, state: platformState{Schema: 1, Plugins: map[string]*Plugin{}, Credentials: map[string]string{}, Resources: map[string]*Resource{}, Incidents: map[string]*Incident{}, Tasks: map[string]*PlatformTask{}, Workers: map[string]*Worker{}, Evidence: []*Evidence{}, Events: []*Event{}, Observations: []Observation{}}}
	if path != ":memory:" {
		lock, e := os.OpenFile(path+".lock", os.O_CREATE|os.O_RDWR, 0600)
		if e != nil {
			db.Close()
			return nil, e
		}
		if e = syscall.Flock(int(lock.Fd()), syscall.LOCK_EX|syscall.LOCK_NB); e != nil {
			lock.Close()
			db.Close()
			return nil, errors.New("platform database already has a live owner")
		}
		p.lock = lock
	}
	success := false
	defer func() {
		if !success {
			db.Close()
			if p.lock != nil {
				p.lock.Close()
			}
		}
	}()
	var raw []byte
	err = db.QueryRow("SELECT payload FROM platform_state WHERE id=1").Scan(&raw)
	if err != nil && err != sql.ErrNoRows {
		db.Close()
		return nil, err
	}
	if raw != nil {
		if err = json.Unmarshal(raw, &p.state); err != nil {
			db.Close()
			return nil, err
		}
		if p.state.Schema != 1 {
			db.Close()
			return nil, errors.New("unsupported platform schema")
		}
	}
	for id, plugin := range p.state.Plugins {
		plugin.CredentialEnv = p.state.Credentials[id]
	}
	if p.state.CommandReceipts == nil {
		p.state.CommandReceipts = map[string]bool{}
	}
	for _, i := range p.state.Incidents {
		if i.Status == "acting" {
			i.Status = "attention"
			i.Reason = "平台重启时动作结果不明确，禁止重复执行；请检查服务与动作记录。"
			i.UpdatedAt = instant()
		}
	}
	if err = p.persist(); err != nil {
		db.Close()
		return nil, err
	}
	if path != ":memory:" {
		_ = os.Chmod(path, 0600)
	}
	success = true
	return p, nil
}
func (p *Platform) Close() error {
	err := p.db.Close()
	if p.lock != nil {
		_ = p.lock.Close()
	}
	return err
}
func (p *Platform) persist() error {
	raw, err := json.Marshal(p.state)
	if err != nil {
		return err
	}
	_, err = p.db.Exec(`INSERT INTO platform_state VALUES(1,1,?) ON CONFLICT(id) DO UPDATE SET payload=excluded.payload`, raw)
	return err
}

// Roll back in-memory changes as well when SQLite refuses a transaction.
func (p *Platform) mutate(fn func() error) error {
	p.mu.Lock()
	defer p.mu.Unlock()
	before, _ := json.Marshal(p.state)
	err := fn()
	if err == nil {
		err = p.persist()
	}
	if err != nil {
		var previous platformState
		_ = json.Unmarshal(before, &previous)
		p.state = previous
		for id, v := range p.state.Plugins {
			v.CredentialEnv = p.state.Credentials[id]
		}
	}
	return err
}
func (p *Platform) event(kind, resource, incident, message string) {
	p.state.Events = append(p.state.Events, &Event{identifier("ev_"), instant(), kind, resource, incident, message})
	if len(p.state.Events) > 2000 {
		p.state.Events = p.state.Events[len(p.state.Events)-2000:]
	}
}
func (p *Platform) active(resource string) *Incident {
	for _, i := range p.state.Incidents {
		if i.ResourceID == resource && i.Status != "closed" {
			return i
		}
	}
	return nil
}
func (p *Platform) enabled(r *Resource) bool {
	plugin := p.state.Plugins[r.PluginID]
	if plugin == nil || !plugin.Enabled {
		return false
	}
	for _, declared := range plugin.Manifest.Resources {
		if declared.ID == r.ID {
			return true
		}
	}
	return false
}
func checksEqual(a, b []Check) bool {
	x, _ := json.Marshal(a)
	y, _ := json.Marshal(b)
	return bytes.Equal(x, y)
}
func (p *Platform) snapshot() Snapshot {
	p.mu.Lock()
	defer p.mu.Unlock()
	out := Snapshot{Plugins: []*Plugin{}, Resources: []*Resource{}, Incidents: []*Incident{}, Tasks: []*PlatformTask{}, Workers: []*Worker{}, Evidence: []*Evidence{}, Events: []*Event{}}
	at := time.Now()
	for _, v := range p.state.Plugins {
		out.Plugins = append(out.Plugins, v)
	}
	for _, v := range p.state.Resources {
		x := *v
		x.Enabled = p.enabled(v)
		t, _ := time.Parse(time.RFC3339Nano, x.SampledAt)
		if x.SampledAt != "" && at.Sub(t) > 45*time.Second {
			x.Health = "stale"
		}
		out.Resources = append(out.Resources, &x)
	}
	for _, v := range p.state.Incidents {
		out.Incidents = append(out.Incidents, v)
	}
	for _, v := range p.state.Tasks {
		out.Tasks = append(out.Tasks, v)
	}
	for _, v := range p.state.Workers {
		x := *v
		t, _ := time.Parse(time.RFC3339Nano, x.LastSeen)
		if at.Sub(t) > 45*time.Second {
			x.Status = "offline"
		}
		out.Workers = append(out.Workers, &x)
	}
	out.Evidence = p.state.Evidence
	out.Events = p.state.Events
	sort.Slice(out.Resources, func(i, j int) bool { return out.Resources[i].ID < out.Resources[j].ID })
	sort.Slice(out.Plugins, func(i, j int) bool { return out.Plugins[i].ID < out.Plugins[j].ID })
	sort.Slice(out.Incidents, func(i, j int) bool { return out.Incidents[i].OpenedAt > out.Incidents[j].OpenedAt })
	sort.Slice(out.Tasks, func(i, j int) bool { return out.Tasks[i].CreatedAt > out.Tasks[j].CreatedAt })
	// Detach pointers: readers must never race with state transitions.
	raw, _ := json.Marshal(out)
	_ = json.Unmarshal(raw, &out)
	return out
}
func (p *Platform) register(m Manifest, address, credential string) error {
	if m.Resources == nil {
		m.Resources = []Resource{}
	}
	if m.Tools == nil {
		m.Tools = []Tool{}
	}
	if m.Events == nil {
		m.Events = []string{}
	}
	if m.Verification.Checks == nil {
		m.Verification.Checks = []string{}
	}
	return p.mutate(func() error {
		enabled := true
		if prior := p.state.Plugins[m.ID]; prior != nil {
			enabled = prior.Enabled
		}
		for _, r := range m.Resources {
			if existing := p.state.Resources[r.ID]; existing != nil && existing.PluginID != m.ID {
				return errors.New("resource belongs to another plugin")
			}
		}
		declared := map[string]bool{}
		for _, r := range m.Resources {
			declared[r.ID] = true
			r.PluginID = m.ID
			r.Health = "unknown"
			if r.Checks == nil {
				r.Checks = []Check{}
			}
			if prev := p.state.Resources[r.ID]; prev != nil && prev.Version == r.Version && prev.EnvironmentID == r.EnvironmentID && checksEqual(prev.Checks, r.Checks) {
				r.Health = prev.Health
				r.SampledAt = prev.SampledAt
				r.Method = prev.Method
				r.Detail = prev.Detail
				r.Failures = prev.Failures
				r.HealthySamples = prev.HealthySamples
			} else if i := p.active(r.ID); i != nil {
				i.Status = "attention"
				i.Verification = "inconclusive"
				i.Reason = "资源版本或环境变更，请重新确认验收范围"
				i.UpdatedAt = instant()
			}
			p.state.Resources[r.ID] = &r
		}
		for id, r := range p.state.Resources {
			if r.PluginID == m.ID && !declared[id] {
				r.Health = "unknown"
				r.RestartAllowed = false
				r.Detail = "插件已撤销此资源"
				if i := p.active(id); i != nil {
					i.Status = "attention"
					i.Verification = "inconclusive"
					i.Reason = "插件已撤销此资源，等待重新注册或用户处理"
					i.UpdatedAt = instant()
				}
			}
		}
		p.state.Plugins[m.ID] = &Plugin{m.ID, m.Name, m.Version, m.Description, m.Workspace, enabled, true, "", address, m, credential}
		p.state.Credentials[m.ID] = credential
		p.event("plugin.registered", "", "", m.Name+" 已注册")
		return nil
	})
}
func (p *Platform) observe(o Observation) (string, error) {
	var incident string
	err := p.mutate(func() error {
		r := p.state.Resources[o.ResourceID]
		if r == nil {
			return errors.New("unknown resource")
		}
		if !p.enabled(r) {
			return errors.New("plugin disabled")
		}
		t, e := time.Parse(time.RFC3339Nano, o.SampledAt)
		if e != nil || time.Since(t) > 45*time.Second || time.Until(t) > 5*time.Second {
			return errors.New("stale or future observation")
		}
		prev, _ := time.Parse(time.RFC3339Nano, r.SampledAt)
		if !t.After(prev) {
			return errors.New("observation already received or out of order")
		}
		if !prev.IsZero() && t.Sub(prev) > 45*time.Second {
			r.Failures = 0
			r.HealthySamples = 0
		}
		if o.Version != r.Version || o.EnvironmentID != r.EnvironmentID {
			return errors.New("observation scope changed")
		}
		if o.Method == "" {
			return errors.New("observation method required")
		}
		r.SampledAt = o.SampledAt
		r.Method = o.Method
		r.Detail = o.Detail
		if o.Unavailable {
			r.Health = "unknown"
			r.Failures = 0
			r.HealthySamples = 0
		} else if o.Healthy {
			r.Health = "healthy"
			r.HealthySamples++
			r.Failures = 0
		} else {
			r.Health = "unhealthy"
			r.Failures++
			r.HealthySamples = 0
		}
		p.state.Observations = append(p.state.Observations, o)
		if len(p.state.Observations) > 5000 {
			p.state.Observations = p.state.Observations[len(p.state.Observations)-5000:]
		}
		i := p.active(r.ID)
		if o.Unavailable && i != nil && i.Status != "acting" {
			i.Status = "attention"
			i.Verification = "inconclusive"
			i.Reason = "观测能力不可用，需要恢复采样：" + o.Detail
			i.UpdatedAt = instant()
		}
		if i == nil && r.Failures >= 2 {
			i = &Incident{ID: identifier("inc_"), ResourceID: r.ID, Status: "diagnosing", OpenedAt: instant(), UpdatedAt: instant(), Reason: o.Detail, Verification: "pending", Version: r.Version, EnvironmentID: r.EnvironmentID}
			p.state.Incidents[i.ID] = i
			p.event("incident.opened", r.ID, i.ID, "连续两次检查失败："+o.Detail)
		}
		if i != nil {
			incident = i.ID
			if r.Failures >= 2 && i.Status == "proving" {
				if i.Attempts >= 2 {
					i.Status = "attention"
					i.Reason = "两次重启后仍未恢复，停止自动动作，需要用户处理"
					i.UpdatedAt = instant()
					p.event("incident.escalated", r.ID, i.ID, i.Reason)
				} else {
					i.Status = "diagnosing"
					i.Reason = o.Detail
					i.UpdatedAt = instant()
				}
			}
		}
		return nil
	})
	return incident, err
}
func (p *Platform) task(id string) (*PlatformTask, error) {
	p.mu.Lock()
	defer p.mu.Unlock()
	t := p.state.Tasks[id]
	if t == nil {
		return nil, errors.New("task does not exist")
	}
	out := *t
	return &out, nil
}

type nativeTask struct {
	ID        string `json:"id"`
	Title     string `json:"title"`
	Goal      string `json:"goal"`
	Cwd       string `json:"cwd"`
	Model     string `json:"model"`
	Status    string `json:"status"`
	CreatedAt string `json:"createdAt"`
	UpdatedAt string `json:"updatedAt"`
	Verified  bool   `json:"verified"`
}

func (p *Platform) syncTasks(tasks []nativeTask, available bool) error {
	return p.mutate(func() error {
		for _, t := range p.state.Tasks {
			t.EngineAvailable = available
		}
		for _, n := range tasks {
			var t *PlatformTask
			for _, prior := range p.state.Tasks {
				if prior.ConversationID == n.ID {
					t = prior
					break
				}
			}
			if t == nil {
				t = &PlatformTask{ID: identifier("task_"), ConversationID: n.ID, BusinessStatus: "backlog", VerificationStatus: "pending"}
				p.state.Tasks[t.ID] = t
			}
			t.Title = n.Title
			t.Goal = n.Goal
			t.Cwd = n.Cwd
			t.Model = n.Model
			previousExecution := t.ExecutionStatus
			t.ExecutionStatus = n.Status
			if previousExecution != n.Status && t.BusinessStatus == "active" && (n.Status == "blocked" || n.Status == "awaiting_confirmation" || (n.Status == "completed" && t.VerificationStatus != "pass" && t.VerificationStatus != "manual")) {
				t.BusinessStatus = "attention"
			}
			t.CreatedAt = n.CreatedAt
			if t.UpdatedAt < n.UpdatedAt {
				t.UpdatedAt = n.UpdatedAt
			}
			t.LegacyVerified = n.Verified
			t.EngineAvailable = true
			if t.VerificationStatus == "manual" && t.AcceptedAt != "" && parseTime(n.UpdatedAt).After(parseTime(t.AcceptedAt)) {
				t.VerificationStatus = "pending"
				if t.BusinessStatus == "done" {
					t.BusinessStatus = "attention"
				}
				p.event("task.acceptance_outdated", "", "", t.Title+" 有新的执行结果，需要重新验收")
			}
		}
		return nil
	})
}
func (p *Platform) status(id, status string) error {
	return p.mutate(func() error {
		t := p.state.Tasks[id]
		if t == nil {
			return errors.New("unknown task")
		}
		if status != "backlog" && status != "active" && status != "attention" && status != "done" {
			return errors.New("invalid business status")
		}
		if status == "done" && t.VerificationStatus != "pass" && t.VerificationStatus != "manual" {
			return errors.New("独立验收尚未通过，不能标记完成；执行自检记录仍保留")
		}
		t.BusinessStatus = status
		t.UpdatedAt = instant()
		return nil
	})
}

func (p *Platform) acceptTask(id, reason string) error {
	if strings.TrimSpace(reason) == "" || len(reason) > 20000 {
		return errors.New("人工验收需要记录实际检查结果")
	}
	return p.mutate(func() error {
		t := p.state.Tasks[id]
		if t == nil {
			return errors.New("unknown task")
		}
		t.VerificationStatus = "manual"
		t.BusinessStatus = "done"
		t.ManualReason = reason
		t.AcceptedAt = instant()
		t.UpdatedAt = t.AcceptedAt
		p.event("task.manual_acceptance", "", "", t.Title+"："+reason)
		return nil
	})
}
func (p *Platform) completeBusinessCommand(id, action, key string, native nativeTask) error {
	return p.mutate(func() error {
		receipt := id + ":" + action + ":" + key
		if p.state.CommandReceipts[receipt] {
			return nil
		}
		t := p.state.Tasks[id]
		if t == nil {
			return errors.New("unknown task")
		}
		if action == "plan" || action == "approve" || action == "continue" {
			if t.VerificationStatus != "manual" {
				t.BusinessStatus = "active"
				if native.Status == "completed" || native.Status == "blocked" || native.Status == "awaiting_confirmation" {
					t.BusinessStatus = "attention"
				}
			}
			t.UpdatedAt = instant()
		}
		p.state.CommandReceipts[receipt] = true
		return nil
	})
}
func (p *Platform) heartbeat(w Worker) error {
	if !validID.MatchString(w.ID) || w.Role == "" {
		return errors.New("invalid worker")
	}
	return p.mutate(func() error { w.Status = "online"; w.LastSeen = instant(); p.state.Workers[w.ID] = &w; return nil })
}
func (p *Platform) resource(id string) (Resource, error) {
	p.mu.Lock()
	defer p.mu.Unlock()
	r := p.state.Resources[id]
	if r == nil {
		return Resource{}, errors.New("unknown resource")
	}
	out := *r
	out.Enabled = p.enabled(r)
	return out, nil
}
func (p *Platform) incident(id string) (Incident, error) {
	p.mu.Lock()
	defer p.mu.Unlock()
	i := p.state.Incidents[id]
	if i == nil {
		return Incident{}, errors.New("unknown incident")
	}
	return *i, nil
}
func (p *Platform) reserveAction(id string) (Incident, Resource, error) {
	var i Incident
	var r Resource
	err := p.mutate(func() error {
		x := p.state.Incidents[id]
		if x == nil {
			return errors.New("unknown incident")
		}
		v := p.state.Resources[x.ResourceID]
		if v == nil || !v.RestartAllowed {
			return errors.New("resource has no preauthorized restart")
		}
		if !p.enabled(v) {
			return errors.New("plugin disabled")
		}
		if v.Version != x.Version || v.EnvironmentID != x.EnvironmentID {
			return errors.New("incident scope changed")
		}
		if x.Status == "closed" || x.Status == "acting" {
			return errors.New("incident cannot restart in current state")
		}
		if x.Attempts >= 2 {
			return errors.New("maximum two restarts per incident")
		}
		x.Attempts++
		x.ActionID = identifier("action_")
		x.ActionAt = instant()
		x.Status = "acting"
		x.Verification = "pending"
		x.UpdatedAt = instant()
		v.HealthySamples = 0
		v.Failures = 0
		i = *x
		r = *v
		p.event("action.started", v.ID, x.ID, fmt.Sprintf("已授权重启 %d/2", x.Attempts))
		return nil
	})
	return i, r, err
}
func (p *Platform) actionResult(id, action string, err error) error {
	return p.mutate(func() error {
		i := p.state.Incidents[id]
		if i == nil || i.ActionID != action {
			return errors.New("action scope changed")
		}
		resource := p.state.Resources[i.ResourceID]
		if resource == nil || !p.enabled(resource) || resource.Version != i.Version || resource.EnvironmentID != i.EnvironmentID {
			i.Status = "attention"
			i.Verification = "inconclusive"
			i.Reason = "动作期间资源范围变更，不能沿用恢复结果"
			i.UpdatedAt = instant()
			return nil
		}
		i.Status = "proving"
		i.Reason = "动作已返回，等待新采样与独立验收"
		if err != nil {
			i.Status = "attention"
			i.Reason = "重启动作未确认成功：" + err.Error()
		}
		i.UpdatedAt = instant()
		p.event("action.returned", i.ResourceID, id, i.Reason)
		return nil
	})
}
func (p *Platform) proof(i Incident, r Resource, result Evidence) error {
	return p.mutate(func() error {
		x := p.state.Incidents[i.ID]
		v := p.state.Resources[r.ID]
		if x == nil || v == nil {
			return errors.New("proof target vanished")
		}
		if !p.enabled(v) || x.ResourceID != r.ID || x.EnvironmentID != i.EnvironmentID || x.ActionID != i.ActionID || x.Version != i.Version || v.Version != r.Version || v.EnvironmentID != r.EnvironmentID || !checksEqual(v.Checks, r.Checks) || x.Status == "closed" {
			return errors.New("proof scope changed")
		}
		result.ID = identifier("proof_")
		result.IncidentID = i.ID
		result.ResourceID = r.ID
		result.ActionID = i.ActionID
		result.Version = i.Version
		result.EnvironmentID = i.EnvironmentID
		result.At = instant()
		if result.Checks == nil {
			result.Checks = []json.RawMessage{}
		}
		if result.Verdict != "pass" && result.Verdict != "fail" && result.Verdict != "inconclusive" && result.Verdict != "manual" {
			result.Verdict = "inconclusive"
			result.Summary = "验证器返回了无效结果"
		}
		if result.Verdict == "pass" {
			var review struct {
				Approved bool   `json:"approved"`
				Summary  string `json:"summary"`
			}
			reviewValid := json.Unmarshal([]byte(result.Review), &review) == nil && review.Approved && strings.TrimSpace(review.Summary) != ""
			valid := reviewValid && v.Health == "healthy" && v.HealthySamples >= 3 && time.Since(parseTime(v.SampledAt)) <= 45*time.Second && len(result.Checks) == len(r.Checks) && len(r.Checks) > 0 && result.ReviewConversationID != "" && result.Review != ""
			for n, c := range result.Checks {
				var check struct {
					ID        string `json:"id"`
					URL       string `json:"url"`
					Passed    bool   `json:"passed"`
					SampledAt string `json:"sampledAt"`
				}
				if json.Unmarshal(c, &check) != nil || n >= len(r.Checks) || check.ID != r.Checks[n].ID || check.URL != r.Checks[n].URL || !check.Passed || parseTime(check.SampledAt).IsZero() || parseTime(check.SampledAt).After(time.Now().Add(5*time.Second)) || parseTime(check.SampledAt).Before(parseTime(i.UpdatedAt)) || time.Since(parseTime(check.SampledAt)) > 45*time.Second {
					valid = false
				}
			}
			if !valid {
				result.Verdict = "inconclusive"
				result.Summary = "缺少三次新鲜健康采样、完整业务检查或独立模型审查"
			}
		}
		p.state.Evidence = append(p.state.Evidence, &result)
		x.Verification = result.Verdict
		x.UpdatedAt = instant()
		x.Reason = result.Summary
		if result.Verdict == "pass" {
			x.Status = "closed"
			x.ClosedAt = instant()
		} else if result.Verdict == "fail" && x.Attempts < 2 {
			x.Status = "diagnosing"
		} else {
			x.Status = "attention"
		}
		p.event("proof."+result.Verdict, r.ID, i.ID, result.Summary)
		return nil
	})
}
func parseTime(value string) time.Time { t, _ := time.Parse(time.RFC3339Nano, value); return t }

// PlatformLoop never requires Pi to observe or repair an unhealthy executor.
func (s *Server) PlatformLoop(ctx context.Context) {
	ticker := time.NewTicker(5 * time.Second)
	defer ticker.Stop()
	for {
		s.synchronize(ctx)
		s.discover(ctx)
		s.pollDiagnoses(ctx)
		for _, plugin := range s.platform.snapshot().Plugins {
			if plugin.Enabled && plugin.Online && len(plugin.Manifest.Events) > 0 {
				if _, loaded := s.platform.operations.LoadOrStore("events:"+plugin.ID, true); !loaded {
					go s.pluginEvents(ctx, *plugin)
				}
			}
		}
		for _, i := range s.platform.snapshot().Incidents {
			if i.Status == "closed" {
				continue
			}
			if i.Status == "diagnosing" && i.DiagnosisID == "" {
				go func(id string) { _, _ = s.requestDiagnosis(ctx, id) }(i.ID)
			}
			r, err := s.platform.resource(i.ResourceID)
			if err != nil {
				continue
			}
			if s.config.AutoRepair && i.Status == "diagnosing" && r.RestartAllowed && r.Failures >= 2 {
				go func(id string) { _ = s.repair(ctx, id) }(i.ID)
			}
			if r.Health == "healthy" && r.HealthySamples >= 3 && i.Status == "proving" {
				go func(id string) { _ = s.verify(ctx, id) }(i.ID)
			}
		}
		select {
		case <-ctx.Done():
			return
		case <-ticker.C:
		}
	}
}
