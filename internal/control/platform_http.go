package control

import (
	"bufio"
	"bytes"
	"compress/gzip"
	"context"
	"crypto/subtle"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/http/httputil"
	"net/url"
	"os"
	"path"
	"sort"
	"strconv"
	"strings"
	"time"
)

func acceptsSnapshotGzip(r *http.Request) bool {
	for _, item := range strings.Split(strings.Join(r.Header.Values("Accept-Encoding"), ","), ",") {
		parts := strings.Split(item, ";")
		if !strings.EqualFold(strings.TrimSpace(parts[0]), "gzip") {
			continue
		}
		quality := 1.0
		for _, parameter := range parts[1:] {
			key, value, found := strings.Cut(strings.TrimSpace(parameter), "=")
			if found && strings.EqualFold(strings.TrimSpace(key), "q") {
				q, err := strconv.ParseFloat(strings.TrimSpace(value), 64)
				if err != nil || q < 0 || q > 1 {
					return false
				}
				quality = q
			}
		}
		return quality > 0
	}
	return false
}

func (s *Server) platformSnapshotJSON() ([]byte, error) {
	value := s.platform.snapshot()
	// Stable array ordering prevents map iteration or equal timestamps from
	// making an unchanged snapshot appear changed on every polling interval.
	sort.Slice(value.Workers, func(i, j int) bool { return value.Workers[i].ID < value.Workers[j].ID })
	sort.Slice(value.Tasks, func(i, j int) bool {
		if value.Tasks[i].CreatedAt == value.Tasks[j].CreatedAt {
			return value.Tasks[i].ID < value.Tasks[j].ID
		}
		return value.Tasks[i].CreatedAt > value.Tasks[j].CreatedAt
	})
	sort.Slice(value.Incidents, func(i, j int) bool {
		if value.Incidents[i].OpenedAt == value.Incidents[j].OpenedAt {
			return value.Incidents[i].ID < value.Incidents[j].ID
		}
		return value.Incidents[i].OpenedAt > value.Incidents[j].OpenedAt
	})
	return json.Marshal(value)
}

func (s *Server) writePlatformSnapshot(w http.ResponseWriter, r *http.Request) {
	raw, err := s.platformSnapshotJSON()
	if err != nil {
		jsonError(w, 500, "snapshot unavailable")
		return
	}
	w.Header().Add("Vary", "Accept-Encoding")
	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	w.Header().Set("Cache-Control", "no-store")
	if acceptsSnapshotGzip(r) {
		w.Header().Set("Content-Encoding", "gzip")
		compressed, _ := gzip.NewWriterLevel(w, gzip.BestSpeed)
		defer compressed.Close()
		_, _ = compressed.Write(append(raw, '\n'))
		return
	}
	_, _ = w.Write(append(raw, '\n'))
}

func decodeBody(w http.ResponseWriter, r *http.Request, v any) error {
	r.Body = http.MaxBytesReader(w, r.Body, 128000)
	d := json.NewDecoder(r.Body)
	if err := d.Decode(v); err != nil {
		return errors.New("invalid JSON body")
	}
	var extra any
	if d.Decode(&extra) != io.EOF {
		return errors.New("request must contain one JSON value")
	}
	return nil
}
func localURL(value string) (*url.URL, error) {
	u, err := url.Parse(value)
	if err != nil || u.Scheme != "http" || (u.Hostname() != "127.0.0.1" && u.Hostname() != "localhost" && u.Hostname() != "::1") || u.User != nil || u.RawQuery != "" || u.Fragment != "" {
		return nil, errors.New("service URL must be loopback HTTP")
	}
	return u, nil
}
func relativePath(value string) bool {
	return strings.HasPrefix(value, "/") && !strings.HasPrefix(value, "//") && !strings.Contains(value, "..") && !strings.ContainsAny(value, "?\\#\r\n")
}
func validateManifest(m Manifest) error {
	if m.SchemaVersion != 1 || !validID.MatchString(m.ID) || m.Name == "" || m.Version == "" || !relativePath(m.Workspace.Path) {
		return errors.New("invalid plugin manifest or schema version")
	}
	ids := map[string]bool{}
	for _, r := range m.Resources {
		if !validID.MatchString(r.ID) || ids[r.ID] || r.Name == "" || r.Version == "" || r.EnvironmentID == "" || (r.RestartAllowed && !validID.MatchString(r.ServiceID)) {
			return errors.New("invalid resource")
		}
		ids[r.ID] = true
		checks := map[string]bool{}
		for _, c := range r.Checks {
			u, err := url.Parse(c.URL)
			if err != nil || (u.Scheme != "http" && u.Scheme != "https") || u.Hostname() == "" || u.User != nil || !validID.MatchString(c.ID) || checks[c.ID] || (c.CredentialEnv != "" && !validEnv.MatchString(c.CredentialEnv)) || (c.Browser != nil && c.Browser.PasswordEnv != "" && !validEnv.MatchString(c.Browser.PasswordEnv)) {
				return errors.New("invalid fixed check")
			}
			checks[c.ID] = true
		}
	}
	ids = map[string]bool{}
	for _, t := range m.Tools {
		if !validID.MatchString(t.ID) || ids[t.ID] || !relativePath(t.Path) || (t.Method != "" && t.Method != "GET" && t.Method != "POST") {
			return errors.New("invalid tool declaration")
		}
		ids[t.ID] = true
	}
	return nil
}
func (s *Server) fetchManifest(ctx context.Context, address, credential string) (Manifest, error) {
	var m Manifest
	u, err := localURL(address)
	if err != nil {
		return m, err
	}
	if credential != "" && !validEnv.MatchString(credential) {
		return m, errors.New("invalid credential environment name")
	}
	req, _ := http.NewRequestWithContext(ctx, "GET", u.String(), nil)
	if credential != "" {
		key := os.Getenv(credential)
		if len(key) < 32 {
			return m, errors.New("plugin credential missing")
		}
		req.Header.Set("Authorization", "Bearer "+key)
	}
	res, err := s.manifestClient.Do(req)
	if err != nil {
		return m, errors.New("plugin is unreachable")
	}
	defer res.Body.Close()
	if res.StatusCode != 200 {
		return m, fmt.Errorf("manifest returned %d", res.StatusCode)
	}
	if err = json.NewDecoder(io.LimitReader(res.Body, 128001)).Decode(&m); err != nil {
		return m, errors.New("invalid manifest JSON")
	}
	return m, validateManifest(m)
}
func (s *Server) discover(ctx context.Context) {
	for _, definition := range s.config.BuiltinPlugins {
		registered := false
		for _, p := range s.platform.snapshot().Plugins {
			if p.ManifestURL == definition.ManifestURL {
				registered = true
				break
			}
		}
		if !registered {
			m, e := s.fetchManifest(ctx, definition.ManifestURL, definition.CredentialEnv)
			if e == nil {
				_ = s.platform.register(m, definition.ManifestURL, definition.CredentialEnv)
			}
		}
	}
	for _, p := range s.platform.snapshot().Plugins {
		if !p.Enabled {
			continue
		}
		s.platform.mu.Lock()
		credential := s.platform.state.Credentials[p.ID]
		s.platform.mu.Unlock()
		m, err := s.fetchManifest(ctx, p.ManifestURL, credential)
		_ = s.platform.mutate(func() error {
			x := s.platform.state.Plugins[p.ID]
			if x == nil {
				return nil
			}
			x.Online = err == nil
			x.Error = ""
			if err != nil {
				x.Error = err.Error()
			} else if m.ID != p.ID || m.Version != p.Version {
				x.Online = false
				x.Error = "插件清单版本变更，请重新注册以确认能力"
			}
			return nil
		})
	}
}
func (s *Server) synchronize(ctx context.Context) {
	syncCtx, cancel := context.WithTimeout(ctx, 2*time.Second)
	defer cancel()
	res, err := s.engineRequest(syncCtx, "GET", "/api/tasks", nil, "")
	var tasks []nativeTask
	available := false
	if err == nil {
		defer res.Body.Close()
		available = res.StatusCode == 200 && json.NewDecoder(io.LimitReader(res.Body, 8<<20)).Decode(&tasks) == nil
	}
	_ = s.platform.syncTasks(tasks, available)
	detail := "执行服务离线；平台状态与监控仍可用"
	if available {
		detail = "Pi Durable 在线，任务上下文独立保存"
	}
	_ = s.platform.mutate(func() error {
		status := "offline"
		last := ""
		if old := s.platform.state.Workers["pi-executor"]; old != nil {
			last = old.LastSeen
		}
		if available {
			status = "online"
			last = instant()
		}
		s.platform.state.Workers["pi-executor"] = &Worker{"pi-executor", "executor", status, last, detail}
		return nil
	})
}
func (s *Server) internalAPI(w http.ResponseWriter, r *http.Request) {
	expected := "Bearer " + s.config.PlatformToken
	if len(s.config.PlatformToken) < 32 || subtle.ConstantTimeCompare([]byte(r.Header.Get("Authorization")), []byte(expected)) != 1 {
		jsonError(w, 401, "未授权")
		return
	}
	parts := strings.Split(strings.Trim(r.URL.Path, "/"), "/")
	switch {
	case r.Method == "GET" && r.URL.Path == "/internal/resources":
		writeJSON(w, 200, s.platform.snapshot().Resources)
	case r.Method == "GET" && r.URL.Path == "/internal/plugins":
		writeJSON(w, 200, s.platform.snapshot().Plugins)
	case r.Method == "GET" && r.URL.Path == "/internal/observations":
		id := r.URL.Query().Get("resourceId")
		resource, err := s.platform.resource(id)
		if err != nil {
			jsonError(w, 404, err.Error())
			return
		}
		s.platform.mu.Lock()
		samples := []Observation{}
		for _, o := range s.platform.state.Observations {
			if o.ResourceID == id {
				samples = append(samples, o)
			}
		}
		s.platform.mu.Unlock()
		incidents := []*Incident{}
		for _, i := range s.platform.snapshot().Incidents {
			if i.ResourceID == id {
				incidents = append(incidents, i)
			}
		}
		writeJSON(w, 200, map[string]any{"resource": resource, "observations": samples, "incidents": incidents})
	case r.Method == "POST" && r.URL.Path == "/internal/heartbeat":
		var b Worker
		if decodeBody(w, r, &b) != nil {
			jsonError(w, 400, "invalid heartbeat")
			return
		}
		if err := s.platform.heartbeat(b); err != nil {
			jsonError(w, 400, err.Error())
			return
		}
		writeJSON(w, 200, map[string]bool{"ok": true})
	case r.Method == "POST" && r.URL.Path == "/internal/observations":
		var o Observation
		if decodeBody(w, r, &o) != nil {
			jsonError(w, 400, "invalid observation")
			return
		}
		id, err := s.platform.observe(o)
		if err != nil {
			jsonError(w, 409, err.Error())
			return
		}
		writeJSON(w, 200, map[string]string{"incidentId": id})
	case r.Method == "POST" && len(parts) == 5 && parts[1] == "plugins" && parts[3] == "tools":
		s.pluginTool(w, r, parts[2], parts[4], true)
	default:
		jsonError(w, 404, "internal endpoint does not exist")
	}
}
func (s *Server) platformAPI(w http.ResponseWriter, r *http.Request) {
	parts := strings.Split(strings.Trim(r.URL.Path, "/"), "/")
	if len(parts) < 3 {
		jsonError(w, 404, "platform endpoint does not exist")
		return
	}
	if r.Method == "GET" && r.URL.Path == "/api/platform/snapshot" {
		s.writePlatformSnapshot(w, r)
		return
	}
	if r.Method == "GET" && len(parts) == 4 && parts[2] == "diagnoses" {
		copyReq := r.Clone(r.Context())
		copyReq.URL.Path = "/api/diagnoses/" + url.PathEscape(parts[3])
		s.proxy.ServeHTTP(w, copyReq)
		return
	}
	if r.Method == "GET" && r.URL.Path == "/api/platform/events" {
		w.Header().Set("Content-Type", "text/event-stream")
		w.Header().Set("Cache-Control", "no-cache")
		w.Header().Set("X-Accel-Buffering", "no")
		w.Header().Add("Vary", "Accept-Encoding")
		flusher, ok := w.(http.Flusher)
		if !ok {
			jsonError(w, 500, "stream unavailable")
			return
		}
		var writer io.Writer = w
		var compressed *gzip.Writer
		if acceptsSnapshotGzip(r) {
			w.Header().Set("Content-Encoding", "gzip")
			compressed, _ = gzip.NewWriterLevel(w, gzip.BestSpeed)
			defer compressed.Close()
			writer = compressed
		}
		ticker := time.NewTicker(2 * time.Second)
		defer ticker.Stop()
		var previous []byte
		for {
			raw, err := s.platformSnapshotJSON()
			if err != nil {
				return
			}
			if bytes.Equal(raw, previous) {
				_, err = io.WriteString(writer, ": heartbeat\n\n")
			} else {
				_, err = fmt.Fprintf(writer, "event: snapshot\ndata: %s\n\n", raw)
				previous = raw
			}
			if err != nil {
				return
			}
			if compressed != nil {
				if err := compressed.Flush(); err != nil {
					return
				}
			}
			flusher.Flush()
			select {
			case <-r.Context().Done():
				return
			case <-ticker.C:
			}
		}
	}
	if r.Method == "POST" && r.URL.Path == "/api/platform/plugins" {
		var b struct {
			ManifestURL   string `json:"manifestUrl"`
			CredentialEnv string `json:"credentialEnv"`
		}
		if decodeBody(w, r, &b) != nil {
			jsonError(w, 400, "invalid registration")
			return
		}
		m, err := s.fetchManifest(r.Context(), b.ManifestURL, b.CredentialEnv)
		if err == nil {
			err = s.platform.register(m, b.ManifestURL, b.CredentialEnv)
		}
		if err != nil {
			jsonError(w, 400, err.Error())
			return
		}
		writeJSON(w, 201, s.platform.snapshot())
		return
	}
	if len(parts) >= 4 && parts[2] == "plugins" {
		id := parts[3]
		if r.Method == "POST" && len(parts) == 5 && parts[4] == "enable" {
			var b struct {
				Enabled bool `json:"enabled"`
			}
			if decodeBody(w, r, &b) != nil {
				jsonError(w, 400, "invalid enable request")
				return
			}
			err := s.platform.mutate(func() error {
				p := s.platform.state.Plugins[id]
				if p == nil {
					return errors.New("unknown plugin")
				}
				p.Enabled = b.Enabled
				for _, res := range s.platform.state.Resources {
					if res.PluginID == id {
						res.Health = "unknown"
						res.HealthySamples = 0
						res.Failures = 0
						res.Detail = "插件启用状态改变，等待新采样"
					}
				}
				s.platform.event("plugin.enabled", "", "", fmt.Sprintf("%s enabled=%v", p.Name, b.Enabled))
				return nil
			})
			if err != nil {
				jsonError(w, 404, err.Error())
				return
			}
			writeJSON(w, 200, s.platform.snapshot())
			return
		}
		if r.Method == "GET" && len(parts) >= 5 && parts[4] == "proxy" {
			s.pluginProxy(w, r, id, "/"+strings.Join(parts[5:], "/"))
			return
		}
		if r.Method == "POST" && len(parts) == 6 && parts[4] == "tools" {
			s.pluginTool(w, r, id, parts[5], false)
			return
		}
	}
	if parts[2] == "tasks" {
		s.platformTaskAPI(w, r, parts)
		return
	}
	if r.Method == "POST" && len(parts) == 5 && parts[2] == "incidents" {
		id := parts[3]
		var err error
		switch parts[4] {
		case "repair":
			err = s.repair(r.Context(), id)
		case "verify":
			err = s.verify(r.Context(), id)
		case "diagnose":
			s.diagnose(w, r, id)
			return
		default:
			jsonError(w, 404, "unknown incident action")
			return
		}
		if err != nil {
			jsonError(w, 409, err.Error())
			return
		}
		writeJSON(w, 200, s.platform.snapshot())
		return
	}
	jsonError(w, 404, "platform endpoint does not exist")
}
func (s *Server) pluginTarget(id string) (Plugin, *url.URL, error) {
	s.platform.mu.Lock()
	defer s.platform.mu.Unlock()
	p := s.platform.state.Plugins[id]
	if p == nil {
		return Plugin{}, nil, errors.New("unknown plugin")
	}
	if !p.Enabled {
		return Plugin{}, nil, errors.New("plugin disabled")
	}
	u, err := localURL(p.ManifestURL)
	if err != nil {
		return Plugin{}, nil, err
	}
	u.Path = ""
	return *p, u, err
}
func (s *Server) pluginProxy(w http.ResponseWriter, r *http.Request, id, targetPath string) {
	p, u, err := s.pluginTarget(id)
	if err != nil {
		jsonError(w, 503, err.Error())
		return
	}
	if !relativePath(targetPath) || !(targetPath == p.Workspace.Path || strings.HasPrefix(targetPath, p.Workspace.Path+"/")) {
		jsonError(w, 403, "workspace path outside manifest")
		return
	}
	proxy := httputil.NewSingleHostReverseProxy(u)
	proxy.Transport = s.manifestClient.Transport
	proxy.Director = func(out *http.Request) {
		out.URL.Scheme = u.Scheme
		out.URL.Host = u.Host
		out.URL.Path = path.Clean(targetPath)
		out.Host = u.Host
		out.Header.Del("Cookie")
		out.Header.Del("Authorization")
		out.Header.Del("X-Refbox-Request")
		out.Header.Del("X-Forwarded-For")
		if p.CredentialEnv != "" {
			out.Header.Set("Authorization", "Bearer "+os.Getenv(p.CredentialEnv))
		}
	}
	proxy.ModifyResponse = func(res *http.Response) error {
		res.Header.Del("Set-Cookie")
		res.Header.Del("Location")
		res.Header.Set("X-Frame-Options", "SAMEORIGIN")
		res.Header.Set("Content-Security-Policy", "default-src 'none'; style-src 'unsafe-inline'; img-src data:; script-src 'none'; frame-ancestors 'self'; sandbox")
		return nil
	}
	proxy.ErrorHandler = func(w http.ResponseWriter, _ *http.Request, _ error) { jsonError(w, 503, "插件工作区离线") }
	w.Header().Del("X-Frame-Options")
	w.Header().Del("Content-Security-Policy")
	proxy.ServeHTTP(w, r)
}
func (s *Server) pluginTool(w http.ResponseWriter, r *http.Request, pluginID, toolID string, internal bool) {
	p, u, err := s.pluginTarget(pluginID)
	if err != nil {
		jsonError(w, 503, err.Error())
		return
	}
	var tool *Tool
	for _, t := range p.Manifest.Tools {
		if t.ID == toolID {
			x := t
			tool = &x
			break
		}
	}
	if tool == nil {
		jsonError(w, 404, "undeclared tool")
		return
	}
	var body map[string]any
	if decodeBody(w, r, &body) != nil {
		jsonError(w, 400, "invalid tool input")
		return
	}
	if internal && tool.Mutates && body["readOnly"] == true {
		jsonError(w, 403, "diagnosis cannot mutate plugin")
		return
	}
	requestKey := r.Header.Get("Idempotency-Key")
	if internal {
		if key, ok := body["_idempotencyKey"].(string); ok {
			requestKey = key
		}
	}
	delete(body, "_idempotencyKey")
	delete(body, "readOnly")
	if internal {
		if input, ok := body["input"].(map[string]any); ok {
			body = input
		}
	}
	raw, _ := json.Marshal(body)
	u.Path = tool.Path
	method := tool.Method
	if method == "" {
		method = "POST"
	}
	var reader io.Reader = bytes.NewReader(raw)
	if method == "GET" {
		query := url.Values{}
		for key, value := range body {
			if text, ok := value.(string); ok {
				query.Set(key, text)
			} else {
				encoded, _ := json.Marshal(value)
				query.Set(key, string(encoded))
			}
		}
		u.RawQuery = query.Encode()
		reader = nil
	}
	outbound, err := http.NewRequestWithContext(r.Context(), method, u.String(), reader)
	if err != nil {
		jsonError(w, 400, "invalid plugin request")
		return
	}
	outbound.Header.Set("Content-Type", "application/json")
	if p.CredentialEnv != "" {
		outbound.Header.Set("Authorization", "Bearer "+os.Getenv(p.CredentialEnv))
	}
	if len(requestKey) > 0 && len(requestKey) <= 200 && !strings.ContainsAny(requestKey, "\r\n") {
		outbound.Header.Set("Idempotency-Key", requestKey)
	}
	res, err := s.serviceClient.Do(outbound)
	if err != nil {
		jsonError(w, 503, "plugin tool unavailable")
		return
	}
	defer res.Body.Close()
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(res.StatusCode)
	_, _ = io.Copy(w, io.LimitReader(res.Body, 1<<20))
}
func (s *Server) serviceRequest(ctx context.Context, address, token string, body []byte) (*http.Response, error) {
	if _, err := localURL(address); err != nil {
		return nil, err
	}
	req, err := http.NewRequestWithContext(ctx, "POST", address, bytes.NewReader(body))
	if err != nil {
		return nil, err
	}
	if token != "" {
		req.Header.Set("Authorization", "Bearer "+token)
	}
	req.Header.Set("Content-Type", "application/json")
	return s.serviceClient.Do(req)
}
func (s *Server) repair(ctx context.Context, id string) error {
	if len(s.config.BrokerToken) < 32 || s.config.BrokerURL == "" {
		return errors.New("动作代理尚未配置；没有执行重启")
	}
	if _, loaded := s.platform.operations.LoadOrStore("incident:"+id, true); loaded {
		return errors.New("incident operation already running")
	}
	defer s.platform.operations.Delete("incident:" + id)
	i, r, err := s.platform.reserveAction(id)
	if err != nil {
		return err
	}
	raw, _ := json.Marshal(map[string]string{"serviceId": r.ServiceID, "actionId": i.ActionID})
	actionContext, cancel := context.WithTimeout(context.WithoutCancel(ctx), 25*time.Second)
	defer cancel()
	res, err := s.serviceRequest(actionContext, strings.TrimRight(s.config.BrokerURL, "/")+"/restart", s.config.BrokerToken, raw)
	if err == nil {
		defer res.Body.Close()
		if res.StatusCode != 200 {
			err = fmt.Errorf("broker returned %d", res.StatusCode)
		} else {
			var receipt struct {
				ActionID  string `json:"actionId"`
				ServiceID string `json:"serviceId"`
				Status    string `json:"status"`
			}
			if json.NewDecoder(io.LimitReader(res.Body, 128000)).Decode(&receipt) != nil || receipt.ActionID != i.ActionID || receipt.ServiceID != r.ServiceID || receipt.Status != "succeeded" {
				err = errors.New("动作回执未绑定当前动作或未确认成功")
			}
		}
	}
	save := s.platform.actionResult(id, i.ActionID, err)
	if save != nil {
		return save
	}
	return err
}
func (s *Server) verify(ctx context.Context, id string) error {
	if _, loaded := s.platform.operations.LoadOrStore("incident:"+id, true); loaded {
		return errors.New("incident operation already running")
	}
	defer s.platform.operations.Delete("incident:" + id)
	i, err := s.platform.incident(id)
	if err != nil {
		return err
	}
	r, err := s.platform.resource(i.ResourceID)
	if err != nil {
		return err
	}
	if i.Status == "closed" || i.Status == "acting" {
		return errors.New("incident cannot verify in current state")
	}
	if r.HealthySamples < 3 || r.Health != "healthy" || time.Since(parseTime(r.SampledAt)) > 45*time.Second {
		return errors.New("需要三次新鲜健康采样后再验收")
	}
	if !r.Enabled {
		return errors.New("资源已禁用或撤销，不能验收")
	}
	result := Evidence{Verdict: "inconclusive", Summary: "独立验证器尚未配置或离线", Checks: []json.RawMessage{}}
	if s.config.VerifierURL != "" && len(s.config.VerifierToken) >= 32 {
		actionScope := i.ActionID
		if actionScope == "" {
			actionScope = "observe_" + id
		}
		raw, _ := json.Marshal(map[string]any{"incidentId": id, "resourceId": r.ID, "actionId": actionScope, "version": r.Version, "environmentId": r.EnvironmentID, "requestedAt": instant(), "checks": r.Checks, "healthySamples": r.HealthySamples})
		res, e := s.serviceRequest(ctx, strings.TrimRight(s.config.VerifierURL, "/")+"/verify", s.config.VerifierToken, raw)
		if e == nil {
			defer res.Body.Close()
			if res.StatusCode != 200 || json.NewDecoder(io.LimitReader(res.Body, 1<<20)).Decode(&result) != nil {
				result = Evidence{Verdict: "inconclusive", Summary: "独立验证器未返回有效验收结果"}
			} else if result.IncidentID != id || result.ResourceID != r.ID || result.ActionID != actionScope || result.Version != r.Version || result.EnvironmentID != r.EnvironmentID {
				result = Evidence{Verdict: "inconclusive", Summary: "验证响应没有绑定本次资源、事件、动作、版本和环境"}
			}
		}
	}
	return s.platform.proof(i, r, result)
}
func (s *Server) diagnose(w http.ResponseWriter, r *http.Request, id string) {
	diagnosis, err := s.requestDiagnosis(r.Context(), id)
	if err != nil {
		jsonError(w, 503, err.Error())
		return
	}
	writeJSON(w, 200, diagnosis)
}

type diagnosisRecord struct {
	ID             string `json:"id"`
	ConversationID string `json:"conversationId"`
	Status         string `json:"status"`
	Summary        string `json:"summary"`
}

func (s *Server) requestDiagnosis(ctx context.Context, id string) (diagnosisRecord, error) {
	var record diagnosisRecord
	if _, loaded := s.platform.operations.LoadOrStore("diagnosis:"+id, true); loaded {
		return record, errors.New("诊断正在请求")
	}
	defer s.platform.operations.Delete("diagnosis:" + id)
	i, err := s.platform.incident(id)
	if err != nil {
		return record, err
	}
	resource, err := s.platform.resource(i.ResourceID)
	if err != nil {
		return record, err
	}
	raw, _ := json.Marshal(map[string]any{"incidentId": id, "resourceId": resource.ID, "actionId": i.ActionID, "version": i.Version, "environmentId": i.EnvironmentID, "context": i.Reason})
	key := "diagnose:" + id + ":" + i.ActionID
	if i.DiagnosisID != "" {
		key += "manual:" + identifier("req_")
	}
	res, err := s.engineRequest(ctx, "POST", "/api/diagnoses", bytes.NewReader(raw), key)
	if err != nil {
		return record, errors.New("Pi 离线；监控与授权修复仍可继续")
	}
	defer res.Body.Close()
	if res.StatusCode >= 300 || json.NewDecoder(io.LimitReader(res.Body, 1<<20)).Decode(&record) != nil {
		return record, errors.New("诊断未完成受理；监控与授权修复仍可继续")
	}
	err = s.platform.mutate(func() error {
		x := s.platform.state.Incidents[id]
		if x == nil {
			return errors.New("incident vanished")
		}
		x.DiagnosisID = record.ID
		x.DiagnosisStatus = record.Status
		x.DiagnosisSummary = record.Summary
		s.platform.event("diagnosis.started", x.ResourceID, id, "独立只读诊断会话 "+record.ConversationID)
		return nil
	})
	return record, err
}
func (s *Server) pollDiagnoses(ctx context.Context) {
	for _, i := range s.platform.snapshot().Incidents {
		if i.DiagnosisID == "" || i.DiagnosisStatus != "running" {
			continue
		}
		jobCtx, cancel := context.WithTimeout(ctx, 2*time.Second)
		res, err := s.engineRequest(jobCtx, "GET", "/api/diagnoses/"+url.PathEscape(i.DiagnosisID), nil, "")
		if err == nil {
			var record diagnosisRecord
			if res.StatusCode == 200 && json.NewDecoder(io.LimitReader(res.Body, 128000)).Decode(&record) == nil {
				_ = s.platform.mutate(func() error {
					x := s.platform.state.Incidents[i.ID]
					if x != nil && x.DiagnosisID == record.ID {
						x.DiagnosisStatus = record.Status
						x.DiagnosisSummary = record.Summary
					}
					return nil
				})
			}
			res.Body.Close()
		}
		cancel()
	}
}
func (s *Server) pluginEvents(ctx context.Context, p Plugin) {
	defer s.platform.operations.Delete("events:" + p.ID)
	target, u, err := s.pluginTarget(p.ID)
	if err != nil {
		return
	}
	u.Path = "/events"
	request, err := http.NewRequestWithContext(ctx, "GET", u.String(), nil)
	if err != nil {
		return
	}
	if target.CredentialEnv != "" {
		request.Header.Set("Authorization", "Bearer "+os.Getenv(target.CredentialEnv))
	}
	response, err := s.serviceClient.Do(request)
	if err != nil {
		return
	}
	defer response.Body.Close()
	if response.StatusCode != 200 {
		return
	}
	scanner := bufio.NewScanner(response.Body)
	scanner.Buffer(make([]byte, 4096), 128000)
	kind := ""
	data := ""
	declared := map[string]bool{}
	for _, name := range p.Manifest.Events {
		declared[name] = true
	}
	for scanner.Scan() {
		line := scanner.Text()
		if strings.HasPrefix(line, "event:") {
			kind = strings.TrimSpace(strings.TrimPrefix(line, "event:"))
		} else if strings.HasPrefix(line, "data:") {
			data += strings.TrimSpace(strings.TrimPrefix(line, "data:"))
		} else if line == "" {
			if declared[kind] && json.Valid([]byte(data)) {
				var payload map[string]any
				_ = json.Unmarshal([]byte(data), &payload)
				_ = s.platform.mutate(func() error {
					plugin := s.platform.state.Plugins[p.ID]
					if plugin == nil || !plugin.Enabled {
						return nil
					}
					message := plugin.Name + " · " + kind
					for _, key := range []string{"id", "title", "resourceId"} {
						if value, ok := payload[key].(string); ok {
							if len(value) > 200 {
								value = value[:200]
							}
							message += " · " + value
						}
					}
					s.platform.event("plugin."+p.ID+"."+kind, "", "", message)
					return nil
				})
			}
			kind = ""
			data = ""
		}
	}
}
func (s *Server) platformTaskAPI(w http.ResponseWriter, r *http.Request, parts []string) {
	if len(parts) == 3 && r.Method == "POST" {
		var b map[string]any
		if decodeBody(w, r, &b) != nil {
			jsonError(w, 400, "invalid task")
			return
		}
		raw, _ := json.Marshal(b)
		res, err := s.engineRequest(r.Context(), "POST", "/api/tasks", bytes.NewReader(raw), r.Header.Get("Idempotency-Key"))
		if err != nil {
			jsonError(w, 503, "Pi 离线，无法创建执行上下文")
			return
		}
		defer res.Body.Close()
		if res.StatusCode >= 300 {
			w.WriteHeader(res.StatusCode)
			_, _ = io.Copy(w, res.Body)
			return
		}
		var n nativeTask
		if json.NewDecoder(res.Body).Decode(&n) != nil {
			jsonError(w, 503, "invalid runtime response")
			return
		}
		if err = s.platform.syncTasks([]nativeTask{n}, true); err != nil {
			jsonError(w, 500, "任务已在 Pi 创建，平台同步失败；相同请求可安全重试")
			return
		}
		for _, t := range s.platform.snapshot().Tasks {
			if t.ConversationID == n.ID {
				writeJSON(w, 201, t)
				return
			}
		}
	}
	if len(parts) < 4 {
		jsonError(w, 404, "task endpoint does not exist")
		return
	}
	t, err := s.platform.task(parts[3])
	if err != nil {
		jsonError(w, 404, err.Error())
		return
	}
	if len(parts) == 4 && r.Method == "GET" {
		writeJSON(w, 200, t)
		return
	}
	if len(parts) != 5 {
		jsonError(w, 404, "task endpoint does not exist")
		return
	}
	action := parts[4]
	if r.Method == "POST" && action == "accept" {
		var b struct {
			Reason string `json:"reason"`
		}
		if decodeBody(w, r, &b) != nil {
			jsonError(w, 400, "invalid acceptance")
			return
		}
		if err = s.platform.acceptTask(t.ID, b.Reason); err != nil {
			jsonError(w, 409, err.Error())
			return
		}
		updated, _ := s.platform.task(t.ID)
		writeJSON(w, 200, updated)
		return
	}
	if r.Method == "POST" && action == "status" {
		var b struct {
			Status string `json:"status"`
		}
		if decodeBody(w, r, &b) != nil {
			jsonError(w, 400, "invalid status")
			return
		}
		if err = s.platform.status(t.ID, b.Status); err != nil {
			jsonError(w, 409, err.Error())
			return
		}
		updated, _ := s.platform.task(t.ID)
		writeJSON(w, 200, updated)
		return
	}
	if r.Method == "GET" && action == "view" {
		view, err := s.engineRequest(r.Context(), "GET", "/api/tasks/"+url.PathEscape(t.ConversationID)+"/view", nil, "")
		if err != nil {
			jsonError(w, 503, "Pi 离线，原生历史暂不可读；平台任务仍保留")
			return
		}
		defer view.Body.Close()
		if view.StatusCode != 200 {
			jsonError(w, 503, "原生历史暂不可读")
			return
		}
		var v json.RawMessage
		if json.NewDecoder(io.LimitReader(view.Body, 8<<20)).Decode(&v) != nil {
			jsonError(w, 503, "invalid history")
			return
		}
		native, err := s.engineRequest(r.Context(), "GET", "/api/tasks/"+url.PathEscape(t.ConversationID), nil, "")
		if err != nil {
			jsonError(w, 503, "runtime task unavailable")
			return
		}
		defer native.Body.Close()
		var n json.RawMessage
		if native.StatusCode != 200 || json.NewDecoder(io.LimitReader(native.Body, 8<<20)).Decode(&n) != nil {
			jsonError(w, 503, "原生任务数据暂不可读")
			return
		}
		writeJSON(w, 200, map[string]any{"view": v, "task": n})
		return
	}
	allowed := action == "artifact" && r.Method == "GET" || r.Method == "POST" && (action == "plan" || action == "approve" || action == "stop" || action == "continue" || action == "steer" || action == "report")
	if !allowed {
		jsonError(w, 404, "task action does not exist")
		return
	}
	copyReq := r.Clone(r.Context())
	copyReq.URL.Path = "/api/tasks/" + url.PathEscape(t.ConversationID) + "/" + action
	if r.Method == "POST" {
		response, err := s.engineRequest(r.Context(), "POST", copyReq.URL.Path, r.Body, r.Header.Get("Idempotency-Key"))
		if err != nil {
			jsonError(w, 503, "Pi 暂不可用；相同请求可安全重试")
			return
		}
		defer response.Body.Close()
		raw, err := io.ReadAll(io.LimitReader(response.Body, 8<<20))
		if err != nil {
			jsonError(w, 503, "执行响应尚未确认；相同请求可安全重试")
			return
		}
		if response.StatusCode < 300 {
			var native nativeTask
			if json.Unmarshal(raw, &native) != nil || native.ID != t.ConversationID {
				jsonError(w, 503, "执行响应与业务任务映射不一致")
				return
			}
			if err = s.platform.syncTasks([]nativeTask{native}, true); err == nil {
				err = s.platform.completeBusinessCommand(t.ID, action, r.Header.Get("Idempotency-Key"), native)
			}
			if err != nil {
				jsonError(w, 500, "执行已受理，业务状态尚未保存；相同请求可安全重试")
				return
			}
		}
		w.Header().Set("Content-Type", "application/json; charset=utf-8")
		w.Header().Set("Cache-Control", "no-store")
		w.WriteHeader(response.StatusCode)
		_, _ = w.Write(raw)
		return
	}
	s.proxy.ServeHTTP(w, copyReq)
}
