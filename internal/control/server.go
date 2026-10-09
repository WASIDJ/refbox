package control

import (
	"bytes"
	"context"
	"crypto/hmac"
	"crypto/pbkdf2"
	"crypto/rand"
	"crypto/sha256"
	"crypto/subtle"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log"
	"net/http"
	"net/http/httputil"
	"net/url"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"sync"
	"time"
)

type Config struct {
	EngineURL, EngineToken, PasswordHash, WebDir string
	SecureCookie                                 bool
}
type Server struct {
	config   Config
	mux      *http.ServeMux
	secret   []byte
	proxy    *httputil.ReverseProxy
	client   *http.Client
	mu       sync.Mutex
	failures map[string][]time.Time
}

func New(cfg Config) (*Server, error) {
	u, err := url.Parse(cfg.EngineURL)
	if err != nil || u.Scheme != "http" || (u.Hostname() != "127.0.0.1" && u.Hostname() != "localhost") {
		return nil, errors.New("engine must be a loopback HTTP endpoint")
	}
	if len(cfg.EngineToken) < 32 {
		return nil, errors.New("internal token must have at least 32 characters")
	}
	if _, _, _, err = decodeHash(cfg.PasswordHash); err != nil {
		return nil, err
	}
	s := &Server{config: cfg, mux: http.NewServeMux(), secret: make([]byte, 32), client: &http.Client{Timeout: 30 * time.Second}, failures: map[string][]time.Time{}}
	if _, err = rand.Read(s.secret); err != nil {
		return nil, err
	}
	s.proxy = httputil.NewSingleHostReverseProxy(u)
	original := s.proxy.Director
	s.proxy.Director = func(r *http.Request) {
		original(r)
		r.Header.Set("Authorization", "Bearer "+cfg.EngineToken)
		r.Header.Del("Cookie")
		r.Header.Del("X-Forwarded-For")
	}
	s.proxy.FlushInterval = -1
	s.proxy.ErrorHandler = func(w http.ResponseWriter, r *http.Request, err error) {
		jsonError(w, 503, "执行服务暂不可用；任务状态保存在执行服务中")
	}
	s.mux.HandleFunc("POST /api/login", s.login)
	s.mux.HandleFunc("POST /api/logout", func(w http.ResponseWriter, r *http.Request) {
		if !s.writeAllowed(r) {
			jsonError(w, 403, "请求来源无效")
			return
		}
		s.cookie(w, "", -1)
		writeJSON(w, 200, map[string]bool{"ok": true})
	})
	s.mux.HandleFunc("GET /api/session", func(w http.ResponseWriter, r *http.Request) {
		writeJSON(w, 200, map[string]bool{"authenticated": s.authenticated(r)})
	})
	s.mux.HandleFunc("/api/", s.api)
	s.mux.HandleFunc("/", s.ui)
	return s, nil
}
func (s *Server) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("X-Content-Type-Options", "nosniff")
	w.Header().Set("Referrer-Policy", "no-referrer")
	w.Header().Set("X-Frame-Options", "DENY")
	w.Header().Set("Content-Security-Policy", "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; connect-src 'self'; img-src 'self' data:; frame-ancestors 'none'")
	s.mux.ServeHTTP(w, r)
}
func writeJSON(w http.ResponseWriter, status int, v any) {
	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	w.Header().Set("Cache-Control", "no-store")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(v)
}
func jsonError(w http.ResponseWriter, status int, message string) {
	writeJSON(w, status, map[string]string{"error": message})
}
func decodeHash(value string) (int, []byte, []byte, error) {
	p := strings.Split(value, "$")
	if len(p) != 4 || p[0] != "pbkdf2-sha256" {
		return 0, nil, nil, errors.New("invalid password hash")
	}
	n, err := strconv.Atoi(p[1])
	if err != nil || n < 100000 || n > 2000000 {
		return 0, nil, nil, errors.New("invalid password iterations")
	}
	salt, e1 := base64.RawURLEncoding.DecodeString(p[2])
	key, e2 := base64.RawURLEncoding.DecodeString(p[3])
	if e1 != nil || e2 != nil || len(salt) < 16 || len(key) != 32 {
		return 0, nil, nil, errors.New("invalid password hash encoding")
	}
	return n, salt, key, nil
}
func (s *Server) verifyPassword(password string) bool {
	n, salt, expected, _ := decodeHash(s.config.PasswordHash)
	key, err := pbkdf2.Key(sha256.New, password, salt, n, 32)
	return err == nil && subtle.ConstantTimeCompare(key, expected) == 1
}
func (s *Server) signature(payload string) string {
	h := hmac.New(sha256.New, s.secret)
	_, _ = h.Write([]byte(payload))
	return base64.RawURLEncoding.EncodeToString(h.Sum(nil))
}
func (s *Server) authenticated(r *http.Request) bool {
	c, err := r.Cookie("refbox_session")
	if err != nil {
		return false
	}
	parts := strings.Split(c.Value, ".")
	if len(parts) != 2 || !hmac.Equal([]byte(parts[1]), []byte(s.signature(parts[0]))) {
		return false
	}
	exp, err := strconv.ParseInt(parts[0], 10, 64)
	return err == nil && exp > time.Now().Unix()
}
func (s *Server) cookie(w http.ResponseWriter, value string, age int) {
	http.SetCookie(w, &http.Cookie{Name: "refbox_session", Value: value, Path: "/", HttpOnly: true, Secure: s.config.SecureCookie, SameSite: http.SameSiteStrictMode, MaxAge: age})
}
func (s *Server) writeAllowed(r *http.Request) bool {
	if r.Header.Get("X-Refbox-Request") != "1" {
		return false
	}
	if origin := r.Header.Get("Origin"); origin != "" {
		u, err := url.Parse(origin)
		if err != nil || u.Host != r.Host {
			return false
		}
	}
	return true
}
func (s *Server) login(w http.ResponseWriter, r *http.Request) {
	if !s.writeAllowed(r) {
		jsonError(w, 403, "请求来源无效")
		return
	}
	ip := r.RemoteAddr
	if i := strings.LastIndex(ip, ":"); i >= 0 {
		ip = ip[:i]
	}
	s.mu.Lock()
	cutoff := time.Now().Add(-time.Minute)
	var recent []time.Time
	for _, t := range s.failures[ip] {
		if t.After(cutoff) {
			recent = append(recent, t)
		}
	}
	s.failures[ip] = recent
	limited := len(recent) >= 10
	s.mu.Unlock()
	if limited {
		jsonError(w, 429, "尝试过多，请一分钟后重试")
		return
	}
	var b struct {
		Password string `json:"password"`
	}
	r.Body = http.MaxBytesReader(w, r.Body, 4096)
	if json.NewDecoder(r.Body).Decode(&b) != nil || len(b.Password) > 1000 {
		jsonError(w, 400, "登录请求无效")
		return
	}
	if !s.verifyPassword(b.Password) {
		s.mu.Lock()
		s.failures[ip] = append(s.failures[ip], time.Now())
		s.mu.Unlock()
		jsonError(w, 401, "密码错误")
		return
	}
	payload := strconv.FormatInt(time.Now().Add(24*time.Hour).Unix(), 10)
	s.cookie(w, payload+"."+s.signature(payload), 86400)
	writeJSON(w, 200, map[string]bool{"authenticated": true})
}
func (s *Server) api(w http.ResponseWriter, r *http.Request) {
	if !s.authenticated(r) {
		jsonError(w, 401, "请先登录")
		return
	}
	if r.Method != "GET" && r.Method != "HEAD" {
		if !s.writeAllowed(r) {
			jsonError(w, 403, "请求来源无效")
			return
		}
		r.Body = http.MaxBytesReader(w, r.Body, 128000)
	}
	s.proxy.ServeHTTP(w, r)
}
func (s *Server) ui(w http.ResponseWriter, r *http.Request) {
	if r.Method != "GET" && r.Method != "HEAD" {
		w.WriteHeader(405)
		return
	}
	clean := filepath.Clean("/" + r.URL.Path)
	filename := filepath.Join(s.config.WebDir, clean)
	if info, err := os.Stat(filename); err == nil && !info.IsDir() {
		http.ServeFile(w, r, filename)
		return
	}
	filename = filepath.Join(s.config.WebDir, "index.html")
	if _, err := os.Stat(filename); err != nil {
		jsonError(w, 503, "前端尚未构建，请运行 npm run build")
		return
	}
	http.ServeFile(w, r, filename)
}

// Report jobs use the runtime's durable command IDs. Go owns neither task state nor agent scheduling.
func (s *Server) ReportLoop(ctx context.Context) {
	tick := time.NewTicker(time.Minute)
	defer tick.Stop()
	for {
		if err := s.catchUp(ctx, time.Now()); err != nil && ctx.Err() == nil {
			log.Print("日报读取或生成暂不可用，稍后重试")
		}
		select {
		case <-ctx.Done():
			return
		case <-tick.C:
		}
	}
}

type reportTask struct {
	ID        string    `json:"id"`
	CreatedAt time.Time `json:"createdAt"`
	Reports   []struct {
		Date string `json:"date"`
	} `json:"reports"`
}

func dueDates(created, at time.Time, existing map[string]bool) []string {
	loc, _ := time.LoadLocation("Asia/Shanghai")
	a := created.In(loc)
	end := at.In(loc)
	cursor := time.Date(a.Year(), a.Month(), a.Day(), 9, 0, 0, 0, loc)
	var result []string
	for !cursor.After(end) {
		date := cursor.Format("2006-01-02")
		if !cursor.Before(a) && !existing[date] {
			result = append(result, date)
		}
		cursor = cursor.AddDate(0, 0, 1)
	}
	return result
}
func (s *Server) engineRequest(ctx context.Context, method, path string, body io.Reader, key string) (*http.Response, error) {
	req, err := http.NewRequestWithContext(ctx, method, s.config.EngineURL+path, body)
	if err != nil {
		return nil, err
	}
	req.Header.Set("Authorization", "Bearer "+s.config.EngineToken)
	req.Header.Set("Content-Type", "application/json")
	if key != "" {
		req.Header.Set("Idempotency-Key", key)
	}
	return s.client.Do(req)
}
func (s *Server) catchUp(ctx context.Context, at time.Time) error {
	res, err := s.engineRequest(ctx, "GET", "/api/tasks", nil, "")
	if err != nil {
		return err
	}
	defer res.Body.Close()
	if res.StatusCode != 200 {
		return fmt.Errorf("runtime %d", res.StatusCode)
	}
	var tasks []reportTask
	if err = json.NewDecoder(res.Body).Decode(&tasks); err != nil {
		return err
	}
	for _, t := range tasks {
		existing := map[string]bool{}
		for _, r := range t.Reports {
			existing[r.Date] = true
		}
		for _, date := range dueDates(t.CreatedAt, at, existing) {
			body, _ := json.Marshal(map[string]string{"date": date})
			response, err := s.engineRequest(ctx, "POST", "/api/tasks/"+url.PathEscape(t.ID)+"/report", bytes.NewReader(body), "daily:"+t.ID+":"+date)
			if err != nil {
				return err
			}
			_, _ = io.Copy(io.Discard, response.Body)
			response.Body.Close()
			if response.StatusCode >= 300 {
				return fmt.Errorf("report %d", response.StatusCode)
			}
		}
	}
	return nil
}
