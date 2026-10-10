package control

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"net/http/httptest"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

// Runs actual HTTP handlers and request/response framing without opening sockets.
type handlerTransport struct{ handler http.Handler }

func (t handlerTransport) RoundTrip(r *http.Request) (*http.Response, error) {
	out := httptest.NewRecorder()
	t.handler.ServeHTTP(out, r)
	return out.Result(), nil
}

type unavailableTransport struct{}

func (unavailableTransport) RoundTrip(*http.Request) (*http.Response, error) {
	return nil, errors.New("executor offline")
}
func platformFixture(t *testing.T) (*Platform, Manifest) {
	t.Helper()
	p, e := OpenPlatform(filepath.Join(t.TempDir(), "platform.sqlite"))
	if e != nil {
		t.Fatal(e)
	}
	t.Cleanup(func() { p.Close() })
	m := Manifest{SchemaVersion: 1, ID: "monitor", Name: "Homelab", Version: "1", Workspace: Workspace{"监控", "/workspace"}, Resources: []Resource{{ID: "engine", Name: "Pi", Version: "1", EnvironmentID: "macmini", ServiceID: "engine", RestartAllowed: true, Checks: []Check{{ID: "functional", URL: "http://127.0.0.1:18801/health", Contains: "ready"}}}}}
	if e = p.register(m, "http://127.0.0.1:18811/manifest", ""); e != nil {
		t.Fatal(e)
	}
	return p, m
}
func sample(t *testing.T, p *Platform, healthy bool) string {
	t.Helper()
	r, _ := p.resource("engine")
	at := time.Now().UTC()
	prior := parseTime(r.SampledAt)
	if !at.After(prior) {
		at = prior.Add(time.Nanosecond)
	}
	id, e := p.observe(Observation{ResourceID: "engine", SampledAt: at.Format(time.RFC3339Nano), Method: "http_body", Healthy: healthy, Detail: "business probe", Version: "1", EnvironmentID: "macmini"})
	if e != nil {
		t.Fatal(e)
	}
	return id
}
func opened(t *testing.T, p *Platform) string {
	t.Helper()
	if id := sample(t, p, false); id != "" {
		t.Fatal("incident before two failures")
	}
	id := sample(t, p, false)
	if id == "" {
		t.Fatal("no incident")
	}
	return id
}
func passing(r Resource) Evidence {
	raw, _ := json.Marshal(map[string]any{"id": "functional", "url": r.Checks[0].URL, "passed": true, "sampledAt": instant()})
	return Evidence{Verdict: "pass", Summary: "fresh business check and independent review passed", Checks: []json.RawMessage{raw}, ReviewConversationID: "review_42", Review: `{"approved":true,"summary":"criteria checked in separate conversation"}`}
}
func TestRepairProofAndReopen(t *testing.T) {
	p, _ := platformFixture(t)
	id := opened(t, p)
	i, r, e := p.reserveAction(id)
	if e != nil {
		t.Fatal(e)
	}
	if e = p.actionResult(id, i.ActionID, nil); e != nil {
		t.Fatal(e)
	}
	sample(t, p, true)
	sample(t, p, true)
	i, _ = p.incident(id)
	r, _ = p.resource("engine")
	if e = p.proof(i, r, passing(r)); e != nil {
		t.Fatal(e)
	}
	i, _ = p.incident(id)
	if i.Status == "closed" {
		t.Fatal("closed before three healthy samples")
	}
	sample(t, p, true)
	i, _ = p.incident(id)
	r, _ = p.resource("engine")
	if e = p.proof(i, r, passing(r)); e != nil {
		t.Fatal(e)
	}
	i, _ = p.incident(id)
	if i.Status != "closed" || i.Verification != "pass" {
		t.Fatalf("not closed: %+v", i)
	}
	if _, _, e = p.reserveAction(id); e == nil {
		t.Fatal("closed incident restarted")
	}
}
func TestRestartBudgetPersistsAndAmbiguousActionEscalates(t *testing.T) {
	p, _ := platformFixture(t)
	id := opened(t, p)
	i, _, e := p.reserveAction(id)
	if e != nil {
		t.Fatal(e)
	}
	_ = p.actionResult(id, i.ActionID, nil)
	sample(t, p, false)
	sample(t, p, false)
	i, _, e = p.reserveAction(id)
	if e != nil {
		t.Fatal(e)
	}
	path := p.dbFilename(t)
	_ = p.Close()
	again, e := OpenPlatform(path)
	if e != nil {
		t.Fatal(e)
	}
	defer again.Close()
	i, _ = again.incident(id)
	if i.Status != "attention" || i.Attempts != 2 {
		t.Fatalf("ambiguous action not stopped: %+v", i)
	}
	if _, _, e = again.reserveAction(id); e == nil {
		t.Fatal("third restart admitted")
	}
}
func (p *Platform) dbFilename(t *testing.T) string {
	t.Helper()
	rows, e := p.db.Query("PRAGMA database_list")
	if e != nil {
		t.Fatal(e)
	}
	defer rows.Close()
	for rows.Next() {
		var seq int
		var name, file string
		if e = rows.Scan(&seq, &name, &file); e != nil {
			t.Fatal(e)
		}
		if name == "main" {
			return file
		}
	}
	t.Fatal("database path missing")
	return ""
}
func TestStaleEvidenceAndWrongScopeCannotClose(t *testing.T) {
	p, _ := platformFixture(t)
	id := opened(t, p)
	for range 3 {
		sample(t, p, true)
	}
	i, _ := p.incident(id)
	r, _ := p.resource("engine")
	bad := passing(r)
	bad.Checks = []json.RawMessage{json.RawMessage(`{"id":"functional","url":"http://127.0.0.1:18801/health","passed":true,"sampledAt":"2020-01-01T00:00:00Z"}`)}
	_ = p.proof(i, r, bad)
	i, _ = p.incident(id)
	if i.Verification != "inconclusive" || i.Status == "closed" {
		t.Fatal("stale proof accepted")
	}
	wrong := Observation{ResourceID: "engine", SampledAt: instant(), Method: "http_body", Healthy: true, Version: "2", EnvironmentID: "macmini"}
	if _, e := p.observe(wrong); e == nil {
		t.Fatal("wrong version observation admitted")
	}
	wrong.Version = "1"
	wrong.SampledAt = time.Now().Add(-time.Minute).Format(time.RFC3339Nano)
	if _, e := p.observe(wrong); e == nil {
		t.Fatal("stale observation admitted")
	}
	if e := p.proof(i, r, Evidence{Verdict: "pass", Summary: "HTTP200"}); e != nil {
		t.Fatal(e)
	}
	i, _ = p.incident(id)
	if i.Status == "closed" {
		t.Fatal("HTTP200 only closed incident")
	}
}
func TestPlatformSurvivesExecutorOfflineAndLegacyImport(t *testing.T) {
	cfg := configForTest("http://127.0.0.1:18801")
	cfg.PlatformToken = strings.Repeat("p", 40)
	s, e := New(cfg)
	if e != nil {
		t.Fatal(e)
	}
	defer s.Close()
	_ = s.platform.syncTasks([]nativeTask{{ID: "32", Title: "existing", Status: "completed", Verified: true, CreatedAt: instant(), UpdatedAt: instant()}}, true)
	task := s.platform.snapshot().Tasks[0]
	if task.ID == task.ConversationID || !task.LegacyVerified || task.VerificationStatus == "pass" {
		t.Fatal("legacy proof promoted or task ID reused")
	}
	_ = s.platform.status(task.ID, "active")
	s.client.Transport = unavailableTransport{}
	s.synchronize(context.Background())
	after := s.platform.snapshot().Tasks[0]
	if after.ID != task.ID || after.BusinessStatus != "active" || after.EngineAvailable {
		t.Fatal("executor failure corrupted platform task")
	}
	if e = s.platform.status(task.ID, "done"); e == nil {
		t.Fatal("self assertion completed business task")
	}
	out := httptest.NewRecorder()
	s.platformAPI(out, httptest.NewRequest("GET", "/api/platform/snapshot", nil))
	if out.Code != 200 || !strings.Contains(out.Body.String(), task.ID) {
		t.Fatal("snapshot depends on offline executor")
	}
	health := httptest.NewRecorder()
	s.ServeHTTP(health, httptest.NewRequest("GET", "/health", nil))
	if health.Code != 200 {
		t.Fatal("control health depends on Pi")
	}
}
func TestActualRestartToIndependentProofHTTPBoundary(t *testing.T) {
	p, _ := platformFixture(t)
	cfg := configForTest("http://127.0.0.1:18801")
	cfg.BrokerURL = "http://127.0.0.1:18814"
	cfg.BrokerToken = strings.Repeat("b", 40)
	cfg.VerifierURL = "http://127.0.0.1:18812"
	cfg.VerifierToken = strings.Repeat("v", 40)
	s, e := New(cfg)
	if e != nil {
		t.Fatal(e)
	}
	s.platform.Close()
	s.platform = p
	restarts := 0
	s.serviceClient.Transport = handlerTransport{http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Header.Get("Cookie") != "" {
			t.Error("admin cookie leaked")
		}
		if r.URL.Path == "/restart" {
			restarts++
			if r.Header.Get("Authorization") != "Bearer "+cfg.BrokerToken {
				t.Error("wrong broker auth")
			}
			var b map[string]string
			_ = json.NewDecoder(r.Body).Decode(&b)
			if b["serviceId"] != "engine" || b["actionId"] == "" {
				t.Error("missing named action")
			}
			writeJSON(w, 200, map[string]string{"status": "succeeded", "actionId": b["actionId"], "serviceId": b["serviceId"]})
			return
		}
		if r.URL.Path == "/verify" {
			if r.Header.Get("Authorization") != "Bearer "+cfg.VerifierToken {
				t.Error("wrong verifier auth")
			}
			resource, _ := p.resource("engine")
			var input map[string]any
			_ = json.NewDecoder(r.Body).Decode(&input)
			result := passing(resource)
			result.IncidentID = input["incidentId"].(string)
			result.ResourceID = resource.ID
			result.ActionID = input["actionId"].(string)
			result.Version = resource.Version
			result.EnvironmentID = resource.EnvironmentID
			writeJSON(w, 200, result)
			return
		}
		w.WriteHeader(404)
	})}
	id := opened(t, p)
	if e = s.repair(context.Background(), id); e != nil {
		t.Fatal(e)
	}
	for range 3 {
		sample(t, p, true)
	}
	if e = s.verify(context.Background(), id); e != nil {
		t.Fatal(e)
	}
	i, _ := p.incident(id)
	if i.Status != "closed" || restarts != 1 || len(p.snapshot().Evidence) != 1 {
		t.Fatalf("loop failed: %+v restarts=%d", i, restarts)
	}
}
func TestPluginCapabilitiesIsolationAndDisabledState(t *testing.T) {
	p, m := platformFixture(t)
	m.Tools = []Tool{{ID: "read", Path: "/tools/read"}, {ID: "write", Path: "/tools/write", Mutates: true}}
	_ = p.register(m, "http://127.0.0.1:18811/manifest", "REFBOX_TEST_PLUGIN_TOKEN")
	t.Setenv("REFBOX_TEST_PLUGIN_TOKEN", strings.Repeat("x", 40))
	s, e := New(configForTest("http://127.0.0.1:18801"))
	if e != nil {
		t.Fatal(e)
	}
	s.platform.Close()
	s.platform = p
	called := 0
	s.serviceClient.Transport = handlerTransport{http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		called++
		if r.Header.Get("Cookie") != "" || r.Header.Get("Authorization") != "Bearer "+strings.Repeat("x", 40) {
			t.Error("plugin credential isolation failed")
		}
		raw, _ := io.ReadAll(r.Body)
		if !bytes.Contains(raw, []byte(`"resourceId":"engine"`)) || bytes.Contains(raw, []byte(`"input"`)) {
			t.Error("runtime input not unwrapped")
		}
		writeJSON(w, 200, map[string]bool{"ok": true})
	})}
	blocked := httptest.NewRecorder()
	s.pluginTool(blocked, httptest.NewRequest("POST", "/", strings.NewReader(`{"input":{},"readOnly":true}`)), "monitor", "write", true)
	if blocked.Code != 403 || called != 0 {
		t.Fatal("read-only diagnosis could mutate")
	}
	allowed := httptest.NewRecorder()
	req := httptest.NewRequest("POST", "/", strings.NewReader(`{"input":{"resourceId":"engine"},"readOnly":true}`))
	req.Header.Set("Cookie", "admin-secret")
	s.pluginTool(allowed, req, "monitor", "read", true)
	if allowed.Code != 200 || called != 1 {
		t.Fatal("declared tool failed")
	}
	_ = p.mutate(func() error { p.state.Plugins["monitor"].Enabled = false; return nil })
	disabled := httptest.NewRecorder()
	s.pluginTool(disabled, httptest.NewRequest("POST", "/", strings.NewReader(`{}`)), "monitor", "read", false)
	if disabled.Code != 503 || called != 1 {
		t.Fatal("disabled plugin invoked")
	}
	if len(p.snapshot().Plugins) != 1 {
		t.Fatal("disabled plugin disappeared")
	}
}

func TestManualAcceptancePreservesIndependentVerdictAndHistory(t *testing.T) {
	p, _ := platformFixture(t)
	_ = p.syncTasks([]nativeTask{{ID: "32", Title: "historic", Status: "completed", Verified: true, CreatedAt: instant(), UpdatedAt: "2026-01-01T00:00:00Z"}}, true)
	task := p.snapshot().Tasks[0]
	if p.acceptTask(task.ID, "") == nil {
		t.Fatal("empty acceptance allowed")
	}
	if err := p.acceptTask(task.ID, "查看产物并核对了完成标准"); err != nil {
		t.Fatal(err)
	}
	accepted, _ := p.task(task.ID)
	_ = p.syncTasks([]nativeTask{{ID: "32", Title: "historic", Status: "completed", Verified: true, CreatedAt: task.CreatedAt, UpdatedAt: "2026-01-01T00:00:00Z"}}, true)
	after, _ := p.task(task.ID)
	if after.VerificationStatus != "manual" || after.BusinessStatus != "done" || after.ManualReason == "" || after.UpdatedAt != accepted.UpdatedAt || !after.LegacyVerified {
		t.Fatal("manual acceptance or native history overwritten")
	}
	filename := p.dbFilename(t)
	p.Close()
	reopened, e := OpenPlatform(filename)
	if e != nil {
		t.Fatal(e)
	}
	defer reopened.Close()
	again, _ := reopened.task(task.ID)
	if again.AcceptedAt == "" || again.VerificationStatus == "pass" {
		t.Fatal("manual approval promoted to independent proof")
	}
	_ = reopened.syncTasks([]nativeTask{{ID: "32", Title: "historic", Status: "running", CreatedAt: task.CreatedAt, UpdatedAt: time.Now().Add(time.Millisecond).Format(time.RFC3339Nano)}}, true)
	resumed, _ := reopened.task(task.ID)
	if resumed.VerificationStatus != "pending" || resumed.BusinessStatus != "attention" || resumed.ManualReason == "" {
		t.Fatal("new execution reused old acceptance or discarded its history")
	}
}

func TestPlatformHasSingleDatabaseOwner(t *testing.T) {
	filename := filepath.Join(t.TempDir(), "platform.sqlite")
	first, e := OpenPlatform(filename)
	if e != nil {
		t.Fatal(e)
	}
	defer first.Close()
	second, e := OpenPlatform(filename)
	if e == nil {
		second.Close()
		t.Fatal("second platform owner could overwrite state")
	}
	first.Close()
	second, e = OpenPlatform(filename)
	if e != nil {
		t.Fatal("owner lock was not released")
	}
	defer second.Close()
}

func TestFailedPersistenceDoesNotExposeUncommittedRegistry(t *testing.T) {
	p, _ := platformFixture(t)
	p.db.Close()
	m := Manifest{SchemaVersion: 1, ID: "uncommitted", Name: "uncommitted", Version: "1", Workspace: Workspace{"test", "/workspace"}}
	if err := p.register(m, "http://127.0.0.1:18813/manifest", ""); err == nil {
		t.Fatal("closed database accepted registration")
	}
	for _, plugin := range p.snapshot().Plugins {
		if plugin.ID == "uncommitted" {
			t.Fatal("failed transaction exposed an uncommitted plugin")
		}
	}
}

func TestExecutionCommandsConnectBusinessStatusAndPreserveManualChanges(t *testing.T) {
	s, e := New(configForTest("http://127.0.0.1:18801"))
	if e != nil {
		t.Fatal(e)
	}
	defer s.Close()
	native := nativeTask{ID: "32", Title: "newgoal", CreatedAt: instant(), UpdatedAt: instant(), Status: "awaiting_confirmation"}
	_ = s.platform.syncTasks([]nativeTask{native}, true)
	task := s.platform.snapshot().Tasks[0]
	s.client.Transport = handlerTransport{http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/api/tasks/32/approve" || r.Header.Get("Idempotency-Key") != "approve-stable" || r.Header.Get("Cookie") != "" {
			t.Error("command mapping/receipt/session isolation failed")
		}
		native.Status = "running"
		native.UpdatedAt = instant()
		writeJSON(w, 200, native)
	})}
	out := httptest.NewRecorder()
	request := httptest.NewRequest("POST", "/api/platform/tasks/"+task.ID+"/approve", strings.NewReader(`{}`))
	request.Header.Set("Idempotency-Key", "approve-stable")
	s.platformTaskAPI(out, request, []string{"api", "platform", "tasks", task.ID, "approve"})
	current, _ := s.platform.task(task.ID)
	if out.Code != 200 || current.BusinessStatus != "active" || current.ExecutionStatus != "running" {
		t.Fatal("starting execution left task in backlog")
	}
	_ = s.platform.status(task.ID, "backlog")
	_ = s.platform.syncTasks([]nativeTask{native}, true)
	current, _ = s.platform.task(task.ID)
	if current.BusinessStatus != "backlog" {
		t.Fatal("snapshot sync overwrote a manual classification")
	}
	if e = s.platform.completeBusinessCommand(task.ID, "approve", "approve-stable", native); e != nil {
		t.Fatal(e)
	}
	current, _ = s.platform.task(task.ID)
	if current.BusinessStatus != "backlog" {
		t.Fatal("duplicate command receipt overwrote later manual classification")
	}
	_ = s.platform.status(task.ID, "active")
	native.Status = "completed"
	native.UpdatedAt = instant()
	_ = s.platform.syncTasks([]nativeTask{native}, true)
	current, _ = s.platform.task(task.ID)
	if current.BusinessStatus != "attention" || current.VerificationStatus != "pending" {
		t.Fatal("execution self-check silently completed business goal")
	}
	_ = s.platform.status(task.ID, "active")
	_ = s.platform.syncTasks([]nativeTask{native}, true)
	current, _ = s.platform.task(task.ID)
	if current.BusinessStatus != "active" {
		t.Fatal("unchanged execution state overwrote manual business status")
	}
}

func TestFutureEvidenceWithdrawnResourceAndSamplingGaps(t *testing.T) {
	p, m := platformFixture(t)
	id := opened(t, p)
	for range 3 {
		sample(t, p, true)
	}
	i, _ := p.incident(id)
	r, _ := p.resource("engine")
	proof := passing(r)
	raw, _ := json.Marshal(map[string]any{"id": "functional", "url": r.Checks[0].URL, "passed": true, "sampledAt": time.Now().Add(time.Hour).Format(time.RFC3339Nano)})
	proof.Checks = []json.RawMessage{raw}
	_ = p.proof(i, r, proof)
	i, _ = p.incident(id)
	if i.Status == "closed" {
		t.Fatal("future evidence closed incident")
	}
	_ = p.mutate(func() error {
		p.state.Resources["engine"].SampledAt = time.Now().Add(-time.Minute).Format(time.RFC3339Nano)
		return nil
	})
	sample(t, p, true)
	r, _ = p.resource("engine")
	if r.HealthySamples != 1 {
		t.Fatal("health sample gap still considered consecutive")
	}
	m.Resources = []Resource{}
	_ = p.register(m, "http://127.0.0.1:18811/manifest", "")
	r, _ = p.resource("engine")
	if r.Enabled {
		t.Fatal("withdrawn resource remained enabled")
	}
	if _, e := p.observe(Observation{ResourceID: "engine", SampledAt: instant(), Method: "http_body", Healthy: true, Version: "1", EnvironmentID: "macmini"}); e == nil {
		t.Fatal("withdrawn resource observation admitted")
	}
	i, _ = p.incident(id)
	if e := p.proof(i, r, passing(Resource{Checks: []Check{{ID: "functional", URL: "http://127.0.0.1:18801/health"}}})); e == nil {
		t.Fatal("withdrawn scope proof admitted")
	}
}

func TestUnavailableProbeDoesNotAuthorizeRestart(t *testing.T) {
	p, _ := platformFixture(t)
	for range 2 {
		if _, e := p.observe(Observation{ResourceID: "engine", SampledAt: instant(), Method: "http_json", Detail: "probe credentials missing", Version: "1", EnvironmentID: "macmini", Unavailable: true}); e != nil {
			t.Fatal(e)
		}
	}
	r, _ := p.resource("engine")
	if r.Health != "unknown" || r.Failures != 0 || len(p.snapshot().Incidents) != 0 {
		t.Fatal("unavailable probe became a service failure and authorized repair")
	}
}

func TestPluginGetToolAndProxyStripAdminSession(t *testing.T) {
	p, m := platformFixture(t)
	m.Tools = []Tool{{ID: "samples", Path: "/samples", Method: "GET"}}
	_ = p.register(m, "http://127.0.0.1:18811/manifest", "REFBOX_TEST_PLUGIN_TOKEN")
	t.Setenv("REFBOX_TEST_PLUGIN_TOKEN", strings.Repeat("x", 40))
	s, e := New(configForTest("http://127.0.0.1:18801"))
	if e != nil {
		t.Fatal(e)
	}
	s.platform.Close()
	s.platform = p
	s.serviceClient.Transport = handlerTransport{http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method != "GET" || r.URL.Query().Get("resourceId") != "engine" || r.Header.Get("Idempotency-Key") != "pi-tool:one" || r.Header.Get("Cookie") != "" {
			t.Error("GET tool protocol mismatch or cookie leaked")
		}
		writeJSON(w, 200, map[string]bool{"ok": true})
	})}
	out := httptest.NewRecorder()
	s.pluginTool(out, httptest.NewRequest("POST", "/", strings.NewReader(`{"input":{"resourceId":"engine"},"readOnly":true,"_idempotencyKey":"pi-tool:one"}`)), "monitor", "samples", true)
	if out.Code != 200 {
		t.Fatal(out.Body.String())
	}
	s.manifestClient.Transport = handlerTransport{http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Header.Get("Cookie") != "" || r.URL.Path != "/workspace" || r.Header.Get("Authorization") != "Bearer "+strings.Repeat("x", 40) {
			t.Error("proxy session isolation failed")
		}
		w.Header().Set("Set-Cookie", "bad=secret")
		w.Write([]byte("<h1>plugin</h1>"))
	})}
	frame := httptest.NewRecorder()
	frame.Header().Set("Content-Security-Policy", "frame-ancestors 'none'")
	frame.Header().Set("X-Frame-Options", "DENY")
	req := httptest.NewRequest("GET", "/", nil)
	req.Header.Set("Cookie", "refbox_session=admin")
	s.pluginProxy(frame, req, "monitor", "/workspace")
	if frame.Code != 200 || frame.Header().Get("Set-Cookie") != "" || strings.Contains(frame.Header().Get("Content-Security-Policy"), "frame-ancestors 'none'") || frame.Header().Get("X-Frame-Options") == "DENY" || !strings.Contains(frame.Header().Get("Content-Security-Policy"), "sandbox") {
		t.Fatal("isolated plugin workspace framing failed")
	}
}
